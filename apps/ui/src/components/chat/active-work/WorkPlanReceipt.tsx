import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus } from '@forge/protocol'
import { ActiveWorkItemDetails } from './ActiveWorkItemDetails'
import { ActiveWorkStatusBadge } from './ActiveWorkStatusBadge'
import {
  ACTIVE_WORK_VISIBLE_ITEM_LIMIT,
  getDisplayItemStatus,
  sortWorkPlanItems,
  type WorkPlanSnapshotView,
} from './active-work-utils'

interface WorkPlanReceiptProps {
  plan: WorkPlanSnapshotView
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus }>
  className?: string
  itemLimit?: number
}

export function WorkPlanReceipt({
  plan,
  agents,
  statuses,
  className,
  itemLimit = ACTIVE_WORK_VISIBLE_ITEM_LIMIT,
}: WorkPlanReceiptProps) {
  const sortedItems = useMemo(() => sortWorkPlanItems(plan.items), [plan])
  const [showAllItems, setShowAllItems] = useState(false)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)

  const visibleItems = showAllItems ? sortedItems : sortedItems.slice(0, itemLimit)
  const knownTotalItems = plan.itemCount ?? sortedItems.length
  const hiddenItemCount = Math.max(0, knownTotalItems - visibleItems.length)
  const locallyHiddenItemCount = Math.max(0, sortedItems.length - visibleItems.length)
  const unavailableItemCount = Math.max(0, knownTotalItems - sortedItems.length)
  const selectedItem = visibleItems.find((item) => item.itemId === selectedItemId) ?? null
  const knownWarningCount = plan.warningCount ?? plan.warnings.length
  const hiddenWarningCount = Math.max(0, knownWarningCount - plan.warnings.length)

  return (
    <div className={cn('space-y-2', className)}>
      {visibleItems.length > 0 ? (
        <div className="space-y-1.5">
          {visibleItems.map((item) => {
            const displayStatus = getDisplayItemStatus(plan.status, item.status)
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
                  <ActiveWorkStatusBadge status={displayStatus} className="shrink-0" scope="item" />
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="rounded-md border border-border/60 bg-background/50 px-2 py-2 text-xs text-muted-foreground">
          No Work Plan items recorded.
        </p>
      )}

      {!showAllItems && locallyHiddenItemCount > 0 ? (
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAllItems(true)}>
          +{hiddenItemCount} more{plan.itemsTruncated ? ' in plan' : ''}
        </Button>
      ) : null}
      {(showAllItems || locallyHiddenItemCount === 0) && (unavailableItemCount > 0 || (plan.itemsTruncated && hiddenItemCount > 0)) ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          +{unavailableItemCount || hiddenItemCount} more item{(unavailableItemCount || hiddenItemCount) === 1 ? '' : 's'} not shown
        </p>
      ) : null}

      {selectedItem ? (
        <ActiveWorkItemDetails
          item={{ ...selectedItem, status: getDisplayItemStatus(plan.status, selectedItem.status) }}
          agents={agents}
          statuses={statuses}
        />
      ) : null}

      {plan.finalSummary || knownWarningCount > 0 ? (
        <div className="rounded-md border border-border/60 bg-background/60 p-3 text-xs">
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
        </div>
      ) : null}
    </div>
  )
}
