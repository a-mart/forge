import type { AgentDescriptor } from '@forge/protocol'

export function chooseMostRecentSessionFallbackForDeletedTarget(
  agents: AgentDescriptor[],
  deletedAgentId: string,
  previousAgentsById: Map<string, AgentDescriptor>,
): string | null {
  const deletedAgent = previousAgentsById.get(deletedAgentId)
  const profileId = deletedAgent
    ? resolveDeletedAgentProfileId(agents, previousAgentsById, deletedAgent)
    : inferProfileIdFromDeletedAgentId(agents, deletedAgentId)
  if (!profileId) {
    return null
  }

  const profileSessions = agents
    .filter((agent) => {
      if (agent.role !== 'manager') {
        return false
      }

      const agentProfileId = agent.profileId?.trim() || agent.agentId
      return agentProfileId === profileId && agent.agentId !== deletedAgentId
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

  return profileSessions[0]?.agentId ?? null
}

function inferProfileIdFromDeletedAgentId(
  agents: AgentDescriptor[],
  deletedAgentId: string,
): string | null {
  const explicitProfileMatch = agents.find(
    (agent) =>
      agent.role === 'manager' &&
      (agent.profileId?.trim() || agent.agentId) === deletedAgentId,
  )
  if (explicitProfileMatch) {
    return explicitProfileMatch.profileId?.trim() || explicitProfileMatch.agentId
  }

  const sessionMatch = /^(.*)--s\d+$/.exec(deletedAgentId.trim())
  if (!sessionMatch) {
    return null
  }

  const inferredProfileId = sessionMatch[1]?.trim()
  if (!inferredProfileId) {
    return null
  }

  return agents.some(
    (agent) =>
      agent.role === 'manager' &&
      (agent.profileId?.trim() || agent.agentId) === inferredProfileId,
  )
    ? inferredProfileId
    : null
}

function resolveDeletedAgentProfileId(
  agents: AgentDescriptor[],
  previousAgentsById: Map<string, AgentDescriptor>,
  deletedAgent: AgentDescriptor,
): string | null {
  if (deletedAgent.role === 'manager') {
    return deletedAgent.profileId?.trim() || deletedAgent.agentId
  }

  const currentManager = agents.find(
    (agent) => agent.role === 'manager' && agent.agentId === deletedAgent.managerId,
  )
  const previousManager = previousAgentsById.get(deletedAgent.managerId)
  const managerDescriptor =
    currentManager ??
    (previousManager && previousManager.role === 'manager' ? previousManager : null)

  if (!managerDescriptor || managerDescriptor.role !== 'manager') {
    return null
  }

  return managerDescriptor.profileId?.trim() || managerDescriptor.agentId
}
