import { useMemo } from 'react'
import type { MessageSourceView } from '@/components/chat/ChatHeader'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'

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

function buildManagerScopedAgentIds(agents: AgentDescriptor[], managerId: string): Set<string> {
  const scopedAgentIds = new Set<string>([managerId])

  for (const agent of agents) {
    if (agent.agentId === managerId || agent.managerId === managerId) {
      scopedAgentIds.add(agent.agentId)
    }
  }

  return scopedAgentIds
}

/**
 * Build the set of actor IDs owned by this manager for Detailed All view.
 * Includes only the manager itself and direct worker children
 * (`agent.role === 'worker' && agent.managerId === managerId`).
 * Does not include sibling managers, project/profile peers, or unknown IDs.
 */
function buildOwnedActorIds(agents: AgentDescriptor[], managerId: string): Set<string> {
  const owned = new Set<string>([managerId])

  for (const agent of agents) {
    if (agent.role === 'worker' && agent.managerId === managerId) {
      owned.add(agent.agentId)
    }
  }

  return owned
}

function isManagerScopedAllViewEntry(
  entry: ConversationEntry,
  managerId: string,
  scopedAgentIds: ReadonlySet<string>,
  detailedAllView: boolean,
  ownedActorIds: ReadonlySet<string>,
): boolean {
  if (entry.type === 'agent_tool_call') {
    // Non-negotiable precondition: entry must belong to this manager's context
    if (entry.agentId !== managerId) {
      return false
    }

    // Default: only manager-owned tool calls
    // Detailed: manager + owned worker tool calls
    if (detailedAllView) {
      return ownedActorIds.has(entry.actorAgentId)
    }

    return entry.actorAgentId === managerId
  }

  if (entry.type === 'agent_message') {
    if (entry.agentId !== managerId) {
      return false
    }

    const fromAgentId = entry.fromAgentId?.trim()
    return scopedAgentIds.has(entry.toAgentId) || (!!fromAgentId && scopedAgentIds.has(fromAgentId))
  }

  return scopedAgentIds.has(entry.agentId)
}

export interface VisibleMessagesOptions {
  messages: ConversationEntry[]
  activityMessages: ConversationEntry[]
  agents: AgentDescriptor[]
  activeAgent: AgentDescriptor | null
  channelView: MessageSourceView
  /** When true and channelView is 'all' for a manager, reveals owned worker tool calls. */
  detailedAllView?: boolean
}

export function deriveVisibleMessages({
  messages,
  activityMessages,
  agents,
  activeAgent,
  channelView,
  detailedAllView = false,
}: VisibleMessagesOptions): {
  allMessages: ConversationEntry[]
  visibleMessages: ConversationEntry[]
} {
  const isManager = activeAgent?.role === 'manager'
  const managerScopedAgentIds =
    isManager ? buildManagerScopedAgentIds(agents, activeAgent.agentId) : null
  const ownedActorIds =
    isManager ? buildOwnedActorIds(agents, activeAgent.agentId) : null

  const allMessages = mergeConversationAndActivityMessages(messages, activityMessages)

  const effectiveDetailed = detailedAllView && isManager

  const visibleMessages =
    channelView === 'all'
      ? !isManager || !managerScopedAgentIds || !ownedActorIds
        ? allMessages
        : allMessages.filter((entry) =>
            isManagerScopedAllViewEntry(
              entry,
              activeAgent.agentId,
              managerScopedAgentIds,
              effectiveDetailed,
              ownedActorIds,
            ),
          )
      : messages.filter((entry) => {
          if (entry.type !== 'conversation_message') {
            return true
          }

          const ch = entry.sourceContext?.channel ?? 'web'
          return ch === 'web' || ch === 'cli'
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
