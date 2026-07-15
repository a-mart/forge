import { useMemo } from 'react'
import type { MessageSourceView } from '@/components/chat/ChatHeader'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import {
  filterVisibleBuilderTimeline,
} from '@forge/protocol'

function toEpochMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

function compareTimelineOrder(left: ConversationEntry, right: ConversationEntry): number {
  if (
    Number.isSafeInteger(left.timelineSequence) &&
    Number.isSafeInteger(right.timelineSequence) &&
    left.timelineSequence !== right.timelineSequence
  ) {
    return left.timelineSequence! - right.timelineSequence!
  }

  const timestampDelta = toEpochMillis(left.timestamp) - toEpochMillis(right.timestamp)
  if (timestampDelta !== 0) return timestampDelta
  return (left.timelineEntryId ?? '').localeCompare(right.timelineEntryId ?? '')
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

    if (compareTimelineOrder(conversationMessage, activityMessage) <= 0) {
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
  const allMessages = mergeConversationAndActivityMessages(messages, activityMessages)
  const visibleMessages = filterVisibleBuilderTimeline(allMessages, {
    activeAgentId: activeAgent?.agentId ?? null,
    activeAgentRole: activeAgent?.role ?? null,
    channelView,
    agents,
    history: allMessages,
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
