import { handleUnreadNotification } from '../../notification-service'
import { getSidebarPerfRegistry } from '../../perf/sidebar-perf-debug'
import { routeModelCacheObservationsForState } from '../model-cache-visualization-state.js'
import { clampConversationHistory, splitConversationHistory } from '../utils'
import type { ManagerWsConversationEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

/**
 * Bootstrap event types coalesced into a single state update during subscribe bootstrap.
 * These correspond to events sent by the backend's `sendSubscriptionBootstrap` that
 * directly update conversation/session state. `unread_counts_snapshot` is the terminal
 * signal that triggers the flush.
 * @see ManagerWsClient bootstrap batching
 */
export const BOOTSTRAP_COALESCIBLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'conversation_history',
  'pending_choices_snapshot',
  'session_task_state_snapshot',
  'unread_counts_snapshot',
])

/**
 * Live conversation event types that trigger force-flush of any pending bootstrap
 * buffer when targeting the bootstrapping session. These indicate the session is
 * actively streaming and buffered state must be applied before the live event.
 * @see ManagerWsClient bootstrap batching
 */
export const BOOTSTRAP_FORCE_FLUSH_CONVERSATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'conversation_message',
  'conversation_log',
  'agent_message',
  'agent_tool_call',
  'choice_request',
  'work_plan_created',
  'model_cache_observation',
])

function isChoiceEventForTarget(
  event: Extract<ServerEvent, { type: 'choice_request' }>,
  targetAgentId: string | null,
): boolean {
  return Boolean(
    targetAgentId &&
      (event.agentId === targetAgentId || event.sessionAgentId === targetAgentId),
  )
}

function upsertChoiceRequestMessages(
  messages: ManagerWsConversationEventContext['state']['messages'],
  choices: Extract<ServerEvent, { type: 'choice_request' }>[],
): ManagerWsConversationEventContext['state']['messages'] {
  if (choices.length === 0) {
    return messages
  }

  const nextMessages = [...messages]
  for (const choice of choices) {
    const existingIdx = nextMessages.findIndex(
      (message) => message.type === 'choice_request' && message.choiceId === choice.choiceId,
    )

    if (existingIdx >= 0) {
      nextMessages[existingIdx] = choice
    } else {
      nextMessages.push(choice)
    }
  }

  return nextMessages
}

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
    case 'conversation_log':
    case 'work_plan_created': {
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      context.updateState({ messages: [...context.state.messages, event] })
      return true
    }

    case 'model_cache_observation': {
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      const routed = routeModelCacheObservationsForState({
        incoming: [event],
        enabled: context.state.modelCacheVisualizationEnabled,
        settingLoaded: context.state.modelCacheVisualizationSettingLoaded,
        currentObservations: context.state.modelCacheObservations,
        pendingObservations: context.state.pendingModelCacheObservations,
        mode: 'upsert',
      })

      context.updateState(routed)
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
      if (!isChoiceEventForTarget(event, context.state.targetAgentId)) {
        return true
      }

      const nextMessages = upsertChoiceRequestMessages(context.state.messages, [event])

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
      handleUnreadNotification(event.agentId, context.state, event.reason, event.sessionAgentId, event.cliOriginated)
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

      const { messages, activityMessages, modelCacheObservations } = splitConversationHistory(event.messages)
      const routedObservations = routeModelCacheObservationsForState({
        incoming: modelCacheObservations,
        enabled: context.state.modelCacheVisualizationEnabled,
        settingLoaded: context.state.modelCacheVisualizationSettingLoaded,
        currentObservations: context.state.modelCacheObservations,
        pendingObservations: context.state.pendingModelCacheObservations,
        mode: 'replace',
      })
      // Sidebar perf: stop `session_switch.click_to_history_loaded_ms` and mark
      // the active session-switch token eligible for first-paint completion.
      // The interaction nonce ensures stale bootstraps from A→B→A rapid
      // switching cannot complete a newer interaction's metric.
      // Plan section 4 — frontend `conversation_history` capture point.
      const perfRegistry = getSidebarPerfRegistry()
      const interactionNonce = perfRegistry.getActiveSessionSwitch()?.token ?? 0
      perfRegistry.markHistoryLoaded(event.agentId, interactionNonce, {
        conversationMessageCount: messages.length,
        activityMessageCount: activityMessages.length,
        allMessageCount: event.messages.length,
      })
      context.updateState({
        messages,
        activityMessages: clampConversationHistory(activityMessages),
        modelCacheObservations: routedObservations.modelCacheObservations,
        pendingModelCacheObservations: routedObservations.pendingModelCacheObservations,
      })
      return true
    }

    case 'pending_choices_snapshot': {
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      const pendingChoiceIds = new Set(event.choiceIds)
      const choices = event.choices?.filter(
        (choice) =>
          pendingChoiceIds.has(choice.choiceId) &&
          isChoiceEventForTarget(choice, context.state.targetAgentId),
      ) ?? []

      context.updateState({
        pendingChoiceIds,
        ...(choices.length > 0
          ? { messages: upsertChoiceRequestMessages(context.state.messages, choices) }
          : {}),
      })
      return true
    }

    case 'session_task_state_snapshot': {
      context.updateState({
        taskSnapshots: {},
        ...(context.state.taskSnapshotLoadingSessionId === event.sessionAgentId
          ? { taskSnapshotLoadingSessionId: null }
          : {}),
      })
      return true
    }

    case 'conversation_reset':
      if (event.agentId !== context.state.targetAgentId) {
        return true
      }

      context.updateState({
        messages: [],
        activityMessages: [],
        modelCacheObservations: [],
        pendingModelCacheObservations: [],
        pendingChoiceIds: new Set(),
        lastError: null,
      })
      return true

    default:
      return false
  }
}
