import type { MonitorableSegment, MonitoringCheckResult, MonitoringCheckStatus } from '../../types'
import type { FlightProviderAdapter } from './types'

const ENV_VAR = 'FLIGHT_MONITORING_API_KEY'

// AviationStack's free tier only serves over plain HTTP, not HTTPS — switch
// to https:// if the connected key is on a paid plan.
const AVIATIONSTACK_URL = 'http://api.aviationstack.com/v1/flights'

function buildTrackingKey(segment: MonitorableSegment): string | null {
  if (!segment.identifier || !segment.departureTime) return null
  return `${segment.identifier}:${segment.departureTime.toISOString().slice(0, 10)}`
}

// AviationStack's free tier reports a flight as "active" for much of its
// scheduled day — including while it's still sitting at the gate, delayed
// (confirmed live 2026-09-23: AA1578 BOS-LAX was "active" with departure
// actual/actual_runway null and no live position, an hour before it pushed
// back). So "active" only counts as DEPARTED when the flight has actually
// left — an actual departure/takeoff time or a live position; otherwise it's
// read the same as "scheduled".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapStatus(flightStatus: string | undefined, delayMinutes: number | undefined, flight?: any): MonitoringCheckStatus {
  const hasLeft = Boolean(flight?.departure?.actual || flight?.departure?.actual_runway || flight?.live)
  switch (flightStatus) {
    case 'scheduled':
      return delayMinutes && delayMinutes > 0 ? 'DELAYED' : 'ON_TIME'
    case 'active':
      if (!flight || hasLeft) return 'DEPARTED'
      return delayMinutes && delayMinutes > 0 ? 'DELAYED' : 'ON_TIME'
    case 'landed':
      return 'ARRIVED'
    case 'cancelled':
      return 'CANCELLED'
    default:
      return 'UNKNOWN'
  }
}

export const aviationStackAdapter: FlightProviderAdapter = {
  id: 'aviationstack-flight-v1',
  supports: ['FLIGHT'],
  // Free plan: 100 requests/month total, 1 request = 1 unit. Confirmed at
  // https://aviationstack.com/pricing (Aug 2026).
  monthlyQuota: 100,
  unitsPerCall: 1,
  isConfigured() {
    return Boolean(process.env[ENV_VAR])
  },
  buildTrackingKey,
  async check(segment: MonitorableSegment): Promise<MonitoringCheckResult> {
    const apiKey = process.env[ENV_VAR]
    if (!apiKey) {
      return {
        status: 'UNKNOWN',
        message: `aviationstack-flight-v1 is not connected yet — set ${ENV_VAR} to enable live checks.`,
        checkedAt: new Date(),
      }
    }

    const flightIata = segment.identifier?.replace(/\s+/g, '')
    if (!flightIata || !segment.departureTime) {
      return { status: 'UNKNOWN', message: 'Segment is missing a flight number or departure date', checkedAt: new Date() }
    }

    // The free AviationStack plan rejects `flight_date` on this endpoint
    // with a 403 "function_access_restricted" — historical/specific-date
    // lookup is a paid-plan feature. Query by flight_iata alone (which the
    // free plan supports) and pick the result matching our departure date
    // client-side, since a flight number can recur daily.
    const params = new URLSearchParams({ access_key: apiKey, flight_iata: flightIata })

    const res = await fetch(`${AVIATIONSTACK_URL}?${params}`)
    if (!res.ok) {
      return { status: 'UNKNOWN', message: `AviationStack request failed (${res.status})`, checkedAt: new Date() }
    }

    const body = await res.json()
    if (body.error) {
      return { status: 'UNKNOWN', message: `AviationStack error: ${body.error.message ?? body.error.code}`, checkedAt: new Date(), raw: body }
    }

    const targetDate = segment.departureTime.toISOString().slice(0, 10)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates: any[] = body.data ?? []
    // A flight number recurs daily, so only trust a result whose
    // flight_date exactly matches our trip — falling back to an arbitrary
    // candidate risks reporting a different day's status (e.g. a genuinely
    // cancelled prior occurrence) for this trip.
    const flight = candidates.find((f) => f.flight_date === targetDate)
    if (!flight) {
      // A codeshare's marketing number (e.g. Etihad's "EY2828") may not be
      // what other providers index — they often only carry the operating
      // carrier's own number (e.g. ITA Airways' "AZ615"). AviationStack
      // exposes that mapping even on a non-matching-date candidate, so pass
      // it along for the rotator to retry the next provider with.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const operatingIdentifier: string | undefined = candidates
        .map((f) => f.flight?.codeshared?.flight_iata as string | undefined)
        .find((iata): iata is string => Boolean(iata))
        ?.toUpperCase()

      return {
        status: 'UNKNOWN',
        message: 'No flight found for this exact date',
        checkedAt: new Date(),
        raw: body,
        noMatch: true,
        operatingIdentifier,
      }
    }

    const delayMinutes: number | undefined = flight.departure?.delay ?? flight.arrival?.delay ?? undefined

    return {
      status: mapStatus(flight.flight_status, delayMinutes, flight),
      delayMinutes,
      gate: flight.departure?.gate ?? undefined,
      terminal: flight.departure?.terminal ?? undefined,
      message: flight.flight_status ? `AviationStack: ${flight.flight_status}` : undefined,
      raw: flight,
      checkedAt: new Date(),
    }
  },
}
