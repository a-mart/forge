import type { AgentDescriptor } from '@forge/protocol'
import type { ManagerWsState } from '../ws-state'
import type { SessionWorkersResult } from './types'
import {
  SESSION_WORKERS_MAX_FETCH_RETRIES,
  SESSION_WORKERS_REFETCH_DEBOUNCE_MS,
  SESSION_WORKERS_RETRY_BASE_MS,
} from './runtime-types'
import { reduceSessionWorkersSnapshot } from './snapshot-reducers'

export interface SessionWorkerCacheDeps {
  getState: () => ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
  /** Removes local-only state for workers absent from an authoritative roster. */
  onWorkersRemoved?: (agentIds: string[]) => void
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
  private readonly retryBaseMs: number
  private readonly pendingFetches = new Map<string, Promise<SessionWorkersResult>>()
  private readonly refetchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly consecutiveFetchFailures = new Map<string, number>()

  constructor(deps: SessionWorkerCacheDeps & { retryBaseMs?: number }) {
    this.deps = deps
    this.refetchDebounceMs = deps.refetchDebounceMs ?? SESSION_WORKERS_REFETCH_DEBOUNCE_MS
    this.retryBaseMs = deps.retryBaseMs ?? SESSION_WORKERS_RETRY_BASE_MS
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns session workers for the given session, using the in-memory cache
   * when `loadedSessionIds` and current-connection worker metadata cover the
   * session and the cached worker count matches the manager's `workerCount`
   * hint. Otherwise dispatches a new fetch (de-duplicated against any
   * in-flight request for the same session).
   */
  getSessionWorkers(sessionAgentId: string): Promise<SessionWorkersResult> {
    const trimmed = sessionAgentId.trim()
    if (!trimmed) {
      return Promise.reject(new Error('Session agent id is required.'))
    }

    const state = this.deps.getState()

    // Cache-hit path: session was previously loaded, refreshed on this socket,
    // and worker count still matches. A reconnect keeps old rows for UI
    // continuity but must fetch fresh descriptors before classifying telemetry.
    if (state.loadedSessionIds.has(trimmed) && state.workerMetadataSessionIds.has(trimmed)) {
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
      // Synchronous throw = dispatch failed outright (e.g. socket not
      // connected). Count it toward the retry budget so the session is
      // requeued on reconnect.
      this.scheduleRetryAfterFailure(trimmed)
      return Promise.reject(err)
    }
    this.pendingFetches.set(trimmed, request)

    // Clean up in-flight tracking after resolution. A success resets the
    // failure backoff; a failure (timeout, dropped response, disconnect
    // mid-flight) schedules a bounded retry — without it, a single lost
    // response leaves the session's worker list empty with no remaining
    // trigger to refetch it.
    request.then(
      () => {
        this.pendingFetches.delete(trimmed)
        this.consecutiveFetchFailures.delete(trimmed)
      },
      () => {
        this.pendingFetches.delete(trimmed)
        this.scheduleRetryAfterFailure(trimmed)
      },
    )

    return request
  }

  /**
   * Called on transport reconnect: failures accumulated against the old socket
   * no longer predict anything, so clear the backoff — and give every session
   * with an unresolved failed fetch one debounced refetch on the new socket
   * (without it, a fetch lost to a disconnect has no remaining trigger).
   */
  retryFailedFetchesAfterReconnect(): void {
    const failedSessionIds = [...this.consecutiveFetchFailures.keys()]
    this.consecutiveFetchFailures.clear()
    for (const sessionAgentId of failedSessionIds) {
      this.queueRefetch(sessionAgentId)
    }
  }

  /**
   * Applies an authoritative session-workers snapshot to state. Called by
   * the event handler layer when a `session_workers_snapshot` event arrives.
   */
  applySessionWorkersSnapshot(
    sessionAgentId: string,
    workers: AgentDescriptor[],
  ): void {
    const state = this.deps.getState()
    const incomingWorkerIds = new Set(workers.map((worker) => worker.agentId))
    const removedWorkerIds = state.agents
      .filter((agent) => agent.role === 'worker' && agent.managerId === sessionAgentId && !incomingWorkerIds.has(agent.agentId))
      .map((agent) => agent.agentId)
    const result = reduceSessionWorkersSnapshot({
      state,
      sessionAgentId,
      workers,
    })
    this.deps.updateState(result.patch)
    if (removedWorkerIds.length > 0) this.deps.onWorkersRemoved?.(removedWorkerIds)
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

  /**
   * Schedules a bounded, linearly backed-off retry after a failed fetch.
   * Reuses the refetch-timer map so `clearQueuedRefetch(es)`/`destroy` cancel
   * retries too. Gives up after {@link SESSION_WORKERS_MAX_FETCH_RETRIES}
   * consecutive failures (reset by a successful fetch or `resetFailureBackoff`).
   */
  private scheduleRetryAfterFailure(sessionAgentId: string): void {
    const failures = (this.consecutiveFetchFailures.get(sessionAgentId) ?? 0) + 1
    this.consecutiveFetchFailures.set(sessionAgentId, failures)

    if (failures > SESSION_WORKERS_MAX_FETCH_RETRIES) {
      return
    }

    this.clearQueuedRefetch(sessionAgentId)

    const timer = setTimeout(() => {
      this.refetchTimers.delete(sessionAgentId)
      void this.getSessionWorkers(sessionAgentId).catch(() => {
        // Failure re-enters scheduleRetryAfterFailure via the request handler.
      })
    }, failures * this.retryBaseMs)

    this.refetchTimers.set(sessionAgentId, timer)
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
    this.consecutiveFetchFailures.clear()
  }
}
