import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ClipboardList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus, SessionTaskStateSnapshotEvent } from '@forge/protocol'
import { ActiveWorkStatusBadge } from './ActiveWorkStatusBadge'
import { WorkPlanReceipt } from './WorkPlanReceipt'
import {
  getDisplayPlan,
  getHeaderSummary,
  getWorkPlanProgressLabel,
  hasActiveWork,
  shouldEmphasizePlan,
  toActiveWorkSnapshotView,
  type WorkPlanSnapshotView,
} from './active-work-utils'

interface ActiveWorkCardProps {
  snapshot?: SessionTaskStateSnapshotEvent | null
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus }>
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  focusNonce?: number
}

interface CollapsibleWorkPlanReceiptProps {
  plan: WorkPlanSnapshotView
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus }>
}

function CollapsibleWorkPlanReceipt({ plan, agents, statuses }: CollapsibleWorkPlanReceiptProps) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const progressLabel = getWorkPlanProgressLabel(plan)

  return (
    <div className="rounded-lg border border-border/60 bg-background/45">
      <button
        type="button"
        className="flex w-full min-w-0 items-start gap-2 rounded-lg p-2 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={expanded ? `Collapse previous Work Plan: ${plan.title}` : `Expand previous Work Plan: ${plan.title}`}
      >
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {expanded ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-xs font-medium text-foreground">{plan.title}</span>
            <ActiveWorkStatusBadge status={plan.status} scope="plan" />
            {progressLabel ? (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {progressLabel}{plan.itemsTruncated ? '+' : ''}
              </span>
            ) : null}
          </span>
          {plan.finalSummary ? (
            <span className="mt-1 line-clamp-2 block text-[11px] text-muted-foreground">{plan.finalSummary}</span>
          ) : plan.goal ? (
            <span className="mt-1 line-clamp-2 block text-[11px] text-muted-foreground">{plan.goal}</span>
          ) : null}
        </span>
      </button>
      <div id={contentId} hidden={!expanded} className={expanded ? 'border-t border-border/50 p-2' : 'hidden'}>
        {expanded ? <WorkPlanReceipt plan={plan} agents={agents} statuses={statuses} /> : null}
      </div>
    </div>
  )
}

function getPreviousPlans(snapshot: SessionTaskStateSnapshotEvent | null, displayPlan: WorkPlanSnapshotView | null): WorkPlanSnapshotView[] {
  if (!snapshot) return []
  if (snapshot.activeWorkPlan) {
    return snapshot.recentWorkPlans
  }
  if (!displayPlan) {
    return snapshot.recentWorkPlans
  }
  return snapshot.recentWorkPlans.filter((plan) => plan.planId !== displayPlan.planId)
}

export function ActiveWorkCard({
  snapshot,
  agents,
  statuses,
  expanded,
  onExpandedChange,
  focusNonce,
}: ActiveWorkCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const detailsId = useId()
  const previousPlansId = useId()
  const snapshotView = toActiveWorkSnapshotView(snapshot)
  const plan = snapshotView ? getDisplayPlan(snapshotView) : null
  const previousPlans = useMemo(() => getPreviousPlans(snapshotView, plan), [snapshotView, plan])
  const [showPreviousPlans, setShowPreviousPlans] = useState(false)

  useEffect(() => {
    if (focusNonce && cardRef.current) {
      cardRef.current.focus()
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [focusNonce])

  useEffect(() => {
    if (plan && shouldEmphasizePlan(plan) && !expanded) {
      onExpandedChange(true)
    }
  }, [expanded, onExpandedChange, plan])

  if (!hasActiveWork(snapshot)) return null

  const progressLabel = plan ? getWorkPlanProgressLabel(plan) : null
  const summary = getHeaderSummary(snapshot) ?? 'Active Work'
  const diagnostic = snapshot?.diagnostics?.state === 'corrupt_recovered' || snapshot?.diagnostics?.state === 'unavailable'
    ? snapshot.diagnostics
    : null
  const detailsExpanded = expanded && Boolean(plan)
  const toggleExpanded = () => onExpandedChange(!expanded)

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      className={cn(
        'rounded-xl border bg-card/80 p-3 shadow-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring',
        plan && shouldEmphasizePlan(plan) ? 'border-amber-500/30' : 'border-border/70',
      )}
      aria-label="Active Work plan"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <button
          type="button"
          className="-m-1 flex min-w-0 flex-1 cursor-pointer gap-2 rounded-md p-1 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={toggleExpanded}
          aria-expanded={detailsExpanded}
          aria-controls={detailsId}
          aria-label={detailsExpanded ? 'Collapse Active Work plan details' : 'Expand Active Work plan details'}
        >
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ClipboardList className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">{plan?.title ?? summary}</span>
              {plan ? <ActiveWorkStatusBadge status={plan.status} /> : null}
              {progressLabel ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {progressLabel}{plan?.itemsTruncated ? '+' : ''}
                </span>
              ) : null}
            </span>
            {plan?.goal ? <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{plan.goal}</span> : null}
            {diagnostic ? (
              <span className="mt-1 block text-xs text-amber-300">
                Active Work state is temporarily unavailable. {diagnostic.message ?? 'The saved state will be retried after the backend recovers it.'}
              </span>
            ) : null}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          onClick={toggleExpanded}
          aria-expanded={detailsExpanded}
          aria-controls={detailsId}
          aria-label={detailsExpanded ? 'Collapse Active Work plan' : 'Expand Active Work plan'}
        >
          {detailsExpanded ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
          {detailsExpanded ? 'Hide' : 'Show'}
        </Button>
      </div>

      <div id={detailsId} hidden={!detailsExpanded} className={cn(detailsExpanded ? 'mt-3' : 'hidden')}>
        {plan ? (
          <>
            <Separator className="mb-2" />
            <WorkPlanReceipt plan={plan} agents={agents} statuses={statuses} />
            {previousPlans.length > 0 ? (
              <div className="mt-3 border-t border-border/60 pt-3">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setShowPreviousPlans((value) => !value)}
                  aria-expanded={showPreviousPlans}
                  aria-controls={previousPlansId}
                >
                  {showPreviousPlans ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
                  {showPreviousPlans
                    ? 'Hide previous completed Work Plans'
                    : `Show ${previousPlans.length} previous completed Work Plan${previousPlans.length === 1 ? '' : 's'}`}
                </button>
                <div id={previousPlansId} hidden={!showPreviousPlans} className={showPreviousPlans ? 'mt-2 space-y-2' : 'hidden'}>
                  {showPreviousPlans ? (
                    <>
                      {previousPlans.map((previousPlan) => (
                        <CollapsibleWorkPlanReceipt
                          key={previousPlan.planId}
                          plan={previousPlan}
                          agents={agents}
                          statuses={statuses}
                        />
                      ))}
                      {snapshotView?.recentWorkPlansTruncated ? (
                        <p className="px-1 text-[11px] text-muted-foreground">
                          Older Work Plans are outside the retained snapshot.
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}
