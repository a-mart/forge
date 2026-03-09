import { Eye, Loader2, MonitorPlay, Unplug, WifiOff, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PlaywrightPreviewStatus } from '@middleman/protocol'

interface PlaywrightLivePreviewEmptyStateProps {
  status: PlaywrightPreviewStatus
  sessionSelected: boolean
  errorMessage?: string | null
  unavailableReason?: string | null
  onRetry?: () => void
}

export function PlaywrightLivePreviewEmptyState({
  status,
  sessionSelected,
  errorMessage,
  unavailableReason,
  onRetry,
}: PlaywrightLivePreviewEmptyStateProps) {
  // No session selected
  if (!sessionSelected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="rounded-full bg-muted/50 p-4">
          <Eye className="size-8 text-muted-foreground/40" />
        </div>
        <div className="space-y-1.5 max-w-xs">
          <h3 className="text-sm font-medium text-foreground">Select a session</h3>
          <p className="text-xs text-muted-foreground">
            Choose a Playwright session from the list to see a live preview of the browser viewport.
          </p>
        </div>
      </div>
    )
  }

  // Starting / loading
  if (status === 'starting' || status === 'idle') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="rounded-full bg-muted/50 p-4">
          <Loader2 className="size-8 text-muted-foreground/60 animate-spin" />
        </div>
        <div className="space-y-1.5 max-w-xs">
          <h3 className="text-sm font-medium text-foreground">
            {status === 'starting' ? 'Connecting to session…' : 'Preparing preview…'}
          </h3>
          <p className="text-xs text-muted-foreground">
            Establishing a live connection to the Playwright-controlled browser.
          </p>
        </div>
      </div>
    )
  }

  // Unavailable (backend says session is not previewable)
  if (status === 'unavailable') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="rounded-full bg-muted/50 p-4">
          <MonitorPlay className="size-8 text-muted-foreground/30" />
        </div>
        <div className="space-y-1.5 max-w-xs">
          <h3 className="text-sm font-medium text-foreground">Preview unavailable</h3>
          <p className="text-xs text-muted-foreground">
            {unavailableReason ??
              'This session is not currently previewable. The browser process may be inactive or the session may have ended.'}
          </p>
        </div>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    )
  }

  // Disconnected (live connection was lost)
  if (status === 'disconnected') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="rounded-full bg-amber-500/10 p-4">
          <Unplug className="size-8 text-amber-500/60" />
        </div>
        <div className="space-y-1.5 max-w-xs">
          <h3 className="text-sm font-medium text-foreground">Preview disconnected</h3>
          <p className="text-xs text-muted-foreground">
            The live preview connection was lost. The browser session may have closed or the controller connection was interrupted.
          </p>
        </div>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Reconnect
          </Button>
        ) : null}
      </div>
    )
  }

  // Expired
  if (status === 'expired') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="rounded-full bg-muted/50 p-4">
          <WifiOff className="size-8 text-muted-foreground/40" />
        </div>
        <div className="space-y-1.5 max-w-xs">
          <h3 className="text-sm font-medium text-foreground">Preview session expired</h3>
          <p className="text-xs text-muted-foreground">
            The preview lease has expired due to inactivity. Click below to reconnect.
          </p>
        </div>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Reconnect
          </Button>
        ) : null}
      </div>
    )
  }

  // Error
  if (status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="rounded-full bg-destructive/10 p-4">
          <XCircle className="size-8 text-destructive/60" />
        </div>
        <div className="space-y-1.5 max-w-xs">
          <h3 className="text-sm font-medium text-foreground">Preview error</h3>
          <p className="text-xs text-muted-foreground">
            {errorMessage ?? 'Failed to establish a live preview connection.'}
          </p>
        </div>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    )
  }

  // Fallback
  return null
}
