import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, ClipboardList } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus, WorkPlanCreatedEvent, WorkPlanSnapshot } from '@forge/protocol'
import { ActiveWorkStatusBadge, WorkPlanReceipt } from '../active-work'
import { formatPlanStatus } from '../active-work/active-work-utils'

interface WorkPlanCreatedRowProps {
  event: WorkPlanCreatedEvent
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus }>
  latestPlan?: WorkPlanSnapshot | null
  onNavigateToWorker?: (agentId: string) => void
}

function formatItemCount(count: number): string {
  return `${count} item${count === 1 ? '' : 's'}`
}

export function WorkPlanCreatedRow({ event, agents, statuses, latestPlan, onNavigateToWorker }: WorkPlanCreatedRowProps) {
  const [expanded, setExpanded] = useState(false)
  const reactId = useId()
  const contentId = `${reactId}-work-plan-created-${event.id}`
  const displayPlan = latestPlan ?? event.plan
  const itemCount = displayPlan.itemCount ?? displayPlan.items.length
  const metadata = [
    displayPlan.mode ? `${displayPlan.mode} mode` : null,
    formatItemCount(itemCount),
  ].filter(Boolean).join(' · ')

  return (
    <div className="flex justify-center px-1 py-1 text-sm text-muted-foreground">
      <div className="w-full max-w-3xl rounded-xl border border-border/60 bg-muted/20 text-left shadow-sm">
        <button
          type="button"
          className={cn(
            'flex w-full min-w-0 items-start gap-2 rounded-xl p-3 text-left transition-colors hover:bg-muted/35',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={expanded ? `Collapse Work Plan created: ${event.plan.title}` : `Expand Work Plan created: ${event.plan.title}`}
        >
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ClipboardList className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">Work Plan created: {event.plan.title}</span>
              <ActiveWorkStatusBadge status={displayPlan.status} />
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{formatPlanStatus(displayPlan.status)}</span>
              {metadata ? <span aria-hidden="true">·</span> : null}
              {metadata ? <span>{metadata}</span> : null}
              {displayPlan.itemsTruncated ? <span>shown items truncated</span> : null}
            </span>
            {displayPlan.goal ? <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{displayPlan.goal}</span> : null}
          </span>
          <span className="mt-1 shrink-0 text-muted-foreground">
            {expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
          </span>
        </button>
        <div id={contentId} hidden={!expanded} className={expanded ? 'border-t border-border/60 p-3' : 'hidden'}>
          {expanded ? (
            <WorkPlanReceipt
              plan={displayPlan}
              agents={agents}
              statuses={statuses}
              sessionAgentId={event.agentId}
              onNavigateToWorker={onNavigateToWorker}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
