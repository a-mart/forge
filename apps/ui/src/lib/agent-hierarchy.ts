import type { AgentDescriptor } from '@middleman/protocol'

const ACTIVE_STATUSES = new Set(['idle', 'streaming'])

function byCreatedAtThenId(a: AgentDescriptor, b: AgentDescriptor): number {
  const createdOrder = a.createdAt.localeCompare(b.createdAt)
  if (createdOrder !== 0) return createdOrder
  return a.agentId.localeCompare(b.agentId)
}

export function isActiveAgent(agent: AgentDescriptor): boolean {
  return ACTIVE_STATUSES.has(agent.status)
}

export function getPrimaryManagerId(agents: AgentDescriptor[]): string | null {
  const managers = agents.filter((agent) => agent.role === 'manager' && isActiveAgent(agent))
  if (managers.length === 0) return null

  return [...managers].sort(byCreatedAtThenId)[0]?.agentId ?? null
}

export interface ManagerTreeRow {
  manager: AgentDescriptor
  workers: AgentDescriptor[]
}

export function buildManagerTreeRows(agents: AgentDescriptor[]): {
  managerRows: ManagerTreeRow[]
  orphanWorkers: AgentDescriptor[]
} {
  const activeAgents = agents.filter(isActiveAgent)
  const managers = activeAgents.filter((agent) => agent.role === 'manager').sort(byCreatedAtThenId)
  const workers = activeAgents.filter((agent) => agent.role === 'worker').sort(byCreatedAtThenId)

  const workersByManager = new Map<string, AgentDescriptor[]>()
  for (const worker of workers) {
    const entries = workersByManager.get(worker.managerId)
    if (entries) {
      entries.push(worker)
    } else {
      workersByManager.set(worker.managerId, [worker])
    }
  }

  const managerRows = managers.map((manager) => ({
    manager,
    workers: workersByManager.get(manager.agentId) ?? [],
  }))

  const managerIds = new Set(managers.map((manager) => manager.agentId))
  const orphanWorkers = workers.filter((worker) => !managerIds.has(worker.managerId))

  return { managerRows, orphanWorkers }
}

export function chooseFallbackAgentId(agents: AgentDescriptor[], preferredAgentId?: string | null): string | null {
  const activeAgents = agents.filter(isActiveAgent)
  if (activeAgents.length === 0) {
    return null
  }

  if (preferredAgentId && activeAgents.some((agent) => agent.agentId === preferredAgentId)) {
    return preferredAgentId
  }

  const primaryManagerId = getPrimaryManagerId(activeAgents)
  if (primaryManagerId) {
    return primaryManagerId
  }

  const firstManager = activeAgents
    .filter((agent) => agent.role === 'manager')
    .sort(byCreatedAtThenId)[0]

  if (firstManager) {
    return firstManager.agentId
  }

  return [...activeAgents].sort(byCreatedAtThenId)[0]?.agentId ?? null
}
