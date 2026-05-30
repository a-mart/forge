import { ClipboardList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SessionTaskStateSnapshotEvent } from '@forge/protocol'
import { getHeaderSummary, hasActiveWork } from './active-work-utils'

interface ActiveWorkHeaderIndicatorProps {
  snapshot?: SessionTaskStateSnapshotEvent | null
  expanded: boolean
  onToggle: () => void
  onFocus?: () => void
  className?: string
}

export function ActiveWorkHeaderIndicator({
  snapshot,
  expanded,
  onToggle,
  onFocus,
  className,
}: ActiveWorkHeaderIndicatorProps) {
  if (!hasActiveWork(snapshot)) return null

  const summary = getHeaderSummary(snapshot) ?? 'Active Work'

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'inline-flex h-7 max-w-36 shrink-0 gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground md:max-w-56',
        expanded && 'bg-accent text-foreground',
        className,
      )}
      onClick={() => {
        onToggle()
        onFocus?.()
      }}
      aria-expanded={expanded}
      aria-label="Toggle Active Work plan"
    >
      <ClipboardList className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{summary}</span>
    </Button>
  )
}
