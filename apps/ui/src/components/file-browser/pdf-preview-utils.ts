import { resolveApiEndpoint } from '@/lib/api-endpoint'

export const PDF_PREVIEW_MAX_RENDER_SCALE = 4
export const PDF_PREVIEW_MAX_CANVAS_DIMENSION = 8192
export const PDF_PREVIEW_MAX_CANVAS_PIXELS = 16_777_216
export const PDF_PREVIEW_MIN_OUTPUT_SCALE = 0.25

export function buildPdfRawUrl(
  wsUrl: string,
  filePath: string,
  agentId: string,
  worktreeId?: string | null,
): string {
  const params = new URLSearchParams({ path: filePath, agentId })
  if (worktreeId) {
    params.set('worktreeId', worktreeId)
  }
  return resolveApiEndpoint(wsUrl, `/api/files/raw?${params.toString()}`)
}

export const PDF_PREVIEW_CANVAS_TOO_LARGE_MESSAGE =
  'This PDF page is too large to preview at the current zoom. Use Fit or zoom out below, or open the raw file instead.'

export class PdfPreviewRenderSizeError extends Error {
  constructor(message = PDF_PREVIEW_CANVAS_TOO_LARGE_MESSAGE) {
    super(message)
    this.name = 'PdfPreviewRenderSizeError'
  }
}

export function isPdfPreviewRenderSizeError(error: unknown): error is PdfPreviewRenderSizeError {
  return error instanceof PdfPreviewRenderSizeError
}

export function formatPdfPreviewError(error: unknown): string {
  if (error instanceof Error && error.name === 'PasswordException') {
    return 'This PDF is password-protected and cannot be previewed.'
  }

  const message = error instanceof Error ? error.message : 'Unknown error'
  return message.length > 120 ? `${message.slice(0, 117)}…` : message
}

export function computeFitWidthScale(pageWidth: number, containerWidth: number, padding = 32): number {
  const availableWidth = Math.max(containerWidth - padding, 1)
  return Math.max(availableWidth / Math.max(pageWidth, 1), 0.1)
}

export function computePdfRenderScale(
  pageWidth: number,
  containerWidth: number,
  manualScale: number,
  fitWidth: boolean,
  maxScale = PDF_PREVIEW_MAX_RENDER_SCALE,
  padding = 32,
): number {
  if (fitWidth) {
    return Math.min(computeFitWidthScale(pageWidth, containerWidth, padding), maxScale)
  }

  return manualScale
}

export function releasePdfPreviewCanvasMemory(canvas: HTMLCanvasElement | null): void {
  if (!canvas) {
    return
  }

  canvas.width = 0
  canvas.height = 0
  canvas.style.removeProperty('width')
  canvas.style.removeProperty('height')
}

export type SafeCanvasOutput =
  | {
      ok: true
      outputScale: number
      canvasWidth: number
      canvasHeight: number
    }
  | {
      ok: false
      message: string
    }

export function computeSafeCanvasOutput(
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
  options?: {
    maxDimension?: number
    maxPixels?: number
    minOutputScale?: number
  },
): SafeCanvasOutput {
  const maxDimension = options?.maxDimension ?? PDF_PREVIEW_MAX_CANVAS_DIMENSION
  const maxPixels = options?.maxPixels ?? PDF_PREVIEW_MAX_CANVAS_PIXELS
  const minOutputScale = options?.minOutputScale ?? PDF_PREVIEW_MIN_OUTPUT_SCALE

  const cssWidth = Math.max(viewportWidth, 1)
  const cssHeight = Math.max(viewportHeight, 1)
  let outputScale = Math.max(devicePixelRatio, minOutputScale)

  let canvasWidth = Math.floor(cssWidth * outputScale)
  let canvasHeight = Math.floor(cssHeight * outputScale)

  const reduceScale = (factor: number) => {
    outputScale = Math.max(outputScale * factor, minOutputScale)
    canvasWidth = Math.floor(cssWidth * outputScale)
    canvasHeight = Math.floor(cssHeight * outputScale)
  }

  if (canvasWidth > maxDimension || canvasHeight > maxDimension) {
    const dimensionScale = Math.min(maxDimension / canvasWidth, maxDimension / canvasHeight)
    reduceScale(dimensionScale)
  }

  while (canvasWidth * canvasHeight > maxPixels && outputScale > minOutputScale) {
    const pixelScale = Math.sqrt(maxPixels / (canvasWidth * canvasHeight))
    reduceScale(Math.min(pixelScale, 0.5))
  }

  if (
    canvasWidth <= 0 ||
    canvasHeight <= 0 ||
    canvasWidth > maxDimension ||
    canvasHeight > maxDimension ||
    canvasWidth * canvasHeight > maxPixels
  ) {
    return { ok: false, message: PDF_PREVIEW_CANVAS_TOO_LARGE_MESSAGE }
  }

  return {
    ok: true,
    outputScale,
    canvasWidth,
    canvasHeight,
  }
}

export function clampPageNumber(page: number, numPages: number): number {
  if (numPages <= 0) {
    return 1
  }

  return Math.min(Math.max(page, 1), numPages)
}

export type PdfPreviewPageLayout = {
  pageNumber: number
  offsetTop: number
  height: number
}

export type PdfPreviewPageMetrics = {
  width: number
  height: number
}

export function computeCurrentPageFromScroll(
  scrollTop: number,
  viewportHeight: number,
  pages: readonly PdfPreviewPageLayout[],
): number {
  if (pages.length === 0) {
    return 1
  }

  const anchor = scrollTop + Math.min(72, Math.max(viewportHeight * 0.15, 1))
  let currentPage = pages[0]?.pageNumber ?? 1

  for (const page of pages) {
    if (page.offsetTop <= anchor) {
      currentPage = page.pageNumber
      continue
    }
    break
  }

  return currentPage
}
