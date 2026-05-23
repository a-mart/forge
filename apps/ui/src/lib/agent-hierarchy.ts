import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'

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

function isActiveAgent(agent: AgentDescriptor): boolean {
  return ACTIVE_STATUSES.has(agent.status)
}

export function isAgentEffectivelyArchived(agent: AgentDescriptor, profiles: ManagerProfile[]): boolean {
  if (agent.role !== 'manager') return false
  if (agent.archivedAt) return true
  const profileId = agent.profileId ?? agent.agentId
  return profiles.some((profile) => profile.profileId === profileId && Boolean(profile.archivedAt))
}

export function getSessionLastUserMessageAt(session: AgentDescriptor): string | null {
  return session.lastUserMessageAt || null
}

export function getProfileRowLastUserMessageAt(row: ProfileTreeRow): string | null {
  return row.sessions.reduce<string | null>((latest, session) => {
    const timestamp = getSessionLastUserMessageAt(session.sessionAgent)
    if (!timestamp) return latest
    return latest === null || timestamp.localeCompare(latest) > 0 ? timestamp : latest
  }, null)
}

export function getArchivedProfileRows(
  agents: AgentDescriptor[],
  profiles: ManagerProfile[],
): ProfileTreeRow[] {
  return buildProfileTreeRows(agents, profiles, { includeArchived: true })
    .filter((row) => Boolean(row.profile.archivedAt))
    .sort((a, b) => {
      const aLastUsed = getProfileRowLastUserMessageAt(a)
      const bLastUsed = getProfileRowLastUserMessageAt(b)
      if (aLastUsed && bLastUsed) {
        const lastUsedOrder = bLastUsed.localeCompare(aLastUsed)
        if (lastUsedOrder !== 0) return lastUsedOrder
      } else if (aLastUsed) {
        return -1
      } else if (bLastUsed) {
        return 1
      }

      const archivedOrder = (b.profile.archivedAt ?? '').localeCompare(a.profile.archivedAt ?? '')
      if (archivedOrder !== 0) return archivedOrder
      return a.profile.profileId.localeCompare(b.profile.profileId)
    })
}

export function getDirectlyArchivedSessionRows(
  agents: AgentDescriptor[],
  profiles: ManagerProfile[],
): SessionRow[] {
  return buildProfileTreeRows(agents, profiles, { includeArchived: true })
    .filter((row) => !row.profile.archivedAt)
    .flatMap((row) => row.sessions.filter((session) => Boolean(session.sessionAgent.archivedAt)))
}

export function filterAgentsAfterSessionArchive(
  agents: AgentDescriptor[],
  archivedAgentId: string,
): AgentDescriptor[] {
  return agents.filter((agent) => agent.agentId !== archivedAgentId && agent.managerId !== archivedAgentId)
}

export function filterAgentsAfterProfileArchive(
  agents: AgentDescriptor[],
  archivedProfileId: string,
): AgentDescriptor[] {
  const archivedManagerIds = new Set(
    agents
      .filter((agent) => agent.role === 'manager' && (agent.profileId ?? agent.agentId) === archivedProfileId)
      .map((agent) => agent.agentId),
  )
  return agents.filter((agent) => {
    if (agent.role === 'manager') {
      return (agent.profileId ?? agent.agentId) !== archivedProfileId
    }
    return !archivedManagerIds.has(agent.managerId)
  })
}

export function filterBuilderVisibleAgents(agents: AgentDescriptor[]): AgentDescriptor[] {
  const collabManagerIds = new Set(
    agents
      .filter((agent) => agent.role === 'manager' && agent.sessionSurface === 'collab')
      .map((agent) => agent.agentId),
  )

  return agents.filter((agent) => {
    if (agent.role === 'manager') {
      return agent.sessionSurface !== 'collab'
    }

    return !collabManagerIds.has(agent.managerId)
  })
}

export function isCortexProfile(row: ProfileTreeRow): boolean {
  // Check if the default session (or any session) has archetypeId === 'cortex'
  const defaultSession = row.sessions.find((s) => s.isDefault)
  const representativeSession = defaultSession ?? row.sessions[0]
  return representativeSession?.sessionAgent.archetypeId === 'cortex'
}

export function getPrimaryManagerId(agents: AgentDescriptor[]): string | null {
  const managers = filterBuilderVisibleAgents(agents).filter(
    (agent) => agent.role === 'manager' && isActiveAgent(agent),
  )
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
  const activeAgents = filterBuilderVisibleAgents(agents).filter(isActiveAgent)
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
  options: { includeArchived?: boolean } = {},
): ProfileTreeRow[] {
  const visibleAgents = filterBuilderVisibleAgents(agents)
  const profileArchivedById = new Map(profiles.map((profile) => [profile.profileId, Boolean(profile.archivedAt)]))

  // Index profiles by profileId
  const profileMap = new Map<string, ManagerProfile>()
  for (const profile of profiles) {
    profileMap.set(profile.profileId, profile)
  }

  // Separate session agents and workers
  const sessionAgents: AgentDescriptor[] = []
  const workers: AgentDescriptor[] = []
  const legacyManagers: AgentDescriptor[] = []

  for (const agent of visibleAgents) {
    if (!options.includeArchived && agent.role === 'manager' && (agent.archivedAt || profileArchivedById.get(agent.profileId ?? agent.agentId))) {
      continue
    }
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
    if (!options.includeArchived && profile.archivedAt) continue
    const sessions = sessionsByProfile.get(profile.profileId) ?? []

    // Sort: most recently active first (fall back to createdAt)
    const sortedSessions = [...sessions].sort((a, b) => {
      const aTime = a.updatedAt || a.createdAt
      const bTime = b.updatedAt || b.createdAt
      return bTime.localeCompare(aTime) || a.agentId.localeCompare(b.agentId)
    })

    const sessionRows: SessionRow[] = sortedSessions.map((session) => ({
      sessionAgent: session,
      workers: (workersByManager.get(session.agentId) ?? []).sort(byCreatedAtDescThenId),
      isDefault: session.agentId === profile.defaultSessionAgentId,
    }))

    treeRows.push({ profile, sessions: sessionRows })
  }

  // Sort profiles by sortOrder first, then createdAt, then profileId for determinism
  treeRows.sort((a, b) => {
    const aOrder = a.profile.sortOrder ?? Number.MAX_SAFE_INTEGER
    const bOrder = b.profile.sortOrder ?? Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) return aOrder - bOrder
    const createdOrder = a.profile.createdAt.localeCompare(b.profile.createdAt)
    if (createdOrder !== 0) return createdOrder
    return a.profile.profileId.localeCompare(b.profile.profileId)
  })

  // Handle legacy managers without profiles — create synthetic profile rows
  for (const manager of legacyManagers) {
    if (!options.includeArchived && manager.archivedAt) continue
    // Skip if already handled via a profile
    if (profileMap.has(manager.agentId)) continue

    const syntheticProfile: ManagerProfile = {
      profileId: manager.agentId,
      displayName: manager.displayName || manager.agentId,
      defaultSessionAgentId: manager.agentId,
      defaultModel: { ...manager.model },
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

/**
 * Resolve the manager ID whose workers should be fetched for the current view.
 *
 * Returns the manager's own agentId when viewing a manager, or the parent
 * managerId when viewing a worker.  Returns `null` when the active agent is
 * not yet loaded (cold-boot / reconnect) — callers must skip the fetch rather
 * than falling back to an arbitrary manager.
 */
export function resolveWorkerFetchManagerId(
  activeAgent: AgentDescriptor | null | undefined,
): string | null {
  if (!activeAgent) return null
  if (activeAgent.role === 'manager') return activeAgent.agentId
  if (activeAgent.role === 'worker' && activeAgent.managerId) return activeAgent.managerId
  return null
}

export function chooseFallbackAgentId(
  agents: AgentDescriptor[],
  preferredAgentId?: string | null,
  profiles: ManagerProfile[] = [],
): string | null {
  const archivedManagerIds = new Set(
    agents
      .filter((agent) => agent.role === 'manager' && isAgentEffectivelyArchived(agent, profiles))
      .map((agent) => agent.agentId),
  )
  const activeAgents = filterBuilderVisibleAgents(agents)
    .filter(isActiveAgent)
    .filter((agent) => agent.role !== 'manager' || !isAgentEffectivelyArchived(agent, profiles))
    .filter((agent) => agent.role !== 'worker' || !archivedManagerIds.has(agent.managerId))
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
