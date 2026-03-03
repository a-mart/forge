import type { AgentDescriptor, ManagerProfile } from '@middleman/protocol'

const ACTIVE_STATUSES = new Set(['idle', 'streaming'])

function byCreatedAtThenId(a: AgentDescriptor, b: AgentDescriptor): number {
  const createdOrder = a.createdAt.localeCompare(b.createdAt)
  if (createdOrder !== 0) return createdOrder
  return a.agentId.localeCompare(b.agentId)
}

function byCreatedAtDescThenId(a: AgentDescriptor, b: AgentDescriptor): number {
  const createdOrder = b.createdAt.localeCompare(a.createdAt)
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
  const workers = activeAgents.filter((agent) => agent.role === 'worker').sort(byCreatedAtDescThenId)

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

// ── Profile-grouped tree (multi-session) ──

export interface SessionRow {
  sessionAgent: AgentDescriptor
  workers: AgentDescriptor[]
  isDefault: boolean
}

export interface ProfileTreeRow {
  profile: ManagerProfile
  sessions: SessionRow[]
}

/**
 * True when the agent is a session manager (has a profileId and role=manager).
 * Workers and managers without a profileId are NOT sessions.
 */
function isSessionAgent(agent: AgentDescriptor): boolean {
  return agent.role === 'manager' && Boolean(agent.profileId)
}

/**
 * True when the agent is "running" — it has an active runtime.
 * Agents without a runtime (no entry in agents list, or stopped) are treated as idle sessions.
 */
function isSessionRunning(agent: AgentDescriptor): boolean {
  return agent.status === 'idle' || agent.status === 'streaming'
}

export { isSessionRunning }

export function buildProfileTreeRows(
  agents: AgentDescriptor[],
  profiles: ManagerProfile[],
): ProfileTreeRow[] {
  // Index profiles by profileId
  const profileMap = new Map<string, ManagerProfile>()
  for (const profile of profiles) {
    profileMap.set(profile.profileId, profile)
  }

  // Separate session agents and workers
  const sessionAgents: AgentDescriptor[] = []
  const workers: AgentDescriptor[] = []
  const legacyManagers: AgentDescriptor[] = []

  for (const agent of agents) {
    if (agent.role === 'worker') {
      workers.push(agent)
    } else if (isSessionAgent(agent)) {
      sessionAgents.push(agent)
    } else if (agent.role === 'manager') {
      legacyManagers.push(agent)
    }
  }

  // Group workers by their managerId (which is the session agentId)
  const workersByManager = new Map<string, AgentDescriptor[]>()
  for (const worker of workers) {
    const list = workersByManager.get(worker.managerId)
    if (list) {
      list.push(worker)
    } else {
      workersByManager.set(worker.managerId, [worker])
    }
  }

  // Group session agents by profileId
  const sessionsByProfile = new Map<string, AgentDescriptor[]>()
  for (const session of sessionAgents) {
    const pid = session.profileId!
    const list = sessionsByProfile.get(pid)
    if (list) {
      list.push(session)
    } else {
      sessionsByProfile.set(pid, [session])
    }
  }

  // Build tree rows for each profile
  const treeRows: ProfileTreeRow[] = []

  for (const profile of profiles) {
    const sessions = sessionsByProfile.get(profile.profileId) ?? []

    // Sort: default session first, then newest-first
    const sortedSessions = [...sessions].sort((a, b) => {
      const aIsDefault = a.agentId === profile.defaultSessionAgentId ? 0 : 1
      const bIsDefault = b.agentId === profile.defaultSessionAgentId ? 0 : 1
      if (aIsDefault !== bIsDefault) return aIsDefault - bIsDefault
      return b.createdAt.localeCompare(a.createdAt) || a.agentId.localeCompare(b.agentId)
    })

    const sessionRows: SessionRow[] = sortedSessions.map((session) => ({
      sessionAgent: session,
      workers: (workersByManager.get(session.agentId) ?? []).sort(byCreatedAtDescThenId),
      isDefault: session.agentId === profile.defaultSessionAgentId,
    }))

    treeRows.push({ profile, sessions: sessionRows })
  }

  // Sort profiles by createdAt
  treeRows.sort((a, b) => a.profile.createdAt.localeCompare(b.profile.createdAt))

  // Handle legacy managers without profiles — create synthetic profile rows
  for (const manager of legacyManagers) {
    // Skip if already handled via a profile
    if (profileMap.has(manager.agentId)) continue

    const syntheticProfile: ManagerProfile = {
      profileId: manager.agentId,
      displayName: manager.displayName || manager.agentId,
      defaultSessionAgentId: manager.agentId,
      createdAt: manager.createdAt,
      updatedAt: manager.updatedAt,
    }

    treeRows.push({
      profile: syntheticProfile,
      sessions: [{
        sessionAgent: manager,
        workers: (workersByManager.get(manager.agentId) ?? []).sort(byCreatedAtDescThenId),
        isDefault: true,
      }],
    })
  }

  return treeRows
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
