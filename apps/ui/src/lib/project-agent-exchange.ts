import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'

type AgentMessageEntry = Extract<ConversationEntry, { type: 'agent_message' }>

/**
 * New events carry a durable marker. Descriptor inference keeps existing saved
 * project-agent exchanges visible without rewriting conversation history.
 */
export function isProjectAgentExchange(
  entry: AgentMessageEntry,
  agentsById: ReadonlyMap<string, AgentDescriptor>,
): boolean {
  if (entry.source !== 'agent_to_agent') return false
  if (entry.projectAgentExchange === true) return true

  const from = entry.fromAgentId ? agentsById.get(entry.fromAgentId) : undefined
  const to = agentsById.get(entry.toAgentId)
  return Boolean(
    from?.role === 'manager' &&
    to?.role === 'manager' &&
    (from.projectAgent !== undefined || to.projectAgent !== undefined),
  )
}
