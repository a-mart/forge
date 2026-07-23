import { useId, useState } from 'react'
import { Check, ChevronDown, ClipboardList, GitBranch } from 'lucide-react'
import type { PlanSummaryEvent, SessionPlanSnapshotEvent } from '@forge/protocol'
import { cn } from '@/lib/utils'
import { PLAN_SURFACE_WIDTH_CLASS } from './plan-surface'
import { PlanView } from './PlanView'

export function PlanSummaryRow({
  summary,
  currentSnapshot,
}: {
  summary: PlanSummaryEvent
  currentSnapshot?: SessionPlanSnapshotEvent | null
}) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const snapshot = summary.state === 'active' && currentSnapshot?.plan.length
    ? currentSnapshot
    : summary
  const completed = snapshot.plan.filter((step) => step.status === 'completed').length
  const isComplete = summary.state !== 'active' || completed === snapshot.plan.length
  const isGraph = snapshot.coordinationMode === 'graph' && Boolean(snapshot.workGraph)
  const active = snapshot.plan.filter((step) => step.status === 'in_progress')
  const currentLabel = active.length > 1
    ? `${active.length} steps in progress`
    : active[0]?.step

  return (
    <section className={cn('mx-auto w-full px-4 py-1', PLAN_SURFACE_WIDTH_CLASS)} aria-label={isComplete ? (isGraph ? 'Completed graph' : 'Completed plan') : (isGraph ? 'Work graph' : 'Working plan')}>
      <div className={cn('overflow-hidden rounded-xl bg-card/60', isComplete ? 'border border-emerald-500/20' : 'border border-border/70')}>
        <button
          type="button"
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', isComplete ? 'bg-emerald-500/10 text-emerald-500' : 'bg-violet-500/10 text-violet-500')}>
            {isGraph ? <GitBranch className="size-4" /> : <ClipboardList className="size-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {isComplete ? (isGraph ? 'Graph complete' : 'Plan complete') : (isGraph ? 'Work graph' : 'Working plan')}
              </span>
              <span className={cn('inline-flex items-center gap-1 text-[11px] tabular-nums', isComplete ? 'text-emerald-500' : 'text-muted-foreground')}>
                {isComplete ? <Check className="size-3" /> : null}
                {completed}/{snapshot.plan.length}
              </span>
            </span>
            <span className="block truncate text-sm text-foreground">
              {currentLabel ?? snapshot.explanation ?? (isComplete ? 'Plan completed' : 'Plan underway')}
            </span>
          </span>
          <ChevronDown className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )} />
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
