import { ExternalLink } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus } from '@forge/protocol'
import { ActiveWorkStatusBadge } from './ActiveWorkStatusBadge'
import {
  isActionableWorkerLink,
  resolveWorkerChipLabel,
  resolveWorkerStatus,
  type WorkPlanItemSnapshotView,
} from './active-work-utils'

interface ActiveWorkItemDetailsProps {
  item: WorkPlanItemSnapshotView
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus }>
  sessionAgentId?: string
  onNavigateToWorker?: (agentId: string) => void
}

function WorkerChip({
  agentId,
  label,
  agents,
  statuses,
  sessionAgentId,
  onNavigateToWorker,
}: {
  agentId: string
  label?: string
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus }>
  sessionAgentId?: string
  onNavigateToWorker?: (agentId: string) => void
}) {
  const actionable = Boolean(onNavigateToWorker) && isActionableWorkerLink(agentId, sessionAgentId, agents)
  const resolvedLabel = resolveWorkerChipLabel(agentId, label, sessionAgentId, agents)
  const status = actionable ? resolveWorkerStatus(agentId, statuses, agents) : 'unavailable'
  const className = cn(
    'inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground',
    actionable && 'cursor-pointer transition-colors hover:border-border hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    status === 'streaming' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  )

  if (actionable) {
    return (
      <button
        type="button"
        className={className}
        aria-label={`View worker transcript: ${resolvedLabel}, ${status}`}
        onClick={() => onNavigateToWorker?.(agentId)}
      >
        <span className="truncate">{resolvedLabel}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0 capitalize">{status}</span>
        <ExternalLink className="size-3 shrink-0 opacity-70" aria-hidden="true" />
      </button>
    )
  }

  return (
    <span className={className} title={`${resolvedLabel} · ${status}`}>
      <span className="truncate">{resolvedLabel}</span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0 capitalize">{status}</span>
    </span>
  )
}

export function ActiveWorkItemDetails({
  item,
  agents,
  statuses,
  sessionAgentId,
  onNavigateToWorker,
}: ActiveWorkItemDetailsProps) {
  const totalWorkerLinks = item.workerLinkCount ?? item.workerLinks.length
  const hiddenWorkerLinks = Math.max(0, totalWorkerLinks - item.workerLinks.length)
  const hasDetails = item.note || item.blocker || item.result || item.workerLinks.length > 0 || hiddenWorkerLinks > 0

  return (
    <div className="mt-2 rounded-md border border-border/60 bg-background/60 p-3 text-xs" role="region" aria-label={`${item.title} details`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ActiveWorkStatusBadge status={item.status} scope="item" />
        {item.phase ? <span className="text-muted-foreground">Phase: {item.phase}</span> : null}
      </div>

      {!hasDetails ? (
        <p className="mt-2 text-muted-foreground">No details yet.</p>
      ) : null}

      {item.note ? (
        <div className="mt-2">
          <div className="font-medium text-foreground">Note</div>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{item.note}</p>
        </div>
      ) : null}

      {item.blocker ? (
        <div className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/10 p-2">
          <div className="font-medium text-amber-200">Blocker{item.blocker.needsUser ? ' · needs user input' : ''}</div>
          <p className="mt-1 whitespace-pre-wrap text-amber-100/80">{item.blocker.reason}</p>
        </div>
      ) : null}

      {item.result ? (
        <div className="mt-2">
          <div className="font-medium text-foreground">Result · {item.result.status}</div>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{item.result.summary}</p>
        </div>
      ) : null}

      {totalWorkerLinks > 0 ? (
        <>
          <Separator className="my-2" />
          <div className="font-medium text-foreground">Linked workers</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {item.workerLinks.map((link) => (
              <WorkerChip
                key={link.linkId}
                agentId={link.agentId}
                label={link.label}
                agents={agents}
                statuses={statuses}
                sessionAgentId={sessionAgentId}
                onNavigateToWorker={onNavigateToWorker}
              />
            ))}
            {hiddenWorkerLinks > 0 ? (
              <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground">
                +{hiddenWorkerLinks} more linked worker{hiddenWorkerLinks === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
