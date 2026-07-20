import {
  Check,
  Circle,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Pause,
  X,
} from 'lucide-react'
import type { WorkGraphNode } from '@forge/protocol'
import { cn } from '@/lib/utils'

export function WorkGraphNodeStatusIcon({
  node,
  className,
}: {
  node: WorkGraphNode
  className?: string
}) {
  const iconClassName = cn('size-4 shrink-0', className)
  switch (node.status) {
    case 'completed':
      return <Check className={cn(iconClassName, 'text-emerald-500')} aria-label="Accepted" />
    case 'running':
      return <LoaderCircle className={cn(iconClassName, 'animate-spin text-violet-500')} aria-label="Running" />
    case 'awaiting_review':
      return <Clock3 className={cn(iconClassName, 'text-amber-500')} aria-label="Awaiting review" />
    case 'waiting':
      return <Pause className={cn(iconClassName, 'text-sky-500')} aria-label="Waiting for decision" />
    case 'blocked':
      return <CircleAlert className={cn(iconClassName, 'text-destructive')} aria-label="Blocked" />
    case 'cancelled':
      return <X className={cn(iconClassName, 'text-muted-foreground')} aria-label="Cancelled" />
    default:
      return <Circle className={cn(iconClassName, 'text-muted-foreground/60')} aria-label="Pending" />
  }
}

export function WorkGraphNodeRuntime({ node }: { node: WorkGraphNode }) {
  const attempt = node.attempts[node.attempts.length - 1]
  if (!attempt) {
    return node.effort !== 'auto' ? (
      <span className="text-[10px] capitalize text-muted-foreground">{node.effort} requested</span>
    ) : null
  }
  const label = node.status === 'awaiting_review'
    ? `Review ${attempt.executionPolicy}`
    : `${attempt.executionPolicy} · try ${attempt.number}`
  return (
    <span className={cn(
      'text-[10px] capitalize text-muted-foreground',
      attempt.executionPolicy === 'deep' && 'text-fuchsia-500',
    )}>
      {label}
    </span>
  )
}
