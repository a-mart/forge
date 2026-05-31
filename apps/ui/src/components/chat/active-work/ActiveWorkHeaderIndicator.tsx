import { ClipboardList, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus, SessionTaskStateSnapshotEvent } from '@forge/protocol'
import { ActiveWorkStatusBadge } from './ActiveWorkStatusBadge'
import { WorkPlanReceipt } from './WorkPlanReceipt'
import { getDisplayPlan, getHeaderSummary, getWorkPlanProgressLabel, hasActiveWork, toActiveWorkSnapshotView } from './active-work-utils'

interface ActiveWorkHeaderIndicatorProps {
  snapshot?: SessionTaskStateSnapshotEvent | null
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus }>
  onNavigateToWorker?: (agentId: string) => void
  className?: string
}

export function ActiveWorkHeaderIndicator({
  snapshot,
  agents,
  statuses,
  onNavigateToWorker,
  className,
}: ActiveWorkHeaderIndicatorProps) {
  if (!hasActiveWork(snapshot)) return null

  const snapshotView = toActiveWorkSnapshotView(snapshot)
  const plan = snapshotView ? getDisplayPlan(snapshotView) : null
  const summary = getHeaderSummary(snapshot) ?? 'Active Work'
  const progressLabel = plan ? getWorkPlanProgressLabel(plan) : null
  const diagnostic = snapshot?.diagnostics?.state === 'corrupt_recovered' || snapshot?.diagnostics?.state === 'unavailable'
    ? snapshot.diagnostics
    : null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'inline-flex h-7 max-w-36 shrink-0 gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground md:max-w-56',
            className,
          )}
          aria-label="Open Active Work plan"
        >
          <ClipboardList className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{summary}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="p-0"
        style={{ width: 'min(34rem, calc(100vw - 1rem))' }}
        aria-label="Active Work plan details"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">{plan?.title ?? summary}</span>
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
          <PopoverClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-m-1 size-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              aria-label="Close Active Work plan"
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </PopoverClose>
        </div>
        {plan ? (
          <div
            className="overflow-y-auto p-3 [scrollbar-width:thin]"
            style={{ maxHeight: 'min(32rem, calc(100vh - 7rem))' }}
          >
            <WorkPlanReceipt
              plan={plan}
              agents={agents}
              statuses={statuses}
              sessionAgentId={snapshotView?.sessionAgentId}
              onNavigateToWorker={onNavigateToWorker}
            />
            {!snapshotView?.activeWorkPlan && snapshotView && snapshotView.recentWorkPlans.length > 1 ? (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Showing the latest completed Work Plan. Historical receipts remain in the transcript.
              </p>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
