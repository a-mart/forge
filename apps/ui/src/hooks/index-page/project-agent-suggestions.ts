import type { ProjectAgentSuggestion } from '@/components/chat/MessageInput'
import type { AgentDescriptor } from '@forge/protocol'

export function getProjectAgentSuggestions(
  activeAgent: AgentDescriptor | null | undefined,
  agents: AgentDescriptor[],
): ProjectAgentSuggestion[] {
  if (!activeAgent || activeAgent.role !== 'manager' || !activeAgent.profileId) return []

  return agents
    .filter(
      (agent) =>
        agent.projectAgent &&
        agent.profileId === activeAgent.profileId &&
        agent.agentId !== activeAgent.agentId,
    )
    .map((agent) => ({
      agentId: agent.agentId,
      handle: agent.projectAgent!.handle,
      displayName: agent.sessionLabel ?? agent.displayName ?? agent.agentId,
      whenToUse: agent.projectAgent!.whenToUse,
    }))
}
