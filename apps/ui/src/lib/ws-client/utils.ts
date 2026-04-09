import type { AgentActivityEntry, ConversationHistoryEntry, ManagerWsState } from '../ws-state'
import { MAX_CLIENT_CONVERSATION_HISTORY, isAgentActivityEntry } from './runtime-types'
import type {
  AgentDescriptor,
  ConversationAttachment,
  ConversationEntry,
  ConversationMessageEvent,
} from '@forge/protocol'

export function resolveStreamingStartedAt(
  previous: ManagerWsState['statuses'][string] | undefined,
  nextStatus: AgentDescriptor['status'],
  serverTimestamp?: number,
): number | undefined {
  if (nextStatus !== 'streaming') {
    return previous?.streamingStartedAt
  }

  // Prefer server-provided timestamp (survives reconnect/reload)
  if (serverTimestamp != null) {
    return serverTimestamp
  }

  if (previous?.status === 'streaming' && previous.streamingStartedAt !== undefined) {
    return previous.streamingStartedAt
  }

  return Date.now()
}

export function chooseMostRecentSessionAgentId(
  agents: AgentDescriptor[],
  profileId: string,
  excludedAgentId?: string,
): string | null {
  const sessions = agents
    .filter((agent) => {
      if (agent.role !== 'manager') {
        return false
      }

      if (agent.agentId === excludedAgentId) {
        return false
      }

      const agentProfileId = agent.profileId?.trim() || agent.agentId
      return agentProfileId === profileId
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt)
      const rightTime = Date.parse(right.updatedAt)

      const normalizedLeftTime = Number.isFinite(leftTime) ? leftTime : 0
      const normalizedRightTime = Number.isFinite(rightTime) ? rightTime : 0

      if (normalizedLeftTime !== normalizedRightTime) {
        return normalizedRightTime - normalizedLeftTime
      }

      return right.agentId.localeCompare(left.agentId)
    })

  return sessions[0]?.agentId ?? null
}

export function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined,
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return []
  }

  const normalized: ConversationAttachment[] = []

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      continue
    }

    const maybe = attachment as {
      type?: unknown
      mimeType?: unknown
      data?: unknown
      text?: unknown
      fileName?: unknown
    }

    const attachmentType = typeof maybe.type === 'string' ? maybe.type.trim() : ''
    const mimeType = typeof maybe.mimeType === 'string' ? maybe.mimeType.trim() : ''
    const fileName = typeof maybe.fileName === 'string' ? maybe.fileName.trim() : ''

    if (attachmentType === 'text') {
      const text = typeof maybe.text === 'string' ? maybe.text : ''
      if (!mimeType || text.trim().length === 0) {
        continue
      }

      normalized.push({
        type: 'text',
        mimeType,
        text,
        fileName: fileName || undefined,
      })
      continue
    }

    if (attachmentType === 'binary') {
      const data = typeof maybe.data === 'string' ? maybe.data.trim() : ''
      if (!mimeType || data.length === 0) {
        continue
      }

      normalized.push({
        type: 'binary',
        mimeType,
        data,
        fileName: fileName || undefined,
      })
      continue
    }

    const data = typeof maybe.data === 'string' ? maybe.data.trim() : ''
    if (!mimeType || !mimeType.startsWith('image/') || !data) {
      continue
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined,
    })
  }

  return normalized
}

export function splitConversationHistory(
  messages: ConversationEntry[],
): { messages: ConversationHistoryEntry[]; activityMessages: AgentActivityEntry[] } {
  const conversationMessages: ConversationHistoryEntry[] = []
  const activityMessages: AgentActivityEntry[] = []

  for (const entry of messages) {
    if (isAgentActivityEntry(entry)) {
      activityMessages.push(entry)
      continue
    }

    conversationMessages.push(entry)
  }

  return {
    messages: conversationMessages,
    activityMessages,
  }
}

export function clampConversationHistory(messages: AgentActivityEntry[]): AgentActivityEntry[] {
  if (messages.length <= MAX_CLIENT_CONVERSATION_HISTORY) {
    return messages
  }

  return messages.slice(-MAX_CLIENT_CONVERSATION_HISTORY)
}

export function normalizeAgentId(agentId: string | null | undefined): string | null {
  const trimmed = agentId?.trim()
  return trimmed ? trimmed : null
}

export function resolveTerminalScopeAgentId(
  agentId: string | null | undefined,
  agents: AgentDescriptor[],
): string | null {
  if (!agentId) {
    return null
  }

  const descriptor = agents.find((agent) => agent.agentId === agentId)
  if (!descriptor) {
    return null
  }

  if (descriptor.role === 'manager') {
    return descriptor.profileId ?? descriptor.agentId
  }

  const managerDescriptor = agents.find(
    (agent) => agent.role === 'manager' && agent.agentId === descriptor.managerId,
  )
  if (managerDescriptor) {
    return managerDescriptor.profileId ?? managerDescriptor.agentId
  }

  return descriptor.managerId
}

export function createSystemConversationMessage(
  targetAgentId: string | null,
  subscribedAgentId: string | null,
  desiredAgentId: string | null,
  text: string,
): ConversationMessageEvent {
  return {
    type: 'conversation_message',
    agentId: (targetAgentId ?? subscribedAgentId ?? desiredAgentId) || 'system',
    role: 'system',
    text,
    timestamp: new Date().toISOString(),
    source: 'system',
  }
}

