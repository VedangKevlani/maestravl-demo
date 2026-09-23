// Pure — executes each of the model's tool calls against an already-fetched
// VoiceContext (see lib/voice/tripContext.ts). No DB access happens here:
// the trip's data is small and trip-scoped, so it's fetched once per turn
// in the API route rather than once per tool call, keeping this whole
// module a plain synchronous fixture-testable function set. Read-only by
// design — there is deliberately no mutating counterpart to these (see
// lib/voice/systemPrompt.ts for why: the voice assistant never writes to a
// trip).
import { segmentLabel } from '@/lib/segmentLabel'
import { STATUS_COPY, actionLabel } from '@/lib/agents/statusCopy'
import { resolveSegment } from './resolveSegment'
import { formatFriendlyTime, resolveSegmentZones } from '@/lib/dateFormat'
import type { VoiceContext, VoiceSegment } from './types'

// Every time is given to the model twice: the raw UTC instant (for "how
// long until", ordering, etc.) and the local wall-clock time already
// rendered in the segment's own zone. Without `localTime` the model read the
// UTC instant aloud — a 10:05 AM Los Angeles train became "5:55 PM" and an
// 8:30 PM dinner "3:30 on the 24th" (found live 2026-09-23).
function timeFields(time: Date | null, zone: string | null) {
  return { time: time?.toISOString() ?? null, localTime: time ? formatFriendlyTime(time, zone) : null }
}

function describeSegment(segment: VoiceSegment) {
  const zones = resolveSegmentZones(segment)
  return {
    label: segmentLabel(segment),
    transportType: segment.transportType,
    status: segment.status,
    departure:
      segment.departureLocation || segment.departureTime
        ? { location: segment.departureLocation, code: segment.departureLocationCode, ...timeFields(segment.departureTime, zones.departure) }
        : null,
    arrival:
      segment.arrivalLocation || segment.arrivalTime
        ? { location: segment.arrivalLocation, code: segment.arrivalLocationCode, ...timeFields(segment.arrivalTime, zones.arrival) }
        : null,
    confirmationNumber: segment.confirmationNumber,
    notes: segment.notes,
  }
}

export function executeGetItinerary(context: VoiceContext) {
  return {
    trip: { title: context.trip.title, status: context.trip.status },
    passengers: context.passengers.map((p) => ({ name: p.name, isPrimary: p.isPrimary })),
    segments: [...context.segments].sort((a, b) => a.order - b.order).map(describeSegment),
  }
}

function notFoundResult(context: VoiceContext) {
  return {
    found: false as const,
    message: 'No segment matched that description.',
    availableSegments: context.segments.map((s) => segmentLabel(s)),
  }
}

function ambiguousResult(candidates: VoiceSegment[]) {
  return {
    found: false as const,
    message: 'More than one segment matches that description — ask the passenger which one they mean.',
    candidates: candidates.map((s) => segmentLabel(s)),
  }
}

export function executeGetSegmentStatus(context: VoiceContext, args: { segment: string }) {
  const result = resolveSegment(context.segments, args.segment, context.now)
  if (result.type === 'not_found') return notFoundResult(context)
  if (result.type === 'ambiguous') return ambiguousResult(result.candidates)

  const segment = result.segment
  return {
    found: true as const,
    segment: describeSegment(segment),
    liveStatus: segment.monitoringStatus,
    liveStatusCheckedAt: segment.monitoringCheckedAt?.toISOString() ?? null,
  }
}

export function executeGetRecoveryActivity(context: VoiceContext, args: { segment?: string }) {
  let runs = context.recentRuns

  if (args.segment) {
    const result = resolveSegment(context.segments, args.segment, context.now)
    if (result.type === 'not_found') return notFoundResult(context)
    if (result.type === 'ambiguous') return ambiguousResult(result.candidates)
    runs = runs.filter((r) => r.segmentId === result.segment.id)
  }

  if (runs.length === 0) {
    return { found: true as const, hasActivity: false as const, message: 'Nothing is currently being handled for this trip.' }
  }

  return {
    found: true as const,
    hasActivity: true as const,
    runs: runs.map((run) => ({
      segment: run.segmentLabel,
      headline: STATUS_COPY[run.status]?.headline ?? run.status,
      isResolved: run.status === 'COMPLETED' || run.status === 'CONFIRMED',
      delayMinutes: run.delayMinutes,
      recentActions: run.actions.slice(-5).map((a) => ({
        summary: actionLabel(a.type, a.description),
        detail: a.description,
        status: a.status,
      })),
    })),
  }
}
