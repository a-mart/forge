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
import type { CollaborationEndpointTarget } from '../collaboration-connections'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionEntry {
  connectionId: string
  target: CollaborationEndpointTarget
  client: CollabWsClient
  state: CollabWsState
  unsubscribe: () => void
}

export type CollabConnectionManagerListener = () => void

// ---------------------------------------------------------------------------
// CollabConnectionManager
// ---------------------------------------------------------------------------

export class CollabConnectionManager {
  private connections = new Map<string, ConnectionEntry>()
  private _activeConnectionId: string | null = null
  private _activeChannelId: string | null = null
  private readonly listeners = new Set<CollabConnectionManagerListener>()

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
        if (existing.target.wsUrl !== target.wsUrl) {
          // URL changed — recreate
          this.teardownConnection(id)
          this.createConnection(target)
        } else {
          // Metadata-only update (label, etc.)
          existing.target = target
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
      prevEntry.client.setActiveChannel(null)
    }

    // Step 2: Update tracked active state
    this._activeConnectionId = connectionId
    this._activeChannelId = channelId

    // Step 3: Establish new detail subscription
    if (connectionId && channelId) {
      const entry = this.connections.get(connectionId)
      if (entry) {
        entry.client.setActiveChannel(channelId)
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
      entry.unsubscribe()
      entry.client.destroy()
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
    const client = new CollabWsClient(target.wsUrl)

    const entry: ConnectionEntry = {
      connectionId: target.connectionId,
      target,
      client,
      state: client.getState(),
      unsubscribe: () => {},
    }

    // Add to map BEFORE subscribing, so the initial subscribe callback
    // (which fires synchronously) can find the entry.
    this.connections.set(target.connectionId, entry)

    entry.unsubscribe = client.subscribe((nextState) => {
      entry.state = nextState
      this.notify()
    })

    client.start()
  }

  private teardownConnection(connectionId: string): void {
    const entry = this.connections.get(connectionId)
    if (!entry) return

    // Clear active state if this was the active connection
    if (this._activeConnectionId === connectionId) {
      this._activeConnectionId = null
      this._activeChannelId = null
    }

    entry.unsubscribe()
    entry.client.destroy()
    this.connections.delete(connectionId)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
