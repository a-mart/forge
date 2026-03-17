import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Maximize2, MonitorPlay, EyeOff, Power } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  startPlaywrightLivePreview,
  releasePlaywrightLivePreview,
} from './playwright-api'
import type {
  PlaywrightDiscoveredSession,
  PlaywrightLivePreviewEmbedStatusMessage,
} from '@forge/protocol'

interface PlaywrightMosaicTileProps {
  wsUrl: string
  session: PlaywrightDiscoveredSession
  selected?: boolean
  onSelect: () => void
  onFocus: () => void
  onClose?: () => Promise<void>
}

/**
 * Timeout for the embed handshake (postMessage 'active' from the iframe).
 *
 * Must be generous enough to cover cold-start scenarios where the Playwright
 * daemon's devtools server needs to restart (e.g., after the tile was
 * unmounted during split/focus mode). The split/focus view uses 30s; tiles
 * use 25s as a compromise — still generous for cold starts but slightly
 * tighter since tiles are smaller, less critical previews.
 */
const TILE_EMBED_HANDSHAKE_TIMEOUT_MS = 25_000

/**
 * Maximum number of bootstrap attempts before giving up. Counts the initial
 * attempt plus all retries (timeout-driven and error-driven combined).
 */
const MAX_BOOTSTRAP_ATTEMPTS = 3

/**
 * Brief delay (ms) before bootstrapping the preview after mount.
 *
 * When returning from split/focus mode to tiles, React cleanup effects
 * release the split pane's preview lease (an async DELETE). The tile mount
 * effects fire immediately after, initiating new preview starts (POST).
 * Without a delay, these requests can race: the POST may arrive before the
 * DELETE, causing the backend to serve a reuse of the about-to-be-released
 * preview, or — for shared-daemon sessions — the DELETE's proxy-channel
 * teardown can briefly shut down the devtools server before the new tiles'
 * upstream WebSocket connections are established.
 *
 * A short RAF-based delay ensures the browser has flushed the cleanup
 * DELETE onto the wire before the tiles send their POSTs.
 */
const MOUNT_BOOTSTRAP_DELAY_MS = 50

function isSessionPreviewable(session: PlaywrightDiscoveredSession): boolean {
  if (session.previewability) return session.previewability.previewable
  return session.liveness === 'active'
}

/**
 * A mosaic tile that shows a scaled-down live preview iframe for previewable
 * sessions, or a compact placeholder for non-previewable ones.
 *
 * Each tile manages its own preview lease lifecycle (start on mount, release
 * on unmount).
 */
export function PlaywrightMosaicTile({
  wsUrl,
  session,
  selected = false,
  onSelect,
  onFocus,
  onClose,
}: PlaywrightMosaicTileProps) {
  const previewable = isSessionPreviewable(session)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'starting' | 'active' | 'failed'>('idle')
  const [embedActive, setEmbedActive] = useState(false)
  const [showCloseDialog, setShowCloseDialog] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const previewIdRef = useRef<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const mountedRef = useRef(true)
  /**
   * Monotonically increasing generation counter. Each call to
   * `bootstrapPreview` bumps the generation; stale `.then()` callbacks
   * from a previous generation are discarded. This prevents a race where
   * an old async response (from a preview that was released during retry)
   * overwrites the state set by the current bootstrap attempt.
   */
  const genRef = useRef(0)
  /** Total number of bootstrap attempts in this mount cycle. */
  const attemptCountRef = useRef(0)

  const canClose = onClose && (session.liveness === 'active' || session.liveness === 'error') && session.socketExists

  /**
   * Start (or restart) a preview lease. Releases any existing lease first,
   * resets iframe/embed state, and initiates a fresh preview request.
   *
   * Uses `reuseIfActive: false` so the backend always creates a fresh
   * preview lease instead of returning a stale one that may be about to be
   * released by the split/focus pane's cleanup. This eliminates the most
   * common race during the split→tiles view transition.
   */
  const bootstrapPreview = useCallback(() => {
    // Bump generation — any in-flight async from the previous generation
    // will see a stale genRef and bail out.
    const gen = ++genRef.current
    attemptCountRef.current++

    // Release any stale preview before starting fresh
    const oldPid = previewIdRef.current
    if (oldPid) {
      previewIdRef.current = null
      void releasePlaywrightLivePreview(wsUrl, oldPid)
    }

    // Reset iframe/embed state so the timeout effect re-arms
    setIframeSrc(null)
    setEmbedActive(false)
    setStatus('starting')

    void startPlaywrightLivePreview(wsUrl, session.id, 'embedded', { reuseIfActive: false })
      .then((handle) => {
        if (!mountedRef.current || gen !== genRef.current) {
          void releasePlaywrightLivePreview(wsUrl, handle.previewId)
          return
        }
        previewIdRef.current = handle.previewId
        setIframeSrc(handle.iframeSrc)
        setStatus('active')
      })
      .catch(() => {
        if (!mountedRef.current || gen !== genRef.current) return
        setStatus('failed')
      })
  }, [wsUrl, session.id])

  // Start preview on mount for previewable sessions.
  // A short delay ensures the browser has flushed the split/focus pane's
  // cleanup DELETE before the tile sends its POST, avoiding backend races.
  useEffect(() => {
    mountedRef.current = true
    genRef.current = 0
    attemptCountRef.current = 0

    if (!previewable) return

    const timer = setTimeout(() => {
      if (mountedRef.current) bootstrapPreview()
    }, MOUNT_BOOTSTRAP_DELAY_MS)

    return () => {
      clearTimeout(timer)
      mountedRef.current = false
      const pid = previewIdRef.current
      if (pid) {
        previewIdRef.current = null
        void releasePlaywrightLivePreview(wsUrl, pid)
      }
    }
  }, [wsUrl, session.id, previewable, bootstrapPreview])

  // Listen for embed status messages from the iframe.
  // Uses both iframe source check AND previewId matching to prevent
  // cross-tile message contamination (e.g., when iframeRef is still null
  // because the iframe hasn't rendered yet).
  //
  // In addition to tracking 'active', non-success statuses (error, expired,
  // disconnected) trigger an immediate retry instead of waiting for the full
  // handshake timeout. This provides fast recovery when the devtools server
  // is briefly unavailable during the split→tiles transition.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return
      if (event.data.type !== 'playwright:embed-status') return

      const msg = event.data as PlaywrightLivePreviewEmbedStatusMessage

      // Primary guard: if our iframe is rendered, only accept from it
      if (iframeRef.current?.contentWindow && event.source !== iframeRef.current.contentWindow) return

      // Secondary guard: if iframe isn't rendered yet (ref is null), verify
      // the previewId matches to avoid accepting another tile's messages
      if (!iframeRef.current?.contentWindow) {
        if (!msg.previewId || !previewIdRef.current || msg.previewId !== previewIdRef.current) return
      }

      if (msg.status === 'active') {
        setEmbedActive(true)
        return
      }

      // Non-success status from the embed (error, expired, disconnected,
      // unavailable). Trigger an immediate retry if we haven't exhausted
      // attempts, instead of waiting for the 25-second timeout.
      if (
        (msg.status === 'error' || msg.status === 'expired' || msg.status === 'disconnected') &&
        attemptCountRef.current < MAX_BOOTSTRAP_ATTEMPTS &&
        mountedRef.current
      ) {
        bootstrapPreview()
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [bootstrapPreview])

  // Timeout: if iframe is mounted but embed-ready never arrives, retry if
  // attempts remain, otherwise mark as failed.
  useEffect(() => {
    if (!iframeSrc || embedActive || status !== 'active') return
    const timer = setTimeout(() => {
      if (!mountedRef.current) return
      if (embedActive) return

      if (attemptCountRef.current < MAX_BOOTSTRAP_ATTEMPTS) {
        bootstrapPreview()
        return
      }

      // Exhausted attempts — give up
      setStatus('failed')
    }, TILE_EMBED_HANDSHAKE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [iframeSrc, embedActive, status, bootstrapPreview])

  const handleFocusClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onFocus()
    },
    [onFocus],
  )

  const handleCloseClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setCloseError(null)
      setShowCloseDialog(true)
    },
    [],
  )

  const handleConfirmClose = useCallback(async () => {
    setIsClosing(true)
    setCloseError(null)
    try {
      await onClose?.()
      setShowCloseDialog(false)
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Failed to close session')
    } finally {
      setIsClosing(false)
    }
  }, [onClose])

  const hasIframe = status === 'active' && !!iframeSrc
  const isLoading = status === 'starting' || (hasIframe && !embedActive)

  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-lg border bg-card transition-all cursor-pointer',
        'hover:ring-2 hover:ring-primary/30 hover:border-primary/40',
        selected && 'ring-2 ring-primary border-primary',
        !selected && session.liveness === 'active' && previewable && 'border-emerald-500/30',
        !selected && session.liveness === 'active' && !previewable && 'border-amber-500/20',
        !session.preferredInDuplicateGroup && 'opacity-60',
      )}
      onClick={onSelect}
    >
      {/* Preview area — 16:10 aspect ratio */}
      <div className="relative aspect-[16/10] bg-muted/30 overflow-hidden">
        {/* Always mount iframe when src is available — avoids deadlock where
            embed-ready postMessage can never arrive because the iframe was
            conditionally unmounted waiting for that very message. */}
        {hasIframe && iframeSrc ? (
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            className={cn(
              'absolute inset-0 w-[200%] h-[200%] origin-top-left scale-50 pointer-events-none border-0',
              !embedActive && 'invisible',
            )}
            sandbox="allow-scripts allow-same-origin"
            title={`Preview: ${session.sessionName}`}
          />
        ) : null}

        {/* Loading overlay — shown while iframe exists but embed handshake pending */}
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-5 text-muted-foreground/40 animate-spin" />
          </div>
        ) : previewable && status === 'failed' ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <EyeOff className="size-5 text-muted-foreground/30" />
          </div>
        ) : !hasIframe ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <MonitorPlay className="size-8 text-muted-foreground/20" />
          </div>
        ) : null}

        {/* Hover overlay with focus/close actions */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 dark:group-hover:bg-white/5 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
          {previewable ? (
            <button
              type="button"
              onClick={handleFocusClick}
              className="flex items-center gap-1.5 rounded-full bg-background/90 px-3 py-1.5 text-xs font-medium shadow-md border"
            >
              <Maximize2 className="size-3" />
              Focus
            </button>
          ) : null}
          {canClose ? (
            <button
              type="button"
              onClick={handleCloseClick}
              className="flex items-center gap-1.5 rounded-full bg-background/90 px-3 py-1.5 text-xs font-medium shadow-md border text-destructive hover:bg-destructive/10"
            >
              <Power className="size-3" />
              Close
            </button>
          ) : null}
        </div>

        {/* Top-right close button (always visible for closeable sessions) */}
        {canClose ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCloseClick}
                  className="absolute top-1.5 right-1.5 z-10 flex items-center justify-center size-6 rounded-full bg-background/80 border border-border/50 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Power className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">Close session</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>

      {/* Compact info bar */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-t bg-card min-w-0">
        <span
          className={cn(
            'inline-block size-1.5 rounded-full shrink-0',
            session.liveness === 'active'
              ? 'bg-emerald-500 animate-pulse'
              : session.liveness === 'stale'
                ? 'bg-amber-500'
                : 'bg-muted-foreground/40',
          )}
        />
        <span className="text-xs font-medium truncate flex-1">{session.sessionName}</span>
        {session.worktreeName ? (
          <Badge variant="secondary" className="text-[9px] px-1 py-0 shrink-0">
            {session.worktreeName}
          </Badge>
        ) : null}
        {session.correlation.matchedAgentDisplayName ? (
          <span className="text-[10px] text-muted-foreground truncate max-w-[100px]">
            {session.correlation.matchedAgentDisplayName}
          </span>
        ) : null}
      </div>

      {/* Close session confirmation dialog */}
      <Dialog open={showCloseDialog} onOpenChange={(v) => { if (!v && !isClosing) setShowCloseDialog(false) }}>
        <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Close browser session</DialogTitle>
            <DialogDescription>
              This will shut down the Playwright daemon for <strong>{session.sessionName}</strong>.
              The browser will be closed and the session will become inactive.
            </DialogDescription>
          </DialogHeader>
          {closeError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {closeError}
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setShowCloseDialog(false)} disabled={isClosing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirmClose}
              disabled={isClosing}
            >
              {isClosing ? (
                <>
                  <Loader2 className="size-3 mr-1.5 animate-spin" />
                  Closing…
                </>
              ) : (
                <>
                  <Power className="size-3 mr-1.5" />
                  Close Session
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
