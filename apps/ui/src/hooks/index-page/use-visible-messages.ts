import { useMemo } from 'react'
import type { MessageSourceView } from '@/components/chat/ChatHeader'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import {
  collectKnownWorkerIds,
  inferManagerAliasIds,
  isVisibleInManagerAllView,
} from '@forge/protocol'

function toEpochMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

function mergeConversationAndActivityMessages(
  messages: ConversationEntry[],
  activityMessages: ConversationEntry[],
): ConversationEntry[] {
  if (activityMessages.length === 0) {
    return messages
  }

  if (messages.length === 0) {
    return activityMessages
  }

  const merged: ConversationEntry[] = []
  let conversationIndex = 0
  let activityIndex = 0

  while (conversationIndex < messages.length && activityIndex < activityMessages.length) {
    const conversationMessage = messages[conversationIndex]
    const activityMessage = activityMessages[activityIndex]

    if (toEpochMillis(conversationMessage.timestamp) <= toEpochMillis(activityMessage.timestamp)) {
      merged.push(conversationMessage)
      conversationIndex += 1
      continue
    }

    merged.push(activityMessage)
    activityIndex += 1
  }

  if (conversationIndex < messages.length) {
    merged.push(...messages.slice(conversationIndex))
  }

  if (activityIndex < activityMessages.length) {
    merged.push(...activityMessages.slice(activityIndex))
  }

  return merged
}

function isWebVisibleConversationMessage(entry: ConversationEntry): boolean {
  if (entry.type !== 'conversation_message') {
    return true
  }

  if (entry.source === 'worker_report') {
    return false
  }

  const channel = entry.sourceContext?.channel ?? 'web'
  return channel === 'web' || channel === 'cli'
}

export interface VisibleMessagesOptions {
  messages: ConversationEntry[]
  activityMessages: ConversationEntry[]
  agents: AgentDescriptor[]
  activeAgent: AgentDescriptor | null
  channelView: MessageSourceView
  /** Reserved for future manager-only metadata expansion; does not change visibility. */
  detailedAllView?: boolean
}

export function deriveVisibleMessages({
  messages,
  activityMessages,
  agents,
  activeAgent,
  channelView,
}: VisibleMessagesOptions): {
  allMessages: ConversationEntry[]
  visibleMessages: ConversationEntry[]
} {
  const isManager = activeAgent?.role === 'manager'
  const allMessages = mergeConversationAndActivityMessages(messages, activityMessages)

  const visibleMessages =
    channelView === 'all'
      ? !isManager || !activeAgent
        ? allMessages
        : (() => {
            const activeManagerId = activeAgent.agentId
            const knownWorkerIds = collectKnownWorkerIds(agents, activeManagerId)
            const managerAliasIds = inferManagerAliasIds(allMessages, activeManagerId, knownWorkerIds)

            return allMessages.filter((entry) =>
              isVisibleInManagerAllView(entry, {
                activeManagerId,
                managerAliasIds,
                knownWorkerIds,
              }),
            )
          })()
      : messages.filter((entry) => {
          if (entry.type === 'conversation_log') {
            return false
          }

          return isWebVisibleConversationMessage(entry)
        })

  return {
    allMessages,
    visibleMessages,
  }
}

export function useVisibleMessages(options: VisibleMessagesOptions): {
  allMessages: ConversationEntry[]
  visibleMessages: ConversationEntry[]
} {
  const { messages, activityMessages, agents, activeAgent, channelView, detailedAllView } = options

  return useMemo(
    () =>
      deriveVisibleMessages({
        messages,
        activityMessages,
        agents,
        activeAgent,
        channelView,
        detailedAllView,
      }),
    [activeAgent, activityMessages, agents, channelView, detailedAllView, messages],
  )
}
