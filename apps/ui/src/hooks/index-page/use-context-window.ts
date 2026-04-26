import { useMemo } from 'react'
import type { ManagerWsState } from '@/lib/ws-state'
import type {
  AgentContextUsage,
  AgentDescriptor,
  ConversationEntry,
  ConversationMessageAttachment,
  ConversationTextAttachment,
} from '@forge/protocol'
import { getCatalogContextWindow } from '@forge/protocol'

const CHARS_PER_TOKEN_ESTIMATE = 4
const MAX_REASONABLE_CONTEXT_USAGE_MULTIPLIER = 5

export function contextWindowForAgent(agent: AgentDescriptor | null): number | null {
  if (!agent) {
    return null
  }

  return getCatalogContextWindow(agent.model.modelId, agent.model.provider) ?? null
}

function isTextAttachmentWithContent(
  attachment: ConversationMessageAttachment,
): attachment is ConversationTextAttachment {
  return attachment.type === 'text' && 'text' in attachment && typeof attachment.text === 'string'
}

function estimateTextAttachmentChars(attachment: ConversationMessageAttachment): number {
  if (isTextAttachmentWithContent(attachment)) {
    return attachment.text.length
  }

  if (
    attachment.type === 'text' &&
    'sizeBytes' in attachment &&
    typeof attachment.sizeBytes === 'number' &&
    Number.isFinite(attachment.sizeBytes) &&
    attachment.sizeBytes > 0
  ) {
    return attachment.sizeBytes
  }

  return 0
}

function estimateUsedTokens(messages: ConversationEntry[]): number {
  let totalChars = 0

  for (const entry of messages) {
    if (entry.type !== 'conversation_message') {
      continue
    }

    totalChars += entry.text.length

    for (const attachment of entry.attachments ?? []) {
      totalChars += estimateTextAttachmentChars(attachment)
    }
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)
}

export function toContextWindowUsage(
  contextUsage: AgentContextUsage | undefined,
): { usedTokens: number; contextWindow: number } | null {
  if (!contextUsage) {
    return null
  }

  if (
    !Number.isFinite(contextUsage.tokens) ||
    contextUsage.tokens < 0 ||
    !Number.isFinite(contextUsage.contextWindow) ||
    contextUsage.contextWindow <= 0 ||
    contextUsage.tokens > contextUsage.contextWindow * MAX_REASONABLE_CONTEXT_USAGE_MULTIPLIER
  ) {
    return null
  }

  return {
    usedTokens: Math.round(contextUsage.tokens),
    contextWindow: Math.max(1, Math.round(contextUsage.contextWindow)),
  }
}

interface UseContextWindowOptions {
  activeAgent: AgentDescriptor | null
  activeAgentId: string | null
  messages: ConversationEntry[]
  statuses: ManagerWsState['statuses']
}

export function useContextWindow({
  activeAgent,
  activeAgentId,
  messages,
  statuses,
}: UseContextWindowOptions): {
  contextWindowUsage: { usedTokens: number; contextWindow: number } | null
} {
  const contextWindow = useMemo(() => contextWindowForAgent(activeAgent), [activeAgent])

  const contextWindowUsage = useMemo(() => {
    const liveFromStatus =
      activeAgentId !== null ? toContextWindowUsage(statuses[activeAgentId]?.contextUsage) : null
    if (liveFromStatus) {
      return liveFromStatus
    }

    const liveFromDescriptor = toContextWindowUsage(activeAgent?.contextUsage)
    if (liveFromDescriptor) {
      return liveFromDescriptor
    }

    if (!contextWindow) {
      return null
    }

    return {
      usedTokens: estimateUsedTokens(messages),
      contextWindow,
    }
  }, [activeAgent, activeAgentId, contextWindow, messages, statuses])

  return {
    contextWindowUsage,
  }
}
