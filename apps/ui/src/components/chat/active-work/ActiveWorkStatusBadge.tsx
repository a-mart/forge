import { AlertTriangle, CheckCircle2, CircleDot, CirclePause, CircleX, HelpCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { WorkPlanItemStatus, WorkPlanStatus } from '@forge/protocol'
import { formatPlanStatus } from './active-work-utils'

type Status = WorkPlanStatus | WorkPlanItemStatus | 'unavailable'

function statusLabel(status: Status, scope: 'plan' | 'item'): string {
  if (scope === 'item' && status === 'active') return 'In progress'

  switch (status) {
    case 'todo': return 'Todo'
    case 'up_next': return 'Up next'
    case 'done': return 'Done'
    case 'skipped': return 'Skipped'
    case 'unknown': return 'Unknown'
    case 'unavailable': return 'Unavailable'
    default: return formatPlanStatus(status as WorkPlanStatus)
  }
}

function statusTone(status: Status): string {
  switch (status) {
    case 'blocked':
    case 'needs_attention':
    case 'completed_with_warnings':
      return 'border-amber-500/35 bg-amber-500/10 text-amber-300'
    case 'failed':
      return 'border-destructive/40 bg-destructive/10 text-destructive'
    case 'stopped':
    case 'interrupted':
    case 'skipped':
    case 'unavailable':
      return 'border-muted-foreground/30 bg-muted/40 text-muted-foreground'
    case 'completed':
    case 'done':
      return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
    case 'active':
      return 'border-primary/35 bg-primary/10 text-primary'
    default:
      return 'border-border/60 bg-muted/30 text-muted-foreground'
  }
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'completed' || status === 'done') return <CheckCircle2 className="size-3" aria-hidden="true" />
  if (status === 'blocked' || status === 'needs_attention' || status === 'completed_with_warnings') return <AlertTriangle className="size-3" aria-hidden="true" />
  if (status === 'failed') return <CircleX className="size-3" aria-hidden="true" />
  if (status === 'stopped' || status === 'interrupted' || status === 'skipped' || status === 'unavailable') return <CirclePause className="size-3" aria-hidden="true" />
  if (status === 'unknown') return <HelpCircle className="size-3" aria-hidden="true" />
  return <CircleDot className="size-3" aria-hidden="true" />
}

export function ActiveWorkStatusBadge({
  status,
  className,
  scope = 'plan',
}: {
  status: Status
  className?: string
  scope?: 'plan' | 'item'
}) {
  return (
    <Badge variant="outline" className={cn('h-5 gap-1 px-1.5 text-[10px] font-medium', statusTone(status), className)}>
      <StatusIcon status={status} />
      <span>{statusLabel(status, scope)}</span>
    </Badge>
  )
}
