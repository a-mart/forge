import type { AgentDescriptor } from '@forge/protocol'
import type { ManagerWsState } from '../ws-state'
import type { SessionWorkersResult } from './types'
import { SESSION_WORKERS_REFETCH_DEBOUNCE_MS } from './runtime-types'
import { reduceSessionWorkersSnapshot } from './snapshot-reducers'

export interface SessionWorkerCacheDeps {
  getState: () => ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
  /**
   * Callback that issues a `get_session_workers` request over the WebSocket.
   * The cache never owns or imports a socket — transport remains in ManagerWsClient.
   */
  requestSessionWorkers: (sessionAgentId: string) => Promise<SessionWorkersResult>
  /** Overridable debounce interval for testing. */
  refetchDebounceMs?: number
}

/**
 * Encapsulates the session-worker caching, de-duplication, and debounced-refetch
 * logic previously inline in `ManagerWsClient`.
 *
 * **Socket ownership**: This class never imports or touches WebSocket transport,
 * does not send commands directly, and has no awareness of request IDs or
 * dispatch mechanics. The injected `requestSessionWorkers` callback is the sole
 * transport surface.
 *
 * **State contract**: `loadedSessionIds` remains in `ManagerWsState` and is read
 * via `getState()` / mutated via `updateState()`. The cache keeps its own
 * in-flight promise map and debounce-timer map as private bookkeeping.
 */
export class SessionWorkerCache {
  private readonly deps: SessionWorkerCacheDeps
  private readonly refetchDebounceMs: number
  private readonly pendingFetches = new Map<string, Promise<SessionWorkersResult>>()
  private readonly refetchTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(deps: SessionWorkerCacheDeps) {
    this.deps = deps
    this.refetchDebounceMs = deps.refetchDebounceMs ?? SESSION_WORKERS_REFETCH_DEBOUNCE_MS
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns session workers for the given session, using the in-memory cache
   * when `loadedSessionIds` covers the session and the cached worker count
   * matches the manager's `workerCount` hint. Otherwise dispatches a new fetch
   * (de-duplicated against any in-flight request for the same session).
   */
  getSessionWorkers(sessionAgentId: string): Promise<SessionWorkersResult> {
    const trimmed = sessionAgentId.trim()
    if (!trimmed) {
      return Promise.reject(new Error('Session agent id is required.'))
    }

    const state = this.deps.getState()

    // Cache-hit path: session was previously loaded and worker count still matches.
    if (state.loadedSessionIds.has(trimmed)) {
      const cachedWorkers = state.agents.filter(
        (agent) => agent.role === 'worker' && agent.managerId === trimmed,
      )
      const manager = state.agents.find(
        (agent) => agent.role === 'manager' && agent.agentId === trimmed,
      )

      if (manager?.workerCount !== undefined && cachedWorkers.length !== manager.workerCount) {
        // Worker count mismatch — invalidate and fall through to fetch.
        const nextLoadedSessionIds = new Set(state.loadedSessionIds)
        nextLoadedSessionIds.delete(trimmed)
        this.deps.updateState({ loadedSessionIds: nextLoadedSessionIds })
      } else {
        return Promise.resolve({
          sessionAgentId: trimmed,
          workers: cachedWorkers,
        })
      }
    }

    // De-duplicate against in-flight request.
    const existing = this.pendingFetches.get(trimmed)
    if (existing) {
      return existing
    }

    // Dispatch a fresh fetch via the injected callback.
    // Wrap in try/catch to convert synchronous callback throws into rejected
    // promises, preserving the async contract for all callers (including
    // debounced refetch which relies on `.catch()`).
    let request: Promise<SessionWorkersResult>
    try {
      request = this.deps.requestSessionWorkers(trimmed)
    } catch (err) {
      return Promise.reject(err)
    }
    this.pendingFetches.set(trimmed, request)

    // Clean up in-flight tracking after resolution (success or failure).
    const cleanup = () => {
      this.pendingFetches.delete(trimmed)
    }
    request.then(cleanup, cleanup)

    return request
  }

  /**
   * Applies an authoritative session-workers snapshot to state. Called by
   * the event handler layer when a `session_workers_snapshot` event arrives.
   */
  applySessionWorkersSnapshot(
    sessionAgentId: string,
    workers: AgentDescriptor[],
  ): void {
    const result = reduceSessionWorkersSnapshot({
      state: this.deps.getState(),
      sessionAgentId,
      workers,
    })
    this.deps.updateState(result.patch)
  }

  /**
   * Queues a debounced refetch for the given session. Coalesces rapid
   * invalidations (e.g., multiple `agent_status` events for the same manager)
   * into a single refetch after the debounce window.
   */
  queueRefetch(sessionAgentId: string): void {
    const trimmed = sessionAgentId.trim()
    if (!trimmed) return

    this.clearQueuedRefetch(trimmed)

    const timer = setTimeout(() => {
      this.refetchTimers.delete(trimmed)
      void this.getSessionWorkers(trimmed).catch(() => {
        // Best-effort refresh to keep worker cache in sync after session invalidation.
      })
    }, this.refetchDebounceMs)

    this.refetchTimers.set(trimmed, timer)
  }

  /** Cancels a queued refetch for a specific session, if any. */
  clearQueuedRefetch(sessionAgentId: string): void {
    const trimmed = sessionAgentId.trim()
    if (!trimmed) return

    const timer = this.refetchTimers.get(trimmed)
    if (timer) {
      clearTimeout(timer)
      this.refetchTimers.delete(trimmed)
    }
  }

  /** Cancels all queued refetch timers. */
  clearQueuedRefetches(): void {
    for (const timer of this.refetchTimers.values()) {
      clearTimeout(timer)
    }
    this.refetchTimers.clear()
  }

  /** Tears down all timers and in-flight bookkeeping. */
  destroy(): void {
    this.clearQueuedRefetches()
    this.pendingFetches.clear()
  }
}
