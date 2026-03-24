import { memo, useCallback, useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentActivityEntry } from '@/lib/ws-state'
import { formatElapsed } from '@/lib/format-utils'
import type { AgentDescriptor, AgentStatus } from '@forge/protocol'
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
}

type QuickLookEntry =
  | { type: 'agent_message'; id: string; message: AgentMessageEntry }
  | { type: 'tool_execution'; id: string; entry: ToolExecutionDisplayEntry }

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
}: WorkerQuickLookProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

  const displayEntries = useMemo(
    () => buildQuickLookEntries(recentActivity),
    [recentActivity],
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

  const [, setTick] = useState(0)
  const isStreaming = status === 'streaming'

  useEffect(() => {
    if (!isStreaming || !streamingStartedAt) return
    const interval = setInterval(() => setTick((t) => t + 1), 1_000)
    return () => clearInterval(interval)
  }, [isStreaming, streamingStartedAt])

  const elapsedLabel =
    isStreaming && streamingStartedAt
      ? formatElapsed(Date.now() - streamingStartedAt)
      : null

  const modelLabel = worker.model?.modelId ?? null
  const thinkingLevel = worker.model?.thinkingLevel
  const modelWithThinking =
    modelLabel && thinkingLevel && thinkingLevel !== 'none'
      ? `${modelLabel} · ${thinkingLevel}`
      : modelLabel
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
    <div className="flex min-h-0 flex-1 flex-col">
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

      {/* Activity feed */}
      <div ref={scrollRef} onScroll={handleScroll} className="max-h-[min(36rem,_70vh)] overflow-y-auto px-2 py-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15 hover:[&::-webkit-scrollbar-thumb]:bg-white/30 [scrollbar-color:rgba(255,255,255,0.15)_transparent] [scrollbar-width:thin]">
        {displayEntries.length === 0 ? (
          <p className="py-4 text-center text-xs italic text-muted-foreground">
            No recent activity
          </p>
        ) : (
          <div className="space-y-0.5">
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
