import type { AgentDescriptor } from '@forge/protocol'

export function hasProjectManagers(agents: AgentDescriptor[]): boolean {
  return agents.some((agent) => {
    if (agent.role !== 'manager') return false
    if (agent.agentId === 'cortex') return false
    if (agent.profileId === 'cortex') return false
    return agent.archetypeId !== 'cortex'
  })
}
