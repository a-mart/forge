import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
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
import { formatElapsed } from '@/lib/format-utils'
import { cn } from '@/lib/utils'
import type { AgentActivityEntry } from '@/lib/ws-state'
import type { AgentDescriptor, AgentStatus } from '@forge/protocol'
import { WorkerQuickLook } from './WorkerQuickLook'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkerPillBarProps {
  workers: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; streamingStartedAt?: number }>
  activityMessages: AgentActivityEntry[]
  onNavigateToWorker: (agentId: string) => void
}

interface PillEntry {
  worker: AgentDescriptor
  status: AgentStatus
  /** Epoch ms when this streaming run started (from ws-client state, persists across navigation). */
  streamingStartedAt: number
  /** Frozen elapsed ms when worker left streaming. undefined = still counting. */
  frozenElapsedMs?: number
  /** Whether this entry is in its exit fade-out period */
  exiting: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWorkerStatus(
  worker: AgentDescriptor,
  statuses: Record<string, { status: AgentStatus }>,
): AgentStatus {
  return statuses[worker.agentId]?.status ?? worker.status
}

/**
 * Pre-filter activity messages into a Map keyed by worker agentId.
 * agent_message entries are indexed by both fromAgentId and toAgentId.
 */
function buildActivityByWorker(
  activityMessages: AgentActivityEntry[],
): Map<string, AgentActivityEntry[]> {
  const map = new Map<string, AgentActivityEntry[]>()

  function push(id: string, entry: AgentActivityEntry) {
    let arr = map.get(id)
    if (!arr) {
      arr = []
      map.set(id, arr)
    }
    arr.push(entry)
  }

  for (const entry of activityMessages) {
    if (entry.type === 'agent_tool_call') {
      push(entry.actorAgentId, entry)
    } else if (entry.type === 'agent_message') {
      if (entry.fromAgentId) {
        push(entry.fromAgentId, entry)
      }
      // Also index by toAgentId if different from fromAgentId
      if (entry.toAgentId && entry.toAgentId !== entry.fromAgentId) {
        push(entry.toAgentId, entry)
      }
    }
  }

  return map
}

// ─── Pill Component ───────────────────────────────────────────────────────────

/** Debounce delay before removing a pill after a worker stops streaming (ms). */
const REMOVE_DELAY_MS = 500

const WorkerPill = memo(function WorkerPill({
  entry,
  tick,
  activityByWorkerRef,
  onNavigateToWorker,
}: {
  entry: PillEntry
  tick: number
  activityByWorkerRef: RefObject<Map<string, AgentActivityEntry[]>>
  onNavigateToWorker: (agentId: string) => void
}) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const { worker, status, frozenElapsedMs, exiting } = entry

  // Fix #8: Close popover gracefully when pill enters exit state
  useEffect(() => {
    if (exiting && popoverOpen) {
      setPopoverOpen(false)
    }
  }, [exiting, popoverOpen])

  // Compute elapsed time — driven by shared tick counter
  const elapsedMs = useMemo(() => {
    if (frozenElapsedMs !== undefined) return frozenElapsedMs
    return Date.now() - entry.streamingStartedAt
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozenElapsedMs, entry.streamingStartedAt, tick])

  const elapsedLabel = formatElapsed(elapsedMs)

  // Read activity from ref (avoids new array refs destabilising memo)
  const workerActivity = activityByWorkerRef.current?.get(worker.agentId) ?? EMPTY_ACTIVITY

  // Take last 30 entries for quick-look
  const recentActivity = workerActivity.slice(-30)

  // Latest tool call summary for tooltip
  let latestToolSummary: string | null = null
  for (let i = workerActivity.length - 1; i >= 0; i--) {
    const act = workerActivity[i]
    if (act.type === 'agent_tool_call' && act.toolName) {
      latestToolSummary = act.toolName
      break
    }
  }

  const modelId = worker.model?.modelId ?? 'unknown'
  const thinkingLevel = worker.model?.thinkingLevel
  const modelLabel =
    thinkingLevel && thinkingLevel !== 'none'
      ? `${modelId} · ${thinkingLevel}`
      : modelId
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
      {/* Fix #3: Suppress tooltip while popover is open */}
      <Tooltip open={popoverOpen ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'group inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-500',
                'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
                'hover:bg-emerald-500/20 dark:hover:bg-emerald-500/25',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                exiting && 'opacity-0',
              )}
            >
              {/* Fix #4: Subtle pulse instead of aggressive ping */}
              <span className="relative inline-flex size-2 animate-pulse rounded-full bg-emerald-500" />

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

      {/* Fix #1: Larger popover for desktop */}
      <PopoverContent
        side="top"
        sideOffset={8}
        align="start"
        avoidCollisions={false}
        className="flex w-[min(62rem,_85vw)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
        style={{ maxHeight: 'min(80vh, calc(100vh - 6rem))' }}
      >
        <WorkerQuickLook
          worker={worker}
          status={status}
          recentActivity={recentActivity}
          onViewFullConversation={handleViewConversation}
          streamingStartedAt={entry.streamingStartedAt}
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
  // Track whether we've ever had pills (for exit animation)
  const hasEverHadPillsRef = useRef(false)

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

  // Fix #7: Pre-filter activity messages by worker ID (O(M) once, not O(N×M) per tick)
  // Store in a ref so pill components can read it without a prop change triggering re-render
  const activityByWorkerRef = useRef<Map<string, AgentActivityEntry[]>>(new Map())
  activityByWorkerRef.current = useMemo(
    () => buildActivityByWorker(activityMessages),
    [activityMessages],
  )

  // Reconcile pill entries: add new streaming workers, mark exiting ones.
  // Note: This mutates pillEntriesRef.current (a Map in a ref) then triggers forceRender.
  // Under StrictMode's double-execution, the idempotent Map.set() calls are safe,
  // and exit timers are cleared before re-scheduling so no duplicates occur.
  useEffect(() => {
    const current = pillEntriesRef.current
    let changed = false

    // Add or update streaming workers
    for (const id of streamingWorkerIds) {
      const worker = workersById.get(id)
      if (!worker) continue

      const existing = current.get(id)
      // Use the persistent timestamp from ws-client state; fall back to now
      const startedAt = statuses[id]?.streamingStartedAt ?? Date.now()
      if (!existing) {
        // New streaming worker — add pill
        current.set(id, {
          worker,
          status: 'streaming',
          streamingStartedAt: startedAt,
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
        // Worker came back to streaming — reset timer for new run
        existing.exiting = false
        existing.frozenElapsedMs = undefined
        existing.streamingStartedAt = startedAt
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
        // Freeze the timer at current run duration
        entry.frozenElapsedMs = Date.now() - entry.streamingStartedAt

        // Clear any existing timer for this ID before scheduling a new one
        const existingTimer = exitTimersRef.current.get(id)
        if (existingTimer) {
          clearTimeout(existingTimer)
        }

        // Schedule removal after fade-out completes
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

  if (pillEntries.length > 0) {
    hasEverHadPillsRef.current = true
  }

  useEffect(() => {
    if (!hasActivePills) return
    const interval = setInterval(() => {
      setTick((t) => t + 1)
    }, 1000)
    return () => clearInterval(interval)
  }, [hasActivePills])

  // Fix #6: Don't unmount before exit animation completes.
  // Render with grid-rows-[0fr] (collapsed) when empty, grid-rows-[1fr] when pills exist.
  // Only fully bail if we've never had any pills at all.
  if (!hasEverHadPillsRef.current && pillEntries.length === 0) return null

  const isExpanded = pillEntries.length > 0

  return (
    <div
      data-tour="workers"
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out',
        isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
      onTransitionEnd={() => {
        // After collapse animation finishes, reset so the component can unmount cleanly
        if (pillEntries.length === 0) {
          hasEverHadPillsRef.current = false
          forceRender((n) => n + 1)
        }
      }}
    >
      <div className="overflow-hidden">
        {/* Fix #15: Single TooltipProvider for all pills */}
        <TooltipProvider delayDuration={400}>
          <div className="flex items-center gap-1.5 overflow-x-auto border-t border-border/40 bg-background px-2 py-1.5 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            {pillEntries.map((entry) => (
              <WorkerPill
                key={entry.worker.agentId}
                entry={entry}
                tick={tick}
                activityByWorkerRef={activityByWorkerRef}
                onNavigateToWorker={onNavigateToWorker}
              />
            ))}
          </div>
        </TooltipProvider>
      </div>
    </div>
  )
})

const EMPTY_ACTIVITY: AgentActivityEntry[] = []
