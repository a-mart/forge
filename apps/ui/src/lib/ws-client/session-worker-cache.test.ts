import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionWorkerCache } from './session-worker-cache'
import type { ManagerWsState } from '../ws-state'
import { createInitialManagerWsState } from '../ws-state'
import type { AgentDescriptor } from '@forge/protocol'
import type { SessionWorkersResult } from './types'

function makeState(overrides: Partial<ManagerWsState> = {}): ManagerWsState {
  return { ...createInitialManagerWsState('session-a'), ...overrides }
}

function makeManager(agentId: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: 'Manager',
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    workerCount: 0,
    activeWorkerCount: 0,
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  }
}

function makeWorker(agentId: string, managerId: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: `Worker ${agentId}`,
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  }
}

describe('SessionWorkerCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(stateOverrides: Partial<ManagerWsState> = {}) {
    let state = makeState(stateOverrides)
    const patches: Partial<ManagerWsState>[] = []

    const getState = () => state
    const updateState = (patch: Partial<ManagerWsState>) => {
      state = { ...state, ...patch }
      patches.push(patch)
    }

    let requestResolve: ((result: SessionWorkersResult) => void) | null = null
    let requestReject: ((error: Error) => void) | null = null
    const requestCalls: string[] = []

    const requestSessionWorkers = vi.fn((sessionAgentId: string) => {
      requestCalls.push(sessionAgentId)
      return new Promise<SessionWorkersResult>((resolve, reject) => {
        requestResolve = resolve
        requestReject = reject
      })
    })

    const cache = new SessionWorkerCache({
      getState,
      updateState,
      requestSessionWorkers,
      refetchDebounceMs: 250,
    })

    return {
      cache,
      getState,
      updateState,
      patches,
      requestSessionWorkers,
      requestCalls,
      resolveRequest: (result: SessionWorkersResult) => requestResolve?.(result),
      rejectRequest: (error: Error) => requestReject?.(error),
      setState: (s: ManagerWsState) => { state = s },
    }
  }

  // ---------------------------------------------------------------------------
  // Basic error handling
  // ---------------------------------------------------------------------------

  it('rejects with an error for blank session id', async () => {
    const { cache } = setup()
    await expect(cache.getSessionWorkers('')).rejects.toThrow('Session agent id is required.')
    await expect(cache.getSessionWorkers('  ')).rejects.toThrow('Session agent id is required.')
  })

  // ---------------------------------------------------------------------------
  // Cache hit path
  // ---------------------------------------------------------------------------

  it('returns cached workers without a WS request when loadedSessionIds contains the session', async () => {
    const worker = makeWorker('w1', 'mgr')
    const manager = makeManager('mgr', { workerCount: 1 })

    const { cache, requestSessionWorkers } = setup({
      agents: [manager, worker],
      loadedSessionIds: new Set(['mgr']),
    })

    const result = await cache.getSessionWorkers('mgr')

    expect(result.sessionAgentId).toBe('mgr')
    expect(result.workers).toHaveLength(1)
    expect(result.workers[0].agentId).toBe('w1')
    expect(requestSessionWorkers).not.toHaveBeenCalled()
  })

  it('returns empty workers array for cached session with zero workers', async () => {
    const manager = makeManager('mgr', { workerCount: 0 })

    const { cache, requestSessionWorkers } = setup({
      agents: [manager],
      loadedSessionIds: new Set(['mgr']),
    })

    const result = await cache.getSessionWorkers('mgr')

    expect(result.sessionAgentId).toBe('mgr')
    expect(result.workers).toHaveLength(0)
    expect(requestSessionWorkers).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Worker count mismatch invalidation
  // ---------------------------------------------------------------------------

  it('invalidates cache and dispatches fetch when workerCount mismatches cached workers', async () => {
    const worker = makeWorker('w1', 'mgr')
    const manager = makeManager('mgr', { workerCount: 2 }) // count says 2, but only 1 cached

    const { cache, requestSessionWorkers, resolveRequest, getState } = setup({
      agents: [manager, worker],
      loadedSessionIds: new Set(['mgr']),
    })

    const promise = cache.getSessionWorkers('mgr')

    // Should have invalidated and dispatched a fetch
    expect(requestSessionWorkers).toHaveBeenCalledWith('mgr')
    expect(getState().loadedSessionIds.has('mgr')).toBe(false)

    const w2 = makeWorker('w2', 'mgr')
    resolveRequest({ sessionAgentId: 'mgr', workers: [worker, w2] })

    const result = await promise
    expect(result.workers).toHaveLength(2)
  })

  // ---------------------------------------------------------------------------
  // In-flight de-duplication
  // ---------------------------------------------------------------------------

  it('de-duplicates concurrent requests for the same session', async () => {
    const { cache, requestSessionWorkers, resolveRequest } = setup()

    const p1 = cache.getSessionWorkers('mgr')
    const p2 = cache.getSessionWorkers('mgr')

    // Only one request dispatched
    expect(requestSessionWorkers).toHaveBeenCalledTimes(1)

    resolveRequest({ sessionAgentId: 'mgr', workers: [] })

    const r1 = await p1
    const r2 = await p2
    expect(r1.sessionAgentId).toBe('mgr')
    expect(r2.sessionAgentId).toBe('mgr')
  })

  it('allows a new request after the previous one resolved', async () => {
    const resolvers: Array<(result: SessionWorkersResult) => void> = []

    const requestSessionWorkers = vi.fn(() => {
      return new Promise<SessionWorkersResult>((resolve) => {
        resolvers.push(resolve)
      })
    })

    const cache = new SessionWorkerCache({
      getState: () => makeState(),
      updateState: () => {},
      requestSessionWorkers,
      refetchDebounceMs: 250,
    })

    const p1 = cache.getSessionWorkers('mgr')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(1)

    resolvers[0]({ sessionAgentId: 'mgr', workers: [] })
    await p1

    const p2 = cache.getSessionWorkers('mgr')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(2)

    resolvers[1]({ sessionAgentId: 'mgr', workers: [] })
    await p2

    cache.destroy()
  })

  it('allows a new request after the previous one rejected', async () => {
    const rejecters: Array<(error: Error) => void> = []

    const requestSessionWorkers = vi.fn(() => {
      return new Promise<SessionWorkersResult>((_, reject) => {
        rejecters.push(reject)
      })
    })

    const cache = new SessionWorkerCache({
      getState: () => makeState(),
      updateState: () => {},
      requestSessionWorkers,
      refetchDebounceMs: 250,
    })

    const p1 = cache.getSessionWorkers('mgr')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(1)

    rejecters[0](new Error('boom'))
    await expect(p1).rejects.toThrow('boom')

    const p2 = cache.getSessionWorkers('mgr')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(2)

    rejecters[1](new Error('boom2'))
    await expect(p2).rejects.toThrow('boom2')

    cache.destroy()
  })

  // ---------------------------------------------------------------------------
  // Cleanup on synchronous throw in requestSessionWorkers
  // ---------------------------------------------------------------------------

  it('rejects and cleans up when requestSessionWorkers throws synchronously', async () => {
    const requestSessionWorkers = vi.fn(() => {
      throw new Error('sync boom')
    })

    const cache = new SessionWorkerCache({
      getState: () => makeState(),
      updateState: () => {},
      requestSessionWorkers,
      refetchDebounceMs: 250,
    })

    await expect(cache.getSessionWorkers('mgr')).rejects.toThrow('sync boom')

    // Should not be stuck in de-dupe — the sync throw was converted to a
    // rejected promise without registering in pendingFetches.
    // Subsequent call should attempt a new request.
    await expect(cache.getSessionWorkers('mgr')).rejects.toThrow('sync boom')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(2)

    cache.destroy()
  })

  it('swallows sync requestSessionWorkers throws from debounced refetch (best-effort)', async () => {
    const requestSessionWorkers = vi.fn(() => {
      throw new Error('sync callback boom')
    })

    const cache = new SessionWorkerCache({
      getState: () => makeState(),
      updateState: () => {},
      requestSessionWorkers,
      refetchDebounceMs: 250,
    })

    cache.queueRefetch('mgr')
    vi.advanceTimersByTime(300)

    // Flush microtasks — the sync throw was converted to a rejected promise
    // and swallowed by .catch(() => {}), so no unhandled rejection propagates.
    await vi.advanceTimersByTimeAsync(0)

    expect(requestSessionWorkers).toHaveBeenCalledWith('mgr')

    cache.destroy()
  })

  // ---------------------------------------------------------------------------
  // applySessionWorkersSnapshot
  // ---------------------------------------------------------------------------

  it('applies session workers snapshot to state', () => {
    const manager = makeManager('mgr', { workerCount: 0 })
    const worker = makeWorker('w1', 'mgr')

    const { cache, getState } = setup({
      agents: [manager],
      loadedSessionIds: new Set(),
    })

    cache.applySessionWorkersSnapshot('mgr', [worker])

    const state = getState()
    expect(state.loadedSessionIds.has('mgr')).toBe(true)
    expect(state.agents.some((a) => a.agentId === 'w1')).toBe(true)
  })

  it('replaces existing workers with snapshot workers', () => {
    const manager = makeManager('mgr', { workerCount: 1 })
    const oldWorker = makeWorker('w-old', 'mgr')
    const newWorker = makeWorker('w-new', 'mgr')

    const { cache, getState } = setup({
      agents: [manager, oldWorker],
      loadedSessionIds: new Set(['mgr']),
    })

    cache.applySessionWorkersSnapshot('mgr', [newWorker])

    const state = getState()
    expect(state.agents.some((a) => a.agentId === 'w-old')).toBe(false)
    expect(state.agents.some((a) => a.agentId === 'w-new')).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Debounced refetch — queueRefetch
  // ---------------------------------------------------------------------------

  it('queues a debounced refetch that fires after the debounce interval', () => {
    const { cache, requestSessionWorkers } = setup()

    cache.queueRefetch('mgr')

    // Not fired yet
    expect(requestSessionWorkers).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)

    expect(requestSessionWorkers).toHaveBeenCalledWith('mgr')
  })

  it('coalesces rapid queueRefetch calls into a single refetch', () => {
    const { cache, requestSessionWorkers } = setup()

    cache.queueRefetch('mgr')
    vi.advanceTimersByTime(100)
    cache.queueRefetch('mgr')
    vi.advanceTimersByTime(100)
    cache.queueRefetch('mgr')
    vi.advanceTimersByTime(300)

    // Only one request dispatched (last timer fire)
    expect(requestSessionWorkers).toHaveBeenCalledTimes(1)
  })

  it('maintains independent timers for different sessions', () => {
    const { cache, requestSessionWorkers } = setup()

    cache.queueRefetch('mgr-a')
    cache.queueRefetch('mgr-b')

    vi.advanceTimersByTime(300)

    expect(requestSessionWorkers).toHaveBeenCalledTimes(2)
    expect(requestSessionWorkers).toHaveBeenCalledWith('mgr-a')
    expect(requestSessionWorkers).toHaveBeenCalledWith('mgr-b')
  })

  it('swallows rejections from debounced refetch (best-effort)', async () => {
    const requestSessionWorkers = vi.fn(() =>
      Promise.reject(new Error('disconnected')),
    )

    const cache = new SessionWorkerCache({
      getState: () => makeState(),
      updateState: () => {},
      requestSessionWorkers,
      refetchDebounceMs: 250,
    })

    cache.queueRefetch('mgr')
    vi.advanceTimersByTime(300)

    // Flush microtasks — rejection should not propagate
    await vi.advanceTimersByTimeAsync(0)

    expect(requestSessionWorkers).toHaveBeenCalledWith('mgr')

    cache.destroy()
  })

  it('ignores blank session id in queueRefetch', () => {
    const { cache, requestSessionWorkers } = setup()

    cache.queueRefetch('')
    cache.queueRefetch('  ')
    vi.advanceTimersByTime(500)

    expect(requestSessionWorkers).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // clearQueuedRefetch
  // ---------------------------------------------------------------------------

  it('cancels a queued refetch for a specific session', () => {
    const { cache, requestSessionWorkers } = setup()

    cache.queueRefetch('mgr')
    cache.clearQueuedRefetch('mgr')

    vi.advanceTimersByTime(500)
    expect(requestSessionWorkers).not.toHaveBeenCalled()
  })

  it('does not affect other sessions when clearing a specific refetch', () => {
    const { cache, requestSessionWorkers } = setup()

    cache.queueRefetch('mgr-a')
    cache.queueRefetch('mgr-b')
    cache.clearQueuedRefetch('mgr-a')

    vi.advanceTimersByTime(300)

    expect(requestSessionWorkers).toHaveBeenCalledTimes(1)
    expect(requestSessionWorkers).toHaveBeenCalledWith('mgr-b')
  })

  it('is a no-op for sessions without a queued refetch', () => {
    const { cache } = setup()
    // Should not throw
    cache.clearQueuedRefetch('nonexistent')
  })

  // ---------------------------------------------------------------------------
  // clearQueuedRefetches (all)
  // ---------------------------------------------------------------------------

  it('cancels all queued refetch timers', () => {
    const { cache, requestSessionWorkers } = setup()

    cache.queueRefetch('mgr-a')
    cache.queueRefetch('mgr-b')
    cache.queueRefetch('mgr-c')
    cache.clearQueuedRefetches()

    vi.advanceTimersByTime(500)
    expect(requestSessionWorkers).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // destroy
  // ---------------------------------------------------------------------------

  it('clears all timers and in-flight bookkeeping on destroy', () => {
    const { cache, requestSessionWorkers } = setup()

    cache.queueRefetch('mgr-a')
    cache.queueRefetch('mgr-b')

    cache.destroy()

    vi.advanceTimersByTime(500)
    expect(requestSessionWorkers).not.toHaveBeenCalled()
  })

  it('allows new requests after destroy (no lingering de-dupe)', async () => {
    const resolvers: Array<(result: SessionWorkersResult) => void> = []

    const requestSessionWorkers = vi.fn(() => {
      return new Promise<SessionWorkersResult>((resolve) => {
        resolvers.push(resolve)
      })
    })

    const cache = new SessionWorkerCache({
      getState: () => makeState(),
      updateState: () => {},
      requestSessionWorkers,
      refetchDebounceMs: 250,
    })

    cache.getSessionWorkers('mgr')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(1)

    cache.destroy()

    // After destroy, a new request should go through (no lingering de-dupe)
    cache.getSessionWorkers('mgr')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(2)

    // Clean up
    resolvers.forEach((r) => r({ sessionAgentId: 'mgr', workers: [] }))
  })

  // ---------------------------------------------------------------------------
  // Bounded retry after failed fetches
  // ---------------------------------------------------------------------------

  function setupWithRejectingRequest(retryBaseMs = 1_000) {
    const rejecters: Array<(error: Error) => void> = []
    const resolvers: Array<(result: SessionWorkersResult) => void> = []

    const requestSessionWorkers = vi.fn(() => {
      return new Promise<SessionWorkersResult>((resolve, reject) => {
        resolvers.push(resolve)
        rejecters.push(reject)
      })
    })

    const cache = new SessionWorkerCache({
      getState: () => makeState(),
      updateState: () => {},
      requestSessionWorkers,
      refetchDebounceMs: 250,
      retryBaseMs,
    })

    return { cache, requestSessionWorkers, rejecters, resolvers }
  }

  it('retries a failed fetch with linear backoff, capped at the retry budget', async () => {
    // Regression: a get_session_workers response lost in transit (e.g. dropped
    // by backend backpressure during a large session bootstrap) rejected once
    // and was never retried — no remaining trigger ever refetched, leaving the
    // sidebar/pill worker lists permanently empty.
    const { cache, requestSessionWorkers, rejecters } = setupWithRejectingRequest()

    const p1 = cache.getSessionWorkers('mgr')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(1)
    rejecters[0](new Error('timeout'))
    await expect(p1).rejects.toThrow('timeout')

    // Retry 1 after 1×base
    await vi.advanceTimersByTimeAsync(1_000)
    expect(requestSessionWorkers).toHaveBeenCalledTimes(2)
    rejecters[1](new Error('timeout'))
    await vi.advanceTimersByTimeAsync(0)

    // Retry 2 after 2×base
    await vi.advanceTimersByTimeAsync(2_000)
    expect(requestSessionWorkers).toHaveBeenCalledTimes(3)
    rejecters[2](new Error('timeout'))
    await vi.advanceTimersByTimeAsync(0)

    // Retry 3 after 3×base
    await vi.advanceTimersByTimeAsync(3_000)
    expect(requestSessionWorkers).toHaveBeenCalledTimes(4)
    rejecters[3](new Error('timeout'))
    await vi.advanceTimersByTimeAsync(0)

    // Budget exhausted — no further automatic retries.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requestSessionWorkers).toHaveBeenCalledTimes(4)

    cache.destroy()
  })

  it('resets the retry budget after a successful fetch', async () => {
    const { cache, requestSessionWorkers, rejecters, resolvers } = setupWithRejectingRequest()

    const p1 = cache.getSessionWorkers('mgr')
    rejecters[0](new Error('timeout'))
    await expect(p1).rejects.toThrow('timeout')

    // Retry fires and succeeds.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(requestSessionWorkers).toHaveBeenCalledTimes(2)
    resolvers[1]({ sessionAgentId: 'mgr', workers: [] })
    await vi.advanceTimersByTimeAsync(0)

    // A later failure starts a fresh backoff at 1×base again.
    const p2 = cache.getSessionWorkers('mgr')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(3)
    rejecters[2](new Error('timeout'))
    await expect(p2).rejects.toThrow('timeout')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(requestSessionWorkers).toHaveBeenCalledTimes(4)

    cache.destroy()
  })

  it('requeues sessions with unresolved failed fetches on reconnect', async () => {
    const { cache, requestSessionWorkers, rejecters } = setupWithRejectingRequest()

    const p1 = cache.getSessionWorkers('mgr')
    rejecters[0](new Error('WebSocket disconnected before request completed.'))
    await expect(p1).rejects.toThrow('disconnected')

    // Reconnect: budget cleared, session requeued on the debounce interval.
    cache.retryFailedFetchesAfterReconnect()
    await vi.advanceTimersByTimeAsync(250)
    expect(requestSessionWorkers).toHaveBeenCalledTimes(2)

    cache.destroy()
  })

  it('counts synchronous dispatch failures toward the retry budget and recovers on reconnect', async () => {
    let throwSync = true
    const requestSessionWorkers = vi.fn(() => {
      if (throwSync) {
        throw new Error('WebSocket is reconnecting; command not sent.')
      }
      return Promise.resolve({ sessionAgentId: 'mgr', workers: [] })
    })

    const cache = new SessionWorkerCache({
      getState: () => makeState(),
      updateState: () => {},
      requestSessionWorkers,
      refetchDebounceMs: 250,
      retryBaseMs: 1_000,
    })

    await expect(cache.getSessionWorkers('mgr')).rejects.toThrow('reconnecting')
    expect(requestSessionWorkers).toHaveBeenCalledTimes(1)

    // Socket comes back; the reconnect requeue fetches successfully.
    throwSync = false
    cache.retryFailedFetchesAfterReconnect()
    await vi.advanceTimersByTimeAsync(250)
    expect(requestSessionWorkers).toHaveBeenCalledTimes(2)

    cache.destroy()
  })

  // ---------------------------------------------------------------------------
  // Edge: trims whitespace from session IDs
  // ---------------------------------------------------------------------------

  it('trims whitespace from session agent id', async () => {
    const worker = makeWorker('w1', 'mgr')
    const manager = makeManager('mgr', { workerCount: 1 })

    const { cache, requestSessionWorkers } = setup({
      agents: [manager, worker],
      loadedSessionIds: new Set(['mgr']),
    })

    const result = await cache.getSessionWorkers('  mgr  ')
    expect(result.sessionAgentId).toBe('mgr')
    expect(requestSessionWorkers).not.toHaveBeenCalled()
  })
})
