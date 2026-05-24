import { useEffect, useMemo, useState } from 'react'
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

export type ContextWindowDisplay =
  | { mode: 'known'; usedTokens: number; contextWindow: number }
  | { mode: 'updating'; contextWindow: number }

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

export function estimateUsedTokens(messages: ConversationEntry[]): number {
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

export function resolveAuthoritativeContextUsage(
  statusEntry: ManagerWsState['statuses'][string] | undefined,
  activeAgent: AgentDescriptor | null,
): { usedTokens: number; contextWindow: number } | null {
  const liveFromStatus = toContextWindowUsage(statusEntry?.contextUsage)
  if (liveFromStatus) {
    return liveFromStatus
  }

  // Manager status events omit managerId, so descriptor contextUsage can remain stale
  // after compaction/recovery. Only trust descriptor usage when no live status exists.
  if (statusEntry !== undefined) {
    return null
  }

  return toContextWindowUsage(activeAgent?.contextUsage)
}

function expectsRuntimeUsageRefresh(input: {
  statusEntry: ManagerWsState['statuses'][string] | undefined
  activeAgent: AgentDescriptor | null
}): boolean {
  const { statusEntry, activeAgent } = input

  if (statusEntry?.contextRecoveryInProgress === true) {
    return true
  }

  const liveStatus = statusEntry?.status ?? activeAgent?.status
  return liveStatus === 'streaming'
}

export function resolveContextWindowDisplay(input: {
  activeAgent: AgentDescriptor | null
  activeAgentId: string | null
  messages: ConversationEntry[]
  statusEntry: ManagerWsState['statuses'][string] | undefined
  hadAuthoritativeUsage: boolean
}): { display: ContextWindowDisplay | null; hadAuthoritativeUsage: boolean } {
  const { activeAgent, activeAgentId, messages, statusEntry, hadAuthoritativeUsage } = input
  const contextWindow = contextWindowForAgent(activeAgent)

  if (!contextWindow || !activeAgentId) {
    return { display: null, hadAuthoritativeUsage: false }
  }

  const recoveryActive = statusEntry?.contextRecoveryInProgress === true
  const authoritative = resolveAuthoritativeContextUsage(statusEntry, activeAgent)

  if (authoritative) {
    return {
      display: { mode: 'known', ...authoritative },
      hadAuthoritativeUsage: true,
    }
  }

  const awaitingRefresh =
    expectsRuntimeUsageRefresh({ statusEntry, activeAgent }) &&
    (recoveryActive || hadAuthoritativeUsage)

  if (awaitingRefresh) {
    return {
      display: { mode: 'updating', contextWindow },
      hadAuthoritativeUsage: true,
    }
  }

  return {
    display: {
      mode: 'known',
      usedTokens: estimateUsedTokens(messages),
      contextWindow,
    },
    hadAuthoritativeUsage: false,
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
  contextWindowUsage: ContextWindowDisplay | null
} {
  const [hadAuthoritativeByAgent, setHadAuthoritativeByAgent] = useState<Record<string, boolean>>({})

  const contextWindowResult = useMemo(() => {
    const statusEntry = activeAgentId !== null ? statuses[activeAgentId] : undefined
    const hadAuthoritativeUsage =
      activeAgentId !== null ? (hadAuthoritativeByAgent[activeAgentId] ?? false) : false

    return resolveContextWindowDisplay({
      activeAgent,
      activeAgentId,
      messages,
      statusEntry,
      hadAuthoritativeUsage,
    })
  }, [activeAgent, activeAgentId, hadAuthoritativeByAgent, messages, statuses])

  useEffect(() => {
    if (activeAgentId === null) {
      return
    }

    const nextValue = contextWindowResult.hadAuthoritativeUsage
    setHadAuthoritativeByAgent((current) => {
      if ((current[activeAgentId] ?? false) === nextValue) {
        return current
      }

      return { ...current, [activeAgentId]: nextValue }
    })
  }, [activeAgentId, contextWindowResult.hadAuthoritativeUsage])

  return {
    contextWindowUsage: contextWindowResult.display,
  }
}
