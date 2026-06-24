import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import '@/styles/file-browser.css'
import { pdfjsLib, type PDFDocumentProxy } from './pdfjs-preview-lib'
import {
  buildPdfRawUrl,
  clampPageNumber,
  computeCurrentPageFromScroll,
  computePdfRenderScale,
  computeSafeCanvasOutput,
  formatPdfPreviewError,
  isPdfPreviewRenderSizeError,
  PDF_PREVIEW_MAX_RENDER_SCALE,
  PdfPreviewRenderSizeError,
  type PdfPreviewPageLayout,
} from './pdf-preview-utils'

interface PdfPreviewProps {
  wsUrl: string
  filePath: string
  agentId: string
  worktreeId?: string | null
}

const ZOOM_STEP = 1.25
const MIN_MANUAL_SCALE = 0.25
const MAX_MANUAL_SCALE = PDF_PREVIEW_MAX_RENDER_SCALE
const PAGE_PREFETCH_MARGIN = 200
const PAGE_GAP_PX = 16

type PageRenderTask = { cancel: () => void; promise: Promise<void> }

interface PdfPreviewPageProps {
  pageNumber: number
  pdf: PDFDocumentProxy
  renderScale: number
  estimatedHeight: number
  scrollRoot: HTMLDivElement | null
  onLayoutChange: (pageNumber: number, height: number) => void
}

function PdfPreviewPage({
  pageNumber,
  pdf,
  renderScale,
  estimatedHeight,
  scrollRoot,
  onLayoutChange,
}: PdfPreviewPageProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<PageRenderTask | null>(null)
  const [shouldRender, setShouldRender] = useState(false)
  const [renderErrorMessage, setRenderErrorMessage] = useState<string | null>(null)
  const [renderedHeight, setRenderedHeight] = useState<number | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !scrollRoot) {
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setShouldRender(entry?.isIntersecting ?? false)
      },
      {
        root: scrollRoot,
        rootMargin: `${PAGE_PREFETCH_MARGIN}px 0px`,
      },
    )
    observer.observe(container)

    return () => observer.disconnect()
  }, [scrollRoot, pageNumber])

  useEffect(() => {
    if (!shouldRender) {
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      return
    }

    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        setRenderErrorMessage(null)
        renderTaskRef.current?.cancel()
        renderTaskRef.current = null

        const page = await pdf.getPage(pageNumber)
        if (cancelled) {
          return
        }

        const viewport = page.getViewport({ scale: renderScale })
        const context = canvas.getContext('2d')
        if (!context || cancelled) {
          return
        }

        const safeCanvas = computeSafeCanvasOutput(
          viewport.width,
          viewport.height,
          window.devicePixelRatio || 1,
        )
        if (!safeCanvas.ok) {
          throw new PdfPreviewRenderSizeError(safeCanvas.message)
        }

        canvas.width = safeCanvas.canvasWidth
        canvas.height = safeCanvas.canvasHeight
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`

        context.setTransform(safeCanvas.outputScale, 0, 0, safeCanvas.outputScale, 0, 0)
        context.clearRect(0, 0, viewport.width, viewport.height)

        const renderTask = page.render({
          canvasContext: context,
          viewport,
        })
        renderTaskRef.current = renderTask
        await renderTask.promise

        if (cancelled) {
          return
        }

        setRenderedHeight(viewport.height)
        onLayoutChange(pageNumber, viewport.height)
      } catch (error) {
        if (cancelled || (error instanceof Error && error.name === 'RenderingCancelledException')) {
          return
        }

        if (isPdfPreviewRenderSizeError(error)) {
          setRenderErrorMessage(error.message)
          return
        }

        setRenderErrorMessage(formatPdfPreviewError(error))
      }
    })()

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [shouldRender, pageNumber, pdf, renderScale, onLayoutChange])

  const placeholderHeight = renderedHeight ?? estimatedHeight

  return (
    <div
      ref={containerRef}
      className="relative flex w-full justify-center"
      data-page-number={pageNumber}
      data-testid={`pdf-preview-page-${pageNumber}`}
      style={{ minHeight: placeholderHeight }}
    >
      <canvas
        ref={canvasRef}
        className={cn(
          'rounded border border-border/50 bg-white shadow-sm',
          renderErrorMessage && 'invisible absolute',
        )}
      />
      {renderErrorMessage ? (
        <div
          className="flex max-w-md flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground"
          data-testid="pdf-preview-render-error"
          role="alert"
        >
          <p className="text-sm text-destructive/80">Unable to render page {pageNumber}</p>
          <p className="text-xs opacity-70">{renderErrorMessage}</p>
        </div>
      ) : null}
    </div>
  )
}

export function PdfPreview({ wsUrl, filePath, agentId, worktreeId = null }: PdfPreviewProps) {
  const pdfUrl = useMemo(
    () => buildPdfRawUrl(wsUrl, filePath, agentId, worktreeId),
    [wsUrl, filePath, agentId, worktreeId],
  )

  const fileName = filePath.split('/').pop() ?? 'Document.pdf'

  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [manualScale, setManualScale] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)
  const [basePageWidth, setBasePageWidth] = useState(0)
  const [basePageHeight, setBasePageHeight] = useState(0)
  const [pageHeights, setPageHeights] = useState<Record<number, number>>({})

  const viewportRef = useRef<HTMLDivElement>(null)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const loadEpochRef = useRef(0)

  const handleReload = useCallback(() => {
    setReloadToken((value) => value + 1)
  }, [])

  const renderScale = useMemo(
    () =>
      computePdfRenderScale(
        basePageWidth,
        viewportWidth,
        manualScale,
        fitWidth,
        MAX_MANUAL_SCALE,
      ),
    [basePageWidth, viewportWidth, manualScale, fitWidth],
  )

  const estimatedPageHeight = useMemo(() => {
    if (basePageHeight <= 0 || renderScale <= 0) {
      return 280
    }
    return basePageHeight * renderScale
  }, [basePageHeight, renderScale])

  const handlePageLayoutChange = useCallback((pageNumber: number, height: number) => {
    setPageHeights((previous) => {
      if (previous[pageNumber] === height) {
        return previous
      }
      return { ...previous, [pageNumber]: height }
    })
  }, [])

  const collectPageLayouts = useCallback((): PdfPreviewPageLayout[] => {
    const viewport = viewportRef.current
    if (!viewport) {
      return []
    }

    const pagesContainer = viewport.querySelector<HTMLElement>('[data-testid="pdf-preview-pages"]')
    const pageElements = pagesContainer?.querySelectorAll<HTMLElement>('[data-page-number]') ?? []
    const layouts: PdfPreviewPageLayout[] = []
    let runningOffset = pagesContainer?.offsetTop ?? 0

    for (const element of pageElements) {
      const pageNumber = Number(element.dataset.pageNumber)
      if (!Number.isFinite(pageNumber)) {
        continue
      }

      const height =
        element.offsetHeight > 0
          ? element.offsetHeight
          : pageHeights[pageNumber] ?? estimatedPageHeight

      layouts.push({
        pageNumber,
        offsetTop: runningOffset,
        height,
      })
      runningOffset += height + PAGE_GAP_PX
    }

    return layouts
  }, [estimatedPageHeight, pageHeights])

  const updateCurrentPageFromScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const nextPage = computeCurrentPageFromScroll(
      viewport.scrollTop,
      viewport.clientHeight,
      collectPageLayouts(),
    )
    setCurrentPage((previous) => (previous === nextPage ? previous : nextPage))
  }, [collectPageLayouts])

  const scrollToPage = useCallback((pageNumber: number) => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const target = viewport.querySelector<HTMLElement>(`[data-page-number="${pageNumber}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  useEffect(() => {
    const epoch = ++loadEpochRef.current
    let cancelled = false

    setLoadState('loading')
    setErrorMessage(null)
    setNumPages(0)
    setCurrentPage(1)
    setFitWidth(true)
    setManualScale(1)
    setBasePageWidth(0)
    setBasePageHeight(0)
    setPageHeights({})

    pdfDocRef.current?.destroy()
    pdfDocRef.current = null
    setPdfDoc(null)

    const loadingTask = pdfjsLib.getDocument({
      url: pdfUrl,
      disableAutoFetch: false,
      rangeChunkSize: 65536,
    })

    void loadingTask.promise
      .then(async (pdf) => {
        if (cancelled || epoch !== loadEpochRef.current) {
          void pdf.destroy()
          return
        }

        pdfDocRef.current = pdf
        setPdfDoc(pdf)
        setNumPages(pdf.numPages)
        setCurrentPage(1)

        try {
          const firstPage = await pdf.getPage(1)
          if (cancelled || epoch !== loadEpochRef.current) {
            return
          }
          const viewport = firstPage.getViewport({ scale: 1 })
          setBasePageWidth(viewport.width)
          setBasePageHeight(viewport.height)
        } catch {
          // Fall back to generic placeholder sizing if page metadata fails.
        }

        setLoadState('ready')
      })
      .catch((error) => {
        if (cancelled || epoch !== loadEpochRef.current) {
          return
        }

        setLoadState('error')
        setErrorMessage(formatPdfPreviewError(error))
      })

    return () => {
      cancelled = true
      void loadingTask.destroy()
      pdfDocRef.current?.destroy()
      pdfDocRef.current = null
      setPdfDoc(null)
    }
  }, [pdfUrl, reloadToken])

  useEffect(() => {
    if (loadState !== 'ready') {
      return
    }

    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const observer = new ResizeObserver(() => {
      setViewportWidth(viewport.clientWidth)
      updateCurrentPageFromScroll()
    })
    observer.observe(viewport)
    setViewportWidth(viewport.clientWidth)

    return () => observer.disconnect()
  }, [loadState, pdfUrl, updateCurrentPageFromScroll])

  useEffect(() => {
    setPageHeights({})
  }, [renderScale, pdfUrl, reloadToken])

  useEffect(() => {
    updateCurrentPageFromScroll()
  }, [pageHeights, numPages, updateCurrentPageFromScroll])

  const goToPreviousPage = useCallback(() => {
    const targetPage = clampPageNumber(currentPage - 1, numPages)
    setCurrentPage(targetPage)
    scrollToPage(targetPage)
  }, [currentPage, numPages, scrollToPage])

  const goToNextPage = useCallback(() => {
    const targetPage = clampPageNumber(currentPage + 1, numPages)
    setCurrentPage(targetPage)
    scrollToPage(targetPage)
  }, [currentPage, numPages, scrollToPage])

  const zoomOut = useCallback(() => {
    setFitWidth(false)
    setManualScale((scale) => Math.max(scale / ZOOM_STEP, MIN_MANUAL_SCALE))
  }, [])

  const zoomIn = useCallback(() => {
    setFitWidth(false)
    setManualScale((scale) => Math.min(scale * ZOOM_STEP, MAX_MANUAL_SCALE))
  }, [])

  const resetFitWidth = useCallback(() => {
    setFitWidth(true)
  }, [])

  const pageNumbers = useMemo(
    () => Array.from({ length: numPages }, (_, index) => index + 1),
    [numPages],
  )

  if (loadState === 'loading') {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-muted-foreground"
        data-testid="pdf-preview"
        data-pdf-url={pdfUrl}
        role="status"
        aria-label={`Loading PDF preview for ${fileName}`}
      >
        <Loader2 className="size-6 animate-spin opacity-60" aria-hidden="true" />
        <p className="text-sm">Loading PDF…</p>
        <p className="font-mono text-xs opacity-60">{fileName}</p>
      </div>
    )
  }

  if (loadState === 'error') {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-muted-foreground"
        data-testid="pdf-preview"
        data-pdf-url={pdfUrl}
        role="alert"
      >
        <p className="text-sm text-destructive/80">Failed to load PDF</p>
        <p className="max-w-md text-center text-xs opacity-70">{errorMessage}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={handleReload}>
            <RotateCw className="size-3.5" aria-hidden="true" />
            Reload
          </Button>
          <a
            href={pdfUrl}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
            data-testid="pdf-preview-open-raw"
          >
            Open PDF
          </a>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="pdf-preview"
      data-pdf-url={pdfUrl}
      aria-label={`PDF preview for ${fileName}`}
    >
      <div
        ref={(node) => {
          viewportRef.current = node
          setScrollRoot(node)
        }}
        className="file-browser-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4"
        data-testid="pdf-preview-viewport"
        onScroll={updateCurrentPageFromScroll}
      >
        <div
          className="mx-auto flex w-full max-w-full flex-col items-center"
          style={{ gap: PAGE_GAP_PX }}
          data-testid="pdf-preview-pages"
        >
          {pdfDoc
            ? pageNumbers.map((pageNumber) => (
                <PdfPreviewPage
                  key={pageNumber}
                  pageNumber={pageNumber}
                  pdf={pdfDoc}
                  renderScale={renderScale}
                  estimatedHeight={pageHeights[pageNumber] ?? estimatedPageHeight}
                  scrollRoot={scrollRoot}
                  onLayoutChange={handlePageLayoutChange}
                />
              ))
            : null}
        </div>
      </div>

      <div
        className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-border/80 bg-card/95 px-3 py-2 backdrop-blur-sm"
        data-testid="pdf-preview-controls"
      >
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8"
          aria-label="Previous page"
          disabled={currentPage <= 1}
          onClick={goToPreviousPage}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span
          className="min-w-[88px] text-center text-xs text-muted-foreground"
          data-testid="pdf-preview-page-indicator"
        >
          Page {currentPage} / {numPages}
        </span>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8"
          aria-label="Next page"
          disabled={currentPage >= numPages}
          onClick={goToNextPage}
        >
          <ChevronRight className="size-4" />
        </Button>
        <div className="mx-1 hidden h-5 w-px bg-border/80 sm:block" aria-hidden="true" />
        <Button type="button" size="icon" variant="outline" className="size-8" aria-label="Zoom out" onClick={zoomOut}>
          <ZoomOut className="size-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant={fitWidth ? 'secondary' : 'outline'}
          className="h-8 px-2"
          aria-label="Fit width"
          onClick={resetFitWidth}
        >
          <Maximize2 className="size-3.5" />
          <span className="hidden sm:inline">Fit</span>
        </Button>
        <Button type="button" size="icon" variant="outline" className="size-8" aria-label="Zoom in" onClick={zoomIn}>
          <ZoomIn className="size-4" />
        </Button>
        <Button type="button" size="icon" variant="outline" className="size-8" aria-label="Reload PDF" onClick={handleReload}>
          <RotateCw className="size-4" />
        </Button>
        <a
          href={pdfUrl}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-8 px-2')}
          data-testid="pdf-preview-open-raw"
        >
          Open PDF
        </a>
      </div>
    </div>
  )
}
