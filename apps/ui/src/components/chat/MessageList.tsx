import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ArtifactReference } from '@/lib/artifacts'
import { formatElapsed } from '@/lib/format-utils'
import { getSidebarPerfRegistry } from '@/lib/perf/sidebar-perf-debug'
import type { ConversationHistoryMutation } from '@/lib/ws-state'
import { cn } from '@/lib/utils'
import { isProjectAgentExchange, normalizePlanSummaryEntries, type AgentDescriptor, type AgentStatus, type ChoiceAnswer, type CodexElicitationPersistScope, type CodexElicitationRequestEvent, type ConversationEntry, type ConversationReplyTargetInput, type ProjectAgentInfo, type SessionPlanSnapshotEvent } from '@forge/protocol'
import { type AgentDisplayMeta, buildAgentDisplayMap } from './message-list/agent-display-utils'
import { AgentMessageRow } from './message-list/AgentMessageRow'
import { ChoiceAnsweredRow } from './message-list/ChoiceAnsweredRow'
import { ChoiceRequestCard } from './message-list/ChoiceRequestCard'
import { CodexElicitationCard } from './message-list/CodexElicitationCard'
import { ConversationMessageRow } from './message-list/ConversationMessageRow'
import { MissingChoiceDetailsFallback } from './message-list/MissingChoiceDetailsFallback'
import { SecureSecretRequestCard } from './message-list/SecureSecretRequestCard'
import { SecureSshTrustRequestCard } from './message-list/SecureSshTrustRequestCard'
import {
  buildStoppableExternalThreadMessageIds,
  resolveConversationMessageTargetId,
} from './message-list/external-thread-stop-eligibility'
import { EmptyState } from './message-list/EmptyState'
import { PlanCard, PlanSummaryRow } from './plan'
import {
  hydrateToolDisplayEntry,
  isToolExecutionEvent,
  resolveToolExecutionEventActorAgentId,
} from './message-list/tool-display-utils'
import { ToolLogRow } from './message-list/ToolLogRow'
import { useOlderHistoryAutoLoad } from './message-list/useOlderHistoryAutoLoad'
import { SecureOutputQuarantineNotice } from './secure-session/SecureOutputQuarantineNotice'
import type { SecureSessionRequestConfig } from './secure-session/types'
import type {
  ChoiceRequestDisplayEntry,
  ConversationLogEntry,
  MessageListSurface,
  ToolExecutionDisplayEntry,
} from './message-list/types'

export type { MessageListSurface } from './message-list/types'

export interface MessageListProps {
  messages: ConversationEntry[]
  /** Agent descriptors for actor label enrichment. Optional — raw ids used when absent. */
  agents?: AgentDescriptor[]
  isLoading: boolean
  wsUrl?: string
  activeAgentId?: string | null
  projectAgent?: ProjectAgentInfo | null
  /** Render surface — controls user-message styling for collab vs builder. */
  surface?: MessageListSurface
  /** When surface='collab', the local user's ID for local/remote message distinction. */
  currentCollabUserId?: string
  onSuggestionClick?: (suggestion: string) => void
  onArtifactClick?: (artifact: ArtifactReference) => void
  onForkFromMessage?: (messageId: string) => void
  onPinMessage?: (messageId: string, pinned: boolean) => void
  onStopExternalThread?: (sidecarAgentId: string) => void
  onReplyToMessage?: (target: ConversationReplyTargetInput) => void
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
  codexElicitations?: CodexElicitationRequestEvent[]
  onCodexElicitationResponse?: (agentId: string, elicitationId: string, decision: 'allow' | 'deny' | 'cancel', values?: Record<string, unknown>, persistScope?: CodexElicitationPersistScope) => void
  missingPendingChoiceIds?: string[]
  streamingStartedAt?: number
  planSnapshot?: SessionPlanSnapshotEvent | null
  planExpanded?: boolean
  onPlanExpandedChange?: (expanded: boolean) => void
  statuses?: Record<string, { status: AgentStatus }>
  hasOlder?: boolean
  olderCursor?: string
  isLoadingOlder?: boolean
  historyCompleteness?: 'complete' | 'partial_scan' | 'source_changed'
  historyMutation?: ConversationHistoryMutation | null
  onLoadOlder?: () => unknown | Promise<unknown>
  /** Live Secure Session requests and quarantined-output state; never persisted as transcript rows. */
  secureSessionRequests?: SecureSessionRequestConfig
  conversationBootstrapPhase?: 'idle' | 'pending' | 'ready' | 'error'
  hasStalePresentation?: boolean
  bootstrapErrorMessage?: string
  onRetryBootstrap?: () => void
}

export interface MessageListHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void
  scrollToMessage: (messageId: string) => void
  /** Returns the scroll container element for DOM-based operations (e.g. search highlighting) */
  getScrollContainer: () => HTMLElement | null
}

const AUTO_SCROLL_THRESHOLD_PX = 100
const REPLY_TEXT_MAX_CHARS = 2000
/** Rows rendered above/below the viewport. Keeps scrolling smooth and makes
 *  search/DOM-walk highlighting resilient to small measurement drift. */
const OVERSCAN = 8
/** Estimated row height before a row has been measured. Rows self-correct via
 *  `measureElement`, so this only affects the very first paint of each row. */
const ESTIMATED_ROW_HEIGHT = 96

function buildReplyTargetSnapshot(
  message: Extract<ConversationEntry, { type: 'conversation_message' }>,
): ConversationReplyTargetInput | null {
  const messageId = message.id?.trim()
  if (!messageId) return null

  const text = message.text.trim()
  return {
    messageId,
    role: message.role,
    timestamp: message.timestamp,
    text: text.length > REPLY_TEXT_MAX_CHARS ? text.slice(0, REPLY_TEXT_MAX_CHARS) : text,
    source: message.source,
    attachmentCount: message.attachments?.length ? message.attachments.length : undefined,
  }
}

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
  | {
      type: 'plan_summary'
      id: string
      entry: Extract<ConversationEntry, { type: 'plan_summary' }>
    }

function isNearBottom(container: HTMLElement, threshold = AUTO_SCROLL_THRESHOLD_PX): boolean {
  const distanceFromBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight
  return distanceFromBottom <= threshold
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

function resolveChoiceResponseAgentId(
  entry: ChoiceRequestDisplayEntry,
  activeAgentId?: string | null,
): string {
  if (activeAgentId && activeAgentId === entry.agentId) {
    return entry.agentId
  }

  return entry.sessionAgentId ?? entry.agentId
}

function buildDisplayEntries(messages: ConversationEntry[]): DisplayEntry[] {
  const displayEntries: DisplayEntry[] = []
  const planSummaryIndexById = new Map<string, number>()
  const toolEntriesByCallId = new Map<string, ToolExecutionDisplayEntry>()
  const choiceEntriesByChoiceId = new Map<string, ChoiceRequestDisplayEntry>()

  for (const [index, message] of normalizePlanSummaryEntries(messages).entries()) {
    if (message.type === 'conversation_message') {
      const targetId = resolveConversationMessageTargetId(message)
      displayEntries.push({
        type: 'conversation_message',
        id: `message-${message.timelineEntryId ?? `${targetId}-${message.id ?? index}`}`,
        message,
      })
      continue
    }

    if (message.type === 'agent_message') {
      displayEntries.push({
        type: 'agent_message',
        id: `agent-message-${message.timelineEntryId ?? `${message.timestamp}-${index}`}`,
        message,
      })
      continue
    }

    if (message.type === 'plan_summary') {
      const nextEntry: DisplayEntry = {
        type: 'plan_summary',
        id: `plan-summary-${message.id}`,
        entry: message,
      }
      const existingIndex = planSummaryIndexById.get(message.id)
      if (existingIndex === undefined) {
        planSummaryIndexById.set(message.id, displayEntries.length)
        displayEntries.push(nextEntry)
      } else {
        displayEntries[existingIndex] = nextEntry
      }
      continue
    }

    if (message.type === 'choice_request') {
      const existing = choiceEntriesByChoiceId.get(message.choiceId)
      if (existing) {
        existing.agentId = message.agentId
        existing.sessionAgentId = message.sessionAgentId
        existing.status = message.status
        existing.answers = message.answers
        existing.timestamp = message.timestamp
      } else {
        const entry: ChoiceRequestDisplayEntry = {
          choiceId: message.choiceId,
          agentId: message.agentId,
          sessionAgentId: message.sessionAgentId,
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

    if (message.type === 'activity_summary') {
      const callId = message.correlationId ?? message.itemId
      const toolGroupKey = `${message.actorAgentId}:${callId}`
      let displayEntry = toolEntriesByCallId.get(toolGroupKey)

      if (!displayEntry) {
        displayEntry = {
          id: `tool-${toolGroupKey}`,
          actorAgentId: message.actorAgentId,
          toolName: message.toolName,
          toolCallId: callId,
          displaySummary: message.displaySummary,
          timestamp: message.timestamp,
          latestKind: 'tool_execution_end',
          isError: message.isError,
        }
        displayEntries.push({ type: 'tool_execution', id: displayEntry.id, entry: displayEntry })
        toolEntriesByCallId.set(toolGroupKey, displayEntry)
      } else {
        displayEntry.timestamp = message.timestamp
        displayEntry.latestKind = 'tool_execution_end'
        displayEntry.isError = message.isError
        displayEntry.toolName = message.toolName ?? displayEntry.toolName
        if (!displayEntry.inputPayload && !displayEntry.latestPayload && !displayEntry.outputPayload) {
          displayEntry.displaySummary = message.displaySummary
        }
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
        id: `tool-${message.timelineEntryId ?? `${message.timestamp}-${index}`}`,
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
        id: `runtime-log-${message.timelineEntryId ?? `${message.timestamp}-${index}`}`,
        entry: message,
      })
    }
  }

  return displayEntries
}

/**
 * The full ordered list of virtualized rows. Non-message chrome (active-work
 * card, missing-choice fallbacks, streaming indicator) is folded into the same
 * flat list as the transcript so the virtualizer measures and positions every
 * vertically-stacked item uniformly, preserving order/grouping exactly.
 */
type VirtualRow =
  | { kind: 'older'; id: string }
  | { kind: 'plan'; id: string }
  | { kind: 'missing_choice'; id: string; choiceId: string }
  | { kind: 'entry'; id: string; entry: DisplayEntry }
  | { kind: 'loading'; id: string }

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
  agents,
  isLoading,
  wsUrl,
  activeAgentId,
  projectAgent,
  surface = 'builder',
  currentCollabUserId,
  onSuggestionClick,
  onArtifactClick,
  onForkFromMessage,
  onPinMessage,
  onStopExternalThread,
  onReplyToMessage,
  getVote,
  hasComment,
  onFeedbackVote,
  onFeedbackComment,
  onFeedbackClearComment,
  isFeedbackSubmitting,
  onChoiceSubmit,
  onChoiceCancel,
  pendingChoiceIds,
  codexElicitations = [],
  onCodexElicitationResponse,
  missingPendingChoiceIds = [],
  streamingStartedAt,
  planSnapshot,
  planExpanded = false,
  onPlanExpandedChange,
  statuses = {},
  hasOlder = false,
  olderCursor,
  isLoadingOlder = false,
  historyCompleteness = 'complete',
  historyMutation = null,
  onLoadOlder,
  secureSessionRequests,
  conversationBootstrapPhase = 'idle',
  hasStalePresentation = false,
  bootstrapErrorMessage,
  onRetryBootstrap,
}, ref) {
  // useState (not useRef) for the scroll element so that the callback ref's
  // re-render lets the virtualizer pick up the real element via getScrollElement.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const scrollElRef = useRef<HTMLDivElement | null>(null)
  const previousAgentIdRef = useRef<string | null>(null)
  const previousFirstEntryIdRef = useRef<string | null>(null)
  const previousEntryCountRef = useRef(0)
  const previousHistoryMutationKeyRef = useRef<string | null>(null)
  const viewportAnchorRef = useRef<{ rowId: string; offsetFromViewportTop: number } | null>(null)
  const prependAnchorFrameRefs = useRef<number[]>([])
  const hasScrolledRef = useRef(false)
  const isAtBottomRef = useRef(true)
  const [showScrollButton, setShowScrollButton] = useState(false)
  // Mirrors showScrollButton so setter callers can cheaply bail when the value
  // is unchanged, keeping visibility writes from adding to any render churn.
  const showScrollButtonRef = useRef(false)
  const setShowScrollButtonGuarded = useCallback((next: boolean) => {
    if (showScrollButtonRef.current === next) return
    showScrollButtonRef.current = next
    setShowScrollButton(next)
  }, [])
  // A row index that must stay mounted regardless of the viewport window —
  // set transiently by scrollToMessage so pin/search/reply jumps to an
  // off-screen row land on a real DOM node (for flash + DOM-walk highlight).
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null)
  const pinnedIndexTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirrors rows.length so the stable scrollToBottom callback can read the
  // current row count without re-creating on every message append.
  const rowCountRef = useRef(0)

  const displayEntries = useMemo(() => buildDisplayEntries(messages), [messages])
  const pendingSecureRequests = useMemo(
    () => secureSessionRequests?.requests.filter((request) => request.status === 'pending') ?? [],
    [secureSessionRequests?.requests],
  )
  const pendingSshTrustRequests = secureSessionRequests?.sshTrustRequests ?? []
  const hasSecureSessionAttention =
    pendingSecureRequests.length > 0
    || pendingSshTrustRequests.length > 0
    || secureSessionRequests?.outputState === 'quarantined'
  const hasMissingPendingChoices = missingPendingChoiceIds.length > 0
  const latestPlanSummary = [...displayEntries].reverse().find((entry) => entry.type === 'plan_summary')
  const hasCurrentPlanAnchor = latestPlanSummary?.type === 'plan_summary' && (
    latestPlanSummary.entry.state === 'active'
    || latestPlanSummary.entry.revision === planSnapshot?.revision
  )
  const showPlanCard = Boolean(planSnapshot?.plan.length) && !hasCurrentPlanAnchor

  const rows = useMemo<VirtualRow[]>(() => {
    const next: VirtualRow[] = []
    if (hasOlder || historyCompleteness !== 'complete') {
      next.push({ kind: 'older', id: 'load-older-history' })
    }
    if (showPlanCard) {
      next.push({ kind: 'plan', id: 'plan-card' })
    }
    for (const choiceId of missingPendingChoiceIds) {
      next.push({ kind: 'missing_choice', id: `missing-choice-${choiceId}`, choiceId })
    }
    for (const entry of displayEntries) {
      next.push({ kind: 'entry', id: entry.id, entry })
    }
    if (isLoading) {
      next.push({ kind: 'loading', id: 'loading-indicator' })
    }
    return next
  }, [showPlanCard, missingPendingChoiceIds, displayEntries, hasOlder, historyCompleteness, isLoading])
  rowCountRef.current = rows.length
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const loadedConversationMessageIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of displayEntries) {
      if (entry.type === 'conversation_message') {
        const id = entry.message.id?.trim()
        if (id) ids.add(id)
      }
    }
    return ids
  }, [displayEntries])

  // Map every scroll-to-able conversation message id
  // to its row index, so scrollToMessage can drive the virtualizer to an
  // off-screen row. Mirrors the ids set as data-message-id below.
  const messageIdToRowIndex = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((row, index) => {
      if (row.kind !== 'entry') return
      if (row.entry.type === 'conversation_message') {
        map.set(resolveConversationMessageTargetId(row.entry.message), index)
      }
    })
    return map
  }, [rows])

  const stoppableExternalThreadMessageIds = useMemo(
    () => buildStoppableExternalThreadMessageIds(messages, statuses),
    [messages, statuses],
  )

  const agentDisplayMap = useMemo<Map<string, AgentDisplayMeta>>(
    () => (agents ? buildAgentDisplayMap(agents) : new Map()),
    [agents],
  )
  const agentsById = useMemo<Map<string, AgentDescriptor>>(
    () => new Map((agents ?? []).map((agent) => [agent.agentId, agent])),
    [agents],
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- useVirtualizer returns unstable functions by design; MessageList does not pass them into memoized children.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: OVERSCAN,
    // Keep the library observer out of Chromium's synchronous ResizeObserver
    // delivery loop. The mounted-row observer below separately handles resize
    // notifications that react-virtual filters during programmatic smooth scroll.
    useAnimationFrameWithResizeObserver: true,
    // Reset the `isScrolling` flag from the native `scrollend` event instead of
    // a 150ms debounce timer. Avoids a stray timer that can fire after unmount
    // (React state update on a torn-down tree); supported in all target browsers
    // and jsdom, with the library falling back safely if unavailable.
    useScrollendEvent: true,
  })

  // TanStack Virtual 3.13 filters measurements for mounted rows outside a small
  // buffer around a programmatic smooth-scroll target. A row can still reflow
  // while it is in that mounted overscan window (width/font changes, lazy images,
  // expanding cards, Mermaid, or streaming content). ResizeObserver does not
  // replay the discarded notification when scrolling settles, so later rows keep
  // transforms based on the stale size and can overlap until a window resize.
  //
  // Keep the library observer for its normal measurement/scroll correction, but
  // also batch every mounted row's latest DOM height through the public resizeItem
  // API. Reading data-index and offsetHeight at flush time makes the update safe
  // across a React re-render or row reindex between delivery and the next frame.
  const virtualizerRef = useRef(virtualizer)
  virtualizerRef.current = virtualizer
  const mountedRowObserverRef = useRef<ResizeObserver | null>(null)
  const mountedRowObserverWindowRef = useRef<Window | null>(null)
  const pendingMountedRowMeasurementsRef = useRef(new Set<HTMLElement>())
  const mountedRowMeasurementFrameRef = useRef<number | null>(null)

  const measureMountedRow = useCallback((node: HTMLDivElement | null) => {
    virtualizerRef.current.measureElement(node)
    if (!node) return

    const ownerWindow = node.ownerDocument.defaultView
    if (!ownerWindow?.ResizeObserver) {
      return () => virtualizerRef.current.measureElement(null)
    }

    let observer = mountedRowObserverRef.current
    if (!observer) {
      mountedRowObserverWindowRef.current = ownerWindow
      observer = new ownerWindow.ResizeObserver((entries) => {
        for (const entry of entries) {
          const resizedNode = entry.target as HTMLElement
          if (resizedNode.isConnected) {
            pendingMountedRowMeasurementsRef.current.add(resizedNode)
          }
        }

        if (
          pendingMountedRowMeasurementsRef.current.size === 0 ||
          mountedRowMeasurementFrameRef.current !== null
        ) {
          return
        }

        mountedRowMeasurementFrameRef.current = ownerWindow.requestAnimationFrame(() => {
          mountedRowMeasurementFrameRef.current = null
          const pendingNodes = Array.from(pendingMountedRowMeasurementsRef.current)
          pendingMountedRowMeasurementsRef.current.clear()

          for (const resizedNode of pendingNodes) {
            if (!resizedNode.isConnected) continue
            const index = Number.parseInt(resizedNode.dataset.index ?? '', 10)
            if (!Number.isInteger(index) || index < 0) continue
            virtualizerRef.current.resizeItem(index, resizedNode.offsetHeight)
          }
        })
      })
      mountedRowObserverRef.current = observer
    }

    observer.observe(node, { box: 'border-box' })
    return () => {
      observer.unobserve(node)
      pendingMountedRowMeasurementsRef.current.delete(node)
      virtualizerRef.current.measureElement(null)
    }
  }, [])

  useEffect(() => {
    const pendingMeasurements = pendingMountedRowMeasurementsRef.current
    return () => {
      mountedRowObserverRef.current?.disconnect()
      mountedRowObserverRef.current = null
      pendingMeasurements.clear()

      const frame = mountedRowMeasurementFrameRef.current
      const ownerWindow = mountedRowObserverWindowRef.current
      if (frame !== null && ownerWindow) {
        ownerWindow.cancelAnimationFrame(frame)
      }
      mountedRowMeasurementFrameRef.current = null
      mountedRowObserverWindowRef.current = null
    }
  }, [])

  // Sidebar perf: attempt to complete `session_switch.click_to_first_transcript_paint_ms`
  // after every commit. The registry refuses completion unless:
  //   - the active session-switch token targets `activeAgentId`, AND
  //   - the matching `conversation_history` has already been processed.
  // This is the explicit fix for the v1 review's reset-empty-state false
  // completion. We schedule the sample inside one rAF so it lands after paint.
  useEffect(() => {
    if (!activeAgentId) {
      return
    }

    // Plan: only attempt completion when the rendered output is the real
    // post-bootstrap paint, not an in-flight loading state.
    const renderedEntryCount = displayEntries.length + missingPendingChoiceIds.length
    const hasContent = renderedEntryCount > 0
    const isResolvedEmpty = renderedEntryCount === 0 && !isLoading
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
        displayEntryCount: renderedEntryCount,
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
  }, [activeAgentId, displayEntries, isLoading, missingPendingChoiceIds.length])

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

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = scrollElRef.current
    if (!container) {
      return
    }

    isAtBottomRef.current = true
    setShowScrollButtonGuarded(false)

    const lastIndex = rowCountRef.current - 1

    const pinToBottom = () => {
      const c = scrollElRef.current
      if (!c || !isAtBottomRef.current) return
      if (lastIndex >= 0) {
        // Idiomatic react-virtual bottom-pin: drives both the virtualizer's
        // internal offset (so the correct window renders) and the DOM scroll
        // (via elementScroll). Robust with dynamic heights.
        virtualizer.scrollToIndex(lastIndex, { align: 'end', behavior })
      }
      // Belt-and-suspenders: also drive the raw scroll offset to the true
      // bottom in case measurements under-report before rows resolve.
      if (behavior === 'smooth' && typeof c.scrollTo === 'function') {
        c.scrollTo({ top: c.scrollHeight, behavior })
      } else {
        c.scrollTop = c.scrollHeight
      }
    }

    pinToBottom()

    // Off-screen rows measured with estimates may shift total size once real
    // heights resolve; re-pin to the true bottom across two frames.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        pinToBottom()
        requestAnimationFrame(pinToBottom)
      })
    }
  }, [virtualizer, setShowScrollButtonGuarded])

  // scrollToBottom is intentionally re-created every render because it closes
  // over `virtualizer`, whose functions are unstable by design (see the
  // eslint-disable on useVirtualizer above). Mirror the latest callback into a
  // ref so the scroll effects/observers can invoke it WITHOUT taking it as a
  // dependency — otherwise those effects would re-run every render, re-install
  // their observers, and feed a setState/re-measure cascade (React #185) on
  // large transcripts. The ref write is idempotent and safe during render.
  const scrollToBottomRef = useRef(scrollToBottom)
  scrollToBottomRef.current = scrollToBottom

  const scrollToMessage = useCallback((messageId: string) => {
    const container = scrollElRef.current
    if (!container) return

    const index = messageIdToRowIndex.get(messageId)

    const escapeId =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape
        : (value: string) => value.replace(/["\\]/g, '\\$&')

    const highlightMounted = () => {
      const target = container.querySelector(`[data-message-id="${escapeId(messageId)}"]`)
      if (!target) return
      if (typeof (target as HTMLElement).scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      // Flash highlight
      target.classList.remove('pin-nav-highlight')
      // Force reflow so re-adding the class restarts the animation
      void (target as HTMLElement).offsetWidth
      target.classList.add('pin-nav-highlight')
      setTimeout(() => target.classList.remove('pin-nav-highlight'), 1500)
    }

    if (index === undefined) {
      // Row id not in the virtualized set (should not happen for valid ids) —
      // fall back to a best-effort DOM lookup in case it is already mounted.
      highlightMounted()
      return
    }

    // Keep the target row mounted while we scroll to and settle on it, so the
    // flash + DOM-walk search highlight land on a real node even off-screen.
    setPinnedIndex(index)
    if (pinnedIndexTimerRef.current) {
      clearTimeout(pinnedIndexTimerRef.current)
    }

    virtualizer.scrollToIndex(index, { align: 'center' })

    // Re-scroll after measurement settles (dynamic heights shift offsets), then
    // refine onto the real DOM node and flash it.
    const settle = () => {
      virtualizer.scrollToIndex(index, { align: 'center' })
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(highlightMounted)
      } else {
        highlightMounted()
      }
    }

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(settle)
    } else {
      settle()
    }

    // Release the forced mount after the jump settles.
    pinnedIndexTimerRef.current = setTimeout(() => {
      setPinnedIndex(null)
      pinnedIndexTimerRef.current = null
    }, 1600)
  }, [messageIdToRowIndex, virtualizer])

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom,
      scrollToMessage,
      getScrollContainer: () => scrollElRef.current,
    }),
    [scrollToBottom, scrollToMessage],
  )

  useEffect(() => {
    return () => {
      if (pinnedIndexTimerRef.current) {
        clearTimeout(pinnedIndexTimerRef.current)
      }
      const ownerWindow = scrollElRef.current?.ownerDocument.defaultView
      if (ownerWindow) {
        for (const frame of prependAnchorFrameRefs.current) {
          ownerWindow.cancelAnimationFrame(frame)
        }
      }
      prependAnchorFrameRefs.current = []
    }
  }, [])

  const updateIsAtBottom = useCallback(() => {
    const container = scrollElRef.current
    if (!container) {
      isAtBottomRef.current = true
      setShowScrollButtonGuarded(false)
      return
    }

    const atBottom = isNearBottom(container)
    isAtBottomRef.current = atBottom
    setShowScrollButtonGuarded(!atBottom)
  }, [setShowScrollButtonGuarded])

  const captureViewportAnchor = useCallback(() => {
    const container = scrollElRef.current
    if (!container) return
    const viewportTop = container.getBoundingClientRect().top
    const firstVisible = Array.from(
      container.querySelectorAll<HTMLElement>('[data-index]'),
    )
      .map((element) => {
        const index = Number.parseInt(element.dataset.index ?? '', 10)
        const row = rowsRef.current[index]
        return { element, row, bounds: element.getBoundingClientRect() }
      })
      .filter(({ row, bounds }) => row?.kind !== 'older' && bounds.bottom > viewportTop)
      .sort((left, right) => left.bounds.top - right.bounds.top)[0]
    viewportAnchorRef.current = firstVisible?.row
      ? {
          rowId: firstVisible.row.id,
          offsetFromViewportTop: firstVisible.bounds.top - viewportTop,
        }
      : null
  }, [])

  const handleScroll = useCallback(() => {
    updateIsAtBottom()
    captureViewportAnchor()
  }, [captureViewportAnchor, updateIsAtBottom])

  const olderHistoryLoader = useOlderHistoryAutoLoad({
    activeAgentId,
    cursor: olderCursor,
    hasOlder,
    isLoading: isLoadingOlder,
    historyCompleteness,
    scrollRoot: scrollEl,
    onBeforeLoad: captureViewportAnchor,
    onLoad: onLoadOlder,
  })

  // Re-scroll to bottom when the scroll container resizes (e.g. WorkerPillBar
  // appearing/disappearing changes flex layout) and the user was already at the bottom.
  useEffect(() => {
    const container = scrollEl
    if (!container) return

    // Keyed only on the scroll element, so the observer is created ONCE per
    // element, not per render. Read scrollToBottom from the ref to avoid
    // depending on its (intentionally unstable) identity.
    const observer = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        scrollToBottomRef.current('auto')
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [scrollEl])

  // Stick-to-bottom and force-scroll on session/conversation transitions.
  // Runs in a layout effect so the scroll adjustment is applied before paint,
  // avoiding a visible jump when new content is appended at the bottom.
  useLayoutEffect(() => {
    // The scroll element is wired to the virtualizer via a callback ref, which
    // lands one commit before this element becomes non-null in state. Defer the
    // (force) scroll until the container exists so scrollToIndex has a target;
    // hasScrolledRef stays false so this re-runs once scrollEl is set.
    if (!scrollEl) return

    const nextAgentId = activeAgentId ?? null
    const nextFirstEntryId = displayEntries[0]?.id ?? null
    const nextEntryCount = displayEntries.length
    const historyMutationKey = historyMutation
      ? `${nextAgentId ?? ''}:${historyMutation.revision}`
      : null
    const didExplicitHistoryMutation =
      historyMutationKey !== null &&
      historyMutationKey !== previousHistoryMutationKeyRef.current
    const didReplaceHistory = didExplicitHistoryMutation && historyMutation?.kind === 'replace'

    const isInitialScroll = !hasScrolledRef.current
    const didAgentChange = previousAgentIdRef.current !== nextAgentId
    const didConversationReset =
      didReplaceHistory ||
      (previousEntryCountRef.current > 0 &&
        (nextEntryCount === 0 ||
          (previousFirstEntryIdRef.current !== nextFirstEntryId && nextEntryCount <= previousEntryCountRef.current) ||
          nextEntryCount < previousEntryCountRef.current))
    const didInitialConversationLoad =
      previousEntryCountRef.current === 0 && nextEntryCount > 0
    const didPrependHistory = didExplicitHistoryMutation
      ? historyMutation?.kind === 'prepend'
      : previousEntryCountRef.current > 0 &&
        nextEntryCount > previousEntryCountRef.current &&
        previousFirstEntryIdRef.current !== nextFirstEntryId

    if (didPrependHistory && !isAtBottomRef.current) {
      const anchor = viewportAnchorRef.current
      const ownerWindow = scrollEl.ownerDocument.defaultView
      if (anchor && ownerWindow) {
        for (const frame of prependAnchorFrameRefs.current) {
          ownerWindow.cancelAnimationFrame(frame)
        }
        prependAnchorFrameRefs.current = []

        const restoreAnchor = () => {
          const anchorElement = Array.from(
            scrollEl.querySelectorAll<HTMLElement>('[data-row-id]'),
          ).find((element) => element.dataset.rowId === anchor.rowId)
          if (!anchorElement) return
          const currentOffset =
            anchorElement.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top
          const delta = currentOffset - anchor.offsetFromViewportTop
          if (Math.abs(delta) > 0.5) {
            scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + delta)
          }
        }

        restoreAnchor()
        const firstFrame = ownerWindow.requestAnimationFrame(() => {
          restoreAnchor()
          const secondFrame = ownerWindow.requestAnimationFrame(() => {
            restoreAnchor()
            prependAnchorFrameRefs.current = []
          })
          prependAnchorFrameRefs.current.push(secondFrame)
        })
        prependAnchorFrameRefs.current.push(firstFrame)
      }
    }

    const shouldForceScroll =
      isInitialScroll ||
      didAgentChange ||
      didConversationReset ||
      didInitialConversationLoad
    const shouldAutoScroll = shouldForceScroll || isAtBottomRef.current

    // Commit the transition markers BEFORE scrolling. scrollToBottom drives the
    // virtualizer/DOM synchronously; the markers being current means that if the
    // scroll causes another synchronous commit, this effect re-runs as a no-op
    // (no agent/reset/initial-load change) rather than re-entering the cascade.
    hasScrolledRef.current = true
    previousAgentIdRef.current = nextAgentId
    previousFirstEntryIdRef.current = nextFirstEntryId
    previousEntryCountRef.current = nextEntryCount
    previousHistoryMutationKeyRef.current = historyMutationKey

    if (shouldAutoScroll) {
      // Read from the ref so this effect does not depend on scrollToBottom's
      // (intentionally unstable) identity and thus does not re-run every render.
      scrollToBottomRef.current(shouldForceScroll ? 'auto' : 'smooth')
    }
    captureViewportAnchor()
  }, [activeAgentId, captureViewportAnchor, displayEntries, historyMutation, isLoading, scrollEl])

  const bootstrapBlocksActions =
    conversationBootstrapPhase === 'pending' || conversationBootstrapPhase === 'error'

  if (
    displayEntries.length === 0 &&
    !showPlanCard &&
    !hasMissingPendingChoices &&
    !hasOlder &&
    bootstrapBlocksActions &&
    !hasSecureSessionAttention
  ) {
    const failed = conversationBootstrapPhase === 'error'
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6"
        aria-busy={!failed}
        role={failed ? 'alert' : 'status'}
        aria-live="polite"
      >
        <div className="text-center text-sm text-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:delay-300">
          <p>{failed ? (bootstrapErrorMessage ?? 'Couldn’t load conversation.') : 'Loading conversation…'}</p>
          {failed && onRetryBootstrap ? (
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetryBootstrap}>
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  if (
    displayEntries.length === 0
    && !isLoading
    && !showPlanCard
    && !hasMissingPendingChoices
    && !hasOlder
    && !hasSecureSessionAttention
  ) {
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

  const handleRefreshChangedHistory = () => {
    // A source-changed page requires a fresh bootstrap, not another cursor
    // request. Keep that disruptive action explicit rather than triggering it
    // merely because the user reached the top of the transcript.
    captureViewportAnchor()
    void Promise.resolve(onLoadOlder?.()).catch(() => undefined)
  }

  const renderRow = (row: VirtualRow) => {
    if (row.kind === 'older') {
      const sourceChanged = historyCompleteness === 'source_changed'
      return (
        <div
          ref={olderHistoryLoader.sentinelRef}
          className="flex min-h-8 items-center justify-center py-1"
          data-testid="older-history-sentinel"
        >
          {sourceChanged ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isLoadingOlder}
              onClick={handleRefreshChangedHistory}
              aria-label="Refresh changed conversation timeline"
            >
              Timeline changed — refresh
            </Button>
          ) : isLoadingOlder ? (
            <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
              Loading older items…
            </span>
          ) : olderHistoryLoader.loadFailed ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={olderHistoryLoader.loadManually}
              aria-label="Retry loading older conversation items"
            >
              Retry loading older items
            </Button>
          ) : !olderHistoryLoader.observerSupported ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={olderHistoryLoader.loadManually}
              aria-label="Load older conversation items"
            >
              Load older items
            </Button>
          ) : (
            <span className="sr-only">Older conversation items load automatically near the top.</span>
          )}
        </div>
      )
    }

    if (row.kind === 'plan') {
      return (
        <PlanCard
          snapshot={planSnapshot}
          expanded={planExpanded}
          onExpandedChange={onPlanExpandedChange ?? (() => undefined)}
        />
      )
    }

    if (row.kind === 'missing_choice') {
      return (
        <MissingChoiceDetailsFallback
          choiceId={row.choiceId}
          responseAgentId={activeAgentId}
          onCancel={handleChoiceCancel}
        />
      )
    }

    if (row.kind === 'loading') {
      return <LoadingIndicator streamingStartedAt={streamingStartedAt} />
    }

    const entry = row.entry

    if (entry.type === 'conversation_message') {
      const isAssistant = entry.message.role === 'assistant'
      const feedbackTargetId = resolveConversationMessageTargetId(entry.message)
      const feedbackLegacyTargetId = resolveConversationMessageLegacyTargetId(entry.message)
      const hasExternalThreadContext =
        entry.message.role === 'system' &&
        entry.message.externalThreadContext?.type === 'codex_app_server'

      return (
        <div data-message-id={feedbackTargetId}>
          <ConversationMessageRow
            message={entry.message}
            wsUrl={wsUrl}
            surface={surface}
            currentCollabUserId={currentCollabUserId}
            activeAgentDisplayName={
              activeAgentId ? agentDisplayMap.get(activeAgentId)?.primaryLabel : undefined
            }
            transcriptAgentId={activeAgentId}
            feedbackTargetId={feedbackTargetId}
            feedbackLegacyTargetId={feedbackLegacyTargetId}
            onArtifactClick={onArtifactClick}
            onForkFromMessage={entry.message.role !== 'system' ? onForkFromMessage : undefined}
            onPinMessage={entry.message.role !== 'system' ? onPinMessage : undefined}
            onStopExternalThread={onStopExternalThread}
            onReplyToMessage={
              surface === 'builder' && entry.message.role !== 'system' && onReplyToMessage
                ? (message) => {
                    const target = buildReplyTargetSnapshot(message)
                    if (target) onReplyToMessage(target)
                  }
                : undefined
            }
            isReplyTargetLoaded={(messageId) => loadedConversationMessageIds.has(messageId)}
            onReplyPreviewClick={(messageId) => scrollToMessage(messageId)}
            canStopExternalThread={
              hasExternalThreadContext
                ? stoppableExternalThreadMessageIds.has(feedbackTargetId)
                : undefined
            }
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

      return isLive ? (
        <ChoiceRequestCard
          choiceId={entry.entry.choiceId}
          agentId={resolveChoiceResponseAgentId(entry.entry, activeAgentId)}
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
      )
    }

    if (entry.type === 'agent_message') {
      return (
        <AgentMessageRow
          message={entry.message}
          activeAgentId={activeAgentId}
          fromDisplayName={
            entry.message.fromAgentId
              ? agentDisplayMap.get(entry.message.fromAgentId)?.primaryLabel
              : undefined
          }
          toDisplayName={agentDisplayMap.get(entry.message.toAgentId)?.primaryLabel}
          projectAgentExchange={isProjectAgentExchange(entry.message, agentsById)}
        />
      )
    }

    if (entry.type === 'plan_summary') {
      return <PlanSummaryRow summary={entry.entry} currentSnapshot={planSnapshot} />
    }

    return (
      <ToolLogRow
        type={entry.type}
        entry={entry.entry}
        isActive={isLoading}
        actorDisplay={
          entry.type === 'tool_execution' && entry.entry.actorAgentId
            ? agentDisplayMap.get(entry.entry.actorAgentId)
            : undefined
        }
      />
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  // Union the viewport window with any transiently pinned row so pin/search
  // jumps to off-screen rows still mount a real node. `start` comes from the
  // virtual item when windowed, else from the (now-current) measurements cache.
  const startByIndex = new Map<number, number>()
  for (const item of virtualItems) {
    startByIndex.set(item.index, item.start)
  }
  if (
    pinnedIndex !== null &&
    pinnedIndex < rows.length &&
    !startByIndex.has(pinnedIndex)
  ) {
    startByIndex.set(pinnedIndex, virtualizer.measurementsCache[pinnedIndex]?.start ?? 0)
  }
  const renderHistoryMutationKey = historyMutation
    ? `${activeAgentId ?? ''}:${historyMutation.revision}`
    : null
  const prependAnchorId =
    historyMutation?.kind === 'prepend' &&
    renderHistoryMutationKey !== previousHistoryMutationKeyRef.current
      ? viewportAnchorRef.current?.rowId
      : undefined
  const prependAnchorIndex = prependAnchorId
    ? rows.findIndex((row) => row.id === prependAnchorId)
    : -1
  if (prependAnchorIndex >= 0 && !startByIndex.has(prependAnchorIndex)) {
    startByIndex.set(
      prependAnchorIndex,
      virtualizer.measurementsCache[prependAnchorIndex]?.start ?? 0,
    )
  }
  const renderIndexes = Array.from(startByIndex.keys()).sort((a, b) => a - b)

  return (
    <div
      className="relative min-h-0 flex flex-1 flex-col overflow-hidden"
      data-chat-transcript-surface=""
      aria-busy={conversationBootstrapPhase === 'pending'}
    >
      {hasSecureSessionAttention && secureSessionRequests ? (
        <section
          className="max-h-[45%] shrink-0 space-y-2 overflow-y-auto border-b border-border/60 p-2 md:p-3"
          aria-label="Secure Session attention"
          data-testid="secure-session-attention"
        >
          {secureSessionRequests.outputState === 'quarantined' ? (
            <SecureOutputQuarantineNotice
              reason={secureSessionRequests.outputStateReason}
              onStopProcessesAndRevoke={
                secureSessionRequests.onRevoke && secureSessionRequests.sessionAgentId
                  ? () => secureSessionRequests.onRevoke?.(
                      secureSessionRequests.sessionAgentId!,
                      undefined,
                      { stopProcesses: true },
                    )
                  : undefined
              }
            />
          ) : null}
          {pendingSecureRequests.map((request) => (
            <SecureSecretRequestCard
              key={request.requestId}
              request={request}
              availability={secureSessionRequests.availability}
              secrets={secureSessionRequests.secrets}
              project={secureSessionRequests.project}
              disabled={secureSessionRequests.disabled}
              canApprove={secureSessionRequests.canApprove}
              onGrant={(grant) =>
                secureSessionRequests.onGrant(request.sessionAgentId, grant)}
              onDeny={(requestId) =>
                secureSessionRequests.onDeny(request.sessionAgentId, requestId)}
              onPrivateFulfill={secureSessionRequests.onPrivateFulfill
                ? (requestId, input) => secureSessionRequests.onPrivateFulfill?.(
                    request.sessionAgentId,
                    requestId,
                    input,
                  )
                : undefined}
              onCreateBrowserPairing={secureSessionRequests.onCreateBrowserPairing}
              onClaimBrowserPairing={secureSessionRequests.onClaimBrowserPairing}
              onBrowserPaired={secureSessionRequests.onBrowserPaired}
            />
          ))}
          {pendingSshTrustRequests.map((request) => (
            <SecureSshTrustRequestCard
              key={request.requestId}
              request={request}
              disabled={secureSessionRequests.disabled}
              canApprove={
                secureSessionRequests.canApprove
                && Boolean(secureSessionRequests.onTrustSshHost)
              }
              onTrust={(requestId) =>
                secureSessionRequests.onTrustSshHost?.(
                  secureSessionRequests.sessionAgentId ?? '',
                  requestId,
                )}
              onDismiss={(requestId) =>
                secureSessionRequests.onDismissSshTrustRequest?.(
                  secureSessionRequests.sessionAgentId ?? '',
                  requestId,
                )}
            />
          ))}
        </section>
      ) : null}
      {bootstrapBlocksActions && hasStalePresentation ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:delay-300"
          role={conversationBootstrapPhase === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <span>
            {conversationBootstrapPhase === 'error'
              ? 'Couldn’t refresh. Showing previous messages.'
              : 'Updating conversation…'}
          </span>
          {conversationBootstrapPhase === 'error' && onRetryBootstrap ? (
            <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={onRetryBootstrap}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {codexElicitations.length ? <div className="shrink-0 space-y-2 overflow-auto p-2 md:p-3">{codexElicitations.map((request) => <CodexElicitationCard key={request.elicitationId} request={request} onRespond={(decision, values, persistScope) => onCodexElicitationResponse?.(request.agentId, request.elicitationId, decision, values, persistScope)} />)}</div> : null}
      <div
        ref={(el) => {
          scrollElRef.current = el
          setScrollEl(el)
        }}
        onScroll={handleScroll}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto p-2 md:p-3',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent',
          '[scrollbar-width:thin] [scrollbar-color:transparent_transparent]',
          'hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]',
        )}
      >
        <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
          {renderIndexes.map((index) => {
            const row = rows[index]
            if (!row) return null
            const start = startByIndex.get(index) ?? 0
            return (
              <div
                key={row.id}
                data-index={index}
                data-row-id={row.id}
                ref={measureMountedRow}
                className="pb-2"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${start}px)`,
                }}
              >
                {renderRow(row)}
              </div>
            )
          })}
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
