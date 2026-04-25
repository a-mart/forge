import { describe, expect, it } from 'vitest'
import { createInitialManagerWsState } from '../ws-state'
import { reduceSessionWorkersSnapshot, reduceAgentStatus } from './snapshot-reducers'
import type { AgentDescriptor } from '@forge/protocol'

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
