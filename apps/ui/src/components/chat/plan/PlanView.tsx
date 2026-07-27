import { Check, Circle, LoaderCircle } from 'lucide-react'
import type { SessionPlanSnapshot } from '@forge/protocol'
import { cn } from '@/lib/utils'
import { WorkGraphView } from './WorkGraphView'

interface PlanViewProps {
  snapshot: SessionPlanSnapshot
  compact?: boolean
}

export function PlanView({ snapshot, compact = false }: PlanViewProps) {
  const completed = snapshot.plan.filter((step) => step.status === 'completed').length

  if (snapshot.coordinationMode === 'graph' && snapshot.workGraph) {
    return (
      <div className={cn('space-y-2', compact && 'space-y-1.5')}>
        {snapshot.explanation ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{snapshot.explanation}</p>
        ) : null}
        <WorkGraphView graph={snapshot.workGraph} compact={compact} />
      </div>
    )
  }

  return (
    <div className={cn('space-y-2', compact && 'space-y-1.5')}>
      {snapshot.explanation ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{snapshot.explanation}</p>
      ) : null}
      <ol className="space-y-1.5" aria-label="Working plan steps">
        {snapshot.plan.map((item, index) => (
          <li key={item.id ?? `${index}:${item.step}`} className="flex items-start gap-2 text-sm">
            {item.status === 'completed' ? (
              <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-label="Completed" />
            ) : item.status === 'in_progress' ? (
              <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-violet-500" aria-label="In progress" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" aria-label="Pending" />
            )}
            <span className={cn(
              'min-w-0 leading-snug',
              item.status === 'completed' && 'text-muted-foreground line-through decoration-muted-foreground/50',
              item.status === 'in_progress' && 'font-medium text-foreground',
              item.status === 'pending' && 'text-muted-foreground',
            )}>
              {item.step}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[11px] tabular-nums text-muted-foreground">
        {completed} of {snapshot.plan.length} completed
      </p>
    </div>
  )
}
