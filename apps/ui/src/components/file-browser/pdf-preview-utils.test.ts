/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'
import {
  buildPdfRawUrl,
  clampPageNumber,
  computeCurrentPageFromScroll,
  computeFitWidthScale,
  computeFitWidthScaleForPages,
  computePdfRenderScale,
  computeSafeCanvasOutput,
  formatPdfPreviewError,
  isPdfPreviewRenderSizeError,
  PDF_PREVIEW_CANVAS_TOO_LARGE_MESSAGE,
  PDF_PREVIEW_MAX_RENDER_SCALE,
  PdfPreviewRenderSizeError,
  releasePdfPreviewCanvasMemory,
} from './pdf-preview-utils'

describe('buildPdfRawUrl', () => {
  it('includes agentId, path, and optional worktreeId', () => {
    const url = buildPdfRawUrl('ws://127.0.0.1:47187', 'docs/spec.pdf', 'session-a', 'feature-linked')
    expect(url).toContain('/api/files/raw?')
    expect(url).toContain('agentId=session-a')
    expect(url).toContain('path=docs%2Fspec.pdf')
    expect(url).toContain('worktreeId=feature-linked')
  })

  it('omits worktreeId for session browsing', () => {
    const url = buildPdfRawUrl('ws://127.0.0.1:47187', 'docs/spec.pdf', 'session-a', null)
    expect(url).not.toContain('worktreeId=')
  })
})

describe('formatPdfPreviewError', () => {
  it('maps password-protected PDFs to a specific message', () => {
    const error = new Error('No password given')
    error.name = 'PasswordException'
    expect(formatPdfPreviewError(error)).toBe('This PDF is password-protected and cannot be previewed.')
  })

  it('truncates long generic errors', () => {
    expect(formatPdfPreviewError(new Error('x'.repeat(130))).endsWith('…')).toBe(true)
  })
})

describe('computeFitWidthScale', () => {
  it('fits page width into the available container width', () => {
    expect(computeFitWidthScale(400, 432, 32)).toBe(1)
  })
})

describe('computePdfRenderScale', () => {
  it('caps fit-width scale to the manual zoom maximum', () => {
    expect(computePdfRenderScale(10, 1000, 1, true, PDF_PREVIEW_MAX_RENDER_SCALE)).toBe(4)
  })

  it('uses manual scale when fit width is disabled', () => {
    expect(computePdfRenderScale(400, 432, 2, false)).toBe(2)
  })
})

describe('computeFitWidthScaleForPages', () => {
  it('uses the widest page width when computing fit-width scale', () => {
    expect(computeFitWidthScaleForPages([400, 800, 500], 832, PDF_PREVIEW_MAX_RENDER_SCALE)).toBe(1)
    expect(computeFitWidthScaleForPages([400, 1200, 500], 832, PDF_PREVIEW_MAX_RENDER_SCALE)).toBeCloseTo(
      800 / 1200,
    )
  })
})

describe('PdfPreviewRenderSizeError', () => {
  it('is recognized by isPdfPreviewRenderSizeError', () => {
    const error = new PdfPreviewRenderSizeError()
    expect(isPdfPreviewRenderSizeError(error)).toBe(true)
    expect(error.message).toBe(PDF_PREVIEW_CANVAS_TOO_LARGE_MESSAGE)
  })
})

describe('computeSafeCanvasOutput', () => {
  it('preserves device pixel ratio for normal page sizes', () => {
    expect(
      computeSafeCanvasOutput(800, 1100, 2, {
        maxDimension: 8192,
        maxPixels: 16_777_216,
      }),
    ).toEqual({
      ok: true,
      outputScale: 2,
      canvasWidth: 1600,
      canvasHeight: 2200,
    })
  })

  it('reduces output scale when canvas dimensions exceed limits', () => {
    const result = computeSafeCanvasOutput(5000, 7000, 2, {
      maxDimension: 8192,
      maxPixels: 16_777_216,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.canvasWidth).toBeLessThanOrEqual(8192)
      expect(result.canvasHeight).toBeLessThanOrEqual(8192)
      expect(result.outputScale).toBeLessThan(2)
    }
  })

  it('returns a friendly error when the page cannot be rendered safely', () => {
    expect(
      computeSafeCanvasOutput(20_000, 30_000, 4, {
        maxDimension: 8192,
        maxPixels: 16_777_216,
        minOutputScale: 0.25,
      }),
    ).toEqual({
      ok: false,
      message: PDF_PREVIEW_CANVAS_TOO_LARGE_MESSAGE,
    })
  })
})

describe('clampPageNumber', () => {
  it('keeps page numbers within bounds', () => {
    expect(clampPageNumber(0, 5)).toBe(1)
    expect(clampPageNumber(3, 5)).toBe(3)
    expect(clampPageNumber(9, 5)).toBe(5)
  })
})

describe('releasePdfPreviewCanvasMemory', () => {
  it('clears canvas bitmap memory and inline dimensions', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 1100
    canvas.style.width = '800px'
    canvas.style.height = '1100px'

    releasePdfPreviewCanvasMemory(canvas)

    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(canvas.style.width).toBe('')
    expect(canvas.style.height).toBe('')
  })
})

describe('computeCurrentPageFromScroll', () => {
  const pages = [
    { pageNumber: 1, offsetTop: 0, height: 280 },
    { pageNumber: 2, offsetTop: 296, height: 280 },
    { pageNumber: 3, offsetTop: 592, height: 280 },
  ]

  it('returns the page aligned with the top of the viewport', () => {
    expect(computeCurrentPageFromScroll(0, 600, pages)).toBe(1)
    expect(computeCurrentPageFromScroll(350, 600, pages)).toBe(2)
    expect(computeCurrentPageFromScroll(650, 600, pages)).toBe(3)
  })
})
