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
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import '@/styles/file-browser.css'
import { pdfjsLib, type PDFDocumentProxy } from './pdfjs-preview-lib'
import {
  clampPageNumber,
  computePdfRenderScale,
  computeSafeCanvasOutput,
  formatPdfPreviewError,
  PDF_PREVIEW_MAX_RENDER_SCALE,
} from './pdf-preview-utils'

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

interface PdfPreviewProps {
  wsUrl: string
  filePath: string
  agentId: string
  worktreeId?: string | null
}

const ZOOM_STEP = 1.25
const MIN_MANUAL_SCALE = 0.25
const MAX_MANUAL_SCALE = PDF_PREVIEW_MAX_RENDER_SCALE

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

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void; promise: Promise<void> } | null>(null)
  const loadEpochRef = useRef(0)

  const handleReload = useCallback(() => {
    setReloadToken((value) => value + 1)
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

    renderTaskRef.current?.cancel()
    pdfDocRef.current?.destroy()
    pdfDocRef.current = null

    const loadingTask = pdfjsLib.getDocument({
      url: pdfUrl,
      disableAutoFetch: false,
      rangeChunkSize: 65536,
    })

    void loadingTask.promise
      .then((pdf) => {
        if (cancelled || epoch !== loadEpochRef.current) {
          void pdf.destroy()
          return
        }

        pdfDocRef.current = pdf
        setNumPages(pdf.numPages)
        setCurrentPage(1)
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
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      void loadingTask.destroy()
      pdfDocRef.current?.destroy()
      pdfDocRef.current = null
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
    })
    observer.observe(viewport)
    setViewportWidth(viewport.clientWidth)

    return () => observer.disconnect()
  }, [loadState, pdfUrl])

  useEffect(() => {
    if (loadState !== 'ready' || !pdfDocRef.current || !canvasRef.current) {
      return
    }

    let cancelled = false
    const pdf = pdfDocRef.current
    const pageNumber = clampPageNumber(currentPage, numPages)

    void (async () => {
      try {
        renderTaskRef.current?.cancel()
        renderTaskRef.current = null

        const page = await pdf.getPage(pageNumber)
        if (cancelled) {
          return
        }

        const baseViewport = page.getViewport({ scale: 1 })
        const renderScale = computePdfRenderScale(
          baseViewport.width,
          viewportWidth,
          manualScale,
          fitWidth,
          MAX_MANUAL_SCALE,
        )
        const viewport = page.getViewport({ scale: renderScale })
        const canvas = canvasRef.current
        if (!canvas || cancelled) {
          return
        }

        const context = canvas.getContext('2d')
        if (!context) {
          throw new Error('Canvas rendering is unavailable.')
        }

        const safeCanvas = computeSafeCanvasOutput(
          viewport.width,
          viewport.height,
          window.devicePixelRatio || 1,
        )
        if (!safeCanvas.ok) {
          throw new Error(safeCanvas.message)
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
      } catch (error) {
        if (cancelled || (error instanceof Error && error.name === 'RenderingCancelledException')) {
          return
        }

        setLoadState('error')
        setErrorMessage(formatPdfPreviewError(error))
      }
    })()

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [loadState, currentPage, manualScale, fitWidth, viewportWidth, numPages, pdfUrl])

  const goToPreviousPage = useCallback(() => {
    setCurrentPage((page) => clampPageNumber(page - 1, numPages))
  }, [numPages])

  const goToNextPage = useCallback(() => {
    setCurrentPage((page) => clampPageNumber(page + 1, numPages))
  }, [numPages])

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
      className="flex h-full min-h-0 flex-col"
      data-testid="pdf-preview"
      data-pdf-url={pdfUrl}
      aria-label={`PDF preview for ${fileName}`}
    >
      <div
        ref={viewportRef}
        className="file-browser-scroll min-h-0 flex-1 overflow-auto p-4"
        data-testid="pdf-preview-viewport"
      >
        <div className="flex min-h-full justify-center">
          <canvas ref={canvasRef} className="rounded border border-border/50 bg-white shadow-sm" />
        </div>
      </div>

      <div
        className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-border/80 bg-card/80 px-3 py-2"
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
        <span className="min-w-[88px] text-center text-xs text-muted-foreground">
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
      </div>
    </div>
  )
}
