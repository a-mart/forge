import type { GitWorktreeAgentSummary } from '@forge/protocol'

const ATTACHED_AGENT_STATUSES = new Set(['idle', 'streaming'])

export function isWorktreeAttachedAgentStatus(status: string): boolean {
  return ATTACHED_AGENT_STATUSES.has(status)
}

export function isWorktreeRunningAgentStatus(status: string): boolean {
  return status === 'streaming'
}

export function isWorktreeRunningWorker(agent: GitWorktreeAgentSummary): boolean {
  return agent.role === 'worker' && isWorktreeRunningAgentStatus(agent.status)
}

export interface WorktreeAgentStats {
  attached: number
  running: number
  managers: number
  workers: number
}

export function summarizeWorktreeAgents(agents: GitWorktreeAgentSummary[]): WorktreeAgentStats {
  const attachedAgents = agents.filter((agent) => isWorktreeAttachedAgentStatus(agent.status))

  return {
    attached: attachedAgents.length,
    running: attachedAgents.filter((agent) => isWorktreeRunningWorker(agent)).length,
    managers: attachedAgents.filter((agent) => agent.role === 'manager').length,
    workers: attachedAgents.filter((agent) => agent.role === 'worker').length,
  }
}
