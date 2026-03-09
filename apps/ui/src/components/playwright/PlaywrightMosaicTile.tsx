import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Maximize2, MonitorPlay, EyeOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  startPlaywrightLivePreview,
  releasePlaywrightLivePreview,
} from './playwright-api'
import type {
  PlaywrightDiscoveredSession,
  PlaywrightLivePreviewEmbedStatusMessage,
} from '@middleman/protocol'

interface PlaywrightMosaicTileProps {
  wsUrl: string
  session: PlaywrightDiscoveredSession
  selected?: boolean
  onSelect: () => void
  onFocus: () => void
}

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
}: PlaywrightMosaicTileProps) {
  const previewable = isSessionPreviewable(session)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'starting' | 'active' | 'failed'>('idle')
  const [embedActive, setEmbedActive] = useState(false)
  const previewIdRef = useRef<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const mountedRef = useRef(true)

  // Start preview on mount for previewable sessions
  useEffect(() => {
    mountedRef.current = true

    if (!previewable) return

    setStatus('starting')

    void startPlaywrightLivePreview(wsUrl, session.id, 'embedded')
      .then((handle) => {
        if (!mountedRef.current) {
          void releasePlaywrightLivePreview(wsUrl, handle.previewId)
          return
        }
        previewIdRef.current = handle.previewId
        setIframeSrc(handle.iframeSrc)
        setStatus('active')
      })
      .catch(() => {
        if (!mountedRef.current) return
        setStatus('failed')
      })

    return () => {
      mountedRef.current = false
      const pid = previewIdRef.current
      if (pid) {
        previewIdRef.current = null
        void releasePlaywrightLivePreview(wsUrl, pid)
      }
    }
  }, [wsUrl, session.id, previewable])

  // Listen for embed status messages from the iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return
      if (event.data.type !== 'playwright:embed-status') return
      if (iframeRef.current?.contentWindow && event.source !== iframeRef.current.contentWindow) return

      const msg = event.data as PlaywrightLivePreviewEmbedStatusMessage
      if (msg.status === 'active') setEmbedActive(true)
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Timeout: if iframe is mounted but embed-ready never arrives, mark as failed
  useEffect(() => {
    if (!iframeSrc || embedActive || status !== 'active') return
    const timer = setTimeout(() => {
      if (!mountedRef.current) return
      if (!embedActive) setStatus('failed')
    }, 10_000) // 10s timeout for embed handshake
    return () => clearTimeout(timer)
  }, [iframeSrc, embedActive, status])

  const handleFocusClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onFocus()
    },
    [onFocus],
  )

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

        {/* Hover overlay with focus action */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 dark:group-hover:bg-white/5 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
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
        </div>
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
    </div>
  )
}
