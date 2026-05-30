import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ClipboardList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus, SessionTaskStateSnapshotEvent } from '@forge/protocol'
import { ActiveWorkItemDetails } from './ActiveWorkItemDetails'
import { ActiveWorkStatusBadge } from './ActiveWorkStatusBadge'
import {
  ACTIVE_WORK_VISIBLE_ITEM_LIMIT,
  countDoneItems,
  getDisplayPlan,
  getHeaderSummary,
  hasActiveWork,
  shouldEmphasizePlan,
  sortWorkPlanItems,
  toActiveWorkSnapshotView,
} from './active-work-utils'

interface ActiveWorkCardProps {
  snapshot?: SessionTaskStateSnapshotEvent | null
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus }>
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  focusNonce?: number
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
  const snapshotView = toActiveWorkSnapshotView(snapshot)
  const plan = snapshotView ? getDisplayPlan(snapshotView) : null
  const sortedItems = useMemo(() => (plan ? sortWorkPlanItems(plan.items) : []), [plan])
  const [showAllItems, setShowAllItems] = useState(false)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)

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

  const visibleItems = showAllItems ? sortedItems : sortedItems.slice(0, ACTIVE_WORK_VISIBLE_ITEM_LIMIT)
  const knownTotalItems = plan?.itemCount ?? sortedItems.length
  const hiddenItemCount = Math.max(0, knownTotalItems - visibleItems.length)
  const selectedItem = visibleItems.find((item) => item.itemId === selectedItemId) ?? null
  const progressLabel = plan && knownTotalItems > 0 ? `${countDoneItems(plan)}/${knownTotalItems}` : null
  const knownWarningCount = plan?.warningCount ?? plan?.warnings.length ?? 0
  const hiddenWarningCount = plan ? Math.max(0, knownWarningCount - plan.warnings.length) : 0
  const knownRecentPlanCount = snapshotView?.recentWorkPlanCount ?? snapshotView?.recentWorkPlans.length ?? 0
  const displayedRecentPlanCount = snapshotView?.activeWorkPlan
    ? 0
    : snapshotView && snapshotView.recentWorkPlans.length > 0
      ? 1
      : 0
  const hiddenRecentPlanCount = snapshotView ? Math.max(0, knownRecentPlanCount - displayedRecentPlanCount) : 0
  const summary = getHeaderSummary(snapshot) ?? 'Active Work'
  const diagnostic = snapshot?.diagnostics?.state === 'corrupt_recovered' || snapshot?.diagnostics?.state === 'unavailable'
    ? snapshot.diagnostics
    : null

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
        <div className="flex min-w-0 gap-2">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ClipboardList className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground">{plan?.title ?? summary}</h2>
              {plan ? <ActiveWorkStatusBadge status={plan.status} /> : null}
              {progressLabel ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {progressLabel}{plan?.itemsTruncated ? '+' : ''}
                </span>
              ) : null}
            </div>
            {plan?.goal ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{plan.goal}</p> : null}
            {diagnostic ? (
              <p className="mt-1 text-xs text-amber-300">
                Active Work state is temporarily unavailable. {diagnostic.message ?? 'The saved state will be retried after the backend recovers it.'}
              </p>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          onClick={() => onExpandedChange(!expanded)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse Active Work plan' : 'Expand Active Work plan'}
        >
          {expanded ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
          {expanded ? 'Hide' : 'Show'}
        </Button>
      </div>

      {expanded && plan ? (
        <div className="mt-3">
          <Separator className="mb-2" />
          <div className="space-y-1.5">
            {visibleItems.map((item) => {
              const selected = selectedItemId === item.itemId
              return (
                <button
                  key={item.itemId}
                  type="button"
                  className={cn(
                    'w-full rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:border-border/70 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected && 'border-border/70 bg-muted/45',
                  )}
                  onClick={() => setSelectedItemId(selected ? null : item.itemId)}
                  aria-expanded={selected}
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-foreground">{item.title}</div>
                      {item.phase || item.note ? (
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {item.phase ? `${item.phase}${item.note ? ' · ' : ''}` : ''}{item.note ?? ''}
                        </div>
                      ) : null}
                    </div>
                    <ActiveWorkStatusBadge status={item.status} className="shrink-0" />
                  </div>
                </button>
              )
            })}
          </div>
          {hiddenItemCount > 0 ? (
            <Button type="button" variant="ghost" size="sm" className="mt-2 h-7 text-xs" onClick={() => setShowAllItems(true)}>
              +{hiddenItemCount} more{plan.itemsTruncated ? ' in plan' : ''}
            </Button>
          ) : null}
          {selectedItem ? <ActiveWorkItemDetails item={selectedItem} agents={agents} statuses={statuses} /> : null}
          {plan.finalSummary || knownWarningCount > 0 || hiddenRecentPlanCount > 0 ? (
            <div className="mt-3 rounded-md border border-border/60 bg-background/60 p-3 text-xs">
              {plan.finalSummary ? <p className="whitespace-pre-wrap text-muted-foreground">{plan.finalSummary}</p> : null}
              {knownWarningCount > 0 ? (
                <div className={plan.finalSummary ? 'mt-2' : undefined}>
                  <div className="font-medium text-amber-200">Warnings</div>
                  {plan.warnings.length > 0 ? (
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-amber-200">
                      {plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                    </ul>
                  ) : null}
                  {hiddenWarningCount > 0 || plan.warningsTruncated ? (
                    <p className="mt-1 text-amber-200/80">
                      +{hiddenWarningCount || Math.max(1, knownWarningCount)} more warning{(hiddenWarningCount || knownWarningCount) === 1 ? '' : 's'} not shown
                    </p>
                  ) : null}
                </div>
              ) : null}
              {hiddenRecentPlanCount > 0 || snapshotView?.recentWorkPlansTruncated ? (
                <p className="mt-2 text-muted-foreground">
                  +{hiddenRecentPlanCount || Math.max(1, knownRecentPlanCount)} more recent Work Plan{(hiddenRecentPlanCount || knownRecentPlanCount) === 1 ? '' : 's'} not shown
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
