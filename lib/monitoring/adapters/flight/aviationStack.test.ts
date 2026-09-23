import { describe, it, expect } from 'vitest'
import { mapStatus } from './aviationStack'

describe('AviationStack mapStatus', () => {
  it('does not treat an "active" flight that has not left as departed', () => {
    // Real payload shape (AA1578, 2026-09-23): "active", 60 min late, still at the gate.
    const atGate = { departure: { delay: 60, actual: null, actual_runway: null }, live: null }
    expect(mapStatus('active', 60, atGate)).toBe('DELAYED')
    expect(mapStatus('active', undefined, { departure: { actual: null }, live: null })).toBe('ON_TIME')
  })

  it('treats "active" as departed once there is an actual departure or a live position', () => {
    expect(mapStatus('active', 60, { departure: { actual: '2026-09-23T21:54:00+00:00' } })).toBe('DEPARTED')
    expect(mapStatus('active', 60, { departure: { actual_runway: '2026-09-23T22:05:00+00:00' } })).toBe('DEPARTED')
    expect(mapStatus('active', undefined, { departure: {}, live: { latitude: 40 } })).toBe('DEPARTED')
  })

  it('keeps the other statuses as before', () => {
    expect(mapStatus('scheduled', 45)).toBe('DELAYED')
    expect(mapStatus('scheduled', 0)).toBe('ON_TIME')
    expect(mapStatus('landed', undefined)).toBe('ARRIVED')
    expect(mapStatus('cancelled', undefined)).toBe('CANCELLED')
  })
})
