import type { ProjectAgentSuggestion } from '@/components/chat/MessageInput'
import {
  type AgentDescriptor,
  type ManagerProfile,
  type ProjectAgentExternalDirectoryEntry,
} from '@forge/protocol'

const BUILDER_SYSTEM_PROFILE_IDS = new Set(['cortex', '_collaboration'])

export function shouldLoadExternalProjectAgentDirectory(options: {
  activeAgentRole: AgentDescriptor['role'] | null | undefined
  activeProfileId: string | null | undefined
  activeProfileType: ManagerProfile['profileType'] | null | undefined
}): boolean {
  const { activeAgentRole, activeProfileId, activeProfileType } = options

  if (activeAgentRole !== 'manager' || !activeProfileId) {
    return false
  }

  if (BUILDER_SYSTEM_PROFILE_IDS.has(activeProfileId)) {
    return false
  }

  if (activeProfileType === 'system') {
    return false
  }

  return true
}

export function getProjectAgentSuggestions(
  activeAgent: AgentDescriptor | null | undefined,
  agents: AgentDescriptor[],
  externalEntries: ProjectAgentExternalDirectoryEntry[] = [],
): ProjectAgentSuggestion[] {
  if (!activeAgent || activeAgent.role !== 'manager' || !activeAgent.profileId) return []

  const localSuggestions = agents
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

  const externalSuggestions = externalEntries.map((entry) => ({
    agentId: entry.agentId,
    handle: entry.handle,
    displayName: entry.displayName,
    whenToUse: entry.whenToUse,
  }))

  return [...localSuggestions, ...externalSuggestions]
}
