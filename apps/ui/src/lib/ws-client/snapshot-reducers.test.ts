import { describe, expect, it } from 'vitest'
import { createInitialManagerWsState } from '../ws-state'
import type { ModelCacheObservationEntry } from '../ws-state'
import { reduceAgentsSnapshot, reduceSessionWorkersSnapshot, reduceAgentStatus } from './snapshot-reducers'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'manager-1',
    managerId: '',
    displayName: 'Test Manager',
    role: 'manager',
    status: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: '/tmp',
    model: { modelId: 'test-model', provider: 'test', thinkingLevel: 'none' },
    sessionFile: '/tmp/session.jsonl',
    workerCount: 3,
    activeWorkerCount: 0,
    ...overrides,
  }
}

function makeWorker(
  id: string,
  managerId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId: id,
    managerId,
    displayName: `Worker ${id}`,
    role: 'worker',
    status: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: '/tmp',
    model: { modelId: 'test-model', provider: 'test', thinkingLevel: 'none' },
    sessionFile: `/tmp/${id}.jsonl`,
    ...overrides,
  }
}

function makeProfile(profileId: string, overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: { modelId: 'test-model', provider: 'test', thinkingLevel: 'none' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// reduceAgentsSnapshot
// ---------------------------------------------------------------------------

describe('reduceAgentsSnapshot', () => {
  it('preserves a pending explicit deep-link target until its targeted snapshot arrives', () => {
    const state = {
      ...createInitialManagerWsState('idle-worker'),
      connected: true,
    }
    const fallback = makeManager({ agentId: 'fallback', managerId: 'fallback' })

    const result = reduceAgentsSnapshot({
      state,
      desiredAgentId: 'idle-worker',
      explicitAgentSelectionAgentId: 'idle-worker',
      agents: [fallback],
    })

    expect(result.patch.targetAgentId).toBeUndefined()
    expect(result.nextDesiredAgentId).toBe('idle-worker')
    expect(result.shouldClearExplicitSelection).toBe(false)
    expect(result.subscribeToAgentId).toBeNull()
  })

  it('does not preserve a selected worker when the parent manager becomes archived', () => {
    const activeManager = makeManager({ agentId: 'active-manager', profileId: 'active-manager' })
    const archivedManager = makeManager({
      agentId: 'archived-manager',
      profileId: 'archived-manager',
      archivedAt: '2026-05-20T00:00:00.000Z',
    })
    const archivedWorker = makeWorker('archived-worker', 'archived-manager')
    const state = {
      ...createInitialManagerWsState('archived-worker'),
      subscribedAgentId: 'archived-worker',
      agents: [activeManager, makeManager({ agentId: 'archived-manager', profileId: 'archived-manager' }), archivedWorker],
      profiles: [makeProfile('active-manager'), makeProfile('archived-manager')],
      loadedSessionIds: new Set(['archived-manager']),
    }

    const result = reduceAgentsSnapshot({
      state,
      desiredAgentId: null,
      explicitAgentSelectionAgentId: null,
      agents: [activeManager, archivedManager],
    })

    expect(result.patch.targetAgentId).toBe('active-manager')
    expect(result.patch.subscribedAgentId).toBe('active-manager')
    expect(result.patch.agents?.some((agent) => agent.agentId === 'archived-worker')).toBe(false)
  })

  it('clears stale context recovery state from agents_snapshot status rebuilds', () => {
    const manager = makeManager()
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager],
      statuses: {
        'manager-1': { status: 'streaming' as const, pendingCount: 0, contextRecoveryInProgress: true },
      },
    }

    const result = reduceAgentsSnapshot({
      state,
      desiredAgentId: 'manager-1',
      explicitAgentSelectionAgentId: null,
      agents: [makeManager({ status: 'streaming' })],
    })

    expect(result.patch.statuses!['manager-1']?.contextRecoveryInProgress).toBeUndefined()
  })

  it('clears modelCacheObservations when agents_snapshot changes the target session', () => {
    const managerA = makeManager({ agentId: 'manager-a' })
    const managerB = makeManager({ agentId: 'manager-b' })
    const staleObservation = {
      type: 'model_cache_observation',
      agentId: 'manager-a',
      id: 'cache-obs-stale',
      timestamp: '2026-06-02T12:00:00.000Z',
      runtimeType: 'pi',
      provider: 'openai',
      modelId: 'gpt-5',
      tokens: {
        promptInputTokens: 2000,
        cachedInputTokens: 1600,
        cacheWriteInputTokens: 0,
        uncachedInputTokens: 400,
        outputTokens: 120,
        totalTokens: 2120,
        normalization: 'raw_input_tokens_total',
      },
      classification: {
        version: 1,
        status: 'hit',
        cachedRatio: 0.8,
        thresholdTokens: 1024,
        hitRatioThreshold: 0.8,
      },
    } satisfies ModelCacheObservationEntry

    const state = {
      ...createInitialManagerWsState('manager-a'),
      targetAgentId: 'manager-a',
      modelCacheObservations: [staleObservation],
      agents: [managerA],
    }

    const result = reduceAgentsSnapshot({
      state,
      desiredAgentId: null,
      explicitAgentSelectionAgentId: null,
      agents: [managerB],
    })

    expect(result.patch.targetAgentId).toBe('manager-b')
    expect(result.patch.modelCacheObservations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reduceSessionWorkersSnapshot
// ---------------------------------------------------------------------------

describe('reduceSessionWorkersSnapshot', () => {
  it('updates manager workerCount and activeWorkerCount from authoritative snapshot', () => {
    const manager = makeManager({ workerCount: 5, activeWorkerCount: 2 })
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager],
    }

    const workers = [
      makeWorker('w-1', 'manager-1', { status: 'streaming' }),
      makeWorker('w-2', 'manager-1', { status: 'idle' }),
      makeWorker('w-3', 'manager-1', { status: 'streaming' }),
    ]

    const result = reduceSessionWorkersSnapshot({
      state,
      sessionAgentId: 'manager-1',
      workers,
    })

    const updatedManager = result.patch.agents!.find(
      (a) => a.role === 'manager' && a.agentId === 'manager-1',
    )
    expect(updatedManager).toBeDefined()
    expect(updatedManager!.workerCount).toBe(3)
    expect(updatedManager!.activeWorkerCount).toBe(2)
  })

  it('marks session as loaded in loadedSessionIds', () => {
    const manager = makeManager()
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager],
    }

    const result = reduceSessionWorkersSnapshot({
      state,
      sessionAgentId: 'manager-1',
      workers: [makeWorker('w-1', 'manager-1')],
    })

    expect(result.patch.loadedSessionIds!.has('manager-1')).toBe(true)
  })

  it('replaces existing workers for the same manager session', () => {
    const manager = makeManager({ workerCount: 2 })
    const oldWorker = makeWorker('w-old', 'manager-1')
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager, oldWorker],
      loadedSessionIds: new Set(['manager-1']),
    }

    const newWorkers = [
      makeWorker('w-new-1', 'manager-1'),
      makeWorker('w-new-2', 'manager-1'),
    ]

    const result = reduceSessionWorkersSnapshot({
      state,
      sessionAgentId: 'manager-1',
      workers: newWorkers,
    })

    const workerIds = result.patch.agents!
      .filter((a) => a.role === 'worker')
      .map((a) => a.agentId)

    expect(workerIds).toEqual(['w-new-1', 'w-new-2'])
    expect(workerIds).not.toContain('w-old')
  })

  it('removes stale worker statuses and adds new ones', () => {
    const manager = makeManager({ workerCount: 1 })
    const oldWorker = makeWorker('w-old', 'manager-1')
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager, oldWorker],
      statuses: {
        'manager-1': { status: 'idle' as const, pendingCount: 0 },
        'w-old': { status: 'idle' as const, pendingCount: 0 },
      },
    }

    const result = reduceSessionWorkersSnapshot({
      state,
      sessionAgentId: 'manager-1',
      workers: [makeWorker('w-new', 'manager-1', { status: 'streaming' })],
    })

    expect(result.patch.statuses!['w-old']).toBeUndefined()
    expect(result.patch.statuses!['w-new']?.status).toBe('streaming')
  })

  it('preserves workers from other manager sessions', () => {
    const manager1 = makeManager({ agentId: 'mgr-1', workerCount: 1 })
    const manager2 = makeManager({ agentId: 'mgr-2', workerCount: 1 })
    const worker2 = makeWorker('w-mgr2', 'mgr-2')
    const state = {
      ...createInitialManagerWsState('mgr-1'),
      agents: [manager1, manager2, worker2],
      loadedSessionIds: new Set(['mgr-2']),
    }

    const result = reduceSessionWorkersSnapshot({
      state,
      sessionAgentId: 'mgr-1',
      workers: [makeWorker('w-mgr1', 'mgr-1')],
    })

    const workerIds = result.patch.agents!
      .filter((a) => a.role === 'worker')
      .map((a) => a.agentId)

    expect(workerIds).toContain('w-mgr1')
    expect(workerIds).toContain('w-mgr2')
  })

  it('clears stale context recovery state from session worker snapshots', () => {
    const manager = makeManager({ workerCount: 1 })
    const worker = makeWorker('w-1', 'manager-1', { status: 'streaming' })
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager, worker],
      statuses: {
        'manager-1': { status: 'idle' as const, pendingCount: 0 },
        'w-1': { status: 'streaming' as const, pendingCount: 0, contextRecoveryInProgress: true },
      },
    }

    const result = reduceSessionWorkersSnapshot({
      state,
      sessionAgentId: 'manager-1',
      workers: [makeWorker('w-1', 'manager-1', { status: 'streaming' })],
    })

    expect(result.patch.statuses!['w-1']?.contextRecoveryInProgress).toBeUndefined()
  })

  it('sets workerCount to 0 and activeWorkerCount to 0 when snapshot is empty', () => {
    const manager = makeManager({ workerCount: 3, activeWorkerCount: 1 })
    const oldWorker = makeWorker('w-old', 'manager-1', { status: 'streaming' })
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager, oldWorker],
    }

    const result = reduceSessionWorkersSnapshot({
      state,
      sessionAgentId: 'manager-1',
      workers: [],
    })

    const updatedManager = result.patch.agents!.find(
      (a) => a.role === 'manager' && a.agentId === 'manager-1',
    )
    expect(updatedManager!.workerCount).toBe(0)
    expect(updatedManager!.activeWorkerCount).toBe(0)
    expect(result.patch.agents!.filter((a) => a.role === 'worker')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// reduceAgentStatus — unknown-worker invalidation & deduplication
// ---------------------------------------------------------------------------

describe('reduceAgentStatus', () => {
  it('invalidates loadedSessionIds and queues refetch for unknown worker with loaded manager', () => {
    const manager = makeManager()
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager],
      loadedSessionIds: new Set(['manager-1']),
      statuses: {
        'manager-1': { status: 'idle' as const, pendingCount: 0 },
      },
    }

    const result = reduceAgentStatus({
      state,
      event: {
        type: 'agent_status',
        agentId: 'unknown-worker',
        managerId: 'manager-1',
        status: 'streaming',
        pendingCount: 0,
      },
    })

    expect(result.patch.loadedSessionIds).toBeDefined()
    expect(result.patch.loadedSessionIds!.has('manager-1')).toBe(false)
    expect(result.queueSessionWorkersRefetchId).toBe('manager-1')
  })

  it('does not invalidate when agent_status is for a known worker', () => {
    const manager = makeManager()
    const worker = makeWorker('w-1', 'manager-1')
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager, worker],
      loadedSessionIds: new Set(['manager-1']),
      statuses: {
        'manager-1': { status: 'idle' as const, pendingCount: 0 },
        'w-1': { status: 'idle' as const, pendingCount: 0 },
      },
    }

    const result = reduceAgentStatus({
      state,
      event: {
        type: 'agent_status',
        agentId: 'w-1',
        managerId: 'manager-1',
        status: 'streaming',
        pendingCount: 0,
      },
    })

    expect(result.queueSessionWorkersRefetchId).toBeNull()
    if (result.patch.loadedSessionIds) {
      expect(result.patch.loadedSessionIds.has('manager-1')).toBe(true)
    }
  })

  it('does not create new statuses reference when status is unchanged (deduplication)', () => {
    const manager = makeManager()
    const worker = makeWorker('w-1', 'manager-1')
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager, worker],
      loadedSessionIds: new Set(['manager-1']),
      statuses: {
        'manager-1': { status: 'idle' as const, pendingCount: 0 },
        'w-1': { status: 'streaming' as const, pendingCount: 0, streamingStartedAt: 1000 },
      },
    }

    const result = reduceAgentStatus({
      state,
      event: {
        type: 'agent_status',
        agentId: 'w-1',
        managerId: 'manager-1',
        status: 'streaming',
        pendingCount: 0,
        streamingStartedAt: 1000,
      },
    })

    // When status is truly unchanged, the statuses object should be the same reference
    expect(result.patch.statuses).toBeUndefined()
  })

  it('clears context recovery state when agent_status omits the recovery flag', () => {
    const manager = makeManager({ status: 'streaming' })
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager],
      statuses: {
        'manager-1': { status: 'streaming' as const, pendingCount: 0, contextRecoveryInProgress: true },
      },
    }

    const result = reduceAgentStatus({
      state,
      event: {
        type: 'agent_status',
        agentId: 'manager-1',
        status: 'streaming',
        pendingCount: 0,
      },
    })

    expect(result.patch.statuses!['manager-1']?.contextRecoveryInProgress).toBeUndefined()
  })

  it('updates activeWorkerCount on manager when worker transitions to streaming', () => {
    const manager = makeManager({ activeWorkerCount: 0 })
    const worker = makeWorker('w-1', 'manager-1', { status: 'idle' })
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager, worker],
      statuses: {
        'manager-1': { status: 'idle' as const, pendingCount: 0 },
        'w-1': { status: 'idle' as const, pendingCount: 0 },
      },
    }

    const result = reduceAgentStatus({
      state,
      event: {
        type: 'agent_status',
        agentId: 'w-1',
        managerId: 'manager-1',
        status: 'streaming',
        pendingCount: 0,
      },
    })

    const updatedManager = result.patch.agents?.find(
      (a) => a.role === 'manager' && a.agentId === 'manager-1',
    )
    expect(updatedManager).toBeDefined()
    expect(updatedManager!.activeWorkerCount).toBe(1)
  })

  it('decrements activeWorkerCount on manager when worker leaves streaming', () => {
    const manager = makeManager({ activeWorkerCount: 2 })
    const worker = makeWorker('w-1', 'manager-1', { status: 'streaming' })
    const state = {
      ...createInitialManagerWsState('manager-1'),
      agents: [manager, worker],
      statuses: {
        'manager-1': { status: 'idle' as const, pendingCount: 0 },
        'w-1': { status: 'streaming' as const, pendingCount: 0 },
      },
    }

    const result = reduceAgentStatus({
      state,
      event: {
        type: 'agent_status',
        agentId: 'w-1',
        managerId: 'manager-1',
        status: 'idle',
        pendingCount: 0,
      },
    })

    const updatedManager = result.patch.agents?.find(
      (a) => a.role === 'manager' && a.agentId === 'manager-1',
    )
    expect(updatedManager).toBeDefined()
    expect(updatedManager!.activeWorkerCount).toBe(1)
  })
})
