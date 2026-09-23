import { prisma } from '@/lib/db'
import { sendStatusChangeEmail } from '@/lib/email'
import { sendStatusChangeText, isTextChannelConfigured, type TextChannel } from '@/lib/sms'
import { getAdapterForTransportType } from './registry'
import { handleDisruptionDetection } from '@/lib/agents/detect'
import { classifyDisruption } from '@/lib/agents/classify'
import { segmentLabel } from '@/lib/segmentLabel'
import type { MonitorableSegment, MonitoringCheckResult, MonitoringCheckStatus } from './types'
import type { TransportType } from '@/lib/constants'

// AviationStack's free tier caps out at 100 requests/month total, so polling
// scales with proximity to departure instead of a flat interval: most of a
// segment's monitored life is spent far from departure, where a status
// change is unlikely and cheap polling is fine; the hours right around
// departure — where a delay/cancellation is both most likely and most
// urgent to catch — get checked much more often. See docs/INTEGRATION.md
// for the budget math.
const FAR_INTERVAL_MS = 1000 * 60 * 60 * 12 // >72h to departure
const NEAR_INTERVAL_MS = 1000 * 60 * 60 * 6 // 24-72h to departure
const SOON_INTERVAL_MS = 1000 * 60 * 60 * 2 // 6-24h to departure
const IMMINENT_INTERVAL_MS = 1000 * 60 * 30 // <=6h to departure, and in-flight

// Once a segment has reached a terminal status it stops costing quota
// immediately. But a provider that never confirms ARRIVED at all (e.g. it
// simply doesn't have this flight in its data — see the "noMatch" path in
// lib/monitoring/adapters/flight/aeroDataBox.ts) would otherwise poll
// forever, so there's also a time-based fallback: stop asking once we're
// well past when the segment must be over, confirmation or not. Measured
// from the *arrival* time when it's known (tightest, most honest signal —
// a few hours past scheduled arrival covers realistic delays without
// pointlessly checking into the next day for a flight that already
// landed) and falls back to a wider window from departure when arrival
// isn't known, since departure alone can't tell us how long the segment
// actually takes.
const STALE_AFTER_ARRIVAL_MS = 1000 * 60 * 60 * 3
const STALE_AFTER_DEPARTURE_MS = 1000 * 60 * 60 * 8

function computeCheckIntervalMs(departureTime: Date | null): number {
  if (!departureTime) return NEAR_INTERVAL_MS
  const msToDeparture = departureTime.getTime() - Date.now()
  if (msToDeparture <= 1000 * 60 * 60 * 6) return IMMINENT_INTERVAL_MS
  if (msToDeparture <= 1000 * 60 * 60 * 24) return SOON_INTERVAL_MS
  if (msToDeparture <= 1000 * 60 * 60 * 72) return NEAR_INTERVAL_MS
  return FAR_INTERVAL_MS
}

function isMonitoringComplete(status: MonitoringCheckStatus, departureTime: Date | null, arrivalTime: Date | null) {
  if (status === 'ARRIVED' || status === 'CANCELLED') return true
  if (arrivalTime) return Date.now() - arrivalTime.getTime() > STALE_AFTER_ARRIVAL_MS
  return Boolean(departureTime && Date.now() - departureTime.getTime() > STALE_AFTER_DEPARTURE_MS)
}

/** Called right after a segment is saved — sets up (or refreshes) its MonitoringRecord.
 *  `enabled` reflects the user's "I want Maestro to actively monitor this segment"
 *  choice: false forces PAUSED regardless of adapter availability; true/undefined
 *  falls back to the previous configured-adapter check. */
export async function initializeMonitoringForSegment(segmentId: string, enabled?: boolean) {
  const segment = await prisma.segment.findUnique({ where: { id: segmentId } })
  if (!segment) return null

  const adapter = getAdapterForTransportType(segment.transportType as TransportType)
  const monitorable: MonitorableSegment = {
    id: segment.id,
    transportType: segment.transportType as TransportType,
    provider: segment.provider,
    identifier: segment.identifier,
    departureLocationCode: segment.departureLocationCode,
    arrivalLocationCode: segment.arrivalLocationCode,
    departureLocation: segment.departureLocation,
    arrivalLocation: segment.arrivalLocation,
    departureTime: segment.departureTime,
    arrivalTime: segment.arrivalTime,
  }

  const trackingKey = adapter?.buildTrackingKey(monitorable) ?? null
  const configured = Boolean(adapter?.isConfigured())
  const resolvedStatus = enabled === false ? 'PAUSED' : (configured ? 'ACTIVE' : 'NOT_CONFIGURED')

  const record = await prisma.monitoringRecord.upsert({
    where: { segmentId },
    create: {
      segmentId,
      apiProvider: adapter?.id ?? null,
      trackingKey,
      status: resolvedStatus,
    },
    update: {
      apiProvider: adapter?.id ?? null,
      trackingKey,
      status: resolvedStatus,
    },
  })

  // Seed a real reading immediately rather than leaving it null until the
  // next scheduled check (up to 6h away) — segment creation is exactly when
  // a user expects to see current status, not much later.
  if (resolvedStatus === 'ACTIVE') {
    return runMonitoringCheck(segmentId)
  }
  return record
}

export { segmentLabel }

/**
 * Notifies every passenger on the segment about a status change over every
 * channel they have a usable contact for — email if they have one, SMS/
 * WhatsApp if they have a phone number and that channel is configured — and
 * logs each attempt independently. A passenger overwhelmed mid-disruption
 * or without signal may never see the email in time, so this doesn't stop
 * at the first channel that works.
 */
async function notifyPassengersOfStatusChange(segmentId: string, previousStatus: string | null, newStatus: string) {
  const segment = await prisma.segment.findUnique({
    where: { id: segmentId },
    include: {
      trip: true,
      passengerLinks: { include: { passenger: true } },
    },
  })
  if (!segment) return

  const label = segmentLabel(segment)
  const passengers = segment.passengerLinks.map((link) => link.passenger)

  const attempts: { passenger: (typeof passengers)[number]; channel: 'EMAIL' | TextChannel }[] = []
  for (const passenger of passengers) {
    if (passenger.email) attempts.push({ passenger, channel: 'EMAIL' })
    if (passenger.phone && isTextChannelConfigured('SMS')) attempts.push({ passenger, channel: 'SMS' })
    if (passenger.phone && isTextChannelConfigured('WHATSAPP')) attempts.push({ passenger, channel: 'WHATSAPP' })
  }

  if (attempts.length === 0) {
    await prisma.notificationLog.create({
      data: {
        tripId: segment.tripId,
        segmentId: segment.id,
        previousStatus,
        newStatus,
        channel: 'NONE',
        success: false,
        errorMessage: 'No passenger email or phone on file for any configured channel',
      },
    })
    return
  }

  for (const { passenger, channel } of attempts) {
    try {
      let subject: string | undefined
      if (channel === 'EMAIL') {
        subject = await sendStatusChangeEmail(passenger.email!, {
          recipientName: passenger.name,
          segmentLabel: label,
          tripTitle: segment.trip.title,
          previousStatus,
          newStatus,
        })
      } else {
        await sendStatusChangeText(channel, passenger.phone!, {
          recipientName: passenger.name,
          segmentLabel: label,
          tripTitle: segment.trip.title,
          newStatus,
        })
      }
      await prisma.notificationLog.create({
        data: {
          tripId: segment.tripId,
          segmentId: segment.id,
          previousStatus,
          newStatus,
          channel,
          recipientEmail: channel === 'EMAIL' ? passenger.email : null,
          recipientPhone: channel === 'EMAIL' ? null : passenger.phone,
          recipientName: passenger.name,
          subject,
          success: true,
        },
      })
    } catch (err) {
      await prisma.notificationLog.create({
        data: {
          tripId: segment.tripId,
          segmentId: segment.id,
          previousStatus,
          newStatus,
          channel,
          recipientEmail: channel === 'EMAIL' ? passenger.email : null,
          recipientPhone: channel === 'EMAIL' ? null : passenger.phone,
          recipientName: passenger.name,
          success: false,
          errorMessage: err instanceof Error ? err.message : 'Failed to send notification',
        },
      })
    }
  }
}

export async function runMonitoringCheck(segmentId: string) {
  const segment = await prisma.segment.findUnique({ where: { id: segmentId } })
  if (!segment) throw new Error('Segment not found')

  const adapter = getAdapterForTransportType(segment.transportType as TransportType)
  if (!adapter) {
    return prisma.monitoringRecord.upsert({
      where: { segmentId },
      create: { segmentId, status: 'NOT_CONFIGURED' },
      update: { status: 'NOT_CONFIGURED' },
    })
  }

  const existing = await prisma.monitoringRecord.findUnique({ where: { segmentId } })
  let previousStatus: string | null = null
  if (existing?.lastKnownData) {
    try {
      previousStatus = (JSON.parse(existing.lastKnownData) as MonitoringCheckResult).status ?? null
    } catch {
      previousStatus = null
    }
  }

  const monitorable: MonitorableSegment = {
    id: segment.id,
    transportType: segment.transportType as TransportType,
    provider: segment.provider,
    identifier: segment.identifier,
    departureLocationCode: segment.departureLocationCode,
    arrivalLocationCode: segment.arrivalLocationCode,
    departureLocation: segment.departureLocation,
    arrivalLocation: segment.arrivalLocation,
    departureTime: segment.departureTime,
    arrivalTime: segment.arrivalTime,
  }

  const result = await adapter.check(monitorable)
  const nextCheckAt = new Date(Date.now() + computeCheckIntervalMs(segment.departureTime))
  const status = !adapter.isConfigured()
    ? 'NOT_CONFIGURED'
    : isMonitoringComplete(result.status, segment.departureTime, segment.arrivalTime)
      ? 'PAUSED'
      : 'ACTIVE'

  const record = await prisma.monitoringRecord.upsert({
    where: { segmentId },
    create: {
      segmentId,
      apiProvider: adapter.id,
      trackingKey: adapter.buildTrackingKey(monitorable),
      status,
      lastCheckedAt: result.checkedAt,
      nextCheckAt,
      lastKnownData: JSON.stringify(result),
    },
    update: {
      status,
      lastCheckedAt: result.checkedAt,
      nextCheckAt,
      lastKnownData: JSON.stringify(result),
    },
  })

  // Only notify once we have a genuine prior reading to compare against —
  // otherwise the very first check would "change" from nothing to something.
  // ARRIVED is deliberately silent — landing isn't actionable or urgent for
  // the passenger to hear about by email, and this segment's monitoring is
  // about to pause anyway (see isMonitoringComplete above), so there's
  // nothing further to report on it either.
  // A segment that was *already* disrupted the first time Maestravl looked
  // (e.g. an itinerary uploaded for a flight that's already running late)
  // never produced a status "change" — the upload's first check is only a
  // baseline, and every later check read DELAYED -> DELAYED — so it was
  // never escalated at all. The segment's own status is what the passenger
  // has actually been told; if a disruptive reading hasn't reached it yet,
  // treat it as a change from there. detect.ts sets the segment's status
  // when it records the disruption, so this fires once, not every check.
  const unreportedDisruption =
    previousStatus !== null &&
    result.status === previousStatus &&
    segment.status !== result.status &&
    classifyDisruption(result.status, result.delayMinutes ?? null) !== null
  const effectivePreviousStatus = unreportedDisruption ? segment.status : previousStatus

  if (effectivePreviousStatus && (result.status !== previousStatus || unreportedDisruption) && result.status !== 'UNKNOWN' && result.status !== 'ARRIVED') {
    await notifyPassengersOfStatusChange(segmentId, effectivePreviousStatus, result.status)
    // Disruptive changes (a real delay or a cancellation) additionally
    // start a recovery AgentRun — see lib/agents/detect.ts. Routine
    // progression (BOARDING/DEPARTED/back to ON_TIME) is already covered by
    // the notification above and isn't disruptive on its own.
    await handleDisruptionDetection(segment, effectivePreviousStatus, result)
  }

  return record
}

/**
 * Runs checks for every actively-monitored segment whose nextCheckAt has
 * passed. Meant to be called on a schedule (see app/api/cron/monitoring) —
 * sequential rather than parallel to stay gentle on rate-limited free-tier
 * provider quotas.
 *
 * Ordered by departure time (soonest first) rather than insertion order —
 * when a run's combined provider quota is tight, whichever segment is
 * closest to departure gets checked before one that's still days out,
 * instead of losing out to whatever happened to be created first.
 */
export async function runDueMonitoringChecks() {
  const due = await prisma.monitoringRecord.findMany({
    where: {
      status: 'ACTIVE',
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
    },
    select: { segmentId: true },
    orderBy: { segment: { departureTime: 'asc' } },
  })

  const results: { segmentId: string; ok: boolean; error?: string }[] = []
  for (const { segmentId } of due) {
    try {
      await runMonitoringCheck(segmentId)
      results.push({ segmentId, ok: true })
    } catch (err) {
      results.push({ segmentId, ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
    }
  }
  return results
}
