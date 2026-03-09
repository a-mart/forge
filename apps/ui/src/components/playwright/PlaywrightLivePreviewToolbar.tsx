import {
  ArrowLeft,
  ExternalLink,
  Maximize2,
  Minimize2,
  MonitorPlay,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PlaywrightDiscoveredSession, PlaywrightPreviewStatus } from '@middleman/protocol'

interface PlaywrightLivePreviewToolbarProps {
  session: PlaywrightDiscoveredSession
  previewStatus: PlaywrightPreviewStatus
  isFocusMode: boolean
  onToggleFocusMode: () => void
  onClose: () => void
  onBack?: () => void
}

const STATUS_INDICATOR: Record<PlaywrightPreviewStatus, { color: string; label: string }> = {
  idle: { color: 'bg-muted-foreground/40', label: 'Idle' },
  starting: { color: 'bg-amber-500 animate-pulse', label: 'Connecting…' },
  active: { color: 'bg-emerald-500', label: 'Live' },
  unavailable: { color: 'bg-muted-foreground/40', label: 'Unavailable' },
  error: { color: 'bg-destructive', label: 'Error' },
  expired: { color: 'bg-amber-500', label: 'Expired' },
}

export function PlaywrightLivePreviewToolbar({
  session,
  previewStatus,
  isFocusMode,
  onToggleFocusMode,
  onClose,
  onBack,
}: PlaywrightLivePreviewToolbarProps) {
  const statusInfo = STATUS_INDICATOR[previewStatus] ?? STATUS_INDICATOR.idle

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/30 px-3">
      {/* Back button (focus mode only) */}
      {isFocusMode && onBack ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onBack}
          title="Back to split view"
        >
          <ArrowLeft className="size-3.5" />
        </Button>
      ) : null}

      {/* Session icon + name */}
      <MonitorPlay className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs font-medium truncate max-w-[200px]">
        {session.sessionName}
      </span>

      {/* Live status indicator */}
      <div className="flex items-center gap-1.5">
        <span className={cn('inline-block size-1.5 rounded-full', statusInfo.color)} />
        <span className="text-[10px] text-muted-foreground">{statusInfo.label}</span>
      </div>

      {/* Worktree badge */}
      {session.worktreeName ? (
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
          {session.worktreeName}
        </Badge>
      ) : null}

      {/* Correlated agent */}
      {session.correlation.matchedAgentDisplayName ? (
        <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">
          {session.correlation.matchedAgentDisplayName}
        </span>
      ) : null}

      <div className="flex-1" />

      {/* Actions */}
      <TooltipProvider delayDuration={300}>
        {/* Focus / minimize toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onToggleFocusMode}
            >
              {isFocusMode ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {isFocusMode ? 'Exit focus mode' : 'Focus mode'}
          </TooltipContent>
        </Tooltip>

        {/* Open standalone (dev escape hatch) */}
        {session.ports.cdp ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground/60"
                onClick={() => {
                  // Escape hatch: open the standalone Playwright devtools window
                  // This is intentionally low-visibility and for debugging only
                  window.open(`http://127.0.0.1:${session.ports.cdp}`, '_blank')
                }}
              >
                <ExternalLink className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Open standalone (debug)
            </TooltipContent>
          </Tooltip>
        ) : null}

        {/* Close preview */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Close preview
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
