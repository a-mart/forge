import { chooseFallbackAgentId } from '../agent-hierarchy'
import type { ManagerWsState } from '../ws-state'
import { isManagerAgent, isWorkerAgent } from './runtime-types'
import {
  chooseMostRecentSessionAgentId,
  resolveStreamingStartedAt,
  resolveTerminalScopeAgentId,
} from './utils'
import type { AgentContextUsage, AgentDescriptor } from '@forge/protocol'

export interface AgentsSnapshotReduction {
  patch: Partial<ManagerWsState>
  nextDesiredAgentId: string | null
  subscribeToAgentId: string | null
  shouldClearExplicitSelection: boolean
  queueSessionWorkersRefetchIds: string[]
}

export interface SessionWorkersSnapshotReduction {
  patch: Partial<ManagerWsState>
  shouldQueueSessionWorkersRefetch: boolean
}

export interface AgentStatusReduction {
  patch: Partial<ManagerWsState>
  nextState: ManagerWsState
  queueSessionWorkersRefetchId: string | null
  managerIdleTransitionAgentId: string | null
}

export interface ManagerDeletedReduction {
  patch: Partial<ManagerWsState>
  nextDesiredAgentId?: string | null
  subscribeToAgentId: string | null
  deletedAgentIds: string[]
}

export interface SessionDeletedReduction {
  patch: Partial<ManagerWsState>
  nextDesiredAgentId?: string | null
  subscribeToAgentId: string | null
  mutedAgentIdToRemove: string
}

export function reduceAgentsSnapshot(input: {
  state: ManagerWsState
  desiredAgentId: string | null
  explicitAgentSelectionAgentId: string | null
  agents: AgentDescriptor[]
}): AgentsSnapshotReduction {
  const { state, desiredAgentId, explicitAgentSelectionAgentId, agents } = input
  const incomingAgentIds = new Set(agents.map((agent) => agent.agentId))
  const preservedWorkers = state.agents.filter(
    (agent) =>
      isWorkerAgent(agent) &&
      !incomingAgentIds.has(agent.agentId) &&
      state.loadedSessionIds.has(agent.managerId),
  )

  const mergedAgents = [...agents, ...preservedWorkers]
  const mergedAgentIds = new Set(mergedAgents.map((agent) => agent.agentId))
  const nextLoadedSessionIds = new Set(state.loadedSessionIds)
  const queueSessionWorkersRefetchIds: string[] = []

  for (const manager of agents) {
    if (!isManagerAgent(manager) || manager.workerCount === undefined) {
      continue
    }

    const cachedWorkers = state.agents.filter(
      (agent) => isWorkerAgent(agent) && agent.managerId === manager.agentId,
    )

    if (nextLoadedSessionIds.has(manager.agentId) && cachedWorkers.length !== manager.workerCount) {
      nextLoadedSessionIds.delete(manager.agentId)
      queueSessionWorkersRefetchIds.push(manager.agentId)
    }
  }

  const previousAgentIds = new Set(state.agents.map((agent) => agent.agentId))
  const preservedUnloadedStatuses = Object.fromEntries(
    Object.entries(state.statuses).filter(
      ([agentId]) => !mergedAgentIds.has(agentId) && !previousAgentIds.has(agentId),
    ),
  )
  const statuses = {
    ...preservedUnloadedStatuses,
    ...Object.fromEntries(
      mergedAgents.map((agent) => {
        const previous = state.statuses[agent.agentId]
        const status = isWorkerAgent(agent) && previous ? previous.status : agent.status
        return [
          agent.agentId,
          {
            status,
            pendingCount: previous && previous.status === status ? previous.pendingCount : 0,
            contextUsage: agent.contextUsage,
            contextRecoveryInProgress: previous?.contextRecoveryInProgress,
            streamingStartedAt: resolveStreamingStartedAt(previous, status, agent.streamingStartedAt),
          },
        ]
      }),
    ),
  }

  const currentTarget = state.targetAgentId ?? state.subscribedAgentId ?? desiredAgentId ?? undefined
  const currentTargetStillExists = currentTarget ? mergedAgentIds.has(currentTarget) : false
  const currentTargetIsIntentionalWorkerSubscription = Boolean(
    currentTarget &&
      currentTarget === state.subscribedAgentId &&
      !agents.some((agent) => agent.agentId === currentTarget && isManagerAgent(agent)),
  )
  const fallbackTarget = currentTargetStillExists
    ? currentTarget
    : currentTargetIsIntentionalWorkerSubscription
      ? currentTarget
      : chooseFallbackAgentId(mergedAgents, currentTarget)
  const targetChanged = fallbackTarget !== state.targetAgentId
  const nextSubscribedAgentId =
    state.subscribedAgentId && mergedAgentIds.has(state.subscribedAgentId)
      ? state.subscribedAgentId
      : currentTargetIsIntentionalWorkerSubscription
        ? state.subscribedAgentId
        : fallbackTarget ?? null

  const patch: Partial<ManagerWsState> = {
    agents: mergedAgents,
    statuses,
    loadedSessionIds: nextLoadedSessionIds,
    hasReceivedAgentsSnapshot: true,
  }

  if (targetChanged) {
    patch.targetAgentId = fallbackTarget ?? null
    patch.messages = []
    patch.activityMessages = []
    patch.pendingChoiceIds = new Set()

    const previousTerminalScopeId = resolveTerminalScopeAgentId(state.targetAgentId, state.agents)
    const nextTerminalScopeId = resolveTerminalScopeAgentId(fallbackTarget, mergedAgents)
    if (previousTerminalScopeId !== nextTerminalScopeId) {
      patch.terminals = []
      patch.terminalSessionScopeId = null
    }
  }

  if (nextSubscribedAgentId !== state.subscribedAgentId) {
    patch.subscribedAgentId = nextSubscribedAgentId
  }

  return {
    patch,
    nextDesiredAgentId: fallbackTarget ?? null,
    subscribeToAgentId:
      targetChanged && fallbackTarget && !currentTargetIsIntentionalWorkerSubscription
        ? fallbackTarget
        : null,
    shouldClearExplicitSelection: targetChanged && fallbackTarget !== explicitAgentSelectionAgentId,
    queueSessionWorkersRefetchIds,
  }
}

export function reduceSessionWorkersSnapshot(input: {
  state: ManagerWsState
  sessionAgentId: string
  workers: AgentDescriptor[]
}): SessionWorkersSnapshotReduction {
  const { state, sessionAgentId, workers } = input
  const nextLoadedSessionIds = new Set(state.loadedSessionIds)
  nextLoadedSessionIds.add(sessionAgentId)

  const incomingWorkerIds = new Set(workers.map((worker) => worker.agentId))
  const preserved = state.agents.filter(
    (agent) => !(isWorkerAgent(agent) && agent.managerId === sessionAgentId && !incomingWorkerIds.has(agent.agentId)),
  )
  const nextAgents = [
    ...preserved.filter((agent) => !(isWorkerAgent(agent) && agent.managerId === sessionAgentId)),
    ...workers,
  ]

  const nextStatuses = { ...state.statuses }
  for (const worker of state.agents) {
    if (isWorkerAgent(worker) && worker.managerId === sessionAgentId && !incomingWorkerIds.has(worker.agentId)) {
      delete nextStatuses[worker.agentId]
    }
  }

  for (const worker of workers) {
    const previous = nextStatuses[worker.agentId]
    nextStatuses[worker.agentId] = {
      status: worker.status,
      pendingCount: previous && previous.status === worker.status ? previous.pendingCount : 0,
      contextUsage: worker.contextUsage,
      contextRecoveryInProgress: previous?.contextRecoveryInProgress,
      streamingStartedAt: resolveStreamingStartedAt(previous, worker.status, worker.streamingStartedAt),
    }
  }

  const patch: Partial<ManagerWsState> = {
    agents: nextAgents,
    statuses: nextStatuses,
    loadedSessionIds: nextLoadedSessionIds,
  }

  const managerDescriptor = nextAgents.find(
    (agent) => isManagerAgent(agent) && agent.agentId === sessionAgentId,
  )
  const shouldQueueSessionWorkersRefetch =
    managerDescriptor?.workerCount !== undefined && workers.length !== managerDescriptor.workerCount

  return {
    patch,
    shouldQueueSessionWorkersRefetch,
  }
}

export function reduceAgentStatus(input: {
  state: ManagerWsState
  event: Extract<import('@forge/protocol').ServerEvent, { type: 'agent_status' }>
}): AgentStatusReduction {
  const { state, event } = input
  const prevEntry = state.statuses[event.agentId]
  const prevStatus = prevEntry?.status
  const isKnownAgent = state.agents.some((agent) => agent.agentId === event.agentId)

  // Resolve streamingStartedAt once so we can compare before allocating
  const resolvedStreamingStartedAt = resolveStreamingStartedAt(prevEntry, event.status, event.streamingStartedAt)

  // Only create a new statuses reference when the entry actually changed
  const statusUnchanged =
    prevEntry != null &&
    prevEntry.status === event.status &&
    prevEntry.pendingCount === event.pendingCount &&
    prevEntry.contextRecoveryInProgress === event.contextRecoveryInProgress &&
    prevEntry.streamingStartedAt === resolvedStreamingStartedAt &&
    contextUsageEqual(prevEntry.contextUsage, event.contextUsage)

  const statuses = statusUnchanged
    ? state.statuses
    : {
        ...state.statuses,
        [event.agentId]: {
          status: event.status,
          pendingCount: event.pendingCount,
          contextUsage: event.contextUsage,
          contextRecoveryInProgress: event.contextRecoveryInProgress,
          streamingStartedAt: resolvedStreamingStartedAt,
        },
      }

  let nextAgents = state.agents
  let nextLoadedSessionIds = state.loadedSessionIds
  let queueSessionWorkersRefetchId: string | null = null

  if (event.managerId) {
    const managerSessionWasLoaded = state.loadedSessionIds.has(event.managerId)
    if (!isKnownAgent && managerSessionWasLoaded) {
      nextLoadedSessionIds = new Set(state.loadedSessionIds)
      nextLoadedSessionIds.delete(event.managerId)
      queueSessionWorkersRefetchId = event.managerId
    }

    // Pre-check whether any agent descriptor actually needs updating
    const workerNeedsStatusUpdate = state.agents.some(
      (agent) => agent.agentId === event.agentId && agent.status !== event.status,
    )
    const streamingDelta =
      event.status === 'streaming' && prevStatus !== 'streaming'
        ? 1
        : event.status !== 'streaming' && prevStatus === 'streaming'
          ? -1
          : 0

    // Only create a new agents array when a descriptor actually changes
    if (workerNeedsStatusUpdate || streamingDelta !== 0) {
      nextAgents = state.agents.map((agent) => {
        if (workerNeedsStatusUpdate && agent.agentId === event.agentId && agent.status !== event.status) {
          return { ...agent, status: event.status, contextUsage: event.contextUsage }
        }
        if (streamingDelta !== 0 && isManagerAgent(agent) && agent.agentId === event.managerId) {
          return {
            ...agent,
            activeWorkerCount: Math.max(0, (agent.activeWorkerCount ?? 0) + streamingDelta),
          }
        }
        return agent
      })
    }
  }

  const patch: Partial<ManagerWsState> = {
    ...(statuses !== state.statuses ? { statuses } : {}),
    ...(nextAgents !== state.agents ? { agents: nextAgents } : {}),
    ...(nextLoadedSessionIds !== state.loadedSessionIds ? { loadedSessionIds: nextLoadedSessionIds } : {}),
  }
  const nextState = { ...state, ...patch }
  const agent = nextState.agents.find((candidate) => candidate.agentId === event.agentId)

  return {
    patch,
    nextState,
    queueSessionWorkersRefetchId,
    managerIdleTransitionAgentId:
      prevStatus === 'streaming' && event.status === 'idle' && agent?.role === 'manager'
        ? event.agentId
        : null,
  }
}

/** Shallow-compare two AgentContextUsage values */
function contextUsageEqual(
  a: AgentContextUsage | undefined,
  b: AgentContextUsage | undefined,
): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  return a.tokens === b.tokens && a.contextWindow === b.contextWindow && a.percent === b.percent
}

export function reduceManagerDeleted(input: {
  state: ManagerWsState
  managerId: string
  socketOpen: boolean
}): ManagerDeletedReduction {
  const { state, managerId, socketOpen } = input
  const wasSelected = state.targetAgentId === managerId || state.subscribedAgentId === managerId

  const nextAgents = state.agents.filter(
    (agent) => agent.agentId !== managerId && agent.managerId !== managerId,
  )
  const nextStatuses = { ...state.statuses }
  delete nextStatuses[managerId]
  const nextUnread = { ...state.unreadCounts }
  delete nextUnread[managerId]
  const deletedAgentIds = [managerId]

  for (const agent of state.agents) {
    if (agent.managerId === managerId) {
      delete nextStatuses[agent.agentId]
      delete nextUnread[agent.agentId]
      deletedAgentIds.push(agent.agentId)
    }
  }

  const nextLoadedSessionIds = new Set(state.loadedSessionIds)
  nextLoadedSessionIds.delete(managerId)

  if (wasSelected) {
    const fallbackId = chooseFallbackAgentId(nextAgents)

    if (fallbackId && socketOpen) {
      return {
        patch: {
          agents: nextAgents,
          statuses: nextStatuses,
          unreadCounts: nextUnread,
          loadedSessionIds: nextLoadedSessionIds,
          targetAgentId: fallbackId,
          subscribedAgentId: fallbackId,
          messages: [],
          activityMessages: [],
          pendingChoiceIds: new Set(),
          terminals: [],
          terminalSessionScopeId: null,
        },
        nextDesiredAgentId: fallbackId,
        subscribeToAgentId: fallbackId,
        deletedAgentIds,
      }
    }

    return {
      patch: {
        agents: nextAgents,
        statuses: nextStatuses,
        unreadCounts: nextUnread,
        loadedSessionIds: nextLoadedSessionIds,
        targetAgentId: null,
        subscribedAgentId: null,
        messages: [],
        activityMessages: [],
        pendingChoiceIds: new Set(),
        terminals: [],
        terminalSessionScopeId: null,
      },
      nextDesiredAgentId: null,
      subscribeToAgentId: null,
      deletedAgentIds,
    }
  }

  return {
    patch: {
      agents: nextAgents,
      statuses: nextStatuses,
      unreadCounts: nextUnread,
      loadedSessionIds: nextLoadedSessionIds,
    },
    subscribeToAgentId: null,
    deletedAgentIds,
  }
}

export function reduceSessionDeleted(input: {
  state: ManagerWsState
  agentId: string
  profileId: string
  socketOpen: boolean
}): SessionDeletedReduction {
  const { state, agentId, profileId, socketOpen } = input
  const wasSelected = state.targetAgentId === agentId || state.subscribedAgentId === agentId

  const nextAgents = state.agents.filter(
    (agent) => agent.agentId !== agentId && agent.managerId !== agentId,
  )
  const nextStatuses = { ...state.statuses }
  delete nextStatuses[agentId]
  const nextUnread = { ...state.unreadCounts }
  delete nextUnread[agentId]

  for (const worker of state.agents) {
    if (isWorkerAgent(worker) && worker.managerId === agentId) {
      delete nextStatuses[worker.agentId]
    }
  }

  const nextLoadedSessionIds = new Set(state.loadedSessionIds)
  nextLoadedSessionIds.delete(agentId)

  if (wasSelected) {
    const fallbackId =
      chooseMostRecentSessionAgentId(nextAgents, profileId, agentId) ?? chooseFallbackAgentId(nextAgents)

    if (fallbackId && socketOpen) {
      const previousTerminalScopeId = resolveTerminalScopeAgentId(agentId, state.agents)
      const nextTerminalScopeId = resolveTerminalScopeAgentId(fallbackId, nextAgents)

      return {
        patch: {
          agents: nextAgents,
          statuses: nextStatuses,
          unreadCounts: nextUnread,
          loadedSessionIds: nextLoadedSessionIds,
          targetAgentId: fallbackId,
          subscribedAgentId: fallbackId,
          messages: [],
          activityMessages: [],
          pendingChoiceIds: new Set(),
          ...(previousTerminalScopeId !== nextTerminalScopeId
            ? { terminals: [], terminalSessionScopeId: null }
            : {}),
        },
        nextDesiredAgentId: fallbackId,
        subscribeToAgentId: fallbackId,
        mutedAgentIdToRemove: agentId,
      }
    }
  }

  return {
    patch: {
      agents: nextAgents,
      statuses: nextStatuses,
      unreadCounts: nextUnread,
      loadedSessionIds: nextLoadedSessionIds,
    },
    subscribeToAgentId: null,
    mutedAgentIdToRemove: agentId,
  }
}
