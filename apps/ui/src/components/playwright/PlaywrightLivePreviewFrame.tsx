import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, MousePointer } from 'lucide-react'
import type { PlaywrightLivePreviewEmbedStatusMessage } from '@forge/protocol'
import { cn } from '@/lib/utils'

interface PlaywrightLivePreviewFrameProps {
  iframeSrc: string
  interactionEnabled: boolean
  onInteractionRequest: () => void
  onLoad?: () => void
  onError?: (message: string) => void
  onStatusMessage?: (message: PlaywrightLivePreviewEmbedStatusMessage) => void
}

/**
 * How long after iframe HTML loads to wait for the embed's controller
 * WebSocket to connect (signalled via postMessage) before timing out.
 */
const EMBED_READY_TIMEOUT_MS = 30_000

export function PlaywrightLivePreviewFrame({
  iframeSrc,
  interactionEnabled,
  onInteractionRequest,
  onLoad,
  onError,
  onStatusMessage,
}: PlaywrightLivePreviewFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  /** Whether the iframe document itself has loaded (HTML served). */
  const [iframeLoaded, setIframeLoaded] = useState(false)
  /**
   * Whether the embedded Playwright DevTools app has reported an `active`
   * status via postMessage — meaning its controller WebSocket connected
   * and the preview is genuinely live.
   */
  const [embedActive, setEmbedActive] = useState(false)
  const [hasError, setHasError] = useState(false)
  const iframeOrigin = useMemo(() => {
    try {
      return new URL(iframeSrc, window.location.href).origin
    } catch {
      return null
    }
  }, [iframeSrc])

  const handleLoad = useCallback(() => {
    setIframeLoaded(true)
    setHasError(false)
    onLoad?.()
  }, [onLoad])

  const handleError = useCallback(() => {
    setIframeLoaded(false)
    setHasError(true)
    onError?.('Failed to load preview frame')
  }, [onError])

  // Reset all readiness state when the iframe src changes (new preview)
  useEffect(() => {
    setIframeLoaded(false)
    setEmbedActive(false)
    setHasError(false)
  }, [iframeSrc])

  // Timeout: if the iframe HTML loaded but the embedded app never reports
  // active status (controller WS never connected), surface an error so the
  // user can retry instead of staring at a spinner forever.
  useEffect(() => {
    if (!iframeLoaded || embedActive || hasError) return

    const timer = setTimeout(() => {
      onError?.('Preview connection timed out — the embedded preview did not become active')
    }, EMBED_READY_TIMEOUT_MS)

    return () => clearTimeout(timer)
  }, [iframeLoaded, embedActive, hasError, onError])

  useEffect(() => {
    if (!onStatusMessage) {
      return
    }

    const handleMessage = (event: MessageEvent) => {
      if (iframeOrigin && event.origin !== iframeOrigin) {
        return
      }

      if (iframeRef.current?.contentWindow && event.source !== iframeRef.current.contentWindow) {
        return
      }

      if (!isEmbedStatusMessage(event.data)) {
        return
      }

      // Track embed readiness: dismiss the loading overlay once the
      // controller WebSocket connects (status === 'active').
      if (event.data.status === 'active') {
        setEmbedActive(true)
      }

      onStatusMessage(event.data)
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
    }
  }, [iframeOrigin, onStatusMessage])

  // Show loading overlay until the embed reports active (WS connected),
  // not just until the iframe HTML loads.
  const showLoading = !embedActive && !hasError
  const loadingText = iframeLoaded ? 'Connecting to preview…' : 'Loading preview…'

  return (
    <div className="relative flex-1 min-h-0 bg-black/5 dark:bg-white/5">
      {/* Loading overlay — kept visible until embed reports active via postMessage */}
      {showLoading ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="size-6 text-muted-foreground animate-spin" />
            <span className="text-xs text-muted-foreground">{loadingText}</span>
          </div>
        </div>
      ) : null}

      {/* Error state */}
      {hasError ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90">
          <div className="text-center space-y-1">
            <p className="text-sm text-muted-foreground">Failed to load preview</p>
            <p className="text-xs text-muted-foreground/70">The preview iframe could not be loaded from the backend.</p>
          </div>
        </div>
      ) : null}

      {/* Click-to-control overlay (only when embed is active and interaction not yet enabled) */}
      {!interactionEnabled && embedActive && !hasError ? (
        <div
          className={cn(
            'absolute inset-0 z-20 cursor-pointer',
            'flex items-end justify-center pb-6',
            'bg-transparent hover:bg-black/5 dark:hover:bg-white/5',
            'transition-colors duration-150',
          )}
          onClick={onInteractionRequest}
          title="Click to enable interaction"
        >
          <div className={cn(
            'flex items-center gap-2 rounded-full px-4 py-2',
            'bg-background/90 border shadow-md',
            'animate-in fade-in-0 slide-in-from-bottom-2 duration-300',
          )}>
            <MousePointer className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Click anywhere to interact</span>
          </div>
        </div>
      ) : null}

      {/* The iframe */}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        className={cn(
          'h-full w-full border-0',
          !interactionEnabled && 'pointer-events-none',
        )}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        allow="clipboard-read; clipboard-write"
        onLoad={handleLoad}
        onError={handleError}
        title="Playwright Live Preview"
      />
    </div>
  )
}

function isEmbedStatusMessage(value: unknown): value is PlaywrightLivePreviewEmbedStatusMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const maybe = value as Record<string, unknown>
  return maybe.type === 'playwright:embed-status' && typeof maybe.status === 'string'
}
