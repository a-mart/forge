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
  const mockGetPage = vi.fn(async (pageNumber: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: (pageNumber === 2 ? 400 : 200) * scale,
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
const intersectionState = new Map<Element, boolean>()
const observerCallbacks = new Map<Element, IntersectionObserverCallback>()

function notifyIntersection(element: Element) {
  observerCallbacks.get(element)?.(
    [{ isIntersecting: intersectionState.get(element) ?? false, target: element } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  intersectionState.clear()
  observerCallbacks.clear()
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
    constructor(private callback: IntersectionObserverCallback) {}

    observe(element: Element) {
      observerCallbacks.set(element, this.callback)
      const pageNumber = (element as HTMLElement).dataset.pageNumber
      if (!intersectionState.has(element)) {
        intersectionState.set(element, pageNumber === '1')
      }
      notifyIntersection(element)
    }

    disconnect() {
      for (const [element, callback] of observerCallbacks.entries()) {
        if (callback === this.callback) {
          observerCallbacks.delete(element)
        }
      }
    }
    unobserve(element: Element) {
      intersectionState.delete(element)
      observerCallbacks.delete(element)
    }
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
  mockGetPage.mockImplementation(async (pageNumber: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: (pageNumber === 2 ? 400 : 200) * scale,
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
  intersectionState.clear()
  observerCallbacks.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'electronBridge')
})

const FILES_PDF_URL = 'http://127.0.0.1:47187/api/files/raw?path=docs%2Fspec.pdf&agentId=session-a'
const WORKTREE_PDF_URL = `${FILES_PDF_URL}&worktreeId=feature-linked`

async function renderPreview(options?: {
  sourceUrl?: string
  nativeFilePath?: string | null
  openUrl?: string | null
}) {
  root ??= createRoot(container)
  await act(async () => {
    flushSync(() => {
      root?.render(
        createElement(PdfPreview, {
          sourceUrl: options?.sourceUrl ?? FILES_PDF_URL,
          fileName: 'spec.pdf',
          nativeFilePath: options && 'nativeFilePath' in options
            ? options.nativeFilePath
            : '/repo/docs/spec.pdf',
          openUrl: options?.openUrl ?? options?.sourceUrl ?? FILES_PDF_URL,
        }),
      )
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function setPageIntersection(pageNumber: number, intersecting: boolean) {
  const page = container.querySelector(`[data-page-number="${pageNumber}"]`)
  if (!page) {
    throw new Error(`Missing page wrapper for page ${pageNumber}`)
  }

  intersectionState.set(page, intersecting)
  await act(async () => {
    notifyIntersection(page)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('PdfPreview source URL', () => {
  it('renders from an explicit source URL, including worktree-scoped Files URLs', async () => {
    await renderPreview({ sourceUrl: WORKTREE_PDF_URL, openUrl: WORKTREE_PDF_URL })

    const preview = container.querySelector('[data-testid="pdf-preview"]')
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute('data-pdf-url')).toBe(WORKTREE_PDF_URL)
    expect(preview?.getAttribute('data-pdf-url')).toContain('/api/files/raw?')
    expect(preview?.getAttribute('data-pdf-url')).toContain('worktreeId=feature-linked')
  })

  it('omits worktreeId from the Files raw URL for session browsing', async () => {
    await renderPreview()

    const preview = container.querySelector('[data-testid="pdf-preview"]')
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute('data-pdf-url')).toBe(FILES_PDF_URL)
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
    expect(mockRender).toHaveBeenCalledTimes(1)
    expect(mockGetPage).toHaveBeenCalledWith(1)
    expect(mockGetPage).not.toHaveBeenCalledWith(2)
    expect(mockGetPage).not.toHaveBeenCalledWith(3)
  })

  it('becomes ready without eagerly fetching metrics for every page', async () => {
    mockPdf.numPages = 25
    mockGetPage.mockClear()

    await renderPreview()

    expect(container.querySelector('[data-testid="pdf-preview-controls"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pdf-preview-page-indicator"]')?.textContent).toBe(
      'Page 1 / 25',
    )
    expect(mockGetPage).toHaveBeenCalledTimes(1)
    expect(mockGetPage).toHaveBeenCalledWith(1)
    for (let pageNumber = 2; pageNumber <= 25; pageNumber += 1) {
      expect(mockGetPage).not.toHaveBeenCalledWith(pageNumber)
    }

    mockPdf.numPages = 3
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
    expect(viewport?.className).toContain('overflow-x-hidden')
  })

  it('enables horizontal scrolling during manual zoom', async () => {
    await renderPreview()

    const zoomInButton = container.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement
    await act(async () => {
      zoomInButton.click()
      await Promise.resolve()
    })

    const viewport = container.querySelector('[data-testid="pdf-preview-viewport"]')
    expect(viewport?.className).toContain('overflow-x-auto')
    expect(viewport?.className).not.toContain('overflow-x-hidden')
  })

  it('does not render offscreen pages until they intersect', async () => {
    await renderPreview()

    expect(mockRender).toHaveBeenCalledTimes(1)

    await setPageIntersection(2, true)
    expect(mockGetPage).toHaveBeenCalledWith(2)
    expect(mockRender).toHaveBeenCalledTimes(2)
  })

  it('uses discovered page metrics on the first render of an unmeasured wider page', async () => {
    await renderPreview()
    mockRender.mockClear()

    await setPageIntersection(2, true)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockRender).toHaveBeenCalledTimes(1)
    type RenderCall = { viewport: { height: number } }
    const firstRender = (mockRender.mock.calls[0] as unknown as [RenderCall])[0]
    const expectedHeight = 280 * (768 / 400)
    const oversizedDefaultHeight = 280 * (768 / 200)
    expect(firstRender.viewport.height).toBeCloseTo(expectedHeight, 1)
    expect(firstRender.viewport.height).not.toBeCloseTo(oversizedDefaultHeight, 1)
  })

  it('releases canvas memory when a page leaves the render range', async () => {
    await renderPreview()

    const canvas = container.querySelector(
      '[data-testid="pdf-preview-page-canvas-1"]',
    ) as HTMLCanvasElement
    expect(canvas.width).toBeGreaterThan(0)

    await setPageIntersection(1, false)

    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(canvas.style.width).toBe('')
  })

  it('re-renders a page after it re-enters the render range', async () => {
    await renderPreview()
    expect(mockRender).toHaveBeenCalledTimes(1)

    await setPageIntersection(1, false)
    await setPageIntersection(1, true)

    expect(mockRender).toHaveBeenCalledTimes(2)
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
    const openRaw = container.querySelector('[data-testid="pdf-preview-open-raw"]') as HTMLButtonElement
    expect(openRaw).not.toBeNull()
    expect(openRaw.tagName).toBe('BUTTON')
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

    const openRaw = container.querySelector('[data-testid="pdf-preview-open-raw"]') as HTMLButtonElement
    expect(openRaw).not.toBeNull()
    expect(openRaw.tagName).toBe('BUTTON')

    const zoomOutButton = container.querySelector('[aria-label="Zoom out"]') as HTMLButtonElement
    await act(async () => {
      zoomOutButton.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="pdf-preview-render-error"]')).toBeNull()
    expect(mockRender).toHaveBeenCalled()
  })

  it('opens an absolute Files path through the native PDF bridge', async () => {
    const openPdfInDefaultApp = vi.fn(async () => ({ success: true as const }))
    const windowOpen = vi.fn()
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        windowRole: 'main',
        backendWsUrl: 'ws://127.0.0.1/socket',
        openPdfInDefaultApp,
      },
    })
    vi.stubGlobal('open', windowOpen)

    await renderPreview()
    const openRaw = container.querySelector('[data-testid="pdf-preview-open-raw"]') as HTMLButtonElement
    await act(async () => {
      openRaw.click()
      await Promise.resolve()
    })

    expect(openPdfInDefaultApp).toHaveBeenCalledWith({ filePath: '/repo/docs/spec.pdf' })
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('materializes a transcript blob PDF through the native PDF bridge instead of window.open', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
    const openPdfInDefaultApp = vi.fn(async () => ({ success: true as const }))
    const windowOpen = vi.fn()
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        windowRole: 'main',
        backendWsUrl: 'ws://127.0.0.1/socket',
        openPdfInDefaultApp,
      },
    })
    vi.stubGlobal('open', windowOpen)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pdfBytes, { status: 200 })))

    await renderPreview({
      sourceUrl: 'blob:https://forge.example.test/pdf',
      nativeFilePath: null,
      openUrl: 'blob:https://forge.example.test/pdf',
    })
    const openRaw = container.querySelector('[data-testid="pdf-preview-open-raw"]') as HTMLButtonElement
    await act(async () => {
      openRaw.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(openPdfInDefaultApp).toHaveBeenCalledWith({
      bytes: pdfBytes,
      fileName: 'spec.pdf',
    })
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('surfaces a native PDF open failure instead of claiming success', async () => {
    const openPdfInDefaultApp = vi.fn(async () => ({ success: false as const, error: 'No application found' }))
    const windowOpen = vi.fn()
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        windowRole: 'main',
        backendWsUrl: 'ws://127.0.0.1/socket',
        openPdfInDefaultApp,
      },
    })
    vi.stubGlobal('open', windowOpen)

    await renderPreview({ nativeFilePath: '/repo/docs/spec.pdf', openUrl: '' })
    const openRaw = container.querySelector('[data-testid="pdf-preview-open-raw"]') as HTMLButtonElement
    await act(async () => {
      openRaw.click()
      await Promise.resolve()
    })

    expect(windowOpen).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="pdf-preview-open-error"]')?.textContent).toBe('No application found')
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
