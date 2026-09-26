import { Clock3, LoaderCircle, Wrench } from 'lucide-react'
import type { ManagerToolActivityEvent } from '@forge/protocol'

interface ManagerToolActivityIndicatorProps {
  activity?: ManagerToolActivityEvent | null
  pendingCount?: number
}

/**
 * Shows the latest ephemeral manager-tool activity at the live conversation edge.
 * The payload is deliberately limited to count and normalized tool name.
 */
export function ManagerToolActivityIndicator({ activity, pendingCount = 0 }: ManagerToolActivityIndicatorProps) {
  const backgroundCount = activity?.backgroundCount ?? 0
  if (backgroundCount > 0) {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-y border-border/60 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground"
        data-testid="manager-background-activity" role="status" aria-live="polite">
        <span className="flex items-center gap-1.5">
          <LoaderCircle className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          <span>{backgroundCount} {backgroundCount === 1 ? 'command' : 'commands'} running in background</span>
        </span>
        {pendingCount > 0 ? (
          <span className="flex items-center gap-1.5" title="Accepted by Forge. The agent has not picked this input up yet.">
            <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{pendingCount} {pendingCount === 1 ? 'message' : 'messages'} waiting for agent</span>
          </span>
        ) : null}
      </div>
    )
  }
  if (pendingCount > 0) {
    return (
      <div className="flex shrink-0 items-center gap-1.5 border-y border-border/60 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground" role="status" aria-live="polite"
        title="Accepted by Forge. The agent has not picked this input up yet; it may be waiting for the current operation to yield.">
        <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{pendingCount === 1 ? '1 message waiting for agent' : `${pendingCount} messages waiting for agent`}</span>
      </div>
    )
  }
  if (!activity || activity.toolCount <= 0) return null

  const toolLabel = `${activity.toolCount} tool${activity.toolCount === 1 ? '' : 's'}`
  const ariaLabel = `Manager tool activity: ${toolLabel}${activity.currentToolName ? `, ${activity.currentToolName}` : ''}`

  return (
    <div
      className="flex shrink-0 items-center gap-1.5 border-y border-border/60 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="manager-tool-activity"
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      title={activity.currentToolName
        ? `${toolLabel} · ${activity.currentToolName}`
        : toolLabel}
    >
      <Wrench className="size-3.5" aria-hidden="true" />
      <span className="font-medium text-foreground/80">Using tools</span>
      <span aria-hidden="true">·</span>
      <span>{toolLabel}</span>
      {activity.currentToolName ? (
        <span className="truncate">· {activity.currentToolName}</span>
      ) : null}
    </div>
  )
}
