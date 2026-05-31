import type { AgentStatus, ConversationEntry } from '@forge/protocol'

const IN_PROGRESS_STATUSES = new Set(['sent', 'running'])
const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'error'])

export function resolveConversationMessageTargetId(
  message: Extract<ConversationEntry, { type: 'conversation_message' }>,
): string {
  const id = message.id?.trim()
  return id && id.length > 0 ? id : message.timestamp
}

export function buildStoppableExternalThreadMessageIds(
  messages: ConversationEntry[],
  statuses: Record<string, { status: AgentStatus }> = {},
): Set<string> {
  const latestInProgressBySidecar = new Map<string, string>()

  for (const message of messages) {
    if (message.type !== 'conversation_message') {
      continue
    }

    const context = message.externalThreadContext
    if (context?.type !== 'codex_app_server') {
      continue
    }

    const sidecarAgentId = context.sidecarAgentId?.trim()
    if (!sidecarAgentId) {
      continue
    }

    const messageId = resolveConversationMessageTargetId(message)

    if (TERMINAL_STATUSES.has(context.status)) {
      latestInProgressBySidecar.delete(sidecarAgentId)
      continue
    }

    if (IN_PROGRESS_STATUSES.has(context.status)) {
      latestInProgressBySidecar.set(sidecarAgentId, messageId)
    }
  }

  const stoppable = new Set<string>()
  for (const [sidecarAgentId, messageId] of latestInProgressBySidecar) {
    if (statuses[sidecarAgentId]?.status === 'streaming') {
      stoppable.add(messageId)
    }
  }

  return stoppable
}
