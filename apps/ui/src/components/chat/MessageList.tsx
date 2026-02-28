import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ArtifactReference } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import type { ConversationEntry } from '@middleman/protocol'
import { AgentMessageRow } from './message-list/AgentMessageRow'
import { ConversationMessageRow } from './message-list/ConversationMessageRow'
import { EmptyState } from './message-list/EmptyState'
import { ToolLogRow } from './message-list/ToolLogRow'
import type {
  ConversationLogEntry,
  ToolExecutionDisplayEntry,
  ToolExecutionEvent,
  ToolExecutionLogEntry,
} from './message-list/types'

interface MessageListProps {
  messages: ConversationEntry[]
  isLoading: boolean
  activeAgentId?: string | null
  onSuggestionClick?: (suggestion: string) => void
  onArtifactClick?: (artifact: ArtifactReference) => void
}

const AUTO_SCROLL_THRESHOLD_PX = 100

type DisplayEntry =
  | {
      type: 'conversation_message'
      id: string
      message: Extract<ConversationEntry, { type: 'conversation_message' }>
    }
  | {
      type: 'agent_message'
      id: string
      message: Extract<ConversationEntry, { type: 'agent_message' }>
    }
  | {
      type: 'tool_execution'
      id: string
      entry: ToolExecutionDisplayEntry
    }
  | {
      type: 'runtime_error_log'
      id: string
      entry: ConversationLogEntry
    }

function isNearBottom(container: HTMLElement, threshold = AUTO_SCROLL_THRESHOLD_PX): boolean {
  const distanceFromBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight
  return distanceFromBottom <= threshold
}

function isToolExecutionLog(entry: ConversationLogEntry): entry is ToolExecutionLogEntry {
  return (
    entry.kind === 'tool_execution_start' ||
    entry.kind === 'tool_execution_update' ||
    entry.kind === 'tool_execution_end'
  )
}

function isToolExecutionEvent(entry: ConversationEntry): entry is ToolExecutionEvent {
  if (entry.type === 'agent_tool_call') {
    return true
  }

  return entry.type === 'conversation_log' && isToolExecutionLog(entry)
}

function resolveToolExecutionEventActorAgentId(event: ToolExecutionEvent): string {
  return event.type === 'agent_tool_call' ? event.actorAgentId : event.agentId
}

function hydrateToolDisplayEntry(
  displayEntry: ToolExecutionDisplayEntry,
  event: ToolExecutionEvent,
): void {
  displayEntry.actorAgentId = resolveToolExecutionEventActorAgentId(event)
  displayEntry.toolName = event.toolName ?? displayEntry.toolName
  displayEntry.toolCallId = event.toolCallId ?? displayEntry.toolCallId
  displayEntry.timestamp = event.timestamp
  displayEntry.latestKind = event.kind

  if (event.kind === 'tool_execution_start') {
    displayEntry.inputPayload = event.text
    displayEntry.latestPayload = event.text
    displayEntry.outputPayload = undefined
    displayEntry.isError = false
    return
  }

  if (event.kind === 'tool_execution_update') {
    displayEntry.latestPayload = event.text
    return
  }

  displayEntry.outputPayload = event.text
  displayEntry.latestPayload = event.text
  displayEntry.isError = event.isError
}

function buildDisplayEntries(messages: ConversationEntry[]): DisplayEntry[] {
  const displayEntries: DisplayEntry[] = []
  const toolEntriesByCallId = new Map<string, ToolExecutionDisplayEntry>()

  for (const [index, message] of messages.entries()) {
    if (message.type === 'conversation_message') {
      displayEntries.push({
        type: 'conversation_message',
        id: `message-${message.timestamp}-${index}`,
        message,
      })
      continue
    }

    if (message.type === 'agent_message') {
      displayEntries.push({
        type: 'agent_message',
        id: `agent-message-${message.timestamp}-${index}`,
        message,
      })
      continue
    }

    if (isToolExecutionEvent(message)) {
      const actorAgentId = resolveToolExecutionEventActorAgentId(message)
      const callId = message.toolCallId?.trim()

      if (callId) {
        const toolGroupKey = `${actorAgentId}:${callId}`
        let displayEntry = toolEntriesByCallId.get(toolGroupKey)

        if (!displayEntry) {
          displayEntry = {
            id: `tool-${toolGroupKey}`,
            actorAgentId,
            toolName: message.toolName,
            toolCallId: callId,
            timestamp: message.timestamp,
            latestKind: message.kind,
          }

          displayEntries.push({
            type: 'tool_execution',
            id: displayEntry.id,
            entry: displayEntry,
          })

          toolEntriesByCallId.set(toolGroupKey, displayEntry)
        }

        hydrateToolDisplayEntry(displayEntry, message)
        continue
      }

      const displayEntry: ToolExecutionDisplayEntry = {
        id: `tool-${message.timestamp}-${index}`,
        actorAgentId,
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        timestamp: message.timestamp,
        latestKind: message.kind,
      }

      hydrateToolDisplayEntry(displayEntry, message)

      displayEntries.push({
        type: 'tool_execution',
        id: displayEntry.id,
        entry: displayEntry,
      })
      continue
    }

    if (message.type === 'conversation_log' && message.isError) {
      displayEntries.push({
        type: 'runtime_error_log',
        id: `runtime-log-${message.timestamp}-${index}`,
        entry: message,
      })
    }
  }

  return displayEntries
}

function LoadingIndicator() {
  return (
    <div
      className="mt-3 flex justify-start"
      role="status"
      aria-live="polite"
      aria-label="Assistant is working"
    >
      <div className="flex items-center gap-0.5">
        <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-duration:900ms]" />
        <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:150ms] [animation-duration:900ms]" />
        <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:300ms] [animation-duration:900ms]" />
      </div>
    </div>
  )
}

export function MessageList({
  messages,
  isLoading,
  activeAgentId,
  onSuggestionClick,
  onArtifactClick,
}: MessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const previousAgentIdRef = useRef<string | null>(null)
  const previousFirstEntryIdRef = useRef<string | null>(null)
  const previousEntryCountRef = useRef(0)
  const hasScrolledRef = useRef(false)
  const isAtBottomRef = useRef(true)
  const [showScrollButton, setShowScrollButton] = useState(false)

  const displayEntries = useMemo(() => buildDisplayEntries(messages), [messages])

  const updateIsAtBottom = () => {
    const container = scrollContainerRef.current
    if (!container) {
      isAtBottomRef.current = true
      setShowScrollButton(false)
      return
    }

    const isAtBottom = isNearBottom(container)
    isAtBottomRef.current = isAtBottom
    setShowScrollButton(!isAtBottom)
  }

  const handleScroll = () => {
    updateIsAtBottom()
  }

  useEffect(() => {
    const nextAgentId = activeAgentId ?? null
    const nextFirstEntryId = displayEntries[0]?.id ?? null
    const nextEntryCount = displayEntries.length

    const isInitialScroll = !hasScrolledRef.current
    const didAgentChange = previousAgentIdRef.current !== nextAgentId
    const didConversationReset =
      previousEntryCountRef.current > 0 &&
      (nextEntryCount === 0 ||
        previousFirstEntryIdRef.current !== nextFirstEntryId ||
        nextEntryCount < previousEntryCountRef.current)
    const didInitialConversationLoad =
      previousEntryCountRef.current === 0 && nextEntryCount > 0

    const shouldForceScroll =
      isInitialScroll ||
      didAgentChange ||
      didConversationReset ||
      didInitialConversationLoad
    const shouldAutoScroll = shouldForceScroll || isAtBottomRef.current

    if (shouldAutoScroll) {
      bottomRef.current?.scrollIntoView({
        behavior: shouldForceScroll ? 'instant' : 'smooth',
        block: 'end',
      })
      isAtBottomRef.current = true
      setShowScrollButton(false)
    }

    hasScrolledRef.current = true
    previousAgentIdRef.current = nextAgentId
    previousFirstEntryIdRef.current = nextFirstEntryId
    previousEntryCountRef.current = nextEntryCount
  }, [activeAgentId, displayEntries, isLoading])

  if (displayEntries.length === 0 && !isLoading) {
    return (
      <EmptyState
        activeAgentId={activeAgentId}
        onSuggestionClick={onSuggestionClick}
      />
    )
  }

  const handleScrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    isAtBottomRef.current = true
    setShowScrollButton(false)
  }

  return (
    <div className="relative min-h-0 flex flex-1 flex-col overflow-hidden">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent',
          '[scrollbar-width:thin] [scrollbar-color:transparent_transparent]',
          'hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]',
        )}
      >
        <div className="space-y-2 p-2 md:p-3">
          {displayEntries.map((entry) => {
            if (entry.type === 'conversation_message') {
              return (
                <ConversationMessageRow
                  key={entry.id}
                  message={entry.message}
                  onArtifactClick={onArtifactClick}
                />
              )
            }

            if (entry.type === 'agent_message') {
              return <AgentMessageRow key={entry.id} message={entry.message} />
            }

            return (
              <ToolLogRow
                key={entry.id}
                type={entry.type}
                entry={entry.entry}
              />
            )
          })}
          {isLoading ? <LoadingIndicator /> : null}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
        <Button
          type="button"
          size="icon"
          tabIndex={showScrollButton ? 0 : -1}
          aria-hidden={!showScrollButton}
          aria-label="Scroll to latest message"
          onClick={handleScrollToBottom}
          className={cn(
            'size-9 rounded-full bg-background/80 text-foreground shadow-md ring-1 ring-border backdrop-blur-sm',
            'transition-opacity transition-transform duration-200',
            showScrollButton
              ? 'pointer-events-auto translate-y-0 opacity-100'
              : 'pointer-events-none translate-y-2 opacity-0',
          )}
        >
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
