export interface ExtractedField<T> {
  value: T | null
  /** 0-100. Fields below CONFIDENCE_REVIEW_THRESHOLD are flagged for user confirmation. */
  confidence: number
  /** Which extraction layer produced this value, for debugging/audit. */
  source: 'regex' | 'dictionary' | 'nlp-date' | 'heuristic' | 'unset'
}

export const CONFIDENCE_REVIEW_THRESHOLD = 70

export function field<T>(value: T | null, confidence: number, source: ExtractedField<T>['source']): ExtractedField<T> {
  return { value, confidence: value === null ? 0 : confidence, source: value === null ? 'unset' : source }
}

import type { TransportType as TransportTypeGuess } from '@/lib/constants'
export type { TransportTypeGuess }

export interface ExtractedSegment {
  transportType: ExtractedField<TransportTypeGuess>
  provider: ExtractedField<string>
  identifier: ExtractedField<string>
  confirmationNumber: ExtractedField<string>
  ticketNumber: ExtractedField<string>
  departureLocation: ExtractedField<string>
  departureLocationCode: ExtractedField<string>
  departureTerminal: ExtractedField<string>
  departureGate: ExtractedField<string>
  departureTime: ExtractedField<string> // ISO 8601
  arrivalLocation: ExtractedField<string>
  arrivalLocationCode: ExtractedField<string>
  arrivalTerminal: ExtractedField<string>
  arrivalTime: ExtractedField<string> // ISO 8601
  seat: ExtractedField<string>
  cabin: ExtractedField<string>
  travelClass: ExtractedField<string>
  currency: ExtractedField<string>
  price: ExtractedField<number>
  baggageInfo: ExtractedField<string>
  notes: ExtractedField<string>
  /** IANA zone the segment's wall-clock times were interpreted in (e.g. "America/New_York"). */
  timezone: ExtractedField<string>
}

export interface ExtractedItinerary {
  passengerNames: ExtractedField<string>[]
  segments: ExtractedSegment[]
  rawText: string
  /** Mean of all field confidences, weighted by how many fields were found. */
  overallConfidence: number
}

export interface TextExtractionResult {
  text: string
  /** How the text was obtained — native text is far more reliable than OCR. */
  method: 'native-pdf' | 'ocr'
  /** Per-page OCR confidence average (0-100), only present when method === 'ocr'. */
  ocrConfidence?: number
}
