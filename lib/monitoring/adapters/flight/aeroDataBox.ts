import type { MonitorableSegment, MonitoringCheckResult, MonitoringCheckStatus } from '../../types'
import type { FlightProviderAdapter } from './types'

const ENV_VAR = 'AERODATABOX_API_KEY'

// AeroDataBox is distributed through RapidAPI — the key is a RapidAPI key,
// not an AeroDataBox-issued one, and every request needs the host header
// below alongside it.
const HOST = 'aerodatabox.p.rapidapi.com'
const BASE_URL = `https://${HOST}/flights/number`

export function mapStatus(status: string | undefined): MonitoringCheckStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'expected':
      return 'ON_TIME'
    case 'enroute':
    case 'departed':
      return 'DEPARTED'
    case 'landed':
    case 'arrived':
      return 'ARRIVED'
    case 'cancelled':
    case 'cancelleduncertain':
      return 'CANCELLED'
    case 'delayed':
    case 'diverted':
      return 'DELAYED'
    default:
      return 'UNKNOWN'
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function utcDateOf(timePoint: any): string | undefined {
  const utc: string | undefined = timePoint?.utc
  if (!utc) return undefined
  // AeroDataBox returns e.g. "2026-08-07 22:10Z" — space instead of "T".
  return new Date(utc.replace(' ', 'T')).toISOString().slice(0, 10)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function minutesBetween(a: any, b: any): number | undefined {
  const aUtc: string | undefined = a?.utc
  const bUtc: string | undefined = b?.utc
  if (!aUtc || !bUtc) return undefined
  const diffMs = new Date(bUtc.replace(' ', 'T')).getTime() - new Date(aUtc.replace(' ', 'T')).getTime()
  return Math.round(diffMs / 60000)
}

export const aeroDataBoxAdapter: FlightProviderAdapter = {
  id: 'aerodatabox-flight-v1',
  supports: ['FLIGHT'],
  // RapidAPI's free "Basic" plan: 600 API units/month, 1 request/second.
  // flights/number costs 2 units/call — confirmed live via the
  // X-RateLimit-API-Units-Remaining response header (Aug 2026), not just
  // read off the pricing page.
  monthlyQuota: 600,
  unitsPerCall: 2,
  isConfigured() {
    return Boolean(process.env[ENV_VAR])
  },
  buildTrackingKey(segment: MonitorableSegment) {
    if (!segment.identifier || !segment.departureTime) return null
    return `${segment.identifier}:${segment.departureTime.toISOString().slice(0, 10)}`
  },
  async check(segment: MonitorableSegment): Promise<MonitoringCheckResult> {
    const apiKey = process.env[ENV_VAR]
    if (!apiKey) {
      return {
        status: 'UNKNOWN',
        message: `aerodatabox-flight-v1 is not connected yet — set ${ENV_VAR} to enable it as a fallback provider.`,
        checkedAt: new Date(),
      }
    }

    const flightNumber = segment.identifier?.replace(/\s+/g, '')
    if (!flightNumber || !segment.departureTime) {
      return { status: 'UNKNOWN', message: 'Segment is missing a flight number or departure date', checkedAt: new Date() }
    }

    const date = segment.departureTime.toISOString().slice(0, 10)
    const res = await fetch(`${BASE_URL}/${flightNumber}/${date}`, {
      headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': HOST },
    })

    // RapidAPI attaches this to every proxied response, success or not —
    // grab it whenever it's there so usage tracking can use the provider's
    // real reset time instead of a calendar-month guess.
    const resetHeader = res.headers.get('X-RateLimit-API-Units-Reset')
    const quotaResetSeconds = resetHeader ? Number(resetHeader) : undefined

    if (!res.ok) {
      return { status: 'UNKNOWN', message: `AeroDataBox request failed (${res.status})`, checkedAt: new Date(), quotaResetSeconds }
    }

    // AeroDataBox responds 204 with an empty body when it has no record of
    // this flight number at all (e.g. it only indexes the operating
    // carrier's number, not every codeshare designator) — a valid "nothing
    // here" answer, not a parse error.
    if (res.status === 204) {
      return { status: 'UNKNOWN', message: 'No flight found for this exact date', checkedAt: new Date(), quotaResetSeconds, noMatch: true }
    }

    const body = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates: any[] = Array.isArray(body) ? body : []
    // A flight number recurs daily, so the endpoint returns every
    // occurrence near the requested date (e.g. one still landing from the
    // day before, one departing today) — only trust a result whose
    // departure date exactly matches this trip. Falling back to an
    // arbitrary candidate risks reporting a different day's status (e.g. a
    // genuinely cancelled prior occurrence) for this trip.
    const flight = candidates.find((f) => utcDateOf(f.departure?.scheduledTime) === date)
    if (!flight) {
      return { status: 'UNKNOWN', message: 'No flight found for this exact date', checkedAt: new Date(), raw: body, quotaResetSeconds, noMatch: true }
    }

    const delayMinutes =
      minutesBetween(flight.departure?.scheduledTime, flight.departure?.revisedTime) ??
      minutesBetween(flight.arrival?.scheduledTime, flight.arrival?.revisedTime ?? flight.arrival?.predictedTime)

    const mapped = mapStatus(flight.status)
    return {
      // "Expected" only means the flight hasn't departed yet — AeroDataBox
      // keeps using it for a flight whose revised departure is hours late.
      // A positive delay on a not-yet-departed flight is a delay.
      status: mapped === 'ON_TIME' && delayMinutes && delayMinutes > 0 ? 'DELAYED' : mapped,
      delayMinutes: delayMinutes && delayMinutes > 0 ? delayMinutes : undefined,
      gate: flight.departure?.gate ?? undefined,
      terminal: flight.departure?.terminal ?? undefined,
      message: flight.status ? `AeroDataBox: ${flight.status}` : undefined,
      raw: flight,
      checkedAt: new Date(),
      quotaResetSeconds,
    }
  },
}
