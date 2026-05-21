import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { isAgentEffectivelyArchived } from '@/lib/agent-hierarchy'

export function isUsableActiveTarget(
  agentId: string,
  agents: AgentDescriptor[],
  profiles: ManagerProfile[],
): boolean {
  const agent = agents.find((entry) => entry.agentId === agentId)
  if (!agent) return false
  if (agent.role === 'manager') {
    return !isAgentEffectivelyArchived(agent, profiles)
  }
  if (agent.role === 'worker') {
    const manager = agents.find((entry) => entry.role === 'manager' && entry.agentId === agent.managerId)
    return manager ? !isAgentEffectivelyArchived(manager, profiles) : false
  }
  return true
}
