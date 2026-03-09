import { Eye, Loader2, MonitorPlay, WifiOff, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PlaywrightPreviewStatus } from '@middleman/protocol'

interface PlaywrightLivePreviewEmptyStateProps {
  status: PlaywrightPreviewStatus
  sessionSelected: boolean
  errorMessage?: string | null
  onRetry?: () => void
}

export function PlaywrightLivePreviewEmptyState({
  status,
  sessionSelected,
  errorMessage,
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
            Choose an active Playwright session from the list to see a live preview of the browser viewport.
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

  // Unavailable (session not previewable)
  if (status === 'unavailable') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="rounded-full bg-muted/50 p-4">
          <MonitorPlay className="size-8 text-muted-foreground/30" />
        </div>
        <div className="space-y-1.5 max-w-xs">
          <h3 className="text-sm font-medium text-foreground">Preview unavailable</h3>
          <p className="text-xs text-muted-foreground">
            This session is not currently previewable. It may be inactive, stale, or the browser process may have exited.
          </p>
        </div>
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
            The preview lease has expired due to inactivity.
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
