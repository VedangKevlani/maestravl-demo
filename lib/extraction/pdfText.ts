import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * Extracts embedded/native text from a digitally-generated PDF (no OCR).
 * Returns an empty string when the PDF has no text layer (e.g. a scanned
 * document saved as images), so the caller can fall back to OCR.
 */
export async function extractNativePdfText(bytes: Uint8Array): Promise<string> {
  const loadingTask = getDocument({
    // pdf.js rejects Node's Buffer (a Uint8Array subclass) with "Please
    // provide binary data as `Uint8Array`, rather than `Buffer`." — must be
    // a genuine COPY (the 1-arg Uint8Array constructor form), not a
    // zero-copy view over the same underlying buffer: pdf.js detaches the
    // ArrayBuffer it's handed once the document load completes, which
    // would silently neuter the caller's original `bytes` too if it shared
    // the same backing buffer (extractText.ts reuses `bytes` afterward for
    // the OCR fallback path — that's exactly the crash this caused:
    // "Cannot perform Construct on a detached ArrayBuffer", then "The PDF
    // file is empty" once `bytes` itself had been neutered).
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0,
  })
  const doc = await loadingTask.promise
  try {
    const pageTexts: string[] = []
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum)
      const content = await page.getTextContent()
      // Keep the PDF's own line breaks (pdf.js marks the last item on each
      // visual line with hasEOL). Joining everything with spaces collapsed a
      // whole page onto one line, which made "Label: value" lines and
      // per-booking sections impossible to tell apart — every booking's
      // details ran together, so only flights (found by flight number
      // alone) ever survived extraction.
      const pageText = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
      pageTexts.push(pageText)
    }
    return pageTexts.join('\n\n').trim()
  } finally {
    await loadingTask.destroy()
  }
}

/** Renders each PDF page to a PNG buffer for OCR fallback (scanned/rasterized PDFs). */
export async function renderPdfPagesToPng(bytes: Uint8Array): Promise<Buffer[]> {
  const { createCanvas } = await import('@napi-rs/canvas').catch(() => {
    throw new Error(
      'Rendering scanned PDFs to images requires the optional "@napi-rs/canvas" package. ' +
      'Install it with `npm install @napi-rs/canvas`, or upload the pages as JPEG/PNG images instead.'
    )
  })

  const loadingTask = getDocument({
    // Same copy requirement as extractNativePdfText above — a zero-copy
    // view here would risk the same detached-buffer crash if this is ever
    // called after another pdf.js load shared the same backing buffer.
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    verbosity: 0,
  })
  const doc = await loadingTask.promise
  try {
    const buffers: Buffer[] = []
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum)
      // PDF's native unit is 72 DPI; Tesseract's own documentation
      // recommends ~300 DPI as the accuracy sweet spot for OCR (materially
      // better character recognition on small body text than the previous
      // scale: 2 / 144 DPI, at a still-reasonable memory/CPU cost for a
      // typical 1-3 page itinerary).
      const viewport = page.getViewport({ scale: 300 / 72 })
      const canvas = createCanvas(viewport.width, viewport.height)
      const context = canvas.getContext('2d')
      await page.render({
        // node-canvas's Canvas/2D context are runtime-compatible with the DOM
        // types pdfjs expects, but not structurally identical — cast at the boundary.
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise
      buffers.push(canvas.toBuffer('image/png'))
    }
    return buffers
  } finally {
    await loadingTask.destroy()
  }
}
