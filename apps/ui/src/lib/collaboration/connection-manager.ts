/**
 * Central multi-connection manager for collaboration backends.
 *
 * Manages one {@link CollabWsClient} per visible/enabled configured
 * connection.  All clients maintain metadata-only subscriptions (workspace,
 * categories, channels, unread counts).  Exactly **one** client at a time
 * may hold an active channel detail subscription (history, messages,
 * workers, activity).
 *
 * Switching the active channel across connections cleanly tears down the
 * old detail subscription (`setActiveChannel(null)`) before establishing
 * the new one — enforcing the "one active detail subscription" invariant.
 *
 * Connection teardown (via {@link removeConnection} or {@link destroy})
 * properly unsubscribes and destroys the client.
 */

import { CollabWsClient } from './ws-client'
import {
  createInitialCollabWsState,
  type CollabWsState,
} from '../collab-ws-state'
import type { CollaborationSessionInfo } from '@forge/protocol'
import type { CollaborationEndpointTarget } from '../collaboration-connections'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionEntry {
  connectionId: string
  target: CollaborationEndpointTarget
  client: CollabWsClient | null
  state: CollabWsState
  unsubscribe: () => void
  authProbeAbortController?: AbortController
  authGateBlocked?: boolean
}

export type CollabConnectionManagerListener = () => void

type AuthProbeResult = 'authenticated' | 'unauthenticated' | 'unknown'

export interface CollabConnectionManagerOptions {
  /**
   * When true, probe /api/collaboration/me before opening a metadata WebSocket.
   * This prevents known-unauthenticated collaboration backends from entering an
   * impossible 401 upgrade/retry loop while keeping the target visible.
   */
  authGateMetadataConnections?: boolean
  authProbe?: (target: CollaborationEndpointTarget, signal: AbortSignal) => Promise<AuthProbeResult>
}

async function defaultAuthProbe(
  target: CollaborationEndpointTarget,
  signal: AbortSignal,
): Promise<AuthProbeResult> {
  const response = await fetch(new URL('/api/collaboration/me', target.apiBaseUrl).toString(), {
    credentials: 'include',
    signal,
  })

  if (!response.ok) {
    return 'unknown'
  }

  const session = (await response.json()) as CollaborationSessionInfo
  if (session.authenticated === true) return 'authenticated'
  if (session.authenticated === false) return 'unauthenticated'
  return 'unknown'
}

function createAuthRequiredState(): CollabWsState {
  return {
    ...createInitialCollabWsState(),
    lastError: 'Sign in to this collaboration backend to connect.',
    lastErrorCode: 'COLLAB_AUTH_REQUIRED',
  }
}

// ---------------------------------------------------------------------------
// CollabConnectionManager
// ---------------------------------------------------------------------------

export class CollabConnectionManager {
  private connections = new Map<string, ConnectionEntry>()
  private _activeConnectionId: string | null = null
  private _activeChannelId: string | null = null
  private readonly listeners = new Set<CollabConnectionManagerListener>()
  private readonly authGateMetadataConnections: boolean
  private readonly authProbe: (target: CollaborationEndpointTarget, signal: AbortSignal) => Promise<AuthProbeResult>

  constructor(options: CollabConnectionManagerOptions = {}) {
    this.authGateMetadataConnections = options.authGateMetadataConnections === true
    this.authProbe = options.authProbe ?? defaultAuthProbe
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  get activeConnectionId(): string | null {
    return this._activeConnectionId
  }

  get activeChannelId(): string | null {
    return this._activeChannelId
  }

  /**
   * Get the state for a specific connection.
   */
  getConnectionState(connectionId: string): CollabWsState | null {
    return this.connections.get(connectionId)?.state ?? null
  }

  /**
   * Get all connection states keyed by connectionId.
   */
  getAllStates(): Record<string, CollabWsState> {
    const result: Record<string, CollabWsState> = {}
    for (const [id, entry] of this.connections) {
      result[id] = entry.state
    }
    return result
  }

  /**
   * Get the connection IDs in insertion order.
   */
  getConnectionIds(): string[] {
    return [...this.connections.keys()]
  }

  /**
   * Get the number of managed connections.
   */
  get size(): number {
    return this.connections.size
  }

  /**
   * Get the active connection's state.
   * Falls back to the first connection's state, then to an initial empty state.
   */
  getActiveState(): CollabWsState {
    if (this._activeConnectionId) {
      const entry = this.connections.get(this._activeConnectionId)
      if (entry) return entry.state
    }

    // Fallback: first available connection (single-backend compat)
    const first = this.connections.values().next()
    if (!first.done) return first.value.state

    return createInitialCollabWsState()
  }

  /**
   * Get the client for a specific connection.
   */
  getClient(connectionId: string): CollabWsClient | null {
    return this.connections.get(connectionId)?.client ?? null
  }

  /**
   * Get the active connection's client.
   */
  getActiveClient(): CollabWsClient | null {
    if (this._activeConnectionId) {
      return this.connections.get(this._activeConnectionId)?.client ?? null
    }

    // Fallback: first available connection (single-backend compat)
    const first = this.connections.values().next()
    if (!first.done) return first.value.client

    return null
  }

  /**
   * Get the target metadata for a specific connection.
   */
  getTarget(connectionId: string): CollaborationEndpointTarget | null {
    return this.connections.get(connectionId)?.target ?? null
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  /**
   * Synchronize the managed connections with the provided targets.
   *
   * - New targets get a client created and started.
   * - Removed targets get their client destroyed.
   * - Existing targets with a changed wsUrl get recreated.
   * - Existing targets with only label/metadata changes are updated in place.
   */
  syncConnections(targets: readonly CollaborationEndpointTarget[]): void {
    const targetMap = new Map(targets.map((t) => [t.connectionId, t]))
    const currentIds = new Set(this.connections.keys())
    const targetIds = new Set(targetMap.keys())

    // Remove connections no longer in targets
    for (const id of currentIds) {
      if (!targetIds.has(id)) {
        this.teardownConnection(id)
      }
    }

    // Add or update connections
    for (const [id, target] of targetMap) {
      const existing = this.connections.get(id)
      if (existing) {
        if (existing.target.wsUrl !== target.wsUrl || existing.target.apiBaseUrl !== target.apiBaseUrl) {
          // URL changed — recreate
          this.teardownConnection(id)
          this.createConnection(target)
        } else {
          // Metadata-only update (label, etc.)
          existing.target = target
          if (existing.authGateBlocked && !existing.authProbeAbortController) {
            this.probeAndConnect(existing)
          }
        }
      } else {
        this.createConnection(target)
      }
    }

    // If the active connection was removed, clear active state
    if (this._activeConnectionId && !this.connections.has(this._activeConnectionId)) {
      this._activeConnectionId = null
      this._activeChannelId = null
    }

    this.notify()
  }

  /**
   * Set the active channel, possibly across connections.
   *
   * Invariants enforced:
   * 1. Old connection's detail subscription is cleared **before**
   *    the new subscription is established.
   * 2. Only one client has a non-null activeChannelId at any time.
   * 3. Passing `connectionId = null` or `channelId = null` clears
   *    the detail subscription entirely.
   */
  setActiveChannel(connectionId: string | null, channelId: string | null): void {
    // No-op guard: skip if nothing actually changed to prevent render loops
    if (this._activeConnectionId === connectionId && this._activeChannelId === channelId) {
      return
    }

    const prevConnectionId = this._activeConnectionId
    const prevEntry = prevConnectionId
      ? this.connections.get(prevConnectionId)
      : null

    // Step 1: Clear old detail subscription if switching connections or clearing
    if (prevEntry && (prevConnectionId !== connectionId || channelId === null)) {
      prevEntry.client?.setActiveChannel(null)
    }

    // Step 2: Update tracked active state
    this._activeConnectionId = connectionId
    this._activeChannelId = channelId

    // Step 3: Establish new detail subscription
    if (connectionId && channelId) {
      const entry = this.connections.get(connectionId)
      if (entry) {
        entry.client?.setActiveChannel(channelId)
      }
    }

    this.notify()
  }

  /**
   * Remove a specific connection and destroy its client.
   * If this was the active connection, active state is cleared.
   */
  removeConnection(connectionId: string): void {
    this.teardownConnection(connectionId)
    this.notify()
  }

  /**
   * Destroy all connections and clean up.
   */
  destroy(): void {
    for (const entry of this.connections.values()) {
      entry.authProbeAbortController?.abort()
      entry.unsubscribe()
      entry.client?.destroy()
    }
    this.connections.clear()
    this._activeConnectionId = null
    this._activeChannelId = null
    this.listeners.clear()
  }

  // -----------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------

  /**
   * Subscribe to manager state changes (any connection's state, or
   * active-connection changes).
   *
   * Returns an unsubscribe function.
   */
  subscribe(listener: CollabConnectionManagerListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private createConnection(target: CollaborationEndpointTarget): void {
    const entry: ConnectionEntry = {
      connectionId: target.connectionId,
      target,
      client: null,
      state: createInitialCollabWsState(),
      unsubscribe: () => {},
    }

    // Add to map before async auth probing/client subscription so the target
    // remains represented even when no WebSocket can be opened yet.
    this.connections.set(target.connectionId, entry)

    if (this.authGateMetadataConnections) {
      this.probeAndConnect(entry)
      return
    }

    this.attachClient(entry)
  }

  private probeAndConnect(entry: ConnectionEntry): void {
    entry.authProbeAbortController?.abort()
    const controller = new AbortController()
    entry.authProbeAbortController = controller
    entry.authGateBlocked = false
    entry.state = createInitialCollabWsState()
    this.notify()

    void this.authProbe(entry.target, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        entry.authProbeAbortController = undefined

        const current = this.connections.get(entry.connectionId)
        if (current !== entry) return

        if (result === 'unauthenticated') {
          entry.authGateBlocked = true
          entry.state = createAuthRequiredState()
          this.notify()
          return
        }

        entry.authGateBlocked = false
        this.attachClient(entry)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        entry.authProbeAbortController = undefined

        const current = this.connections.get(entry.connectionId)
        if (current !== entry) return

        entry.authGateBlocked = false
        this.attachClient(entry)
      })
  }

  private attachClient(entry: ConnectionEntry): void {
    entry.unsubscribe()
    entry.client?.destroy()

    const client = new CollabWsClient(entry.target.wsUrl)
    entry.client = client
    entry.state = client.getState()

    entry.unsubscribe = client.subscribe((nextState) => {
      entry.state = nextState
      this.notify()
    })

    client.start()

    if (this._activeConnectionId === entry.connectionId && this._activeChannelId) {
      client.setActiveChannel(this._activeChannelId)
    }
  }

  private teardownConnection(connectionId: string): void {
    const entry = this.connections.get(connectionId)
    if (!entry) return

    // Clear active state if this was the active connection
    if (this._activeConnectionId === connectionId) {
      this._activeConnectionId = null
      this._activeChannelId = null
    }

    entry.authProbeAbortController?.abort()
    entry.unsubscribe()
    entry.client?.destroy()
    this.connections.delete(connectionId)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
