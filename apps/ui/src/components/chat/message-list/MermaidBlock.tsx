import DOMPurify from 'dompurify'
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
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
import { ContentZoomDialog } from '@/components/chat/ContentZoomDialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { highlightCode } from '@/lib/syntax-highlight'
import { cn } from '@/lib/utils'
import {
  isMermaidPreviewChildMessage,
  resolveMermaidPreviewIframeUrl,
  type MermaidPreviewChildMessage,
  type MermaidPreviewExportSvgMessage,
  type MermaidPreviewParentMessage,
  type MermaidPreviewPingMessage,
  type MermaidPreviewRenderMessage,
  type MermaidThemeMode,
} from '@/mermaid-preview/bridge'

// ---------------------------------------------------------------------------
// Dark-mode subscription — re-renders components when the theme class changes
// ---------------------------------------------------------------------------

type ThemeListener = () => void

const themeListeners = new Set<ThemeListener>()

function subscribeTheme(listener: ThemeListener): () => void {
  themeListeners.add(listener)

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
    for (const listener of themeListeners) listener()
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
// Embed helpers
// ---------------------------------------------------------------------------

const DEFAULT_INLINE_HEIGHT = 220
const DEFAULT_ZOOM_HEIGHT = 520
const PREVIEW_READY_TIMEOUT_MS = 15_000

function sanitizeHighlightedHtml(html: string): string {
  const maybeSanitize = (DOMPurify as unknown as {
    sanitize?: (dirty: string, config?: Record<string, unknown>) => string
  }).sanitize

  if (typeof maybeSanitize === 'function') {
    return maybeSanitize(html, {
      USE_PROFILES: { html: true },
    })
  }

  if (typeof DOMPurify === 'function') {
    return (DOMPurify as unknown as (
      dirty: string,
      config?: Record<string, unknown>,
    ) => string)(html, {
      USE_PROFILES: { html: true },
    })
  }

  return html
}

let mermaidInstanceCounter = 0

function nextMermaidInstanceId(prefix: string): string {
  mermaidInstanceCounter += 1
  return `${prefix}-${mermaidInstanceCounter.toString(36)}`
}

let mermaidRequestCounter = 0

function nextMermaidRequestId(prefix: string): string {
  mermaidRequestCounter += 1
  return `${prefix}-${mermaidRequestCounter.toString(36)}`
}

function useStableMermaidInstanceId(prefix: string): string {
  const instanceIdRef = useRef<string | null>(null)
  if (!instanceIdRef.current) {
    instanceIdRef.current = nextMermaidInstanceId(prefix)
  }
  return instanceIdRef.current
}

interface MermaidPreviewFrameState {
  rendered: boolean
  error: string | null
}

interface MermaidPreviewEmbedHandle {
  requestSvg: () => Promise<string | null>
}

interface MermaidPreviewEmbedProps {
  code: string
  themeMode: MermaidThemeMode
  title: string
  instanceId: string
  minHeight: number
  onFrameStateChange?: (state: MermaidPreviewFrameState) => void
}

const MermaidPreviewEmbed = forwardRef<
  MermaidPreviewEmbedHandle,
  MermaidPreviewEmbedProps
>(function MermaidPreviewEmbed(
  { code, themeMode, title, instanceId, minHeight, onFrameStateChange },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const initialThemeModeRef = useRef(themeMode)
  const iframeSrc = useMemo(
    () => resolveMermaidPreviewIframeUrl(instanceId, initialThemeModeRef.current),
    [instanceId],
  )
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [ready, setReady] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(minHeight)
  const currentRenderRequestIdRef = useRef<string | null>(null)
  const pendingSvgRequestsRef = useRef(new Map<string, (svg: string | null) => void>())

  const publishFrameState = useCallback(
    (nextState: MermaidPreviewFrameState) => {
      setRendered(nextState.rendered)
      setError(nextState.error)
      onFrameStateChange?.(nextState)
    },
    [onFrameStateChange],
  )

  const resolveFrameWindow = useCallback((): Window | null => {
    return iframeRef.current?.contentWindow ?? null
  }, [])

  const postMessageToFrame = useCallback(
    (message: MermaidPreviewParentMessage): boolean => {
      const frameWindow = resolveFrameWindow()
      if (!frameWindow) {
        return false
      }

      frameWindow.postMessage(message, '*')
      return true
    },
    [resolveFrameWindow],
  )

  const postRenderRequest = useCallback(() => {
    if (!ready) {
      return
    }

    const requestId = nextMermaidRequestId('render')
    currentRenderRequestIdRef.current = requestId
    publishFrameState({ rendered: false, error: null })
    setHeight((currentHeight) => Math.max(currentHeight, minHeight))

    const message: MermaidPreviewRenderMessage = {
      type: 'forge:mermaid-render',
      instanceId,
      requestId,
      code,
      source: code,
      themeMode,
    }

    if (!postMessageToFrame(message)) {
      publishFrameState({
        rendered: false,
        error: 'Unable to reach Mermaid preview frame.',
      })
    }
  }, [
    code,
    instanceId,
    minHeight,
    postMessageToFrame,
    publishFrameState,
    ready,
    themeMode,
  ])

  const handleFrameMessage = useCallback(
    (message: MermaidPreviewChildMessage) => {
      switch (message.type) {
        case 'forge:mermaid-ready': {
          setReady(true)
          publishFrameState({ rendered: false, error: null })
          return
        }

        case 'forge:mermaid-rendered': {
          if (
            currentRenderRequestIdRef.current &&
            message.requestId !== currentRenderRequestIdRef.current
          ) {
            return
          }

          publishFrameState({ rendered: true, error: null })
          const renderedHeight = message.size?.height ?? message.height
          if (typeof renderedHeight === 'number' && Number.isFinite(renderedHeight)) {
            setHeight(Math.max(Math.ceil(renderedHeight), minHeight))
          }
          return
        }

        case 'forge:mermaid-size': {
          if (
            message.requestId &&
            currentRenderRequestIdRef.current &&
            message.requestId !== currentRenderRequestIdRef.current
          ) {
            return
          }

          const nextHeight = message.size?.height ?? message.height
          if (typeof nextHeight === 'number' && Number.isFinite(nextHeight)) {
            setHeight(Math.max(Math.ceil(nextHeight), minHeight))
          }
          return
        }

        case 'forge:mermaid-error': {
          if (
            message.requestId &&
            currentRenderRequestIdRef.current &&
            message.requestId !== currentRenderRequestIdRef.current
          ) {
            return
          }

          publishFrameState({
            rendered: false,
            error: message.message ?? message.error ?? 'Unable to render Mermaid diagram.',
          })
          return
        }

        case 'forge:mermaid-export-svg-result': {
          const resolvePending = pendingSvgRequestsRef.current.get(message.requestId)
          if (!resolvePending) {
            return
          }

          pendingSvgRequestsRef.current.delete(message.requestId)
          resolvePending(typeof message.svg === 'string' ? message.svg : null)
          return
        }
      }
    },
    [minHeight, publishFrameState],
  )

  useEffect(() => {
    setReady(false)
    publishFrameState({ rendered: false, error: null })
    setHeight(minHeight)
    currentRenderRequestIdRef.current = null
  }, [iframeSrc, minHeight, publishFrameState])

  useEffect(() => {
    postRenderRequest()
  }, [postRenderRequest])

  useEffect(() => {
    if (!iframeLoaded || ready || error) {
      return
    }

    const timeout = window.setTimeout(() => {
      setReady(false)
      publishFrameState({
        rendered: false,
        error: 'Diagram renderer failed to initialize.',
      })
    }, PREVIEW_READY_TIMEOUT_MS)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [error, iframeLoaded, publishFrameState, ready])

  const sendPingToChild = useCallback(() => {
    const pingMessage: MermaidPreviewPingMessage = {
      type: 'forge:mermaid-ping',
      instanceId,
    }
    postMessageToFrame(pingMessage)
  }, [instanceId, postMessageToFrame])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!isMermaidPreviewChildMessage(event.data)) {
        return
      }

      const frameWindow = resolveFrameWindow()
      if (frameWindow && event.source && event.source !== frameWindow) {
        return
      }

      if (event.data.instanceId !== instanceId) {
        return
      }

      handleFrameMessage(event.data)
    }

    window.addEventListener('message', handleMessage)

    // Ping child to re-post READY in case it fired before this listener
    // was attached.  The ping is idempotent — the child simply re-posts
    // its READY message, which is a no-op if the parent already saw it.
    if (iframeRef.current?.contentWindow) {
      sendPingToChild()
    }

    return () => {
      window.removeEventListener('message', handleMessage)
    }
  }, [handleFrameMessage, instanceId, resolveFrameWindow, sendPingToChild])

  useEffect(() => {
    return () => {
      for (const resolvePending of pendingSvgRequestsRef.current.values()) {
        resolvePending(null)
      }
      pendingSvgRequestsRef.current.clear()
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      requestSvg: async () => {
        if (!ready) {
          return null
        }

        const requestId = nextMermaidRequestId('export')
        const message: MermaidPreviewExportSvgMessage = {
          type: 'forge:mermaid-export-svg',
          instanceId,
          requestId,
        }

        return new Promise<string | null>((resolve) => {
          pendingSvgRequestsRef.current.set(requestId, resolve)
          const sent = postMessageToFrame(message)
          if (!sent) {
            pendingSvgRequestsRef.current.delete(requestId)
            resolve(null)
          }
        })
      },
    }),
    [instanceId, postMessageToFrame, ready],
  )

  const effectiveHeight = Math.max(height, minHeight)
  const loadingText = iframeLoaded ? 'Rendering diagram…' : 'Loading preview…'

  return (
    <div className="relative w-full" style={{ minHeight: effectiveHeight }}>
      {!rendered && !error ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            <span>{loadingText}</span>
          </div>
        </div>
      ) : null}

      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title={title}
        data-mermaid-preview-frame="true"
        className="w-full border-0 bg-transparent"
        style={{ height: effectiveHeight }}
        sandbox="allow-scripts allow-same-origin"
        onLoad={() => {
          setIframeLoaded(true)
          publishFrameState({ rendered: false, error: null })
          // Ping child to re-post READY — covers the case where the
          // listener effect ran before the iframe loaded, so the earlier
          // ping had no contentWindow to reach.
          sendPingToChild()
        }}
        onError={() => {
          setIframeLoaded(false)
          setReady(false)
          publishFrameState({
            rendered: false,
            error: 'Failed to load Mermaid preview.',
          })
        }}
      />
    </div>
  )
})

// ---------------------------------------------------------------------------
// Exported component
// ---------------------------------------------------------------------------

interface MermaidBlockProps {
  code: string
  isDocument?: boolean
}

export const MermaidBlock = memo(function MermaidBlock({
  code,
  isDocument = false,
}: MermaidBlockProps) {
  const isDark = useIsDarkMode()
  const themeMode: MermaidThemeMode = isDark ? 'dark' : 'light'
  const inlineInstanceId = useStableMermaidInstanceId('mermaid-inline')
  const zoomInstanceId = useStableMermaidInstanceId('mermaid-zoom')
  const inlinePreviewRef = useRef<MermaidPreviewEmbedHandle>(null)
  const [rendered, setRendered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(true)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [zoomOpen, setZoomOpen] = useState(false)
  const userToggledRef = useRef(false)

  useEffect(() => {
    setRendered(false)
    setError(null)
  }, [code, themeMode])

  const handleFrameStateChange = useCallback((state: MermaidPreviewFrameState) => {
    setRendered(state.rendered)
    setError(state.error)

    if (state.error) {
      if (!userToggledRef.current) {
        setShowCode(false)
      }
      return
    }

    if (state.rendered && !userToggledRef.current) {
      setShowCode(false)
    }
  }, [])

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
    void inlinePreviewRef.current?.requestSvg().then((svg) => {
      if (!svg) {
        return
      }

      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      downloadBlob(blob, 'diagram.svg')
    })
  }, [])

  const handleDownloadPng = useCallback(() => {
    void inlinePreviewRef.current?.requestSvg().then((svg) => {
      if (!svg) {
        return
      }

      void svgToPng(svg).then((blob) => {
        if (blob) {
          downloadBlob(blob, 'diagram.png')
        }
      })
    })
  }, [])

  const highlightedCode = sanitizeHighlightedHtml(highlightCode(code, undefined))

  const embedIsHidden = showCode || !!error

  return (
    <>
      <div
        className={cn(
          'group/mermaid overflow-hidden rounded-lg border border-border/50 bg-background',
          isDocument ? 'my-5' : 'my-2',
        )}
      >
        <div className="flex items-center justify-between border-b border-border/40 bg-muted/30 px-3 py-1.5">
          <span className="font-mono text-[11px] font-medium text-muted-foreground">
            mermaid
          </span>

          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-0.5">
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

              {rendered ? (
                <ToolbarButton tooltip="Download SVG" onClick={handleDownloadSvg}>
                  <Download className="size-3.5" />
                </ToolbarButton>
              ) : null}

              {rendered ? (
                <ToolbarButton tooltip="Download PNG" onClick={handleDownloadPng}>
                  <ImageIcon className="size-3.5" />
                </ToolbarButton>
              ) : null}

              {rendered ? (
                <ToolbarButton
                  tooltip="Expand diagram"
                  onClick={() => setZoomOpen(true)}
                >
                  <Maximize2 className="size-3.5" />
                </ToolbarButton>
              ) : null}
            </div>
          </TooltipProvider>
        </div>

        <div className="relative w-full">
          <div
            className={cn(
              'w-full',
              embedIsHidden
                ? 'pointer-events-none absolute inset-0 z-0 opacity-0'
                : 'relative',
            )}
            aria-hidden={embedIsHidden}
          >
            <ScrollArea className="max-h-[70vh] w-full">
              <MermaidPreviewEmbed
                ref={inlinePreviewRef}
                code={code}
                themeMode={themeMode}
                title="Mermaid diagram preview"
                instanceId={inlineInstanceId}
                minHeight={DEFAULT_INLINE_HEIGHT}
                onFrameStateChange={handleFrameStateChange}
              />
            </ScrollArea>
          </div>

          {showCode ? (
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
          ) : null}
        </div>
      </div>

      <ContentZoomDialog
        open={zoomOpen}
        onOpenChange={setZoomOpen}
        title="Expanded Mermaid diagram"
        contentClassName="w-full"
      >
        {zoomOpen ? (
          <MermaidPreviewEmbed
            code={code}
            themeMode={themeMode}
            title="Expanded Mermaid diagram preview"
            instanceId={zoomInstanceId}
            minHeight={DEFAULT_ZOOM_HEIGHT}
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
          aria-label={tooltip}
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
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  setTimeout(() => {
    document.body.removeChild(anchor)
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url)
    }
  }, 100)
}

async function svgToPng(svgString: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const image = new window.Image()
    const svgBlob = new Blob([svgString], {
      type: 'image/svg+xml;charset=utf-8',
    })
    const url = URL.createObjectURL(svgBlob)

    image.onload = () => {
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth * scale
      canvas.height = image.naturalHeight * scale

      const context = canvas.getContext('2d')
      if (!context) {
        if (typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(url)
        }
        resolve(null)
        return
      }

      context.scale(scale, scale)
      context.drawImage(image, 0, 0)
      if (typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url)
      }

      canvas.toBlob((blob) => resolve(blob), 'image/png')
    }

    image.onerror = () => {
      if (typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url)
      }
      resolve(null)
    }

    image.src = url
  })
}
