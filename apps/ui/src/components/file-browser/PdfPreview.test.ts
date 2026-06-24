/** @vitest-environment jsdom */

import { createElement, act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDF_PREVIEW_CANVAS_TOO_LARGE_MESSAGE } from './pdf-preview-utils'
import * as pdfPreviewUtils from './pdf-preview-utils'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  mockRenderCancel,
  mockRender,
  mockGetPage,
  mockPdfDestroy,
  mockLoadingDestroy,
  mockGetDocument,
  mockPdf,
} = vi.hoisted(() => {
  const mockRenderCancel = vi.fn()
  const mockRender = vi.fn(() => ({
    promise: Promise.resolve(),
    cancel: mockRenderCancel,
  }))
  const mockGetPage = vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 200 * scale,
      height: 280 * scale,
    }),
    render: mockRender,
  }))
  const mockPdfDestroy = vi.fn()
  const mockPdf = {
    numPages: 3,
    getPage: mockGetPage,
    destroy: mockPdfDestroy,
  }
  const mockLoadingDestroy = vi.fn()
  const mockGetDocument = vi.fn(() => ({
    promise: Promise.resolve(mockPdf),
    destroy: mockLoadingDestroy,
  }))

  return {
    mockRenderCancel,
    mockRender,
    mockGetPage,
    mockPdfDestroy,
    mockLoadingDestroy,
    mockGetDocument,
    mockPdf,
  }
})

vi.mock('./pdfjs-preview-lib', () => ({
  pdfjsLib: {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: mockGetDocument,
  },
}))

import { PdfPreview } from './PdfPreview'

let container: HTMLDivElement
let root: Root | null = null
let intersectionObserverCallback: IntersectionObserverCallback | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  class ResizeObserverMock {
    constructor(private callback: ResizeObserverCallback) {}

    observe(element: Element) {
      Object.defineProperty(element, 'clientWidth', {
        configurable: true,
        value: 800,
      })
      Object.defineProperty(element, 'clientHeight', {
        configurable: true,
        value: 600,
      })
      this.callback(
        [{ target: element } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
    }

    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  class IntersectionObserverMock {
    constructor(callback: IntersectionObserverCallback) {
      intersectionObserverCallback = callback
    }

    observe(element: Element) {
      intersectionObserverCallback?.(
        [{ isIntersecting: true, target: element } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    }

    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  Element.prototype.scrollIntoView = vi.fn()
  mockRender.mockClear()
  mockRenderCancel.mockClear()
  mockGetPage.mockClear()
  mockGetDocument.mockClear()
  mockPdfDestroy.mockClear()
  mockLoadingDestroy.mockClear()
  mockGetPage.mockImplementation(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 200 * scale,
      height: 280 * scale,
    }),
    render: mockRender,
  }))
  mockGetDocument.mockImplementation(() => ({
    promise: Promise.resolve(mockPdf),
    destroy: mockLoadingDestroy,
  }))
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 1,
  })
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      flushSync(() => root?.unmount())
    })
  }
  root = null
  container.remove()
  intersectionObserverCallback = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function renderPreview(worktreeId?: string | null) {
  root ??= createRoot(container)
  await act(async () => {
    flushSync(() => {
      root?.render(
        createElement(PdfPreview, {
          wsUrl: 'ws://127.0.0.1:47187',
          filePath: 'docs/spec.pdf',
          agentId: 'session-a',
          worktreeId,
        }),
      )
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('PdfPreview raw route URL', () => {
  it('includes worktreeId in the raw file URL when browsing a linked worktree', async () => {
    await renderPreview('feature-linked')

    const preview = container.querySelector('[data-testid="pdf-preview"]')
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute('data-pdf-url')).toContain('/api/files/raw?')
    expect(preview?.getAttribute('data-pdf-url')).toContain('worktreeId=feature-linked')
    expect(preview?.getAttribute('data-pdf-url')).toContain('path=docs%2Fspec.pdf')
    expect(preview?.getAttribute('data-pdf-url')).toContain('agentId=session-a')
  })

  it('omits worktreeId from the raw file URL for session browsing', async () => {
    await renderPreview(null)

    const preview = container.querySelector('[data-testid="pdf-preview"]')
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute('data-pdf-url')).not.toContain('worktreeId=')
  })
})

describe('PdfPreview PDF.js rendering', () => {
  it('loads the document from the raw route and renders a continuous scroll stack', async () => {
    await renderPreview()

    expect(mockGetDocument).toHaveBeenCalledWith({
      url: expect.stringContaining('/api/files/raw?'),
      disableAutoFetch: false,
      rangeChunkSize: 65536,
    })
    expect(container.querySelector('[data-testid="pdf-preview-controls"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pdf-preview-page-indicator"]')?.textContent).toBe(
      'Page 1 / 3',
    )
    expect(container.querySelector('[data-testid="pdf-preview-pages"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-page-number]')).toHaveLength(3)
    expect(container.querySelector('[data-testid="pdf-preview-viewport"]')).not.toBeNull()
    expect(mockRender).toHaveBeenCalled()
  })

  it('keeps controls visible with sticky layout classes', async () => {
    await renderPreview()

    const preview = container.querySelector('[data-testid="pdf-preview"]')
    const controls = container.querySelector('[data-testid="pdf-preview-controls"]')
    const viewport = container.querySelector('[data-testid="pdf-preview-viewport"]')

    expect(preview?.className).toContain('overflow-hidden')
    expect(preview?.className).toContain('min-h-0')
    expect(controls?.className).toContain('shrink-0')
    expect(viewport?.className).toContain('overflow-y-auto')
  })

  it('scrolls to adjacent pages when using page navigation buttons', async () => {
    await renderPreview()

    const nextButton = container.querySelector('[aria-label="Next page"]') as HTMLButtonElement
    const prevButton = container.querySelector('[aria-label="Previous page"]') as HTMLButtonElement

    expect(prevButton.disabled).toBe(true)
    await act(async () => {
      nextButton.click()
      await Promise.resolve()
    })
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="pdf-preview-page-indicator"]')?.textContent).toBe(
      'Page 2 / 3',
    )

    await act(async () => {
      nextButton.click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="pdf-preview-page-indicator"]')?.textContent).toBe(
      'Page 3 / 3',
    )
    expect(nextButton.disabled).toBe(true)
  })

  it('updates the page indicator from scroll position', async () => {
    await renderPreview()

    const viewport = container.querySelector('[data-testid="pdf-preview-viewport"]') as HTMLDivElement
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 350 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 })

    for (const [pageNumber, offsetTop, height] of [
      [1, 0, 280],
      [2, 296, 280],
      [3, 592, 280],
    ] as const) {
      const page = container.querySelector(`[data-page-number="${pageNumber}"]`) as HTMLElement
      Object.defineProperty(page, 'offsetTop', { configurable: true, value: offsetTop })
      Object.defineProperty(page, 'offsetHeight', { configurable: true, value: height })
    }

    await act(async () => {
      viewport.dispatchEvent(new Event('scroll'))
    })

    expect(container.querySelector('[data-testid="pdf-preview-page-indicator"]')?.textContent).toBe(
      'Page 2 / 3',
    )
  })

  it('shows an error state when document loading fails', async () => {
    mockGetDocument.mockImplementationOnce(() => ({
      promise: Promise.reject(new Error('Network failure')),
      destroy: mockLoadingDestroy,
    }))

    await renderPreview()

    expect(container.textContent).toContain('Failed to load PDF')
    expect(container.textContent).toContain('Network failure')
    const openRaw = container.querySelector('[data-testid="pdf-preview-open-raw"]') as HTMLAnchorElement
    expect(openRaw.href).toContain('/api/files/raw?')
    expect(openRaw.getAttribute('target')).toBe('_blank')
    expect(openRaw.getAttribute('rel')).toBe('noreferrer')
  })

  it('keeps zoom controls available when canvas output exceeds safe limits', async () => {
    vi.spyOn(pdfPreviewUtils, 'computeSafeCanvasOutput').mockImplementation(
      (viewportWidth, viewportHeight) => {
        if (viewportHeight > 900) {
          return {
            ok: false,
            message: PDF_PREVIEW_CANVAS_TOO_LARGE_MESSAGE,
          }
        }
        return {
          ok: true,
          outputScale: 1,
          canvasWidth: viewportWidth,
          canvasHeight: viewportHeight,
        }
      },
    )

    await renderPreview()

    expect(container.querySelector('[data-testid="pdf-preview-controls"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pdf-preview-render-error"]')).not.toBeNull()
    expect(container.textContent).toContain('Unable to render page 1')
    expect(container.textContent).toContain(PDF_PREVIEW_CANVAS_TOO_LARGE_MESSAGE)
    expect(container.textContent).not.toContain('Failed to load PDF')
    expect(mockRender).not.toHaveBeenCalled()

    const openRaw = container.querySelector('[data-testid="pdf-preview-open-raw"]') as HTMLAnchorElement
    expect(openRaw.href).toContain('/api/files/raw?')
    expect(openRaw.getAttribute('target')).toBe('_blank')
    expect(openRaw.getAttribute('rel')).toBe('noreferrer')

    const zoomOutButton = container.querySelector('[aria-label="Zoom out"]') as HTMLButtonElement
    await act(async () => {
      zoomOutButton.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="pdf-preview-render-error"]')).toBeNull()
    expect(mockRender).toHaveBeenCalled()
  })

  it('cancels render tasks on unmount', async () => {
    await renderPreview()
    expect(mockRender).toHaveBeenCalled()

    await act(async () => {
      flushSync(() => root?.unmount())
      root = null
      await Promise.resolve()
    })

    expect(mockRenderCancel).toHaveBeenCalled()
    expect(mockPdfDestroy).toHaveBeenCalled()
  })
})
