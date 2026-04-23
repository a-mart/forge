import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CollabEmptyState } from '@/components/chat/collab/CollabEmptyState'
import { CollabHeader } from '@/components/chat/collab/CollabHeader'
import type { CollabMessageSourceView } from '@/components/chat/collab/CollabHeader'
import { WorkerHistoryPanel } from '@/components/chat/collab/WorkerHistoryPanel'
import { adaptCollabToConversationEntries } from '@/components/chat/collab/collab-conversation-adapter'
import { MessageInput } from '@/components/chat/MessageInput'
import type { MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList } from '@/components/chat/MessageList'
import type { MessageListHandle } from '@/components/chat/MessageList'
import { WorkerPillBar } from '@/components/chat/WorkerPillBar'
import { useCollabWsContext } from '@/hooks/index-page/use-collab-ws-connection'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { AgentActivityEntry } from '@/lib/ws-state'
import type { ChoiceAnswer, CollaborationCategory, CollaborationChannel, ConversationAttachment, ConversationEntry } from '@forge/protocol'

interface CollabWorkspaceProps {
  wsUrl: string
  channelId?: string
  onSelectChannel?: (channelId?: string) => void
}

/**
 * Filters conversation entries based on the selected message source view.
 *
 * - `web`: Only conversation messages with `sourceContext.channel === 'web'`
 *   (or missing sourceContext, which defaults to web).
 * - `all`: All entries including activity messages.
 */
function filterEntriesByView(
  entries: ConversationEntry[],
  view: CollabMessageSourceView,
): ConversationEntry[] {
  if (view === 'all') {
    return entries
  }

  // Web view: show only conversation_message entries sourced from the web channel
  return entries.filter((entry) => {
    if (entry.type !== 'conversation_message') {
      return false
    }

    const channel = entry.sourceContext?.channel
    return channel === 'web' || channel === undefined
  })
}

export function CollabWorkspace({
  wsUrl,
  channelId,
  onSelectChannel,
}: CollabWorkspaceProps) {
  const { clientRef, state } = useCollabWsContext()
  const previousChannelIdRef = useRef<string | undefined>(undefined)
  const messageListRef = useRef<MessageListHandle>(null)
  const messageInputRef = useRef<MessageInputHandle>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [messageSourceView, setMessageSourceView] = useState<CollabMessageSourceView>('web')
  const [compactInProgress, setCompactInProgress] = useState(false)
  const [smartCompactInProgress, setSmartCompactInProgress] = useState(false)
  const [clearInProgress, setClearInProgress] = useState(false)
  const [workerPanelOpen, setWorkerPanelOpen] = useState(false)

  const selectedChannel = useMemo(
    () => state.channels.find((channel) => channel.channelId === channelId),
    [channelId, state.channels],
  )

  const selectedCategory = useMemo(() => {
    if (!selectedChannel?.categoryId) {
      return null
    }

    return state.categories.find((category) => category.categoryId === selectedChannel.categoryId) ?? null
  }, [selectedChannel?.categoryId, state.categories])

  const memberCount = typeof state.workspace?.memberCount === 'number' && Number.isFinite(state.workspace.memberCount)
    ? state.workspace.memberCount
    : undefined
  useEffect(() => {
    if (!state.hasBootstrapped) {
      return
    }

    const client = clientRef.current
    if (!client) {
      previousChannelIdRef.current = channelId
      return
    }

    client.setActiveChannel(channelId ?? null)
    previousChannelIdRef.current = channelId
  }, [channelId, clientRef, state.hasBootstrapped])

  useEffect(() => {
    const client = clientRef.current

    return () => {
      if (previousChannelIdRef.current) {
        client?.setActiveChannel(null)
      }
    }
  }, [clientRef])

  useEffect(() => {
    if (!channelId || !state.hasBootstrapped) {
      return
    }

    if (!selectedChannel) {
      onSelectChannel?.(findFallbackChannelId(state.channels, state.categories))
    }
  }, [channelId, onSelectChannel, selectedChannel, state.categories, state.channels, state.hasBootstrapped])

  useEffect(() => {
    if (!state.hasBootstrapped || !selectedChannel?.channelId) {
      return
    }

    clientRef.current?.markChannelRead(selectedChannel.channelId)
  }, [clientRef, selectedChannel?.channelId, state.hasBootstrapped, state.connected])

  useEffect(() => {
    if (!state.hasBootstrapped || !selectedChannel?.channelId || typeof document === 'undefined') {
      return
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        clientRef.current?.markChannelRead(selectedChannel.channelId)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [clientRef, selectedChannel?.channelId, state.hasBootstrapped])

  const sessionAgentId = selectedChannel?.sessionAgentId ?? ''

  const conversationEntries = useMemo(
    () =>
      adaptCollabToConversationEntries({
        messages: state.channelHistory,
        choiceRequests: state.pendingChoiceRequests,
        activity: state.sessionActivity,
        sessionAgentId,
      }),
    [state.channelHistory, state.pendingChoiceRequests, state.sessionActivity, sessionAgentId],
  )

  const visibleEntries = useMemo(
    () => filterEntriesByView(conversationEntries, messageSourceView),
    [conversationEntries, messageSourceView],
  )

  const pendingChoiceIds = useMemo(
    () =>
      new Set(
        state.pendingChoiceRequests
          .filter((r) => r.status === 'pending')
          .map((r) => r.choiceId),
      ),
    [state.pendingChoiceRequests],
  )

  const activeChannelId = state.activeChannelId

  const handleChoiceSubmit = useCallback(
    (_agentId: string, choiceId: string, answers: ChoiceAnswer[]) => {
      if (!activeChannelId) return
      clientRef.current?.sendChoiceResponse(activeChannelId, choiceId, answers)
    },
    [activeChannelId, clientRef],
  )

  const handleChoiceCancel = useCallback(
    (_agentId: string, choiceId: string) => {
      if (!activeChannelId) return
      clientRef.current?.sendChoiceCancel(activeChannelId, choiceId)
    },
    [activeChannelId, clientRef],
  )

  const handlePinMessage = useCallback(
    (messageId: string, pinned: boolean) => {
      if (!activeChannelId) return
      clientRef.current?.pinMessage(activeChannelId, messageId, pinned)
    },
    [activeChannelId, clientRef],
  )

  // WorkerPillBar expects AgentActivityEntry[] — CollaborationSessionActivityEntry
  // is structurally identical (AgentMessageEvent | AgentToolCallEvent).
  const workerActivityMessages = state.sessionActivity as AgentActivityEntry[]

  const handleNavigateToWorker = useCallback(() => {
    messageListRef.current?.scrollToBottom('smooth')
  }, [])

  const handleToggleWorkerPanel = useCallback(() => {
    setWorkerPanelOpen((prev) => !prev)
  }, [])

  // ── Conversation actions (compact / smart-compact / clear) ──

  const handleCompact = useCallback(async () => {
    if (!sessionAgentId || compactInProgress || smartCompactInProgress) return

    setCompactInProgress(true)
    setActionError(null)

    try {
      const endpoint = resolveApiEndpoint(
        wsUrl,
        `/api/agents/${encodeURIComponent(sessionAgentId)}/compact`,
      )

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? `Compaction failed (${response.status})`)
      }
    } catch (error) {
      setActionError(`Failed to compact: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCompactInProgress(false)
    }
  }, [sessionAgentId, compactInProgress, smartCompactInProgress, wsUrl])

  const handleSmartCompact = useCallback(async () => {
    if (!sessionAgentId || compactInProgress || smartCompactInProgress) return

    setSmartCompactInProgress(true)
    setActionError(null)

    try {
      const endpoint = resolveApiEndpoint(
        wsUrl,
        `/api/agents/${encodeURIComponent(sessionAgentId)}/smart-compact`,
      )

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? `Smart compaction failed (${response.status})`)
      }
    } catch (error) {
      setActionError(`Failed to smart compact: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSmartCompactInProgress(false)
    }
  }, [sessionAgentId, compactInProgress, smartCompactInProgress, wsUrl])

  const handleClearConversation = useCallback(async () => {
    if (!sessionAgentId || clearInProgress) return

    setClearInProgress(true)
    setActionError(null)

    try {
      const endpoint = resolveApiEndpoint(
        wsUrl,
        `/api/agents/${encodeURIComponent(sessionAgentId)}/clear`,
      )

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? `Clear conversation failed (${response.status})`)
      }
    } catch (error) {
      setActionError(`Failed to clear conversation: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setClearInProgress(false)
    }
  }, [sessionAgentId, clearInProgress, wsUrl])

  const composerDraftKey = activeChannelId ? `collab:channel:${activeChannelId}` : undefined
  const composerPlaceholder = !selectedChannel
    ? 'Select a channel to start chatting'
    : state.connected
      ? `Message #${selectedChannel.name}`
      : 'Reconnect to send messages'

  const handleSend = useCallback(
    (text: string, attachments?: ConversationAttachment[]): boolean => {
      const client = clientRef.current
      if (!client || !activeChannelId) return false
      return client.sendMessage(activeChannelId, text, attachments)
    },
    [activeChannelId, clientRef],
  )

  // Restore the composer draft when the server rejects a sent message
  const prevErrorCodeRef = useRef<string | null>(null)
  useEffect(() => {
    const code = state.lastErrorCode
    if (code === 'COLLAB_USER_MESSAGE_FAILED' && prevErrorCodeRef.current !== code) {
      messageInputRef.current?.restoreLastSubmission()
    }
    prevErrorCodeRef.current = code
  }, [state.lastErrorCode])

  if (!state.hasBootstrapped) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          <span>Loading workspace…</span>
        </div>
      </div>
    )
  }

  const hasAiSession = Boolean(selectedChannel?.aiEnabled && sessionAgentId)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {selectedChannel ? (
        <CollabHeader
          channel={selectedChannel}
          workspaceDisplayName={state.workspace?.displayName}
          categoryName={selectedCategory?.name}
          memberCount={memberCount}
          channelView={messageSourceView}
          onChannelViewChange={setMessageSourceView}
          onCompact={hasAiSession ? handleCompact : undefined}
          compactInProgress={compactInProgress}
          onSmartCompact={hasAiSession ? handleSmartCompact : undefined}
          smartCompactInProgress={smartCompactInProgress}
          onClearConversation={hasAiSession ? handleClearConversation : undefined}
          clearInProgress={clearInProgress}
          workerCount={state.sessionWorkers.length}
          isWorkerPanelOpen={workerPanelOpen}
          onToggleWorkerPanel={state.sessionWorkers.length > 0 ? handleToggleWorkerPanel : undefined}
        />
      ) : null}

      {selectedChannel && workerPanelOpen && state.sessionWorkers.length > 0 ? (
        <WorkerHistoryPanel
          workers={state.sessionWorkers}
          statuses={state.sessionAgentStatuses}
          activityMessages={workerActivityMessages}
          onNavigateToWorker={handleNavigateToWorker}
        />
      ) : null}

      {selectedChannel && state.sessionWorkers.length > 0 ? (
        <WorkerPillBar
          workers={state.sessionWorkers}
          statuses={state.sessionAgentStatuses}
          activityMessages={workerActivityMessages}
          onNavigateToWorker={handleNavigateToWorker}
        />
      ) : null}

      {actionError || state.lastError ? (
        <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {actionError ?? state.lastError}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!selectedChannel ? (
          <CollabEmptyState variant="no-channel" />
        ) : state.channelHistoryLoaded ? (
          visibleEntries.length > 0 ? (
            <MessageList
              ref={messageListRef}
              messages={visibleEntries}
              isLoading={state.channelStatus !== 'idle'}
              wsUrl={wsUrl}
              surface="collab"
              currentCollabUserId={state.currentUser?.userId}
              activeAgentId={sessionAgentId || null}
              pendingChoiceIds={pendingChoiceIds}
              onChoiceSubmit={handleChoiceSubmit}
              onChoiceCancel={handleChoiceCancel}
              onPinMessage={handlePinMessage}
              streamingStartedAt={state.channelStreamingStartedAt}
            />
          ) : (
            <CollabEmptyState
              variant="empty-channel"
              channelName={selectedChannel.name}
            />
          )
        ) : (
          <div className="flex h-full min-h-0 flex-1 items-center justify-center px-6 py-10 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading conversation…</span>
            </div>
          </div>
        )}
      </div>

      <MessageInput
        ref={messageInputRef}
        onSend={handleSend}
        isLoading={state.channelStatus !== 'idle'}
        disabled={!selectedChannel || !state.connected}
        placeholderOverride={composerPlaceholder}
        draftKey={composerDraftKey}
        wsUrl={wsUrl}
      />
    </div>
  )
}

function findFallbackChannelId(
  channels: CollaborationChannel[],
  categories: CollaborationCategory[],
): string | undefined {
  const categoryOrder = new Map(
    [...categories]
      .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name))
      .map((category, index) => [category.categoryId, index]),
  )

  return [...channels]
    .sort((left, right) => compareChannelsByCategory(left, right, categoryOrder))
    .at(0)?.channelId
}

function compareChannelsByCategory(
  left: CollaborationChannel,
  right: CollaborationChannel,
  categoryOrder: Map<string, number>,
): number {
  const leftCategoryRank = left.categoryId ? (categoryOrder.get(left.categoryId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
  const rightCategoryRank = right.categoryId ? (categoryOrder.get(right.categoryId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER

  if (leftCategoryRank !== rightCategoryRank) {
    return leftCategoryRank - rightCategoryRank
  }

  if (left.position !== right.position) {
    return left.position - right.position
  }

  const byName = left.name.localeCompare(right.name)
  if (byName !== 0) {
    return byName
  }

  return left.channelId.localeCompare(right.channelId)
}
