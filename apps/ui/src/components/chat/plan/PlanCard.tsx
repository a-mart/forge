import { useId } from 'react'
import { ChevronDown, ClipboardList } from 'lucide-react'
import type { SessionPlanSnapshotEvent } from '@forge/protocol'
import { cn } from '@/lib/utils'
import { PlanView } from './PlanView'

interface PlanCardProps {
  snapshot?: SessionPlanSnapshotEvent | null
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}

export function PlanCard({ snapshot, expanded, onExpandedChange }: PlanCardProps) {
  const detailsId = useId()
  if (!snapshot || snapshot.plan.length === 0) return null

  const completed = snapshot.plan.filter((step) => step.status === 'completed').length
  const isComplete = completed === snapshot.plan.length
  const active = snapshot.plan.filter((step) => step.status === 'in_progress')
  const currentLabel = active.length > 1
    ? `${active.length} steps in progress`
    : active[0]?.step

  return (
    <section className="mx-auto w-full max-w-3xl px-4 pt-3" aria-label="Working plan">
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card/80 shadow-sm backdrop-blur">
        <button
          type="button"
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            isComplete ? 'bg-emerald-500/10 text-emerald-500' : 'bg-violet-500/10 text-violet-500',
          )}>
            <ClipboardList className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {isComplete ? 'Plan complete' : 'Working plan'}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{completed}/{snapshot.plan.length}</span>
            </span>
            <span className="block truncate text-sm text-foreground">
              {currentLabel ?? snapshot.explanation ?? 'All planned steps completed'}
            </span>
          </span>
          <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
        </button>
        {expanded ? (
          <div id={detailsId} className="border-t border-border/60 px-4 py-3">
            <PlanView snapshot={snapshot} />
          </div>
        ) : null}
      </div>
    </section>
  )
}
