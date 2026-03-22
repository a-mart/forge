import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { cn } from '@/lib/utils'
import type { AgentActivityEntry } from '@/lib/ws-state'
import type { AgentDescriptor, AgentStatus } from '@forge/protocol'
import { WorkerQuickLook } from './WorkerQuickLook'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkerPillBarProps {
  workers: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus }>
  activityMessages: AgentActivityEntry[]
  onNavigateToWorker: (agentId: string) => void
}

interface PillEntry {
  worker: AgentDescriptor
  status: AgentStatus
  /** Epoch ms when the timer should freeze (worker left streaming). undefined = still counting. */
  frozenElapsedMs?: number
  /** Whether this entry is in its exit fade-out period */
  exiting: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function getWorkerStatus(
  worker: AgentDescriptor,
  statuses: Record<string, { status: AgentStatus }>,
): AgentStatus {
  return statuses[worker.agentId]?.status ?? worker.status
}

// ─── Pill Component ───────────────────────────────────────────────────────────

const REMOVE_DELAY_MS = 500

const WorkerPill = memo(function WorkerPill({
  entry,
  tick,
  activityMessages,
  onNavigateToWorker,
}: {
  entry: PillEntry
  tick: number
  activityMessages: AgentActivityEntry[]
  onNavigateToWorker: (agentId: string) => void
}) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const { worker, status, frozenElapsedMs, exiting } = entry

  // Compute elapsed time
  const elapsedMs = useMemo(() => {
    if (frozenElapsedMs !== undefined) return frozenElapsedMs
    const createdEpoch = Date.parse(worker.createdAt)
    if (!Number.isFinite(createdEpoch)) return 0
    return Date.now() - createdEpoch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozenElapsedMs, worker.createdAt, tick])

  const elapsedLabel = formatElapsed(elapsedMs)

  // Filter activity messages for this worker
  const workerActivity = useMemo(() => {
    return activityMessages
      .filter((entry) => {
        if (entry.type === 'agent_tool_call') {
          return entry.actorAgentId === worker.agentId
        }
        if (entry.type === 'agent_message') {
          return entry.fromAgentId === worker.agentId || entry.toAgentId === worker.agentId
        }
        return false
      })
      .slice(-8)
  }, [activityMessages, worker.agentId])

  // Latest tool call summary for tooltip
  const latestToolSummary = useMemo(() => {
    for (let i = workerActivity.length - 1; i >= 0; i--) {
      const entry = workerActivity[i]
      if (entry.type === 'agent_tool_call' && entry.toolName) {
        return entry.toolName
      }
    }
    return null
  }, [workerActivity])

  const modelLabel = worker.model?.modelId ?? 'unknown'
  const statusText = status === 'streaming' ? 'Working' : status === 'idle' ? 'Idle' : status

  const handleViewConversation = useCallback(() => {
    setPopoverOpen(false)
    onNavigateToWorker(worker.agentId)
  }, [onNavigateToWorker, worker.agentId])

  const truncatedName = worker.displayName
    ? worker.displayName.length > 20
      ? `${worker.displayName.slice(0, 20)}…`
      : worker.displayName
    : worker.agentId.slice(0, 20)

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'group inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-200',
                  'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
                  'hover:bg-emerald-500/20 dark:hover:bg-emerald-500/25',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  exiting && 'opacity-0',
                )}
              >
                {/* Pulsing dot */}
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                </span>

                {/* Worker name */}
                <span className="truncate">{truncatedName}</span>

                {/* Elapsed timer */}
                <span className="tabular-nums text-emerald-600/60 dark:text-emerald-400/60">
                  {elapsedLabel}
                </span>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>

          <TooltipContent side="top" sideOffset={6}>
            <div className="space-y-0.5 text-xs">
              <div className="font-medium">{worker.displayName ?? worker.agentId}</div>
              <div className="opacity-80">{modelLabel}</div>
              <div className="opacity-80">
                {statusText}
                {latestToolSummary ? ` · ${latestToolSummary}` : ''}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent
        side="top"
        sideOffset={8}
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)] p-0"
      >
        <WorkerQuickLook
          worker={worker}
          status={status}
          recentActivity={workerActivity}
          onViewFullConversation={handleViewConversation}
        />
      </PopoverContent>
    </Popover>
  )
})

// ─── Pill Bar Container ───────────────────────────────────────────────────────

export const WorkerPillBar = memo(function WorkerPillBar({
  workers,
  statuses,
  activityMessages,
  onNavigateToWorker,
}: WorkerPillBarProps) {
  const [tick, setTick] = useState(0)
  const pillEntriesRef = useRef<Map<string, PillEntry>>(new Map())
  const exitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [, forceRender] = useState(0)

  // Derive which workers are currently streaming
  const streamingWorkerIds = useMemo(() => {
    return new Set(
      workers
        .filter((w) => getWorkerStatus(w, statuses) === 'streaming')
        .map((w) => w.agentId),
    )
  }, [workers, statuses])

  // Workers by ID for quick lookup
  const workersById = useMemo(() => {
    const map = new Map<string, AgentDescriptor>()
    for (const w of workers) {
      map.set(w.agentId, w)
    }
    return map
  }, [workers])

  // Reconcile pill entries: add new streaming workers, mark exiting ones
  useEffect(() => {
    const current = pillEntriesRef.current
    let changed = false

    // Add or update streaming workers
    for (const id of streamingWorkerIds) {
      const worker = workersById.get(id)
      if (!worker) continue

      const existing = current.get(id)
      if (!existing) {
        // New streaming worker — add pill
        current.set(id, {
          worker,
          status: 'streaming',
          exiting: false,
        })
        // Cancel any pending exit timer
        const timer = exitTimersRef.current.get(id)
        if (timer) {
          clearTimeout(timer)
          exitTimersRef.current.delete(id)
        }
        changed = true
      } else if (existing.exiting) {
        // Worker came back to streaming — cancel exit
        existing.exiting = false
        existing.frozenElapsedMs = undefined
        existing.status = 'streaming'
        existing.worker = worker
        const timer = exitTimersRef.current.get(id)
        if (timer) {
          clearTimeout(timer)
          exitTimersRef.current.delete(id)
        }
        changed = true
      } else {
        // Update worker descriptor
        existing.worker = worker
        existing.status = 'streaming'
      }
    }

    // Mark workers that stopped streaming as exiting
    for (const [id, entry] of current) {
      if (!streamingWorkerIds.has(id) && !entry.exiting) {
        entry.exiting = true
        entry.status = getWorkerStatus(entry.worker, statuses)
        // Freeze the timer
        const createdEpoch = Date.parse(entry.worker.createdAt)
        entry.frozenElapsedMs = Number.isFinite(createdEpoch) ? Date.now() - createdEpoch : 0

        // Schedule removal
        const timer = setTimeout(() => {
          current.delete(id)
          exitTimersRef.current.delete(id)
          forceRender((n) => n + 1)
        }, REMOVE_DELAY_MS)
        exitTimersRef.current.set(id, timer)
        changed = true
      }
    }

    if (changed) {
      forceRender((n) => n + 1)
    }
  }, [streamingWorkerIds, workersById, statuses])

  // Cleanup exit timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of exitTimersRef.current.values()) {
        clearTimeout(timer)
      }
    }
  }, [])

  // Shared 1-second interval for timer ticks
  const pillEntries = Array.from(pillEntriesRef.current.values())
  const hasActivePills = pillEntries.some((e) => !e.exiting)

  useEffect(() => {
    if (!hasActivePills) return
    const interval = setInterval(() => {
      setTick((t) => t + 1)
    }, 1000)
    return () => clearInterval(interval)
  }, [hasActivePills])

  if (pillEntries.length === 0) return null

  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out',
        pillEntries.length > 0 ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div className="overflow-hidden">
        <div className="flex items-center gap-1.5 overflow-x-auto border-t border-border/40 bg-background px-2 py-1.5 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {pillEntries.map((entry) => (
            <WorkerPill
              key={entry.worker.agentId}
              entry={entry}
              tick={tick}
              activityMessages={activityMessages}
              onNavigateToWorker={onNavigateToWorker}
            />
          ))}
        </div>
      </div>
    </div>
  )
})
