// Shared time/timezone/duration formatting — the single place every
// passenger-facing (and provider-facing) surface should get a segment's
// time from. Plain functions only, no server-only imports, since both
// client components (SegmentCard.tsx) and server code (email.ts,
// orchestrator.ts) need this.
//
// Two real bugs (found via live end-to-end testing 2026-08-12) motivate
// this file rather than each call site formatting its own way:
// 1. Almost every display site formatted with no `timeZone` option at all,
//    silently defaulting to the server/browser's own zone instead of the
//    segment's — a real segment stored as 11:55 PM EDT displayed as 10:55 PM.
// 2. Raw minutes ("delayed 150m") and technical zone abbreviations (EDT/
//    EST/UTC) require mental math or lookup an infrequent flyer shouldn't
//    have to do.
import type { AIRPORTS } from './data/airports'
import { lookupAirport } from './data/airports'

interface LocatableSegment {
  departureLocationCode: string | null
  arrivalLocationCode: string | null
  timezone: string | null
}

/**
 * Plain-language zone label derived from the IANA identifier itself (e.g.
 * "America/New_York" -> "New York time") — no separate name table needed,
 * IANA zone names are already "Continent/City". Falls back to "local time"
 * (not "UTC", itself a jargon term) when the zone is unknown.
 */
export function friendlyZoneLabel(timezone: string | null): string {
  if (!timezone) return 'local time'
  const city = timezone.split('/').pop()
  if (!city) return 'local time'
  return `${city.replace(/_/g, ' ')} time`
}

/**
 * Renders a time in the given zone using a plain-language zone name instead
 * of a technical abbreviation (EDT/EST/GMT) — someone who doesn't fly often
 * shouldn't have to know what those mean. Falls back to UTC internally when
 * no zone is known (Intl still needs *a* zone), but the label always reads
 * "local time" rather than surfacing "UTC" as if it were meaningful to the
 * reader.
 */
export function formatFriendlyTime(date: Date, timezone: string | null): string {
  const time = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone || 'UTC',
  }).format(date)
  return `${time}, ${friendlyZoneLabel(timezone)}`
}

/** e.g. 101 -> "1 hour 41 minutes" — used anywhere a delay/duration is shown to a person, so nobody has to do the math on a raw minute count themselves. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) return `${mins} minutes`
  if (mins === 0) return `${hours} hour${hours === 1 ? '' : 's'}`
  return `${hours} hour${hours === 1 ? '' : 's'} ${mins} minutes`
}

type Airport = (typeof AIRPORTS)[string]

/**
 * Resolves the real departure/arrival IANA zones for a route-based segment,
 * preferring each end's own airport code lookup over the segment's single
 * manually-entered `timezone` field — a flight's two endpoints can genuinely
 * be in different zones (confirmed live: Kingston->Miami, Jamaica time vs
 * New York time), so a single field can't correctly represent both.
 *
 * The arrival side falls back to null — never silently reused from
 * departure — when it can't be resolved from a known airport code. Showing
 * no arrival-local-time figure is honest; assuming arrival shares
 * departure's zone would silently reintroduce the same class of bug this
 * file exists to fix.
 *
 * The exception is a segment with no arrival code at all (a hotel's
 * check-out, a train or boat between named places): there is no second
 * endpoint to look up, and the segment's own `timezone` — set when the
 * itinerary was extracted, or entered by hand — is the zone its times were
 * written in. Falling back to null there rendered the time in UTC.
 */
export function resolveSegmentZones(segment: LocatableSegment): { departure: string | null; arrival: string | null } {
  const departureAirport: Airport | null = segment.departureLocationCode ? lookupAirport(segment.departureLocationCode) : null
  const arrivalAirport: Airport | null = segment.arrivalLocationCode ? lookupAirport(segment.arrivalLocationCode) : null

  return {
    departure: departureAirport?.timezone ?? segment.timezone ?? null,
    arrival: arrivalAirport?.timezone ?? (segment.arrivalLocationCode ? null : segment.timezone) ?? null,
  }
}

/** Offset (in minutes, UTC minus zone) `timeZone` was at when `instant` occurred — e.g. 300 for America/New_York (EST). */
function timezoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return (asUTC - instant.getTime()) / 60_000
}

/**
 * Parses a `<input type="date">` + `<input type="time">` pair as wall-clock
 * time *in `timeZone`* (rather than the browser/server's own zone, which is
 * what plain `new Date(dateStr + 'T' + timeStr)` silently does) — the actual
 * UTC instant returned is correct regardless of what zone this code happens
 * to run in. Falls back to the runtime's own zone when `timeZone` is null
 * (e.g. neither manually entered nor auto-detected).
 *
 * Two-pass DST correction: the zone's UTC offset can differ right around a
 * DST transition depending on which instant you ask it for, so the first
 * pass's offset (computed as if the input were already UTC) is used to get
 * close, then re-queried at that corrected instant for the real answer —
 * same approach date-fns-tz/luxon use internally.
 */
export function zonedDateTimeToUtc(dateStr: string, timeStr: string, timeZone: string | null): Date {
  const naiveUTC = new Date(`${dateStr}T${timeStr}:00Z`)
  if (!timeZone) return naiveUTC
  const offset1 = timezoneOffsetMinutes(naiveUTC, timeZone)
  const guess = new Date(naiveUTC.getTime() - offset1 * 60_000)
  const offset2 = timezoneOffsetMinutes(guess, timeZone)
  return new Date(naiveUTC.getTime() - offset2 * 60_000)
}

export type ArrivalHourClass = 'LATE_NIGHT' | 'EARLY_MORNING' | 'NORMAL'

/**
 * Buckets an arrival by how inconvenient its *local* hour is — a 2am
 * landing is a materially different experience than a 2pm one, worth
 * flagging visually rather than burying in a plain timestamp.
 */
export function classifyArrivalHour(date: Date, timezone: string): ArrivalHourClass {
  // en-US + hour12:false uses an h24 cycle, which renders midnight as "24"
  // rather than "0" in Node's ICU — normalize it back so the 0-5 bucket
  // check below actually catches midnight.
  const raw = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(date)
  )
  const hour = raw === 24 ? 0 : raw
  if (hour >= 0 && hour < 6) return 'LATE_NIGHT'
  if ((hour >= 6 && hour < 8) || hour >= 21) return 'EARLY_MORNING'
  return 'NORMAL'
}
