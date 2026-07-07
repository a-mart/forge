/**
 * Per-origin selector store (WP-U1).
 *
 * Wraps ONE {@link ManagerWsClient} — the existing transport + event reducer —
 * and adds a per-(origin, selector) notification layer on top of the client's
 * whole-state `subscribe`.  This is the fix for the whole-snapshot re-render
 * finding: today every WS event replaces `ManagerWsState` and notifies every
 * React consumer (`ws-client.ts` `updateState`), so a worker-status tick
 * re-renders sidebar + transcript + header.  Here, a subscriber registers under
 * a `selectorKey`; on each state change the store recomputes only the selectors
 * that currently have subscribers and notifies only the sets whose selected
 * value identity changed.
 *
 * Origin isolation is structural: each origin has its own `OriginStore`
 * instance with its own client and its own listener sets, so an event on origin
 * A can never wake origin B's subscribers.  Within an origin, per-selector
 * memoization means a slice whose value is unchanged is not notified.
 *
 * Ingestion is transport-agnostic (requirement 7): {@link ingest} hydrates the
 * store from a `snapshot` or a single `event` with no socket, no `window`, and
 * no reload side effects. A reconnect re-hydrates WS state in place (the client
 * re-subscribes on transport open) rather than reloading the page.
 *
 * @see .internal/forge-review-2026-07/97-remote/U1-REQUIREMENTS.md
 * @see apps/ui/src/lib/connection-health-store.ts (useSyncExternalStore precedent)
 */

import type { ServerEvent } from '@forge/protocol'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import { handleConversationEvent } from '@/lib/ws-client/event-handlers/conversation-event-handlers'
import { createBuilderSettingsApiClient, type SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  createSettingsApiClient,
} from '@/components/settings/settings-api-client'
import { createCollabSettingsTarget } from '@/components/settings/settings-target'
import {
  createInitialOriginMetaState,
  type OriginMetaState,
} from './origin-meta'
import { LOCAL_ORIGIN_ID, type OriginId } from './origin-key'

/** A pure selector over an origin's domain state. */
export type OriginSelector<T> = (state: ManagerWsState) => T

type Unsubscribe = () => void

/**
 * A registered per-selector subscription.  We memoize the last selected value
 * so we only notify when the value identity (per `equalityFn`) changes.
 */
interface SliceSubscription<T = unknown> {
  selector: OriginSelector<T>
  equalityFn: (a: T, b: T) => boolean
  lastValue: T
  listeners: Set<() => void>
}

export interface OriginStoreOptions {
  originId: OriginId
  /** WebSocket URL for this origin's backend. */
  wsUrl: string
  /**
   * Optional explicit HTTP client factory (Wave R remote origins pass a
   * credentialed collab client).  When omitted, a same-origin Builder client
   * derived from `wsUrl` is used.
   */
  httpClient?: SettingsApiClient
  /**
   * When `true`, do NOT start a live WebSocket connection.  Used by tests and
   * by transport-agnostic ingestion so a second origin can be exercised with
   * no real socket.  Defaults to `false`.
   */
  offline?: boolean
}

export class OriginStore {
  readonly originId: OriginId
  readonly wsUrl: string

  private readonly client: ManagerWsClient
  private readonly httpClient: SettingsApiClient

  private state: ManagerWsState
  private meta: OriginMetaState

  /** Per-selector-key subscriptions (domain slices). */
  private readonly slices = new Map<string, SliceSubscription>()
  /** Meta-slice listeners (separate from domain state). */
  private readonly metaListeners = new Set<() => void>()

  private readonly detachClient: Unsubscribe
  private transportStarted = false

  constructor(options: OriginStoreOptions) {
    this.originId = options.originId
    this.wsUrl = options.wsUrl

    this.client = new ManagerWsClient(options.wsUrl, null)
    this.state = this.client.getState()
    this.meta = createInitialOriginMetaState()

    this.httpClient = options.httpClient ?? defaultHttpClientFor(options)

    // Bridge the client's whole-state notifications into the per-slice layer.
    // The client remains the single source of `ManagerWsState`; the store only
    // fans changes out to the subscribers whose selected value actually moved.
    this.detachClient = this.client.subscribe((next) => {
      this.applyState(next)
    })

    if (!options.offline) {
      this.startTransport()
    }
  }

  /**
   * Open the live WebSocket for this origin. Idempotent. Wave R remote
   * origins are created with `offline: true` so the section (meta) renders
   * while the handshake/auth probe runs; the origin manager calls this once
   * the origin is authenticated and version-compatible.
   */
  startTransport(): void {
    if (this.transportStarted) return
    this.transportStarted = true
    this.patchMeta({ connectionStatus: 'connecting' })
    this.client.start()
  }

  /** Whether {@link startTransport} has been called on this store. */
  hasStartedTransport(): boolean {
    return this.transportStarted
  }

  // -----------------------------------------------------------------------
  // Snapshots
  // -----------------------------------------------------------------------

  /** Current domain snapshot (stable identity between changes). */
  getSnapshot(): ManagerWsState {
    return this.state
  }

  /** Current meta snapshot (stable identity between changes). */
  getMetaSnapshot(): OriginMetaState {
    return this.meta
  }

  // -----------------------------------------------------------------------
  // Command / request facade (requirement 6) + HTTP (requirement 9)
  // -----------------------------------------------------------------------

  /**
   * The command/request facade for this origin.  Optimistic patches applied by
   * client methods land only on this origin's store.  Per-client internals
   * (RequestDispatcher / BootstrapBuffer / SessionWorkerCache) stay per-client.
   */
  getClient(): ManagerWsClient {
    return this.client
  }

  /**
   * Per-origin target-aware HTTP client (requirement 9).  Local origin →
   * same-origin Builder client; remote → credentialed collab client.  Feature
   * APIs take this client, never a raw `wsUrl`.
   */
  getHttpClient(): SettingsApiClient {
    return this.httpClient
  }

  // -----------------------------------------------------------------------
  // Subscriptions — per (origin, selector)
  // -----------------------------------------------------------------------

  /**
   * Subscribe to a domain slice under a caller-provided `selectorKey`.  Two
   * subscribers sharing a key share one memoized selection (so equal selectors
   * do not each recompute).  The listener fires only when the selected value's
   * identity changes per `equalityFn` (default `Object.is`).
   */
  subscribeSlice<T>(
    selectorKey: string,
    selector: OriginSelector<T>,
    listener: () => void,
    equalityFn: (a: T, b: T) => boolean = Object.is,
  ): Unsubscribe {
    let entry = this.slices.get(selectorKey) as SliceSubscription<T> | undefined
    if (!entry) {
      entry = {
        selector,
        equalityFn: equalityFn as (a: T, b: T) => boolean,
        lastValue: selector(this.state),
        listeners: new Set(),
      }
      this.slices.set(selectorKey, entry as SliceSubscription)
    }
    entry.listeners.add(listener)

    return () => {
      const current = this.slices.get(selectorKey)
      if (!current) return
      current.listeners.delete(listener)
      if (current.listeners.size === 0) {
        this.slices.delete(selectorKey)
      }
    }
  }

  /** Read a slice's current value (for `useSyncExternalStore` getSnapshot). */
  readSlice<T>(selector: OriginSelector<T>): T {
    return selector(this.state)
  }

  /** Subscribe to the origin meta slice (requirement 5). */
  subscribeMeta(listener: () => void): Unsubscribe {
    this.metaListeners.add(listener)
    return () => {
      this.metaListeners.delete(listener)
    }
  }

  // -----------------------------------------------------------------------
  // Transport-agnostic ingestion (requirement 7)
  // -----------------------------------------------------------------------

  /**
   * Hydrate the store from a `snapshot` or a single domain `event` with no
   * socket.  Used by tests and by non-WebSocket transports (Wave R).  This
   * routes conversation-family events through the SAME pure reducer the live
   * client uses (`handleConversationEvent`), so id-keyed bootstrap-merge
   * behavior stays in one place (see Coordination-with-WP-P1 in the store dir
   * README).  There is no `window` access and no reload side effect here.
   */
  ingest(input: { type: 'snapshot'; state: Partial<ManagerWsState> } | { type: 'event'; event: ServerEvent }): void {
    if (input.type === 'snapshot') {
      this.applyState({ ...this.state, ...input.state })
      return
    }

    // Route the event through the shared conversation reducer with an
    // origin-scoped context.  Non-conversation events are ignored by the
    // reducer (returns false) — the live path handles those via the client.
    handleConversationEvent(input.event, {
      state: this.state,
      updateState: (patch) => this.applyState({ ...this.state, ...patch }),
    })
  }

  /** Write the origin meta slice (connection manager / Wave R auth). */
  patchMeta(patch: Partial<OriginMetaState>): void {
    const next = { ...this.meta, ...patch }
    this.meta = next
    for (const listener of this.metaListeners) listener()
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  destroy(): void {
    this.detachClient()
    this.client.destroy()
    this.slices.clear()
    this.metaListeners.clear()
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Adopt a new whole-state object and notify only the slices whose selected
   * value moved.  Mirrors the connection status into the meta slice from the
   * domain `connected` flag so meta subscribers see connect/disconnect without
   * the connection manager wiring (local origin convenience).
   */
  private applyState(next: ManagerWsState): void {
    if (next === this.state) return
    const previous = this.state
    this.state = next

    for (const entry of this.slices.values()) {
      const value = entry.selector(next)
      if (!entry.equalityFn(entry.lastValue, value)) {
        entry.lastValue = value
        for (const listener of entry.listeners) listener()
      }
    }

    if (previous.connected !== next.connected) {
      this.patchMeta({
        connectionStatus: next.connected ? 'connected' : 'reconnecting',
        lastError: next.connected ? null : this.meta.lastError,
      })
    }
  }
}

/**
 * Default per-origin HTTP client: same-origin Builder client for the local
 * origin, credentialed collab client for anything else (Wave R).
 */
function defaultHttpClientFor(options: OriginStoreOptions): SettingsApiClient {
  if (options.originId === LOCAL_ORIGIN_ID) {
    return createBuilderSettingsApiClient(options.wsUrl)
  }
  return createSettingsApiClient(createCollabSettingsTarget(options.wsUrl))
}
