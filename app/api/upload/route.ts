import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUserId } from '@/lib/apiAuth'
import { validateUploadedFile } from '@/lib/security/fileValidation'
import { encryptBuffer, randomStorageFilename } from '@/lib/security/encryption'
import { uploadDocument } from '@/lib/storage'
import { extractText } from '@/lib/extraction/extractText'
import { parseItinerary } from '@/lib/extraction/parse'
import { normalizeItinerary } from '@/lib/extraction/normalize'
import { initializeMonitoringForSegment } from '@/lib/monitoring/service'

export async function POST(req: Request) {
  const auth = await requireUserId()
  if ('error' in auth) return auth.error

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })

  const file = form.get('file')
  const tripIdInput = form.get('tripId')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file"' }, { status: 400 })
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const validation = validateUploadedFile(bytes)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  // Resolve or create the trip this document belongs to.
  let tripId: string
  if (typeof tripIdInput === 'string' && tripIdInput) {
    const trip = await prisma.trip.findFirst({ where: { id: tripIdInput, userId: auth.userId } })
    if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 })
    tripId = trip.id
  } else {
    const trip = await prisma.trip.create({
      data: { title: file.name.replace(/\.[^.]+$/, '') || 'Imported Trip', userId: auth.userId },
    })
    tripId = trip.id
  }

  const storedFilename = randomStorageFilename()
  await uploadDocument(storedFilename, encryptBuffer(bytes))

  const document = await prisma.document.create({
    data: {
      tripId,
      userId: auth.userId,
      storedFilename,
      originalFilename: file.name,
      mimeType: validation.type,
      fileSize: bytes.length,
      status: 'PROCESSING',
    },
  })

  try {
    const { text, method, ocrConfidence } = await extractText(bytes, validation.type)
    const extracted = parseItinerary(text)
    const normalized = normalizeItinerary(extracted)

    // OCR is inherently less reliable than a native text layer — reflect that
    // by capping every field's confidence when the text came from OCR.
    const ocrPenalty = method === 'ocr' ? Math.min(1, (ocrConfidence ?? 70) / 100) : 1

    const maxOrder = await prisma.segment.aggregate({ where: { tripId }, _max: { order: true } })
    let nextOrder = (maxOrder._max.order ?? -1) + 1

    const createdSegmentIds: string[] = []
    for (const seg of normalized.segments) {
      const scaledConfidence = Object.fromEntries(
        Object.entries(seg.confidenceScores).map(([k, v]) => [k, Math.round(v * ocrPenalty)])
      )
      const created = await prisma.segment.create({
        data: {
          tripId,
          sourceDocumentId: document.id,
          order: nextOrder++,
          transportType: seg.transportType as never,
          provider: seg.provider,
          identifier: seg.identifier,
          confirmationNumber: seg.confirmationNumber,
          ticketNumber: seg.ticketNumber,
          departureLocation: seg.departureLocation,
          departureLocationCode: seg.departureLocationCode,
          departureTerminal: seg.departureTerminal,
          departureGate: seg.departureGate,
          departureTime: seg.departureTime ? new Date(seg.departureTime) : null,
          arrivalLocation: seg.arrivalLocation,
          arrivalLocationCode: seg.arrivalLocationCode,
          arrivalTerminal: seg.arrivalTerminal,
          arrivalTime: seg.arrivalTime ? new Date(seg.arrivalTime) : null,
          seat: seg.seat,
          cabin: seg.cabin,
          travelClass: seg.travelClass,
          currency: seg.currency,
          price: seg.price,
          notes: seg.notes,
          timezone: seg.timezone,
          baggageInfo: seg.baggageInfo,
          confidenceScores: JSON.stringify(scaledConfidence),
        },
      })
      createdSegmentIds.push(created.id)
    }

    for (const id of createdSegmentIds) {
      await initializeMonitoringForSegment(id)
    }

    // Create passenger records for any names the parser found, skipping duplicates already on the trip.
    const existingPassengers = await prisma.passenger.findMany({ where: { tripId } })
    const existingNames = new Set(existingPassengers.map((p) => p.name.toLowerCase()))
    let hasPrimary = existingPassengers.some((p) => p.isPrimary)
    for (const name of normalized.passengerNames) {
      if (existingNames.has(name.toLowerCase())) continue
      // Only the first passenger on a trip is its primary traveller — this
      // used to mark every name found in the document as primary.
      await prisma.passenger.create({ data: { tripId, name, isPrimary: !hasPrimary } })
      hasPrimary = true
      existingNames.add(name.toLowerCase())
    }

    // Every passenger now on the trip (pre-existing or just extracted from
    // this document) gets linked to every segment this document produced —
    // same default as manually adding a segment (see
    // app/api/trips/[id]/segments/route.ts): a segment should never
    // silently start with nobody to notify if it's disrupted.
    const allPassengers = await prisma.passenger.findMany({ where: { tripId }, select: { id: true } })
    if (allPassengers.length > 0 && createdSegmentIds.length > 0) {
      await prisma.segmentPassenger.createMany({
        data: createdSegmentIds.flatMap((segmentId) => allPassengers.map((p) => ({ segmentId, passengerId: p.id }))),
        skipDuplicates: true,
      })
    }

    await prisma.document.update({
      where: { id: document.id },
      data: { status: 'COMPLETED', extractedRawText: text, processedAt: new Date() },
    })

    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        passengers: true,
        segments: { orderBy: { order: 'asc' }, include: { monitoring: true } },
      },
    })

    return NextResponse.json({
      trip,
      extraction: {
        method,
        overallConfidence: Math.round(normalized.overallConfidence * ocrPenalty),
        documentId: document.id,
      },
    }, { status: 201 })
  } catch (err) {
    console.error('Document extraction failed', { documentId: document.id, err })
    await prisma.document.update({
      where: { id: document.id },
      data: { status: 'FAILED', extractionError: err instanceof Error ? err.message : 'Unknown extraction error' },
    })
    return NextResponse.json({ error: 'Could not extract this document. You can still add it manually.', tripId }, { status: 422 })
  }
}
