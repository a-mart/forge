import { memo, useCallback, useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentActivityEntry } from '@/lib/ws-state'
import { formatElapsed } from '@/lib/format-utils'
import type {
  AgentDescriptor,
  AgentStatus,
  GenerationThroughputLiveMeasurement,
} from '@forge/protocol'
import { finalThroughputRate } from './throughput-final'
import { formatThroughputRate } from './throughput-format'
import { AgentMessageRow } from './message-list/AgentMessageRow'
import {
  hydrateToolDisplayEntry,
  type ToolExecutionEvent,
} from './message-list/tool-display-utils'
import { ToolLogRow } from './message-list/ToolLogRow'
import type {
  AgentMessageEntry,
  ToolExecutionDisplayEntry,
} from './message-list/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkerQuickLookProps {
  worker: AgentDescriptor
  status: AgentStatus
  recentActivity: AgentActivityEntry[]
  onViewFullConversation: () => void
  streamingStartedAt?: number
  throughput?: GenerationThroughputLiveMeasurement
  latestFinal?: GenerationThroughputLiveMeasurement
}

type QuickLookEntry =
  | { type: 'agent_message'; id: string; message: AgentMessageEntry }
  | { type: 'tool_execution'; id: string; entry: ToolExecutionDisplayEntry }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getActivityIdentity(entry: AgentActivityEntry): string {
  if (entry.type === 'activity_summary') {
    return `summary:${entry.itemId}`
  }

  if (entry.type === 'agent_tool_call') {
    const callId = entry.toolCallId?.trim()
    if (callId) {
      // A tool can emit many streaming updates. Keep only the latest event for
      // each phase; the display layer already reconciles phases by call id.
      return `tool:${entry.actorAgentId}:${callId}:${entry.kind}`
    }

    return [
      'tool',
      entry.timelineEntryId,
      entry.actorAgentId,
      entry.kind,
      entry.timestamp,
      entry.text,
    ].join(':')
  }

  return [
    'message',
    entry.timelineEntryId,
    entry.agentId,
    entry.fromAgentId,
    entry.toAgentId,
    entry.timestamp,
    entry.text,
  ].join(':')
}

function mergeOpenSessionActivity(
  current: AgentActivityEntry[],
  incoming: AgentActivityEntry[],
): AgentActivityEntry[] {
  const indexByIdentity = new Map(
    current.map((entry, index) => [getActivityIdentity(entry), index]),
  )
  let next = current

  for (const entry of incoming) {
    const identity = getActivityIdentity(entry)
    const existingIndex = indexByIdentity.get(identity)
    if (existingIndex === undefined) {
      if (next === current) next = [...current]
      indexByIdentity.set(identity, next.length)
      next.push(entry)
    } else if (next[existingIndex] !== entry) {
      if (next === current) next = [...current]
      next[existingIndex] = entry
    }
  }

  return next
}

function buildQuickLookEntries(activities: AgentActivityEntry[]): QuickLookEntry[] {
  const entries: QuickLookEntry[] = []
  const toolByCallId = new Map<string, ToolExecutionDisplayEntry>()

  for (const [index, msg] of activities.entries()) {
    if (msg.type === 'agent_message') {
      entries.push({
        type: 'agent_message',
        id: `ql-msg-${msg.timestamp}-${index}`,
        message: msg as AgentMessageEntry,
      })
      continue
    }

    if (msg.type === 'activity_summary') {
      const callId = msg.correlationId ?? msg.itemId
      const groupKey = `${msg.actorAgentId}:${callId}`
      let display = toolByCallId.get(groupKey)
      if (!display) {
        display = {
          id: `ql-tool-${groupKey}`,
          actorAgentId: msg.actorAgentId,
          toolName: msg.toolName,
          toolCallId: callId,
          displaySummary: msg.displaySummary,
          timestamp: msg.timestamp,
          latestKind: 'tool_execution_end',
          isError: msg.isError,
        }
        toolByCallId.set(groupKey, display)
        entries.push({ type: 'tool_execution', id: display.id, entry: display })
      } else {
        display.timestamp = msg.timestamp
        display.latestKind = 'tool_execution_end'
        display.isError = msg.isError
        display.toolName = msg.toolName ?? display.toolName
        if (!display.inputPayload && !display.latestPayload && !display.outputPayload) {
          display.displaySummary = msg.displaySummary
        }
      }
      continue
    }

    if (msg.type === 'agent_tool_call') {
      const actorAgentId = msg.actorAgentId
      const callId = msg.toolCallId?.trim()
      const groupKey = callId ? `${actorAgentId}:${callId}` : null

      if (groupKey) {
        let display = toolByCallId.get(groupKey)
        if (!display) {
          display = {
            id: `ql-tool-${groupKey}`,
            actorAgentId,
            toolName: msg.toolName,
            toolCallId: callId,
            timestamp: msg.timestamp,
            latestKind: msg.kind,
          }
          toolByCallId.set(groupKey, display)
          entries.push({ type: 'tool_execution', id: display.id, entry: display })
        }
        hydrateToolDisplayEntry(display, msg as ToolExecutionEvent)
      } else {
        const display: ToolExecutionDisplayEntry = {
          id: `ql-tool-${msg.timestamp}-${index}`,
          actorAgentId,
          toolName: msg.toolName,
          toolCallId: msg.toolCallId,
          timestamp: msg.timestamp,
          latestKind: msg.kind,
        }
        hydrateToolDisplayEntry(display, msg as ToolExecutionEvent)
        entries.push({ type: 'tool_execution', id: display.id, entry: display })
      }
    }
  }

  return entries
}

// ─── Status Dot ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span
      className={cn(
        'inline-block size-2 rounded-full',
        status === 'streaming' && 'bg-emerald-500',
        status === 'idle' && 'bg-slate-400',
        (status === 'terminated' || status === 'stopped' || status === 'error') &&
          'bg-rose-400',
      )}
    />
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export const WorkerQuickLook = memo(function WorkerQuickLook({
  worker,
  status,
  recentActivity,
  onViewFullConversation,
  streamingStartedAt,
  throughput,
  latestFinal,
}: WorkerQuickLookProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  // Popover content unmounts on close, so this state is scoped to one open
  // session. Keep the initial slice and accumulate live rows without allowing
  // upstream rolling-window eviction to remove anything the user already saw.
  const [openSessionActivity, setOpenSessionActivity] = useState(recentActivity)

  useEffect(() => {
    setOpenSessionActivity((current) => mergeOpenSessionActivity(current, recentActivity))
  }, [recentActivity])

  const displayEntries = useMemo(
    () => buildQuickLookEntries(openSessionActivity),
    [openSessionActivity],
  )

  // Check if user has scrolled away from the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 40
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  // Scroll to bottom on initial open
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
      isAtBottomRef.current = true
    }
  }, [])

  // Auto-scroll to bottom when new entries arrive (if user hasn't scrolled up)
  useEffect(() => {
    const el = scrollRef.current
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [displayEntries])

  const isStreaming = status === 'streaming'
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!isStreaming || !streamingStartedAt) return
    // Keep nowMs ticking at 1s while streaming
    setNowMs(Date.now())
    const interval = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [isStreaming, streamingStartedAt])

  const elapsedLabel =
    isStreaming && streamingStartedAt
      ? formatElapsed(nowMs - streamingStartedAt)
      : status === 'terminated' || status === 'stopped' || status === 'idle'
        ? formatElapsed(
            new Date(worker.updatedAt).getTime() -
              new Date(worker.createdAt).getTime(),
          )
        : null

  const modelLabel = worker.model?.modelId ?? null
  const thinkingLevel = worker.model?.thinkingLevel
  const modelWithThinking =
    modelLabel && thinkingLevel && thinkingLevel !== 'none'
      ? `${modelLabel} · ${thinkingLevel}`
      : modelLabel
  const displayedRate = finalThroughputRate(throughput) ?? finalThroughputRate(latestFinal)
  const statusText =
    status === 'streaming'
      ? 'Working'
      : status === 'idle'
        ? 'Idle'
        : status === 'terminated'
          ? 'Terminated'
          : status === 'stopped'
            ? 'Stopped'
            : status

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        <StatusDot status={status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {worker.displayName ?? worker.agentId}
        </span>
        {modelWithThinking ? (
          <span className="shrink-0 rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {modelWithThinking}
          </span>
        ) : null}
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {statusText}
          {elapsedLabel ? <span className="tabular-nums"> · {elapsedLabel}</span> : null}
        </span>
      </div>
      <div
        data-worker-throughput-row
        className="flex h-7 shrink-0 items-center justify-between border-b border-border/50 px-3 text-[11px] text-muted-foreground"
      >
        <span>Latest final throughput</span>
        <span className="w-[72px] truncate whitespace-nowrap text-right tabular-nums text-foreground">
          {formatThroughputRate(displayedRate)} tok/s
        </span>
      </div>

      {/* Activity feed */}
      <div
        ref={scrollRef}
        data-worker-quick-look-scroll
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15 hover:[&::-webkit-scrollbar-thumb]:bg-white/30 [scrollbar-color:rgba(255,255,255,0.15)_transparent] [scrollbar-width:thin]"
      >
        {displayEntries.length === 0 ? (
          <p className="py-4 text-center text-xs italic text-muted-foreground">
            No recent activity
          </p>
        ) : (
          <div data-worker-quick-look-entries className="space-y-0.5">
            {displayEntries.map((entry) => {
              if (entry.type === 'agent_message') {
                return (
                  <AgentMessageRow key={entry.id} message={entry.message} />
                )
              }
              return (
                <ToolLogRow
                  key={entry.id}
                  type="tool_execution"
                  entry={entry.entry}
                  isActive={status === 'streaming'}
                  nowMs={isStreaming ? nowMs : undefined}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border/50 px-3 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-auto w-full justify-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={onViewFullConversation}
        >
          View full conversation
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </div>
  )
})
