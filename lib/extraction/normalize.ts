import type { ExtractedItinerary, ExtractedSegment } from './types'
import { CONFIDENCE_REVIEW_THRESHOLD } from './types'

/**
 * The single canonical shape every itinerary — regardless of source airline,
 * hotel platform, or transport type — is normalized into before it reaches
 * the database. Nothing downstream (editor, timeline, monitoring) should
 * ever need to know which provider or document format a segment came from.
 */
export interface NormalizedSegment {
  transportType: string
  status: 'SCHEDULED'
  provider: string | null
  identifier: string | null
  confirmationNumber: string | null
  ticketNumber: string | null
  departureLocation: string | null
  departureLocationCode: string | null
  departureTerminal: string | null
  departureGate: string | null
  departureTime: string | null
  arrivalLocation: string | null
  arrivalLocationCode: string | null
  arrivalTerminal: string | null
  arrivalTime: string | null
  seat: string | null
  cabin: string | null
  travelClass: string | null
  currency: string | null
  price: number | null
  baggageInfo: string | null
  notes: string | null
  timezone: string | null
  /** fieldName -> confidence (0-100), only for fields that were auto-extracted */
  confidenceScores: Record<string, number>
  /** field names below CONFIDENCE_REVIEW_THRESHOLD, surfaced for the user to confirm */
  fieldsNeedingReview: string[]
}

export interface NormalizedItinerary {
  passengerNames: string[]
  segments: NormalizedSegment[]
  overallConfidence: number
}

function normalizeSegment(seg: ExtractedSegment): NormalizedSegment {
  const confidenceScores: Record<string, number> = {}
  const fieldsNeedingReview: string[] = []

  const pick = <T,>(name: string, f: { value: T | null; confidence: number }): T | null => {
    if (f.value !== null) {
      confidenceScores[name] = f.confidence
      if (f.confidence < CONFIDENCE_REVIEW_THRESHOLD) fieldsNeedingReview.push(name)
    }
    return f.value
  }

  return {
    transportType: pick('transportType', seg.transportType) ?? 'OTHER',
    status: 'SCHEDULED',
    provider: pick('provider', seg.provider),
    identifier: pick('identifier', seg.identifier),
    confirmationNumber: pick('confirmationNumber', seg.confirmationNumber),
    ticketNumber: pick('ticketNumber', seg.ticketNumber),
    departureLocation: pick('departureLocation', seg.departureLocation),
    departureLocationCode: pick('departureLocationCode', seg.departureLocationCode),
    departureTerminal: pick('departureTerminal', seg.departureTerminal),
    departureGate: pick('departureGate', seg.departureGate),
    departureTime: pick('departureTime', seg.departureTime),
    arrivalLocation: pick('arrivalLocation', seg.arrivalLocation),
    arrivalLocationCode: pick('arrivalLocationCode', seg.arrivalLocationCode),
    arrivalTerminal: pick('arrivalTerminal', seg.arrivalTerminal),
    arrivalTime: pick('arrivalTime', seg.arrivalTime),
    seat: pick('seat', seg.seat),
    cabin: pick('cabin', seg.cabin),
    travelClass: pick('travelClass', seg.travelClass),
    currency: pick('currency', seg.currency),
    price: pick('price', seg.price),
    baggageInfo: pick('baggageInfo', seg.baggageInfo),
    notes: pick('notes', seg.notes),
    timezone: pick('timezone', seg.timezone),
    confidenceScores,
    fieldsNeedingReview,
  }
}

export function normalizeItinerary(extracted: ExtractedItinerary): NormalizedItinerary {
  return {
    passengerNames: extracted.passengerNames
      .map((f) => f.value)
      .filter((v): v is string => v !== null),
    segments: extracted.segments.map(normalizeSegment),
    overallConfidence: extracted.overallConfidence,
  }
}
