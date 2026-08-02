import { Wrench } from 'lucide-react'
import type { ManagerToolActivityEvent } from '@forge/protocol'

interface ManagerToolActivityIndicatorProps {
  activity?: ManagerToolActivityEvent | null
}

/**
 * Shows the latest ephemeral manager-tool activity at the live conversation edge.
 * The payload is deliberately limited to count and normalized tool name.
 */
export function ManagerToolActivityIndicator({ activity }: ManagerToolActivityIndicatorProps) {
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
