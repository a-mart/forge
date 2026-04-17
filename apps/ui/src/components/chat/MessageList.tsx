import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ArtifactReference } from '@/lib/artifacts'
import { formatElapsed } from '@/lib/format-utils'
import { getSidebarPerfRegistry } from '@/lib/perf/sidebar-perf-debug'
import { cn } from '@/lib/utils'
import type { ChoiceAnswer, ConversationEntry, ProjectAgentInfo } from '@forge/protocol'
import { AgentMessageRow } from './message-list/AgentMessageRow'
import { ChoiceAnsweredRow } from './message-list/ChoiceAnsweredRow'
import { ChoiceRequestCard } from './message-list/ChoiceRequestCard'
import { ConversationMessageRow } from './message-list/ConversationMessageRow'
import { EmptyState } from './message-list/EmptyState'
import {
  hydrateToolDisplayEntry,
  isToolExecutionEvent,
  resolveToolExecutionEventActorAgentId,
} from './message-list/tool-display-utils'
import { ToolLogRow } from './message-list/ToolLogRow'
import type {
  ChoiceRequestDisplayEntry,
  ConversationLogEntry,
  ToolExecutionDisplayEntry,
} from './message-list/types'

interface MessageListProps {
  messages: ConversationEntry[]
  isLoading: boolean
  wsUrl?: string
  activeAgentId?: string | null
  projectAgent?: ProjectAgentInfo | null
  onSuggestionClick?: (suggestion: string) => void
  onArtifactClick?: (artifact: ArtifactReference) => void
  onForkFromMessage?: (messageId: string) => void
  onPinMessage?: (messageId: string, pinned: boolean) => void
  getVote?: (targetId: string, fallbackTargetId?: string) => 'up' | 'down' | null
  hasComment?: (targetId: string, fallbackTargetId?: string) => boolean
  onFeedbackVote?: (
    scope: 'message' | 'session',
    targetId: string,
    value: 'up' | 'down',
    reasonCodes?: string[],
    comment?: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  onFeedbackComment?: (
    scope: 'message' | 'session',
    targetId: string,
    comment: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  onFeedbackClearComment?: (
    scope: 'message' | 'session',
    targetId: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  isFeedbackSubmitting?: boolean
  onChoiceSubmit?: (agentId: string, choiceId: string, answers: ChoiceAnswer[]) => void
  onChoiceCancel?: (agentId: string, choiceId: string) => void
  pendingChoiceIds: Set<string>
  streamingStartedAt?: number
}

export interface MessageListHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void
  scrollToMessage: (messageId: string) => void
  /** Returns the scroll container element for DOM-based operations (e.g. search highlighting) */
  getScrollContainer: () => HTMLElement | null
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
      type: 'choice_request'
      id: string
      entry: ChoiceRequestDisplayEntry
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

function resolveConversationMessageTargetId(
  message: Extract<ConversationEntry, { type: 'conversation_message' }>,
): string {
  const id = message.id?.trim()
  return id && id.length > 0 ? id : message.timestamp
}

function resolveConversationMessageLegacyTargetId(
  message: Extract<ConversationEntry, { type: 'conversation_message' }>,
): string | undefined {
  const id = message.id?.trim()
  if (!id || id.length === 0) {
    return undefined
  }

  const timestampTargetId = message.timestamp.trim()
  if (!timestampTargetId || timestampTargetId === id) {
    return undefined
  }

  return timestampTargetId
}

function buildDisplayEntries(messages: ConversationEntry[]): DisplayEntry[] {
  const displayEntries: DisplayEntry[] = []
  const toolEntriesByCallId = new Map<string, ToolExecutionDisplayEntry>()
  const choiceEntriesByChoiceId = new Map<string, ChoiceRequestDisplayEntry>()

  for (const [index, message] of messages.entries()) {
    if (message.type === 'conversation_message') {
      const targetId = resolveConversationMessageTargetId(message)
      displayEntries.push({
        type: 'conversation_message',
        id: `message-${targetId}-${index}`,
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

    if (message.type === 'choice_request') {
      const existing = choiceEntriesByChoiceId.get(message.choiceId)
      if (existing) {
        existing.status = message.status
        existing.answers = message.answers
        existing.timestamp = message.timestamp
      } else {
        const entry: ChoiceRequestDisplayEntry = {
          choiceId: message.choiceId,
          agentId: message.agentId,
          questions: message.questions,
          status: message.status,
          answers: message.answers,
          timestamp: message.timestamp,
        }

        choiceEntriesByChoiceId.set(message.choiceId, entry)
        displayEntries.push({
          type: 'choice_request',
          id: `choice-${message.choiceId}`,
          entry,
        })
      }
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

function LoadingIndicator({ streamingStartedAt }: { streamingStartedAt?: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!streamingStartedAt) return
    setNowMs(Date.now())
    const interval = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [streamingStartedAt])

  const elapsedLabel = streamingStartedAt
    ? formatElapsed(nowMs - streamingStartedAt)
    : null

  return (
    <div
      className="mt-3 flex justify-start"
      role="status"
      aria-live="polite"
      aria-label="Assistant is working"
    >
      <div className="flex items-center gap-1.5">
        <div className="flex items-center gap-0.5">
          <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-duration:900ms]" />
          <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:150ms] [animation-duration:900ms]" />
          <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:300ms] [animation-duration:900ms]" />
        </div>
        {elapsedLabel ? (
          <span className="text-xs tabular-nums text-muted-foreground">{elapsedLabel}</span>
        ) : null}
      </div>
    </div>
  )
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList({
  messages,
  isLoading,
  wsUrl,
  activeAgentId,
  projectAgent,
  onSuggestionClick,
  onArtifactClick,
  onForkFromMessage,
  onPinMessage,
  getVote,
  hasComment,
  onFeedbackVote,
  onFeedbackComment,
  onFeedbackClearComment,
  isFeedbackSubmitting,
  onChoiceSubmit,
  onChoiceCancel,
  pendingChoiceIds,
  streamingStartedAt,
}, ref) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const previousAgentIdRef = useRef<string | null>(null)
  const previousFirstEntryIdRef = useRef<string | null>(null)
  const previousEntryCountRef = useRef(0)
  const hasScrolledRef = useRef(false)
  const isAtBottomRef = useRef(true)
  const [showScrollButton, setShowScrollButton] = useState(false)

  const displayEntries = useMemo(() => buildDisplayEntries(messages), [messages])

  // Sidebar perf: attempt to complete `session_switch.click_to_first_transcript_paint_ms`
  // after every commit. The registry refuses completion unless:
  //   - the active session-switch token targets `activeAgentId`, AND
  //   - the matching `conversation_history` has already been processed.
  // This is the explicit fix for the v1 review's reset-empty-state false
  // completion. We schedule the sample inside one rAF so it lands after paint.
  // Plan section 4 — `MessageList.tsx` post-commit effect.
  useEffect(() => {
    if (!activeAgentId) {
      return
    }

    // Plan: only attempt completion when the rendered output is the real
    // post-bootstrap paint, not an in-flight loading state.
    const hasContent = displayEntries.length > 0
    const isResolvedEmpty = displayEntries.length === 0 && !isLoading
    if (!hasContent && !isResolvedEmpty) {
      return
    }

    let rafId = 0
    const win = typeof window !== 'undefined' ? window : null
    const schedule =
      win && typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame.bind(win)
        : null
    const cancel =
      win && typeof win.cancelAnimationFrame === 'function'
        ? win.cancelAnimationFrame.bind(win)
        : null

    const finalize = () => {
      const perfRegistry = getSidebarPerfRegistry()
      const interactionNonce = perfRegistry.getActiveSessionSwitch()?.token ?? 0
      perfRegistry.maybeCompleteFirstPaint(activeAgentId, interactionNonce, {
        displayEntryCount: displayEntries.length,
        emptySession: isResolvedEmpty,
      })
    }

    if (schedule) {
      rafId = schedule(finalize)
      return () => {
        if (rafId && cancel) {
          cancel(rafId)
        }
      }
    }

    finalize()
    return undefined
  }, [activeAgentId, displayEntries, isLoading])

  const handleChoiceSubmit = useCallback(
    (agentId: string, choiceId: string, answers: ChoiceAnswer[]) => {
      onChoiceSubmit?.(agentId, choiceId, answers)
    },
    [onChoiceSubmit],
  )

  const handleChoiceCancel = useCallback(
    (agentId: string, choiceId: string) => {
      onChoiceCancel?.(agentId, choiceId)
    },
    [onChoiceCancel],
  )

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto', force = false) => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    const doScroll = () => {
      if (behavior === 'smooth' && typeof container.scrollTo === 'function') {
        container.scrollTo({ top: container.scrollHeight, behavior })
      } else {
        container.scrollTop = container.scrollHeight
      }

      isAtBottomRef.current = true
      setShowScrollButton(false)
    }

    doScroll()

    // When force-scrolling (agent switch, initial load), content-visibility: auto
    // causes the browser to use estimated heights for off-screen items. The real
    // heights are only resolved once content scrolls into view, which can push
    // the position away from the true bottom. Schedule follow-up scrolls to
    // compensate once layout has settled.
    if (force) {
      requestAnimationFrame(() => {
        doScroll()
        requestAnimationFrame(() => {
          doScroll()
        })
      })
    }
  }, [])

  const scrollToMessage = useCallback((messageId: string) => {
    const container = scrollContainerRef.current
    if (!container) return

    const target = container.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!target) return

    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // Re-scroll after layout settles (content-visibility can cause height shifts)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    })

    // Flash highlight
    target.classList.remove('pin-nav-highlight')
    // Force reflow so re-adding the class restarts the animation
    void (target as HTMLElement).offsetWidth
    target.classList.add('pin-nav-highlight')
    setTimeout(() => target.classList.remove('pin-nav-highlight'), 1500)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom,
      scrollToMessage,
      getScrollContainer: () => scrollContainerRef.current,
    }),
    [scrollToBottom, scrollToMessage],
  )

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

  // Re-scroll to bottom when the scroll container resizes (e.g. WorkerPillBar
  // appearing/disappearing changes flex layout) and the user was already at the bottom.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        scrollToBottom('auto')
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [scrollToBottom])

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
      scrollToBottom(shouldForceScroll ? 'auto' : 'smooth', shouldForceScroll)
    }

    hasScrolledRef.current = true
    previousAgentIdRef.current = nextAgentId
    previousFirstEntryIdRef.current = nextFirstEntryId
    previousEntryCountRef.current = nextEntryCount
  }, [activeAgentId, displayEntries, isLoading, scrollToBottom])

  if (displayEntries.length === 0 && !isLoading) {
    return (
      <EmptyState
        activeAgentId={activeAgentId}
        projectAgent={projectAgent}
        onSuggestionClick={onSuggestionClick}
      />
    )
  }

  const handleScrollToBottom = () => {
    scrollToBottom('smooth')
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
              const isAssistant = entry.message.role === 'assistant'
              const feedbackTargetId = resolveConversationMessageTargetId(entry.message)
              const feedbackLegacyTargetId = resolveConversationMessageLegacyTargetId(entry.message)

              return (
                <div
                  key={entry.id}
                  data-message-id={resolveConversationMessageTargetId(entry.message)}
                  className="[content-visibility:auto] [contain-intrinsic-size:auto_96px]"
                >
                  <ConversationMessageRow
                    message={entry.message}
                    wsUrl={wsUrl}
                    feedbackTargetId={feedbackTargetId}
                    feedbackLegacyTargetId={feedbackLegacyTargetId}
                    onArtifactClick={onArtifactClick}
                    onForkFromMessage={entry.message.role !== 'system' ? onForkFromMessage : undefined}
                    onPinMessage={entry.message.role !== 'system' ? onPinMessage : undefined}
                    feedbackVote={
                      isAssistant && getVote
                        ? getVote(feedbackTargetId, feedbackLegacyTargetId)
                        : undefined
                    }
                    feedbackHasComment={
                      isAssistant && hasComment
                        ? hasComment(feedbackTargetId, feedbackLegacyTargetId)
                        : undefined
                    }
                    onFeedbackVote={isAssistant ? onFeedbackVote : undefined}
                    onFeedbackComment={isAssistant ? onFeedbackComment : undefined}
                    onFeedbackClearComment={isAssistant ? onFeedbackClearComment : undefined}
                    isFeedbackSubmitting={isFeedbackSubmitting}
                  />
                </div>
              )
            }

            if (entry.type === 'choice_request') {
              const isLive =
                entry.entry.status === 'pending' &&
                pendingChoiceIds.has(entry.entry.choiceId)

              return (
                <div
                  key={entry.id}
                  className="[content-visibility:auto] [contain-intrinsic-size:auto_200px]"
                >
                  {isLive ? (
                    <ChoiceRequestCard
                      choiceId={entry.entry.choiceId}
                      agentId={entry.entry.agentId}
                      questions={entry.entry.questions}
                      onSubmit={handleChoiceSubmit}
                      onCancel={handleChoiceCancel}
                    />
                  ) : (
                    <ChoiceAnsweredRow
                      choiceId={entry.entry.choiceId}
                      questions={entry.entry.questions}
                      answers={entry.entry.answers ?? []}
                      status={entry.entry.status === 'pending' ? 'expired' : entry.entry.status}
                      timestamp={entry.entry.timestamp}
                    />
                  )}
                </div>
              )
            }

            if (entry.type === 'agent_message') {
              return (
                <div
                  key={entry.id}
                  className="[content-visibility:auto] [contain-intrinsic-size:auto_84px]"
                >
                  <AgentMessageRow message={entry.message} />
                </div>
              )
            }

            return (
              <div
                key={entry.id}
                className="[content-visibility:auto] [contain-intrinsic-size:auto_84px]"
              >
                <ToolLogRow
                  type={entry.type}
                  entry={entry.entry}
                  isActive={isLoading}
                />
              </div>
            )
          })}
          {isLoading ? <LoadingIndicator streamingStartedAt={streamingStartedAt} /> : null}
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
})
