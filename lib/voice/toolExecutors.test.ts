import { describe, it, expect } from 'vitest'
import { executeGetItinerary, executeGetSegmentStatus, executeGetRecoveryActivity } from './toolExecutors'
import { STATUS_COPY, actionLabel } from '@/lib/agents/statusCopy'
import type { VoiceContext, VoiceSegment } from './types'

function makeSegment(overrides: Partial<VoiceSegment>): VoiceSegment {
  return {
    id: 'seg-1',
    order: 0,
    transportType: 'FLIGHT',
    status: 'SCHEDULED',
    provider: 'American Airlines',
    identifier: 'AA123',
    departureLocation: 'Kingston',
    departureLocationCode: 'KIN',
    departureTime: new Date('2026-06-16T14:30:00Z'),
    arrivalLocation: 'Miami',
    arrivalLocationCode: 'MIA',
    arrivalTime: new Date('2026-06-16T17:45:00Z'),
    confirmationNumber: 'XJ7K2P',
    notes: null,
    timezone: 'America/Jamaica',
    monitoringStatus: 'on time',
    monitoringCheckedAt: new Date('2026-06-15T12:00:00Z'),
    ...overrides,
  }
}

const NOW = new Date('2026-06-15T12:00:00Z')

function makeContext(overrides: Partial<VoiceContext> = {}): VoiceContext {
  return {
    now: NOW,
    trip: { id: 'trip-1', title: 'Jamaica trip', status: 'UPCOMING' },
    passengers: [{ name: 'Jane Doe', isPrimary: true }],
    segments: [makeSegment({})],
    recentRuns: [],
    ...overrides,
  }
}

describe('executeGetItinerary', () => {
  it('returns trip, passengers, and segments in order', () => {
    const second = makeSegment({ id: 'seg-2', order: 1, identifier: 'BB456' })
    const first = makeSegment({ id: 'seg-1', order: 0, identifier: 'AA123' })
    const result = executeGetItinerary(makeContext({ segments: [second, first] }))
    expect(result.trip).toEqual({ title: 'Jamaica trip', status: 'UPCOMING' })
    expect(result.passengers).toEqual([{ name: 'Jane Doe', isPrimary: true }])
    expect(result.segments.map((s) => s.label)).toEqual(['AA123 (KIN → MIA)', 'BB456 (KIN → MIA)'])
  })
})

describe('executeGetSegmentStatus', () => {
  it('returns the live monitoring status for a found segment', () => {
    const context = makeContext()
    const result = executeGetSegmentStatus(context, { segment: 'AA123' })
    expect(result.found).toBe(true)
    if (result.found) {
      expect(result.liveStatus).toBe('on time')
      expect(result.segment.label).toBe('AA123 (KIN → MIA)')
    }
  })

  it('returns a not-found payload listing real segment labels when nothing matches', () => {
    const context = makeContext()
    const result = executeGetSegmentStatus(context, { segment: 'submarine' })
    expect(result.found).toBe(false)
    if (!result.found && 'availableSegments' in result) {
      expect(result.availableSegments).toEqual(['AA123 (KIN → MIA)'])
    }
  })

  it('returns an ambiguous payload with real candidates when more than one segment matches', () => {
    const hotelA = makeSegment({ id: 'h1', transportType: 'HOTEL', provider: 'Marriott', identifier: null, departureLocationCode: null, arrivalLocationCode: null })
    const hotelB = makeSegment({ id: 'h2', transportType: 'HOTEL', provider: 'Hilton', identifier: null, departureLocationCode: null, arrivalLocationCode: null })
    const context = makeContext({ segments: [hotelA, hotelB] })
    const result = executeGetSegmentStatus(context, { segment: 'hotel' })
    expect(result.found).toBe(false)
    if (!result.found && 'candidates' in result) {
      expect(result.candidates.sort()).toEqual(['Hilton', 'Marriott'])
    }
  })
})

describe('executeGetRecoveryActivity', () => {
  it('reports no activity when there are no recent runs', () => {
    const result = executeGetRecoveryActivity(makeContext(), {})
    expect(result).toEqual({ found: true, hasActivity: false, message: 'Nothing is currently being handled for this trip.' })
  })

  it('reuses STATUS_COPY and ACTION_TYPE_LABEL wording exactly, not its own phrasing', () => {
    const context = makeContext({
      recentRuns: [
        {
          id: 'run-1',
          status: 'CONTACTING',
          summary: null,
          createdAt: new Date('2026-06-15T11:00:00Z'),
          segmentId: 'seg-1',
          segmentLabel: 'AA123 (KIN → MIA)',
          newStatus: 'DELAYED',
          delayMinutes: 90,
          actions: [
            { type: 'CONTACT_PROVIDER', description: 'Emailed American Airlines about the delay', status: 'EXECUTED', createdAt: new Date('2026-06-15T11:01:00Z') },
          ],
        },
      ],
    })
    const result = executeGetRecoveryActivity(context, {})
    expect(result.found).toBe(true)
    if (result.found && result.hasActivity) {
      expect(result.runs[0].headline).toBe(STATUS_COPY['CONTACTING'].headline)
      expect(result.runs[0].recentActions[0].summary).toBe(actionLabel('CONTACT_PROVIDER', 'fallback'))
      expect(result.runs[0].delayMinutes).toBe(90)
      expect(result.runs[0].isResolved).toBe(false)
    } else {
      throw new Error('expected recovery activity to be found')
    }
  })

  it('filters recovery activity to one segment when asked', () => {
    const other = makeSegment({ id: 'seg-2', identifier: 'BB456', departureLocationCode: 'MIA', arrivalLocationCode: 'JFK' })
    const context = makeContext({
      segments: [makeSegment({}), other],
      recentRuns: [
        { id: 'r1', status: 'COMPLETED', summary: null, createdAt: NOW, segmentId: 'seg-1', segmentLabel: 'AA123 (KIN → MIA)', newStatus: 'ON_TIME', delayMinutes: null, actions: [] },
        { id: 'r2', status: 'CONTACTING', summary: null, createdAt: NOW, segmentId: 'seg-2', segmentLabel: 'BB456 (MIA → JFK)', newStatus: 'DELAYED', delayMinutes: 30, actions: [] },
      ],
    })
    const result = executeGetRecoveryActivity(context, { segment: 'BB456' })
    if (result.found && result.hasActivity) {
      expect(result.runs).toHaveLength(1)
      expect(result.runs[0].segment).toBe('BB456 (MIA → JFK)')
    } else {
      throw new Error('expected recovery activity to be found')
    }
  })

  it('returns not-found when filtering to a segment that does not exist', () => {
    const result = executeGetRecoveryActivity(makeContext(), { segment: 'submarine' })
    expect(result.found).toBe(false)
  })
})

describe('local times for the assistant', () => {
  it('gives each time in the segment’s own zone, not UTC', () => {
    const train = makeSegment({
      transportType: 'TRAIN', provider: 'Amtrak', identifier: 'Pacific Surfliner',
      departureLocation: 'Los Angeles Union Station', departureLocationCode: null,
      arrivalLocation: 'San Diego Santa Fe Depot', arrivalLocationCode: null,
      departureTime: new Date('2026-09-24T17:05:00Z'), arrivalTime: new Date('2026-09-24T19:55:00Z'),
      timezone: 'America/Los_Angeles',
    })
    const seg = executeGetItinerary(makeContext({ segments: [train] })).segments[0]
    expect(seg.departure?.localTime).toContain('10:05')
    expect(seg.departure?.localTime).toContain('Los Angeles')
    expect(seg.arrival?.localTime).toContain('12:55')
  })
})
