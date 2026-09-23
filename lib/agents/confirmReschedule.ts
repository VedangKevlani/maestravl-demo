// Impure mutation body extracted from
// app/api/agent-runs/[id]/confirm-reschedule/route.ts, kept separate so the
// route itself is a thin auth/ownership + status-mapping wrapper around it.
// See that route's original header comment for why this is the one place a
// recovery run's own action is allowed to rewrite a Segment's scheduled
// time: gated behind an explicit human confirmation via the "Confirm —
// update itinerary" / "Not quite" buttons — the same trust boundary as a
// manual segment edit. The voice assistant has no path to this at all; it
// is strictly read-only (see lib/voice/systemPrompt.ts).
import { prisma } from '@/lib/db'
import { segmentLabel } from '@/lib/segmentLabel'
import { sendItineraryUpdatedEmail } from '@/lib/email'
import { resolveSegmentZones } from '@/lib/dateFormat'
import type { AgentRun } from '@prisma/client'

export type ConfirmRescheduleResult =
  | { status: 'not_found' }
  | { status: 'not_pending' }
  | { status: 'rejected'; agentRun: AgentRun }
  | { status: 'confirmed'; agentRun: AgentRun }

export async function confirmReschedule(agentRunId: string, accept: boolean): Promise<ConfirmRescheduleResult> {
  const run = await prisma.agentRun.findUnique({ where: { id: agentRunId } })
  if (!run) return { status: 'not_found' }
  if (run.status !== 'RESCHEDULING') return { status: 'not_pending' }

  const pendingRequests = await prisma.rescheduleRequest.findMany({
    where: { agentRunId, status: 'REQUESTED' },
    include: { segment: true },
  })

  if (!accept) {
    await prisma.agentAction.create({
      data: {
        agentRunId,
        segmentId: null,
        type: 'VERIFY',
        riskLevel: 'LOW',
        status: 'EXECUTED',
        description: "You said the provider's reply didn't actually mean the reschedule was accepted — keeping this open.",
      },
    })
    const updated = await prisma.agentRun.update({
      where: { id: agentRunId },
      data: { status: 'ACTION_REQUIRED', summary: "Reply looked like a yes, but you said it wasn't — take another look." },
    })
    return { status: 'rejected', agentRun: updated }
  }

  const changes: { label: string; oldTime: Date | null; newTime: Date; timezone: string | null }[] = []

  for (const request of pendingRequests) {
    const segment = request.segment

    // A reply doesn't always accept the primary requested time — it might
    // accept the fallback alternative instead (see
    // lib/agents/inboundReply.ts, which marks whichever Alternative the
    // reply actually matched as `selected`). Apply that one when it exists;
    // only fall back to the plain requested time when no reply-driven
    // selection was ever recorded (e.g. this run was confirmed without
    // going through reply interpretation at all).
    const selectedAlternative = await prisma.alternative.findFirst({
      where: { agentRunId, segmentId: segment.id, selected: true },
    })
    const targetTime = selectedAlternative?.proposedTime ?? request.requestedTime
    const delta = segment.departureTime ? targetTime.getTime() - segment.departureTime.getTime() : null

    await prisma.segment.update({
      where: { id: segment.id },
      data: {
        departureTime: targetTime,
        arrivalTime: segment.arrivalTime && delta !== null ? new Date(segment.arrivalTime.getTime() + delta) : segment.arrivalTime,
        status: 'DELAYED',
      },
    })

    changes.push({
      label: segmentLabel(segment),
      oldTime: segment.departureTime,
      newTime: targetTime,
      timezone: resolveSegmentZones(segment).departure,
    })

    await prisma.rescheduleRequest.update({
      where: { id: request.id },
      data: { status: 'CONFIRMED', respondedAt: new Date() },
    })

    await prisma.agentAction.create({
      data: {
        agentRunId,
        segmentId: segment.id,
        type: 'UPDATE_ITINERARY',
        riskLevel: 'LOW',
        status: 'EXECUTED',
        description: `Updated ${segmentLabel(segment)}'s scheduled time to reflect the confirmed reschedule.`,
      },
    })
  }

  if (changes.length > 0) await notifyPassengersOfUpdate(agentRunId, run.tripId, changes)

  const updated = await prisma.agentRun.update({
    where: { id: agentRunId },
    data: { status: 'CONFIRMED', summary: 'Rescheduled and confirmed — your itinerary is up to date.', completedAt: new Date() },
  })
  return { status: 'confirmed', agentRun: updated }
}

/**
 * Emails every passenger on the trip with an address on file once a
 * reschedule is actually applied. Best-effort, same as the other passenger
 * notifications: a failed send is logged on the run, never allowed to undo
 * or fail the confirmation itself.
 */
async function notifyPassengersOfUpdate(
  agentRunId: string,
  tripId: string,
  changes: { label: string; oldTime: Date | null; newTime: Date; timezone: string | null }[]
) {
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { passengers: true } })
  if (!trip) return
  const recipients = trip.passengers.filter((p) => p.email)
  if (recipients.length === 0) return

  const results: { recipient: string; success: boolean; error?: string }[] = []
  for (const passenger of recipients) {
    try {
      await sendItineraryUpdatedEmail(passenger.email!, { recipientName: passenger.name, tripTitle: trip.title, changes })
      results.push({ recipient: passenger.email!, success: true })
    } catch (err) {
      results.push({ recipient: passenger.email!, success: false, error: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  const anySucceeded = results.some((r) => r.success)
  await prisma.agentAction.create({
    data: {
      agentRunId,
      segmentId: null,
      type: 'NOTIFY_PASSENGER',
      riskLevel: 'LOW',
      status: anySucceeded ? 'EXECUTED' : 'FAILED',
      description: anySucceeded ? 'Passengers emailed the updated itinerary.' : 'Failed to email passengers the updated itinerary.',
      detail: JSON.stringify(results),
    },
  })
}
