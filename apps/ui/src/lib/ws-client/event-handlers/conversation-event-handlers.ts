import { handleUnreadNotification } from '../../notification-service'
import { getSidebarPerfRegistry } from '../../perf/sidebar-perf-debug'
import { clampConversationHistory, splitConversationHistory } from '../utils'
import type { ManagerWsConversationEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleConversationEvent(
  event: ServerEvent,
  context: ManagerWsConversationEventContext,
): boolean {
  switch (event.type) {
    case 'ready':
      context.updateState({
        connected: true,
        targetAgentId: event.subscribedAgentId,
        subscribedAgentId: event.subscribedAgentId,
        lastError: null,
      })
      return true

    case 'conversation_message':
    case 'conversation_log': {
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      context.updateState({ messages: [...context.state.messages, event] })
      return true
    }

    case 'message_pinned': {
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      const pinnedMessages = context.state.messages.map((message) => {
        if (message.type === 'conversation_message' && message.id === event.messageId) {
          return { ...message, pinned: event.pinned }
        }
        return message
      })
      context.updateState({ messages: pinnedMessages })
      return true
    }

    case 'choice_request': {
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      const existingIdx = context.state.messages.findIndex(
        (message) => message.type === 'choice_request' && message.choiceId === event.choiceId,
      )

      let nextMessages = [...context.state.messages]
      if (existingIdx >= 0) {
        nextMessages[existingIdx] = event
      } else {
        nextMessages = [...nextMessages, event]
      }

      const nextPendingChoiceIds = new Set(context.state.pendingChoiceIds)
      if (event.status === 'pending') {
        nextPendingChoiceIds.add(event.choiceId)
      } else {
        nextPendingChoiceIds.delete(event.choiceId)
      }

      context.updateState({ messages: nextMessages, pendingChoiceIds: nextPendingChoiceIds })
      return true
    }

    case 'unread_notification':
      handleUnreadNotification(event.agentId, context.state, event.reason, event.sessionAgentId)
      return true

    case 'unread_counts_snapshot': {
      const counts = { ...event.counts }
      if (context.state.targetAgentId) {
        delete counts[context.state.targetAgentId]
      }
      context.updateState({ unreadCounts: counts })
      return true
    }

    case 'unread_count_update': {
      if (event.agentId === context.state.targetAgentId) {
        return true
      }

      const nextUnread = { ...context.state.unreadCounts }
      if (event.count > 0) {
        nextUnread[event.agentId] = event.count
      } else {
        delete nextUnread[event.agentId]
      }
      context.updateState({ unreadCounts: nextUnread })
      return true
    }

    case 'agent_message':
    case 'agent_tool_call': {
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      const activityMessages = clampConversationHistory([
        ...context.state.activityMessages,
        event,
      ])
      context.updateState({ activityMessages })
      return true
    }

    case 'conversation_history': {
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      const { messages, activityMessages } = splitConversationHistory(event.messages)
      // Sidebar perf: stop `session_switch.click_to_history_loaded_ms` and mark
      // the active session-switch token eligible for first-paint completion.
      // Plan section 4 — frontend `conversation_history` capture point.
      getSidebarPerfRegistry().markHistoryLoaded(event.agentId, {
        conversationMessageCount: messages.length,
        activityMessageCount: activityMessages.length,
        allMessageCount: event.messages.length,
      })
      context.updateState({
        messages,
        activityMessages: clampConversationHistory(activityMessages),
      })
      return true
    }

    case 'pending_choices_snapshot':
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      context.updateState({ pendingChoiceIds: new Set(event.choiceIds) })
      return true

    case 'conversation_reset':
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      context.updateState({
        messages: [],
        activityMessages: [],
        pendingChoiceIds: new Set(),
        lastError: null,
      })
      return true

    default:
      return false
  }
}
