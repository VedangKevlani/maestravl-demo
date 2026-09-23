import { describe, it, expect } from 'vitest'
import { parseItinerary } from './parse'

const REF_DATE = new Date('2026-09-01T00:00:00Z')

// Shape of a real multi-booking itinerary as pdf.js now emits it (one line
// per printed line): a flight plus hotel, restaurant, boat charter and train.
const TEXT = `
NEW YORK WEEKEND — TRIP ITINERARY
Booking reference: MQX7RT
Passenger: Vedang Kevlani
Passenger: Bob Sonder
Passenger: Jane Gilby
FLIGHT — Delta Air Lines
Flight DL 1234
From: Miami (MIA)
To: New York (JFK)
Departs: Sep 23, 2026 1:15 PM
Arrives: Sep 23, 2026 4:05 PM
Seat: 14A
RESTAURANT — Onepot Kitchen
Address: 120 Hudson St, New York, NY
Reservation: Sep 23, 2026 6:30 PM
Party size: 3
Confirmation number: OPK4821
Reservations: onepot.team@gmail.com
BOAT CHARTER — Harborlight Sail & Charter
Vessel: Harborlight II
Meeting point: Pier 25, Hudson River Park
Departs: Sep 23, 2026 8:00 PM
Returns: Sep 23, 2026 10:00 PM
Confirmation number: HSC9031
Reservations: kevlanivedang28+charter@gmail.com
TRAIN — Amtrak
Service: Northeast Regional
Train number: 175
From: New York Penn Station (NYP)
To: Boston South Station (BOS)
Departs: Sep 24, 2026 9:05 AM
Arrives: Sep 24, 2026 1:10 PM
Seat: Coach 4, Seat 12C
HOTEL — The Beacon Harbor Hotel
Address: 200 Atlantic Ave, Boston, MA
Check-in: Sep 24, 2026 3:00 PM
Check-out: Sep 26, 2026 11:00 AM
Confirmation number: BHH55120
Reservations: kevlanivedang28+hotel@gmail.com
`

describe('parseItinerary — multi-booking itinerary', () => {
  const result = parseItinerary(TEXT, REF_DATE)
  const byType = (t: string) => result.segments.filter((s) => s.transportType.value === t)

  it('extracts every booking, not just the flight', () => {
    expect(result.segments.map((s) => s.transportType.value)).toEqual(['FLIGHT', 'RESTAURANT', 'BOAT', 'TRAIN', 'HOTEL'])
  })

  it('reads flight times in the airports’ own zones', () => {
    const f = byType('FLIGHT')[0]
    expect(f.identifier.value).toBe('DL1234')
    expect(f.departureLocationCode.value).toBe('MIA')
    expect(f.arrivalLocationCode.value).toBe('JFK')
    expect(f.departureTime.value).toBe('2026-09-23T17:15:00.000Z') // 1:15 PM EDT
    expect(f.arrivalTime.value).toBe('2026-09-23T20:05:00.000Z')
    expect(f.timezone.value).toBe('America/New_York')
  })

  it('reads each non-flight booking’s own name, place, time and contact', () => {
    const r = byType('RESTAURANT')[0]
    expect(r.provider.value).toBe('Onepot Kitchen')
    expect(r.departureLocation.value).toBe('120 Hudson St, New York, NY')
    expect(r.departureTime.value).toBe('2026-09-23T22:30:00.000Z')
    expect(r.confirmationNumber.value).toBe('OPK4821')
    expect(r.notes.value).toContain('onepot.team@gmail.com')
    expect(r.notes.value).not.toContain('charter@')

    const b = byType('BOAT')[0]
    expect(b.provider.value).toBe('Harborlight Sail & Charter')
    expect(b.identifier.value).toBe('Harborlight II')
    expect(b.arrivalTime.value).toBe('2026-09-24T02:00:00.000Z')
    expect(b.notes.value).toContain('kevlanivedang28+charter@gmail.com')

    const t = byType('TRAIN')[0]
    expect(t.provider.value).toBe('Amtrak')
    expect(t.identifier.value).toBe('Northeast Regional')
    expect(t.departureLocationCode.value).toBe('NYP')
    expect(t.arrivalLocationCode.value).toBe('BOS')
    expect(t.departureTime.value).toBe('2026-09-24T13:05:00.000Z')
    expect(t.notes.value).toContain('Train number: 175')

    const h = byType('HOTEL')[0]
    expect(h.provider.value).toBe('The Beacon Harbor Hotel')
    expect(h.departureTime.value).toBe('2026-09-24T19:00:00.000Z')
    expect(h.arrivalTime.value).toBe('2026-09-26T15:00:00.000Z')
    expect(h.confirmationNumber.value).toBe('BHH55120')
    expect(h.timezone.value).toBe('America/New_York')
  })

  it('keeps every extracted field above the review threshold', () => {
    for (const s of result.segments) {
      for (const [name, f] of Object.entries(s)) {
        if (f.value !== null) expect(f.confidence, `${s.transportType.value}.${name}`).toBeGreaterThanOrEqual(70)
      }
    }
  })

  it('finds all passengers', () => {
    expect(result.passengerNames.map((p) => p.value)).toEqual(['Vedang Kevlani', 'Bob Sonder', 'Jane Gilby'])
  })
})
