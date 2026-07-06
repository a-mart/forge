/**
 * Transcript / search / feedback controller (WP-U3 BuilderSurface split).
 *
 * Owns the chat-transcript domain that used to live inline in BuilderSurface:
 * visible-message derivation, find-in-chat search + highlight + scroll-to-match,
 * context-window usage, pending-response tracking, pinned-message derivation,
 * and per-session feedback.  BuilderSurface renders the transcript with the
 * values this hook returns.
 *
 * Threaded-state controller (WP-U3 plan review): it receives `state` and the
 * derived active-agent info rather than re-subscribing via `useOriginSlice`.
 * `messageListRef` is a shell-level ref (attached to `ChatWorkspace` in the
 * shell) threaded in so the search-container-sync effect and scroll-to-message
 * can drive the imperative MessageList handle.
 */

import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import type { AgentDescriptor, AgentStatus } from '@forge/protocol'
import type { ManagerWsState } from '@/lib/ws-state'
import type { MessageListHandle } from '@/components/chat/MessageList'
import type { MessageSourceView } from '@/components/chat/ChatHeader'
import { useChatSearch } from '@/components/chat/useChatSearch'
import { useSearchHighlight } from '@/components/chat/useSearchHighlight'
import { collectArtifactsFromMessages } from '@/lib/collect-artifacts'
import { useFeedback } from '@/lib/use-feedback'
import { useVisibleMessages } from '@/hooks/index-page/use-visible-messages'
import { useContextWindow } from '@/hooks/index-page/use-context-window'
import { usePendingResponse } from '@/hooks/index-page/use-pending-response'
import { shouldIgnoreGlobalShortcutTarget } from '@/hooks/index-page/global-shortcut-target'

export interface UseTranscriptControllerOptions {
  state: ManagerWsState
  activeView: string
  activeAgent: AgentDescriptor | null
  activeAgentId: string | null
  activeAgentStatus: AgentStatus | null
  messageSourceView: MessageSourceView
  effectiveDetailedAllView: boolean
  messageListRef: MutableRefObject<MessageListHandle | null>
}

export function useTranscriptController({
  state,
  activeView,
  activeAgent,
  activeAgentId,
  activeAgentStatus,
  messageSourceView,
  effectiveDetailedAllView,
  messageListRef,
}: UseTranscriptControllerOptions) {
  const { contextWindowUsage } = useContextWindow({
    activeAgent,
    activeAgentId,
    messages: state.messages,
    statuses: state.statuses,
  })

  const {
    markPendingResponse,
    clearPendingResponseForAgent,
    isAwaitingResponseStart,
  } = usePendingResponse({
    activeAgentId,
    activeAgentStatus,
    messages: state.messages,
  })

  const isLoading = activeAgentStatus === 'streaming' || isAwaitingResponseStart

  const { allMessages, visibleMessages } = useVisibleMessages({
    messages: state.messages,
    activityMessages: state.activityMessages,
    agents: state.agents,
    activeAgent,
    channelView: messageSourceView,
    detailedAllView: effectiveDetailedAllView,
  })

  const pinnedMessageIds = useMemo(() => {
    const ids: string[] = []
    for (const m of visibleMessages) {
      if (m.type === 'conversation_message' && m.pinned) {
        const id = m.id?.trim() || m.timestamp
        ids.push(id)
      }
    }
    return ids
  }, [visibleMessages])

  const pinnedCount = pinnedMessageIds.length

  // ── Find-in-chat search ──
  const chatSearch = useChatSearch(visibleMessages)

  const searchContainerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    searchContainerRef.current = messageListRef.current?.getScrollContainer() ?? null
  })

  useSearchHighlight(
    searchContainerRef,
    chatSearch.matches,
    chatSearch.currentMatchIndex,
    chatSearch.isOpen,
  )

  // Scroll to the message containing the current match
  useEffect(() => {
    if (!chatSearch.isOpen || chatSearch.matches.length === 0) return
    const match = chatSearch.matches[chatSearch.currentMatchIndex]
    if (match) {
      messageListRef.current?.scrollToMessage(match.messageId)
    }
  }, [chatSearch.isOpen, chatSearch.matches, chatSearch.currentMatchIndex, messageListRef])

  // Close search on session switch
  useEffect(() => {
    chatSearch.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId])

  // Keyboard shortcut: Ctrl+F / Cmd+F to toggle find-in-chat
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnoreGlobalShortcutTarget(e)) return
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        if (activeView !== 'chat') return
        e.preventDefault()
        if (chatSearch.isOpen) {
          chatSearch.close()
        } else {
          chatSearch.open()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeView, chatSearch])

  const handleScrollToMessage = useCallback((messageId: string) => {
    messageListRef.current?.scrollToMessage(messageId)
  }, [messageListRef])

  const collectedArtifacts = useMemo(
    () => collectArtifactsFromMessages(allMessages),
    [allMessages],
  )

  const feedbackSessionId = useMemo(() => {
    if (!activeAgent) {
      return null
    }

    return activeAgent.role === 'worker' ? activeAgent.managerId : activeAgent.agentId
  }, [activeAgent])

  const feedbackSessionAgent = useMemo(() => {
    if (!feedbackSessionId) {
      return null
    }

    return (
      state.agents.find(
        (agent) => agent.agentId === feedbackSessionId && agent.role === 'manager',
      ) ?? null
    )
  }, [feedbackSessionId, state.agents])

  const feedbackProfileId = feedbackSessionAgent?.profileId ?? null
  const feedback = useFeedback(feedbackProfileId, feedbackSessionId)

  return {
    contextWindowUsage,
    markPendingResponse,
    clearPendingResponseForAgent,
    isLoading,
    allMessages,
    visibleMessages,
    pinnedMessageIds,
    pinnedCount,
    chatSearch,
    handleScrollToMessage,
    collectedArtifacts,
    feedbackProfileId,
    feedback,
  }
}
