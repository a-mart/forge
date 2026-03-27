import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  AlertCircle,
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  Image as ImageIcon,
  Maximize2,
} from 'lucide-react'
import DOMPurify from 'dompurify'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ContentZoomDialog } from '@/components/chat/ContentZoomDialog'
import { highlightCode } from '@/lib/syntax-highlight'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Dark-mode subscription — re-renders components when the theme class changes
// ---------------------------------------------------------------------------

type ThemeListener = () => void

const themeListeners = new Set<ThemeListener>()

function subscribeTheme(listener: ThemeListener): () => void {
  themeListeners.add(listener)

  // Listen for class mutations on <html>
  if (typeof document !== 'undefined' && themeListeners.size === 1) {
    startObserver()
  }

  return () => {
    themeListeners.delete(listener)
    if (themeListeners.size === 0) stopObserver()
  }
}

let observer: MutationObserver | null = null

function startObserver() {
  if (typeof document === 'undefined') return
  observer = new MutationObserver(() => {
    for (const l of themeListeners) l()
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
}

function stopObserver() {
  observer?.disconnect()
  observer = null
}

function getIsDark(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

function useIsDarkMode(): boolean {
  return useSyncExternalStore(subscribeTheme, getIsDark, () => false)
}

// ---------------------------------------------------------------------------
// Mermaid rendering helpers
// ---------------------------------------------------------------------------

/** Counter for unique render IDs */
let renderIdCounter = 0

function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  })
}

// ---------------------------------------------------------------------------
// Exported component
// ---------------------------------------------------------------------------

interface MermaidBlockProps {
  /** The raw mermaid definition text */
  code: string
  /** Whether the block appears in a document variant (wider layout) */
  isDocument?: boolean
}

export const MermaidBlock = memo(function MermaidBlock({
  code,
  isDocument = false,
}: MermaidBlockProps) {
  const isDark = useIsDarkMode()

  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(true)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [zoomOpen, setZoomOpen] = useState(false)

  // Track whether user has explicitly toggled the view
  const userToggledRef = useRef(false)

  // Keep a ref to the latest svg for the zoom dialog & exports
  const svgRef = useRef<string | null>(null)
  svgRef.current = svg

  // -----------------------------------------------------------------------
  // Render the diagram whenever code or theme changes
  // -----------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false

    setSvg(null)
    setError(null)

    void (async () => {
      try {
        const module = await import('mermaid')
        const mermaidApi = module.default

        const desiredTheme = isDark ? 'dark' : 'default'

        // Always enforce strict security config before every render
        mermaidApi.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: desiredTheme,
        })

        const renderId = `mmd-${(renderIdCounter++).toString(36)}`
        const { svg: rawSvg } = await mermaidApi.render(renderId, code)

        if (cancelled) return

        const sanitized = sanitizeSvg(rawSvg)
        setSvg(sanitized)

        // Auto-switch to diagram view on first successful render (unless user toggled)
        if (!userToggledRef.current) {
          setShowCode(false)
        }
      } catch (renderError) {
        if (cancelled) return
        setError(
          renderError instanceof Error
            ? renderError.message
            : 'Unable to render Mermaid diagram.',
        )

        // Auto-switch to error view (which shows error banner + raw source)
        if (!userToggledRef.current) {
          setShowCode(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, isDark])

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {
        setCopyFailed(true)
        setTimeout(() => setCopyFailed(false), 1500)
      },
    )
  }, [code])

  const handleDownloadSvg = useCallback(() => {
    const currentSvg = svgRef.current
    if (!currentSvg) return
    const blob = new Blob([currentSvg], { type: 'image/svg+xml;charset=utf-8' })
    downloadBlob(blob, 'diagram.svg')
  }, [])

  const handleDownloadPng = useCallback(() => {
    const currentSvg = svgRef.current
    if (!currentSvg) return
    void svgToPng(currentSvg).then((blob) => {
      if (blob) downloadBlob(blob, 'diagram.png')
    })
  }, [])

  // -----------------------------------------------------------------------
  // Syntax-highlighted raw source (for code view)
  // -----------------------------------------------------------------------

  const highlightedCode = DOMPurify.sanitize(highlightCode(code, undefined), {
    USE_PROFILES: { html: true },
  })

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <>
      <div
        className={cn(
          'group/mermaid overflow-hidden rounded-lg border border-border/50 bg-background',
          isDocument ? 'my-5' : 'my-2',
        )}
      >
        {/* Toolbar */}
        <div className="flex items-center justify-between border-b border-border/40 bg-muted/30 px-3 py-1.5">
          <span className="font-mono text-[11px] font-medium text-muted-foreground">
            mermaid
          </span>

          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-0.5">
              {/* Toggle code / diagram */}
              <ToolbarButton
                tooltip={showCode ? 'Show diagram' : 'Show source'}
                onClick={() => {
                  userToggledRef.current = true
                  setShowCode((prev) => !prev)
                }}
              >
                {showCode ? (
                  <Eye className="size-3.5" />
                ) : (
                  <Code2 className="size-3.5" />
                )}
              </ToolbarButton>

              {/* Copy source */}
              <ToolbarButton
                tooltip={copied ? 'Copied!' : copyFailed ? 'Copy failed' : 'Copy source'}
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-500" />
                ) : copyFailed ? (
                  <AlertCircle className="size-3.5 text-destructive" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </ToolbarButton>

              {/* SVG download */}
              {svg && (
                <ToolbarButton tooltip="Download SVG" onClick={handleDownloadSvg}>
                  <Download className="size-3.5" />
                </ToolbarButton>
              )}

              {/* PNG download */}
              {svg && (
                <ToolbarButton tooltip="Download PNG" onClick={handleDownloadPng}>
                  <ImageIcon className="size-3.5" />
                </ToolbarButton>
              )}

              {/* Expand / fullscreen */}
              {svg && (
                <ToolbarButton
                  tooltip="Expand diagram"
                  onClick={() => setZoomOpen(true)}
                >
                  <Maximize2 className="size-3.5" />
                </ToolbarButton>
              )}
            </div>
          </TooltipProvider>
        </div>

        {/* Body */}
        {showCode ? (
          /* Raw mermaid source with syntax highlighting */
          <div className="w-full">
            <pre className="overflow-x-auto p-4">
              <code
                className={cn(
                  'font-mono text-foreground/90',
                  isDocument ? 'text-[13px] leading-6' : 'text-xs leading-5',
                )}
                dangerouslySetInnerHTML={{ __html: highlightedCode }}
              />
            </pre>
          </div>
        ) : error ? (
          /* Error state: show error banner + raw code */
          <div className="space-y-2 p-4">
            <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="size-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                Diagram error — showing raw source
              </span>
            </div>
            <pre className="overflow-x-auto rounded-md bg-muted/30 p-3">
              <code
                className={cn(
                  'font-mono text-foreground/90',
                  isDocument ? 'text-[13px] leading-6' : 'text-xs leading-5',
                )}
              >
                {code}
              </code>
            </pre>
          </div>
        ) : svg ? (
          /* Rendered diagram */
          <ScrollArea className="max-h-[70vh] w-full">
            <div
              className="flex justify-center p-4 [&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </ScrollArea>
        ) : (
          /* Loading state */
          <div className="flex items-center justify-center py-8">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
              <span>Rendering diagram…</span>
            </div>
          </div>
        )}
      </div>

      {/* Fullscreen dialog */}
      <ContentZoomDialog
        open={zoomOpen}
        onOpenChange={setZoomOpen}
        title="Expanded Mermaid diagram"
      >
        {svg ? (
          <div
            className={cn(
              'flex min-h-full min-w-full items-center justify-center',
              '[&_svg]:h-auto [&_svg]:max-h-full [&_svg]:max-w-full',
            )}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : null}
      </ContentZoomDialog>
    </>
  )
})

// ---------------------------------------------------------------------------
// Toolbar button helper
// ---------------------------------------------------------------------------

function ToolbarButton({
  tooltip,
  onClick,
  disabled,
  children,
}: {
  tooltip: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClick}
          disabled={disabled}
          className="size-6 text-muted-foreground/60 hover:text-muted-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// Download / export helpers
// ---------------------------------------------------------------------------

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)
}

async function svgToPng(svgString: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new window.Image()
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)

    img.onload = () => {
      // Use 2x scale for crisp rendering
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth * scale
      canvas.height = img.naturalHeight * scale

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        resolve(null)
        return
      }

      ctx.scale(scale, scale)
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)

      canvas.toBlob((blob) => resolve(blob), 'image/png')
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }

    img.src = url
  })
}
