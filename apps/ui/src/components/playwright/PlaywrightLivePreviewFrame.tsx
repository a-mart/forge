import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, MousePointer } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PlaywrightLivePreviewFrameProps {
  iframeSrc: string
  interactionEnabled: boolean
  onInteractionRequest: () => void
  onLoad?: () => void
  onError?: (message: string) => void
}

export function PlaywrightLivePreviewFrame({
  iframeSrc,
  interactionEnabled,
  onInteractionRequest,
  onLoad,
  onError,
}: PlaywrightLivePreviewFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)

  const handleLoad = useCallback(() => {
    setIsLoading(false)
    setHasError(false)
    onLoad?.()
  }, [onLoad])

  const handleError = useCallback(() => {
    setIsLoading(false)
    setHasError(true)
    onError?.('Failed to load preview frame')
  }, [onError])

  // Reset loading state when src changes
  useEffect(() => {
    setIsLoading(true)
    setHasError(false)
  }, [iframeSrc])

  return (
    <div className="relative flex-1 min-h-0 bg-black/5 dark:bg-white/5">
      {/* Loading overlay */}
      {isLoading ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="size-6 text-muted-foreground animate-spin" />
            <span className="text-xs text-muted-foreground">Loading preview…</span>
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

      {/* Click-to-control overlay (when interaction is not enabled) */}
      {!interactionEnabled && !isLoading && !hasError ? (
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
