import { memo, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SpecialistBadge } from '@/components/chat/SpecialistBadge'
import { WorkerQuickLook } from '@/components/chat/WorkerQuickLook'
import { cn } from '@/lib/utils'
import type { AgentActivityEntry } from '@/lib/ws-state'
import type { AgentDescriptor, AgentStatus } from '@forge/protocol'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkerHistoryPanelProps {
  workers: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; streamingStartedAt?: number }>
  activityMessages: AgentActivityEntry[]
  onNavigateToWorker: (agentId: string) => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLAPSED_LIMIT = 5

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWorkerStatus(
  worker: AgentDescriptor,
  statuses: Record<string, { status: AgentStatus }>,
): AgentStatus {
  return statuses[worker.agentId]?.status ?? worker.status
}

function buildActivityByWorker(
  activityMessages: AgentActivityEntry[],
): Map<string, AgentActivityEntry[]> {
  const map = new Map<string, AgentActivityEntry[]>()

  for (const entry of activityMessages) {
    if (entry.type === 'agent_tool_call') {
      let arr = map.get(entry.actorAgentId)
      if (!arr) {
        arr = []
        map.set(entry.actorAgentId, arr)
      }
      arr.push(entry)
    } else if (entry.type === 'agent_message') {
      if (entry.fromAgentId) {
        let arr = map.get(entry.fromAgentId)
        if (!arr) {
          arr = []
          map.set(entry.fromAgentId, arr)
        }
        arr.push(entry)
      }
      if (entry.toAgentId && entry.toAgentId !== entry.fromAgentId) {
        let arr = map.get(entry.toAgentId)
        if (!arr) {
          arr = []
          map.set(entry.toAgentId, arr)
        }
        arr.push(entry)
      }
    }
  }

  return map
}

const EMPTY_ACTIVITY: AgentActivityEntry[] = []

// ─── Worker Entry ─────────────────────────────────────────────────────────────

const WorkerEntry = memo(function WorkerEntry({
  worker,
  status,
  recentActivity,
  streamingStartedAt,
  onNavigateToWorker,
}: {
  worker: AgentDescriptor
  status: AgentStatus
  recentActivity: AgentActivityEntry[]
  streamingStartedAt?: number
  onNavigateToWorker: (agentId: string) => void
}) {
  const [popoverOpen, setPopoverOpen] = useState(false)

  const isStreaming = status === 'streaming'
  const isStopped = status === 'terminated' || status === 'stopped'

  const name = worker.displayName || worker.agentId
  const modelId = worker.model?.modelId ?? 'unknown'
  const thinkingLevel = worker.model?.thinkingLevel
  const modelLabel =
    thinkingLevel && thinkingLevel !== 'none'
      ? `${modelId} · ${thinkingLevel}`
      : modelId

  const handleViewConversation = () => {
    setPopoverOpen(false)
    onNavigateToWorker(worker.agentId)
  }

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Tooltip open={popoverOpen ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                'hover:bg-accent/50',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              )}
            >
              {/* Status dot */}
              <span
                className={cn(
                  'inline-block size-1.5 shrink-0 rounded-full',
                  isStreaming
                    ? 'bg-emerald-500 animate-pulse'
                    : isStopped
                      ? 'bg-red-400/60'
                      : 'bg-muted-foreground/40',
                )}
              />

              {/* Worker name */}
              <span className="min-w-0 flex-1 truncate text-foreground/90">
                {name}
              </span>

              {/* Specialist badge */}
              {worker.specialistId && worker.specialistDisplayName && worker.specialistColor ? (
                <SpecialistBadge
                  displayName={worker.specialistDisplayName}
                  color={worker.specialistColor}
                  className="shrink-0"
                />
              ) : null}

              {/* Model label */}
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {modelId}
              </span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>

        <TooltipContent side="right" sideOffset={6} className="px-2 py-1 text-[10px]">
          <p className="font-medium">{name}</p>
          <p className="opacity-80">{modelLabel}</p>
          <p className="opacity-80">{status}</p>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="bottom"
        sideOffset={8}
        align="start"
        avoidCollisions
        className="flex w-[min(62rem,_85vw)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
        style={{ maxHeight: 'min(80vh, calc(100vh - 6rem))' }}
      >
        <WorkerQuickLook
          worker={worker}
          status={status}
          recentActivity={recentActivity}
          onViewFullConversation={handleViewConversation}
          streamingStartedAt={streamingStartedAt}
        />
      </PopoverContent>
    </Popover>
  )
})

// ─── Panel ────────────────────────────────────────────────────────────────────

export const WorkerHistoryPanel = memo(function WorkerHistoryPanel({
  workers,
  statuses,
  activityMessages,
  onNavigateToWorker,
}: WorkerHistoryPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const activityByWorker = useMemo(
    () => buildActivityByWorker(activityMessages),
    [activityMessages],
  )

  // Sort workers: streaming first, then by display name
  const sortedWorkers = useMemo(() => {
    return [...workers].sort((a, b) => {
      const statusA = getWorkerStatus(a, statuses)
      const statusB = getWorkerStatus(b, statuses)
      const aStreaming = statusA === 'streaming' ? 0 : 1
      const bStreaming = statusB === 'streaming' ? 0 : 1
      if (aStreaming !== bStreaming) return aStreaming - bStreaming
      return (a.displayName || a.agentId).localeCompare(b.displayName || b.agentId)
    })
  }, [workers, statuses])

  const hasMore = sortedWorkers.length > COLLAPSED_LIMIT
  const visibleWorkers = isExpanded ? sortedWorkers : sortedWorkers.slice(0, COLLAPSED_LIMIT)

  const streamingCount = useMemo(
    () => workers.filter((w) => getWorkerStatus(w, statuses) === 'streaming').length,
    [workers, statuses],
  )

  if (workers.length === 0) return null

  return (
    <div className="border-b border-border/40 bg-muted/20">
      {/* Section header */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Workers
        </span>
        <span className="text-[11px] text-muted-foreground/70">
          {workers.length}
          {streamingCount > 0 ? (
            <span className="text-emerald-500"> · {streamingCount} active</span>
          ) : null}
        </span>
      </div>

      {/* Worker list */}
      <TooltipProvider delayDuration={400}>
        <div className="px-1 pb-1.5">
          {visibleWorkers.map((worker) => {
            const status = getWorkerStatus(worker, statuses)
            const activity = activityByWorker.get(worker.agentId) ?? EMPTY_ACTIVITY
            const recentActivity = activity.slice(-30)
            const startedAt = statuses[worker.agentId]?.streamingStartedAt

            return (
              <WorkerEntry
                key={worker.agentId}
                worker={worker}
                status={status}
                recentActivity={recentActivity}
                streamingStartedAt={startedAt}
                onNavigateToWorker={onNavigateToWorker}
              />
            )
          })}

          {/* Show more / less toggle */}
          {hasMore ? (
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex w-full items-center justify-center gap-1 rounded-md py-1 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="size-3" />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown className="size-3" />
                  Show {sortedWorkers.length - COLLAPSED_LIMIT} more
                </>
              )}
            </button>
          ) : null}
        </div>
      </TooltipProvider>
    </div>
  )
})
