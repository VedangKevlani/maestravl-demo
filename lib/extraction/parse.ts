import * as chrono from 'chrono-node'
import { lookupAirline } from '@/lib/data/airlines'
import { lookupAirport } from '@/lib/data/airports'
import { zonedDateTimeToUtc } from '@/lib/dateFormat'
import {
  field,
  type ExtractedField,
  type ExtractedItinerary,
  type ExtractedSegment,
  type TransportTypeGuess,
} from './types'

function emptySegment(transportType: TransportTypeGuess, transportConfidence: number): ExtractedSegment {
  return {
    transportType: field(transportType, transportConfidence, 'heuristic'),
    provider: field<string>(null, 0, 'unset'),
    identifier: field<string>(null, 0, 'unset'),
    confirmationNumber: field<string>(null, 0, 'unset'),
    ticketNumber: field<string>(null, 0, 'unset'),
    departureLocation: field<string>(null, 0, 'unset'),
    departureLocationCode: field<string>(null, 0, 'unset'),
    departureTerminal: field<string>(null, 0, 'unset'),
    departureGate: field<string>(null, 0, 'unset'),
    departureTime: field<string>(null, 0, 'unset'),
    arrivalLocation: field<string>(null, 0, 'unset'),
    arrivalLocationCode: field<string>(null, 0, 'unset'),
    arrivalTerminal: field<string>(null, 0, 'unset'),
    arrivalTime: field<string>(null, 0, 'unset'),
    seat: field<string>(null, 0, 'unset'),
    cabin: field<string>(null, 0, 'unset'),
    travelClass: field<string>(null, 0, 'unset'),
    currency: field<string>(null, 0, 'unset'),
    price: field<number>(null, 0, 'unset'),
    baggageInfo: field<string>(null, 0, 'unset'),
    notes: field<string>(null, 0, 'unset'),
    timezone: field<string>(null, 0, 'unset'),
  }
}

// Two-letter prefix (AA123, BW406, JM114...) — the overwhelmingly common
// format, safe to accept without dictionary confirmation.
const FLIGHT_NUMBER_STRICT_RE = /\b([A-Z]{2})\s?-?\s?(\d{2,4})\b/g
// Letter+digit or digit+letter prefixes (B6, 3M, 4O...) are real IATA codes
// for some carriers, but that shape also matches incidental things like gate
// numbers ("B12") — only accept these when the prefix is a KNOWN airline.
const FLIGHT_NUMBER_LOOSE_RE = /\b([A-Z][0-9]|[0-9][A-Z])\s?-?\s?(\d{1,4})\b/g
const AIRPORT_CODE_RE = /\b([A-Z]{3})\b/g
const CONFIRMATION_RE = /(?:booking reference|confirmation(?: number| code)?|record locator|pnr)[:\s#-]*\s*([A-Z0-9]{5,8})\b/gi
const TICKET_RE = /ticket(?:\s*number)?[:\s#-]*\s*([A-Z0-9-]{6,15})\b/gi
const SEAT_RE = /seat[:\s#-]*\s*(\d{1,3}[A-Z])\b/i
const GATE_RE = /gate[:\s#-]*\s*([A-Z0-9]{1,4})\b/gi
const TERMINAL_RE = /terminal[:\s#-]*\s*([A-Z0-9]{1,3})\b/gi
const CABIN_RE = /\b(economy|premium economy|business|first)\s*class\b|\bcabin[:\s]*(\w+)/i
const PRICE_RE = /(USD|EUR|GBP|JMD|CAD|\$|€|£)\s?([\d,]+\.\d{2})/
const CURRENCY_SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' }

const TRANSPORT_KEYWORDS: [RegExp, TransportTypeGuess][] = [
  [/\btrain\b|\brailway\b|\bamtrak\b/i, 'TRAIN'],
  [/\bbus\b|\bcoach\b|\bgreyhound\b/i, 'BUS'],
  [/\btaxi\b|\bcab\b|\brideshare\b|\buber\b|\blyft\b/i, 'TAXI'],
  [/\bferry\b/i, 'FERRY'],
  [/\bcruise\b/i, 'CRUISE'],
  [/\bboat\b|\bcharter\b/i, 'BOAT'],
  [/\bhelicopter\b/i, 'HELICOPTER'],
  [/\bbicycle\b|\bbike rental\b/i, 'BICYCLE'],
  [/\brental car\b|\bcar rental\b/i, 'RENTAL_CAR'],
  [/\bhotel\b|\bcheck-?in\b|\bresort\b/i, 'HOTEL'],
  [/\brestaurant\b|\breservation for dinner\b/i, 'RESTAURANT'],
  [/\bexcursion\b|\btour\b/i, 'EXCURSION'],
]

function guessTransportType(scope: string): { type: TransportTypeGuess; confidence: number } {
  for (const [re, type] of TRANSPORT_KEYWORDS) {
    if (re.test(scope)) return { type, confidence: 65 }
  }
  return { type: 'OTHER', confidence: 30 }
}

/** Finds flight-number-like tokens (airline prefix + digits), scored higher when the prefix is a known carrier. */
function findFlightAnchors(text: string): { identifier: string; provider: string | null; confidence: number; index: number }[] {
  const anchors: { identifier: string; provider: string | null; confidence: number; index: number }[] = []
  const seenIndexes = new Set<number>()

  for (const m of text.matchAll(FLIGHT_NUMBER_STRICT_RE)) {
    const prefix = m[1].toUpperCase()
    const digits = m[2]
    const airline = lookupAirline(prefix)
    const index = m.index ?? 0
    seenIndexes.add(index)
    anchors.push({ identifier: `${prefix}${digits}`, provider: airline, confidence: airline ? 95 : 60, index })
  }

  // Ambiguous letter+digit / digit+letter prefixes (B6, 3M...) only count as
  // a flight if the prefix is a carrier we actually recognize — otherwise
  // things like "Gate: B12" get misread as a second flight.
  for (const m of text.matchAll(FLIGHT_NUMBER_LOOSE_RE)) {
    const index = m.index ?? 0
    if (seenIndexes.has(index)) continue
    const prefix = m[1].toUpperCase()
    const digits = m[2]
    const airline = lookupAirline(prefix)
    if (!airline) continue
    anchors.push({ identifier: `${prefix}${digits}`, provider: airline, confidence: 95, index })
  }

  anchors.sort((a, b) => a.index - b.index)

  // The same flight is often mentioned more than once in one document (a
  // structured itinerary block, then a prose "day of travel" recap that
  // restates the flight number) — only the first mention should become a
  // segment, or the recap gets misread as a connecting/return flight.
  const seenIdentifiers = new Set<string>()
  return anchors.filter((a) => {
    if (seenIdentifiers.has(a.identifier)) return false
    seenIdentifiers.add(a.identifier)
    return true
  })
}

/** Finds up to two dictionary-known airport codes in a text window, in order of appearance. */
function findAirportCodesInScope(scope: string): { code: string; confidence: number; index: number }[] {
  const found: { code: string; confidence: number; index: number }[] = []
  const seen = new Set<number>()
  for (const m of scope.matchAll(AIRPORT_CODE_RE)) {
    const code = m[1]
    if (!lookupAirport(code)) continue
    const idx = m.index ?? 0
    if (seen.has(idx)) continue
    seen.add(idx)
    found.push({ code, confidence: 90, index: idx })
  }
  return found
}

function findPassengerNames(text: string): ExtractedField<string>[] {
  const results: ExtractedField<string>[] = []
  const seen = new Set<string>()

  // "LASTNAME/FIRSTNAME MR" style PNR format
  for (const m of text.matchAll(/\b([A-Z]{2,})\/([A-Z]{2,})(?:\s+(MR|MRS|MS|MISS|DR))?\b/g)) {
    const name = `${m[2]} ${m[1]}`
    const key = name.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    results.push(field(toTitleCase(name), 90, 'regex'))
  }

  // "Passenger: John Smith" / "Traveler Name: Jane Doe" style. Uses [ \t]
  // rather than \s between name words so the match can't run past a line
  // break onto unrelated text on the next line (e.g. "Passenger: John Smith\nFlight AA123").
  for (const m of text.matchAll(/(?:passenger|traveler|traveller|guest)s?(?:[ \t]*name)?[ \t]*[:\-][ \t]*([A-Za-z][A-Za-z'\-]+(?:[ \t]+[A-Za-z][A-Za-z'\-]+){1,3})/gi)) {
    const name = m[1].trim()
    const key = name.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    results.push(field(toTitleCase(name), 80, 'regex'))
  }

  return results
}

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

// These labels (ticket/confirmation/gate/terminal) are matched case-insensitively
// so "TICKET NUMBER" and "Ticket Number" both work, but that /i flag also makes
// the *value* capture group case-insensitive — which lets it match ordinary
// lowercase prose (e.g. "Electronic Ticket Passenger Itinerary" capturing
// "Passenger", or "Gates D30" capturing a stray "s"). Real codes are written
// in caps in these documents, so require the captured text to already be
// all-caps rather than trusting the match and calling .toUpperCase() on it.
function isAlreadyUpperCase(value: string): boolean {
  return value === value.toUpperCase()
}

/**
 * Returns the first regex match (across all occurrences of the label in the
 * text) whose captured value is already all-caps — skipping label mentions
 * that happened to capture ordinary lowercase prose instead of a real code,
 * rather than giving up as soon as the first occurrence turns out to be bogus.
 */
function firstValidUpperCaseMatch(text: string, re: RegExp): string | null {
  for (const m of text.matchAll(re)) {
    if (isAlreadyUpperCase(m[1])) return m[1]
  }
  return null
}

function findConfirmationNumber(text: string): ExtractedField<string> {
  const value = firstValidUpperCaseMatch(text, CONFIRMATION_RE)
  return value ? field(value, 88, 'regex') : field<string>(null, 0, 'unset')
}

function findTicketNumber(scope: string): ExtractedField<string> {
  const value = firstValidUpperCaseMatch(scope, TICKET_RE)
  return value ? field(value, 85, 'regex') : field<string>(null, 0, 'unset')
}

function findSeat(scope: string): ExtractedField<string> {
  const m = scope.match(SEAT_RE)
  return m ? field(m[1].toUpperCase(), 90, 'regex') : field<string>(null, 0, 'unset')
}

function findGate(scope: string): ExtractedField<string> {
  const value = firstValidUpperCaseMatch(scope, GATE_RE)
  return value ? field(value, 82, 'regex') : field<string>(null, 0, 'unset')
}

function findTerminal(scope: string): ExtractedField<string> {
  const value = firstValidUpperCaseMatch(scope, TERMINAL_RE)
  return value ? field(value, 82, 'regex') : field<string>(null, 0, 'unset')
}

function findCabin(scope: string): ExtractedField<string> {
  const m = scope.match(CABIN_RE)
  const value = m ? (m[1] || m[2]) : null
  return value ? field(toTitleCase(value), 75, 'regex') : field<string>(null, 0, 'unset')
}

function findPrice(scope: string): { price: ExtractedField<number>; currency: ExtractedField<string> } {
  const m = scope.match(PRICE_RE)
  if (!m) return { price: field<number>(null, 0, 'unset'), currency: field<string>(null, 0, 'unset') }
  const rawCurrency = m[1]
  const currency = CURRENCY_SYMBOLS[rawCurrency] ?? rawCurrency.toUpperCase()
  const amount = parseFloat(m[2].replace(/,/g, ''))
  return {
    price: field(amount, 85, 'regex'),
    currency: field(currency, 85, 'regex'),
  }
}

const SCOPE_RADIUS = 350

function sliceScope(text: string, index: number, nextIndex: number | null): string {
  const start = Math.max(0, index - SCOPE_RADIUS)
  const end = nextIndex !== null ? Math.min(text.length, nextIndex) : Math.min(text.length, index + SCOPE_RADIUS * 2)
  return text.slice(start, end)
}

// ---------------------------------------------------------------------------
// Dates and time zones
//
// An itinerary prints wall-clock times ("Departs 1:15 PM") in the local time
// of wherever that booking happens — never in UTC, and never in whatever
// zone the server parsing it happens to run in. chrono-node on its own reads
// an offset-less time in the runtime's zone (UTC on Vercel), which stored a
// 1:15 PM New York departure as 1:15 PM UTC — displayed as 9:15 AM New York
// time. So times are captured as wall-clock components first and only
// converted to an instant once the booking's zone is known (a flight's
// airports, or the zone the traveller is in at that point in the trip).
// ---------------------------------------------------------------------------

interface WallClock {
  /** chrono's own reading — only trusted as-is when the text carried an explicit offset/zone. */
  date: Date
  ymd: string // YYYY-MM-DD
  hm: string // HH:MM
  hasTime: boolean
  explicitZone: boolean
}

function toWallClock(r: chrono.ParsedResult): WallClock {
  const c = r.start
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: c.date(),
    ymd: `${c.get('year')}-${pad(c.get('month') ?? 1)}-${pad(c.get('day') ?? 1)}`,
    hm: `${pad(c.get('hour') ?? 0)}:${pad(c.get('minute') ?? 0)}`,
    hasTime: c.isCertain('hour'),
    explicitZone: c.isCertain('timezoneOffset'),
  }
}

function parseWallClocks(text: string, referenceDate: Date): WallClock[] {
  return chrono.parse(text, referenceDate, { forwardDate: true }).map(toWallClock)
}

function wallClockToIso(wc: WallClock, timeZone: string | null): string {
  if (wc.explicitZone || !timeZone) return wc.date.toISOString()
  return zonedDateTimeToUtc(wc.ymd, wc.hm, timeZone).toISOString()
}

/** Pending segment: fields filled, but times still wall-clock until zones are resolved across the whole trip. */
interface PendingSegment {
  seg: ExtractedSegment
  dep: WallClock | null
  arr: WallClock | null
  /** Zone known from the booking itself (e.g. an airport) — null means "wherever the traveller is at this point". */
  depZone: string | null
  arrZone: string | null
}

// ---------------------------------------------------------------------------
// Booking sections
//
// A real itinerary bundles several bookings — a flight, then a hotel, a
// dinner reservation, a train — each under its own heading. Previously any
// flight number anywhere in the document made the parser ignore everything
// else, so a combined itinerary came back as flights only. Sections are now
// found by their headings and each is read on its own, so a booking's
// details (and its own contact email) never bleed into its neighbour's.
// ---------------------------------------------------------------------------

const SECTION_KEYWORDS: [RegExp, TransportTypeGuess][] = [
  [/^(flights?|air(?:line)?|airfare)$/i, 'FLIGHT'],
  [/^(hotel|accommodations?|lodging|stay)$/i, 'HOTEL'],
  [/^(restaurant|dining|dinner|lunch|brunch|breakfast)$/i, 'RESTAURANT'],
  [/^(boat|yacht|charter|sailing|sail)$/i, 'BOAT'],
  [/^(cruise)$/i, 'CRUISE'],
  [/^(ferry)$/i, 'FERRY'],
  [/^(train|rail|railway|amtrak)$/i, 'TRAIN'],
  [/^(bus|coach)$/i, 'BUS'],
  [/^(taxi|transfer|rideshare)$/i, 'TAXI'],
  [/^(car rental|rental car)$/i, 'RENTAL_CAR'],
  [/^(excursion|tour|activity)$/i, 'EXCURSION'],
  [/^(helicopter)$/i, 'HELICOPTER'],
]

const LABEL_LINE_RE = /^[A-Za-z][A-Za-z &/'().#-]{0,40}?\s*:\s+/
const HEADING_RE = /^[^A-Za-z0-9]*(?:\d+[.)]\s*)?(car rental|rental car|[A-Za-z]+)\b(?!\s*:)/

/** Returns the booking type a heading line introduces, or null when the line isn't a section heading. */
function headingType(line: string): TransportTypeGuess | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 90) return null
  // "Train number: 175" is a detail line inside a section, not a heading.
  if (LABEL_LINE_RE.test(trimmed)) return null
  const m = HEADING_RE.exec(trimmed)
  if (!m) return null
  for (const [re, type] of SECTION_KEYWORDS) {
    if (re.test(m[1])) return type
  }
  return null
}

interface Section {
  type: TransportTypeGuess | null
  heading: string
  lines: string[]
}

function splitSections(text: string): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = []
  const sections: Section[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const type = headingType(line)
    const last = sections[sections.length - 1]
    if (type && last && last.lines.length === 1) {
      // Two headings back to back ("FLIGHT — Delta Air Lines" then
      // "Flight DL 1234") introduce one booking, not two.
      last.lines.push(line)
      last.type = last.type ?? type
    } else if (type) {
      sections.push({ type, heading: line, lines: [line] })
    } else if (sections.length > 0) {
      sections[sections.length - 1].lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  return { preamble, sections }
}

/** "Label: value" lines, keyed by lowercased label. First occurrence wins. */
function readLabels(lines: string[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const line of lines) {
    const m = /^([A-Za-z][A-Za-z &/'().#-]{0,40}?)\s*:\s+(.+)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase().replace(/\s+/g, ' ').trim()
    if (!labels.has(key)) labels.set(key, m[2].trim())
  }
  return labels
}

function firstLabel(labels: Map<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = labels.get(k)
    if (v) return v
  }
  return null
}

const PROVIDER_LABELS = ['operator', 'provider', 'vendor', 'property', 'hotel', 'restaurant', 'carrier', 'company', 'charter company', 'charter operator', 'venue', 'name']
const TRAIN_IDENTIFIER_LABELS = ['service', 'route', 'train']
const BOAT_IDENTIFIER_LABELS = ['vessel', 'boat', 'yacht']
const DEP_LOCATION_LABELS = ['address', 'location', 'meeting point', 'from', 'origin', 'departs from', 'departure station', 'pickup location', 'pick-up location', 'marina', 'dock']
const ARR_LOCATION_LABELS = ['to', 'destination', 'arrives at', 'arrival station', 'drop-off location']
const DEP_TIME_LABELS = ['check-in', 'check in', 'reservation', 'reservation time', 'date & time', 'date/time', 'departs', 'departure', 'departure time', 'boarding', 'pickup time', 'pick-up time', 'start', 'start time']
const ARR_TIME_LABELS = ['check-out', 'check out', 'arrives', 'arrival', 'arrival time', 'returns', 'return', 'end', 'end time', 'drop-off time']
const SEAT_LABELS = ['seat', 'seats']
const CLASS_LABELS = ['class', 'cabin', 'fare class', 'room type']
// Lines kept verbatim as the segment's notes — most importantly the
// booking's own contact line, which lib/agents/contact.ts reads before
// falling back to the whole document (so each provider is contacted at its
// own address, not whichever email happens to appear first in the PDF).
const NOTE_LABELS = ['reservations', 'contact', 'email', 'phone', 'notes', 'party size', 'guests', 'train number', 'car', 'coach', 'duration', 'special requests', 'cancellation policy']

/** Splits "New York Penn Station (NYP)" into its name and a 3-letter code. */
function splitLocation(value: string): { name: string; code: string | null } {
  const m = /^(.*?)\s*\(([A-Z]{3})\)\s*$/.exec(value)
  return m ? { name: m[1].trim(), code: m[2] } : { name: value.trim(), code: null }
}

function parseLabeledTime(value: string | null, dateFallback: string | null, referenceDate: Date): WallClock | null {
  if (!value) return null
  const direct = parseWallClocks(value, referenceDate)[0]
  if (direct && (direct.date.getFullYear() > 1970) && /\d{4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(value)) return direct
  if (dateFallback) {
    const combined = parseWallClocks(`${dateFallback} ${value}`, referenceDate)[0]
    if (combined) return combined
  }
  return direct ?? null
}

function readNonFlightSection(section: Section, type: TransportTypeGuess, referenceDate: Date): PendingSegment {
  const seg = emptySegment(type, 90)
  const body = section.lines.join('\n')
  const labels = readLabels(section.lines.slice(1))

  let provider = firstLabel(labels, PROVIDER_LABELS)
  if (!provider) {
    // "HOTEL — The Beekman" style headings carry the name after a dash.
    const m = /[—–-]\s+(.+)$/.exec(section.heading)
    if (m) provider = m[1].trim()
  }
  if (!provider && type === 'TRAIN' && /\bamtrak\b/i.test(body)) provider = 'Amtrak'
  if (provider) seg.provider = field(provider, 85, 'regex')

  const identifier =
    type === 'TRAIN' ? firstLabel(labels, TRAIN_IDENTIFIER_LABELS)
    : type === 'BOAT' || type === 'FERRY' || type === 'CRUISE' ? firstLabel(labels, BOAT_IDENTIFIER_LABELS)
    : null
  if (identifier) seg.identifier = field(identifier, 85, 'regex')

  const confirmation = findConfirmationNumber(body)
  if (confirmation.value) seg.confirmationNumber = confirmation

  const depLoc = firstLabel(labels, DEP_LOCATION_LABELS)
  if (depLoc) {
    const { name, code } = splitLocation(depLoc)
    seg.departureLocation = field(name, 85, 'regex')
    if (code) seg.departureLocationCode = field(code, 85, 'regex')
  }
  const arrLoc = firstLabel(labels, ARR_LOCATION_LABELS)
  if (arrLoc) {
    const { name, code } = splitLocation(arrLoc)
    seg.arrivalLocation = field(name, 85, 'regex')
    if (code) seg.arrivalLocationCode = field(code, 85, 'regex')
  }

  const dateLabel = labels.get('date') ?? null
  let dep = parseLabeledTime(firstLabel(labels, DEP_TIME_LABELS) ?? labels.get('time') ?? null, dateLabel, referenceDate)
  const arr = parseLabeledTime(firstLabel(labels, ARR_TIME_LABELS), dateLabel, referenceDate)
  if (!dep && labels.size === 0) {
    // Unlabeled prose ("Hotel reservation at X, check-in Dec 20") — best effort.
    dep = parseWallClocks(body, referenceDate)[0] ?? null
  }

  const seat = firstLabel(labels, SEAT_LABELS)
  if (seat) seg.seat = field(seat, 85, 'regex')
  const cls = firstLabel(labels, CLASS_LABELS)
  if (cls) {
    seg.cabin = field(cls, 80, 'regex')
    seg.travelClass = seg.cabin
  }

  const { price, currency } = findPrice(body)
  seg.price = price
  seg.currency = currency

  const noteLines = section.lines.slice(1).filter((line) => {
    const key = /^([A-Za-z][A-Za-z &/'().#-]{0,40}?)\s*:\s+/.exec(line)?.[1].toLowerCase().trim()
    return (key && NOTE_LABELS.includes(key)) || /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(line)
  })
  if (noteLines.length) seg.notes = field(noteLines.join('\n'), 85, 'regex')

  const explicitZone = labels.get('time zone') ?? labels.get('timezone') ?? null
  const zone = explicitZone && /^[A-Za-z_]+\/[A-Za-z_]+$/.test(explicitZone) ? explicitZone : null

  return { seg, dep, arr, depZone: zone, arrZone: zone }
}

/** Flight segments from one region of text (a flight section, or a heading-less document). */
function readFlights(scopeText: string, referenceDate: Date, docConfirmation: ExtractedField<string>): PendingSegment[] {
  const anchors = findFlightAnchors(scopeText)
  return anchors.map((anchor, i) => {
    const nextIndex = i + 1 < anchors.length ? anchors[i + 1].index : null
    const scope = sliceScope(scopeText, anchor.index, nextIndex)

    const seg = emptySegment('FLIGHT', 95)
    seg.identifier = field(anchor.identifier, anchor.confidence, 'regex')
    seg.provider = anchor.provider ? field(anchor.provider, anchor.confidence, 'dictionary') : field<string>(null, 0, 'unset')
    const localConfirmation = findConfirmationNumber(scope)
    seg.confirmationNumber = localConfirmation.value ? localConfirmation : docConfirmation

    // Airports are searched from the flight number onward — a preceding
    // section's codes must not be mistaken for this flight's route.
    const forward = scopeText.slice(anchor.index, nextIndex ?? Math.min(scopeText.length, anchor.index + SCOPE_RADIUS * 2))
    const airports = findAirportCodesInScope(forward).length >= 2 ? findAirportCodesInScope(forward) : findAirportCodesInScope(scope)
    let depZone: string | null = null
    let arrZone: string | null = null
    if (airports[0]) {
      seg.departureLocationCode = field(airports[0].code, airports[0].confidence, 'dictionary')
      const info = lookupAirport(airports[0].code)
      if (info) {
        seg.departureLocation = field(`${info.city} (${info.name})`, airports[0].confidence, 'dictionary')
        depZone = info.timezone
      }
    }
    if (airports[1]) {
      seg.arrivalLocationCode = field(airports[1].code, airports[1].confidence, 'dictionary')
      const info = lookupAirport(airports[1].code)
      if (info) {
        seg.arrivalLocation = field(`${info.city} (${info.name})`, airports[1].confidence, 'dictionary')
        arrZone = info.timezone
      }
    }

    // Dates found *before* the flight mention are usually document metadata
    // (booking date, issue date) rather than travel dates — search forward only.
    const times = parseWallClocks(forward, referenceDate)

    seg.ticketNumber = findTicketNumber(scope)
    seg.seat = findSeat(scope)
    seg.cabin = findCabin(scope)
    seg.travelClass = seg.cabin
    seg.departureGate = findGate(scope)
    seg.departureTerminal = findTerminal(scope)
    const { price, currency } = findPrice(scope)
    seg.price = price
    seg.currency = currency

    return { seg, dep: times[0] ?? null, arr: times[1] ?? null, depZone, arrZone: arrZone ?? depZone }
  })
}

/** Converts every pending segment's wall-clock times to instants, carrying the traveller's current zone forward through the trip. */
function resolveTimes(pending: PendingSegment[]): ExtractedSegment[] {
  const firstKnown = pending.map((p) => p.depZone ?? p.arrZone).find((z): z is string => Boolean(z)) ?? null
  let current: string | null = firstKnown
  return pending.map((p) => {
    const depZone = p.depZone ?? current
    const arrZone = p.arrZone ?? depZone
    const confOf = (wc: WallClock) => (wc.hasTime ? 85 : 55)
    if (p.dep) p.seg.departureTime = field(wallClockToIso(p.dep, depZone), confOf(p.dep), 'nlp-date')
    if (p.arr) p.seg.arrivalTime = field(wallClockToIso(p.arr, arrZone), confOf(p.arr), 'nlp-date')
    if (depZone) p.seg.timezone = field(depZone, p.depZone ? 90 : 80, p.depZone ? 'dictionary' : 'heuristic')
    current = arrZone ?? current
    return p.seg
  })
}

export function parseItinerary(rawText: string, referenceDate: Date = new Date()): ExtractedItinerary {
  const text = rawText.replace(/\r/g, '')
  const passengerNames = findPassengerNames(text)
  const confirmationNumber = findConfirmationNumber(text)
  const { preamble, sections } = splitSections(text)

  const pending: PendingSegment[] = []

  if (sections.length > 0) {
    const preambleText = preamble.join('\n')
    pending.push(...readFlights(preambleText, referenceDate, confirmationNumber))
    for (const section of sections) {
      const sectionText = section.lines.join('\n')
      // A section whose heading says "flight" — or any section carrying a
      // known carrier's flight number when the heading is ambiguous — is
      // read as flights; everything else as a single booking of its type.
      if (section.type === 'FLIGHT') {
        const flights = readFlights(sectionText, referenceDate, confirmationNumber)
        if (flights.length > 0) {
          pending.push(...flights)
          continue
        }
      }
      pending.push(readNonFlightSection(section, section.type ?? guessTransportType(sectionText).type, referenceDate))
    }
  } else {
    const flights = readFlights(text, referenceDate, confirmationNumber)
    if (flights.length > 0) {
      pending.push(...flights)
    } else {
      // No headings and no flight numbers — treat the whole document as a single, less-structured segment.
      const { type, confidence } = guessTransportType(text)
      const seg = emptySegment(type, confidence)
      seg.confirmationNumber = confirmationNumber
      let depZone: string | null = null
      const airports = findAirportCodesInScope(text)
      if (airports[0]) {
        seg.departureLocationCode = field(airports[0].code, airports[0].confidence, 'dictionary')
        const info = lookupAirport(airports[0].code)
        if (info) {
          seg.departureLocation = field(`${info.city} (${info.name})`, airports[0].confidence, 'dictionary')
          depZone = info.timezone
        }
      }
      if (airports[1]) {
        seg.arrivalLocationCode = field(airports[1].code, airports[1].confidence, 'dictionary')
        const info = lookupAirport(airports[1].code)
        if (info) seg.arrivalLocation = field(`${info.city} (${info.name})`, airports[1].confidence, 'dictionary')
      }
      const times = parseWallClocks(text, referenceDate)
      const { price, currency } = findPrice(text)
      seg.price = price
      seg.currency = currency
      pending.push({ seg, dep: times[0] ?? null, arr: times[1] ?? null, depZone, arrZone: depZone })
    }
  }

  let segments = resolveTimes(pending)

  // Chronological order, so the trip's timeline (and the dependency engine,
  // which walks segments in order) reflects when things actually happen
  // rather than the order the PDF happened to list them in.
  if (segments.every((s) => s.departureTime.value)) {
    segments = [...segments].sort((a, b) => Date.parse(a.departureTime.value!) - Date.parse(b.departureTime.value!))
  }

  const allFields = [
    ...passengerNames,
    confirmationNumber,
    ...segments.flatMap((s) => Object.values(s) as ExtractedField<unknown>[]),
  ]
  const known = allFields.filter((f) => f.value !== null)
  const overallConfidence = known.length
    ? Math.round(known.reduce((sum, f) => sum + f.confidence, 0) / known.length)
    : 0

  return { passengerNames, segments, rawText: text, overallConfidence }
}
