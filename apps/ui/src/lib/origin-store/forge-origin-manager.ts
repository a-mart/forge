/**
 * ForgeOriginManager (Wave R, SPEC §5.3).
 *
 * Module-level owner of REMOTE origin lifecycle. For every registry
 * connection with `remoteProjectsEnabled`, it drives:
 *
 *   probe `/api/collaboration/status` → version gate → auth probe
 *   `/api/collaboration/me` → origin store transport start
 *
 * The origin STORE is created up front (offline) so the sidebar section can
 * render connection state from origin meta the whole way through — origin
 * meta is the source of truth for remote origin health (never
 * `connection-health-store.ts`, which stays hardcoded to the local pair).
 *
 * Lifecycle rules:
 * - Registry record removed / opt-out → origin destroyed.
 * - Close code 4001 (session invalidated) → transport stops (client-side),
 *   meta flips to `unauthorized`, section renders the sign-in sheet; a
 *   successful sign-in calls {@link ForgeOriginManager.retryOrigin}.
 * - Server protocol version above this client's ceiling → `versionBlocked`
 *   meta; no socket is opened ("update Forge to connect").
 * - Probe network failure → `disconnected` meta + a modest fixed-interval
 *   re-probe while the connection stays managed.
 *
 * The local origin (`LOCAL_ORIGIN_ID`) is never touched by this manager.
 */

import { BUILDER_PROTOCOL_MAX_SUPPORTED } from '@forge/protocol'
import type { CollaborationStatus } from '@forge/protocol'
import {
  cacheCollaborationConnectionCapabilities,
  getCollaborationConnectionOptions,
  subscribeToRegistryChanges,
  type CollaborationEndpointTarget,
} from '@/lib/collaboration-connections'
import { LOCAL_ORIGIN_ID, type OriginId } from './origin-key'
import { originRegistry } from './origin-registry'
import type { OriginStore } from './origin-store'
import type { OriginCurrentUser } from './origin-meta'

const UNREACHABLE_REPROBE_MS = 15_000

interface AuthProbeResponse {
  authenticated?: boolean
  user?: { userId?: string; name?: string; email?: string; role?: string }
}

interface ManagedOrigin {
  connectionId: string
  target: CollaborationEndpointTarget
  abortController: AbortController | null
  reprobeTimer: ReturnType<typeof setTimeout> | null
  /** Monotonic guard: stale async probe results are dropped. */
  generation: number
}

export interface ForgeOriginManagerDeps {
  fetchFn?: typeof fetch
}

export class ForgeOriginManager {
  private readonly managed = new Map<string, ManagedOrigin>()
  private unsubscribeRegistry: (() => void) | null = null
  private started = false
  private readonly fetchFn: typeof fetch

  constructor(deps: ForgeOriginManagerDeps = {}) {
    this.fetchFn = deps.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  }

  /** Begin managing remote origins. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribeRegistry = subscribeToRegistryChanges(() => this.syncFromRegistry())
    this.syncFromRegistry()
  }

  /** Tear everything down (tests / full app teardown). */
  destroy(): void {
    this.unsubscribeRegistry?.()
    this.unsubscribeRegistry = null
    for (const entry of [...this.managed.values()]) {
      this.deactivate(entry.connectionId, { destroyOrigin: true })
    }
    this.managed.clear()
    this.started = false
  }

  /** Currently managed remote origin ids (insertion order). */
  getManagedOriginIds(): OriginId[] {
    return [...this.managed.keys()]
  }

  /**
   * Re-run the probe→auth→connect chain for one origin (sign-in success,
   * manual retry). Recreates the origin store when its previous transport
   * was permanently stopped (a `ManagerWsClient` cannot restart after 4001).
   */
  retryOrigin(connectionId: string): void {
    const entry = this.managed.get(connectionId)
    if (!entry) return
    void this.activate(entry, { forceFreshStore: true })
  }

  /**
   * Reconcile managed origins with the connection registry: remote
   * connections with `remoteProjectsEnabled` are managed; everything else is
   * torn down. Also re-activates entries whose URL changed.
   */
  syncFromRegistry(): void {
    if (!this.started) return

    const targets = getCollaborationConnectionOptions().filter(
      (target) => target.isRemote && !target.virtual && target.remoteProjectsEnabled === true,
    )
    const targetIds = new Set(targets.map((target) => target.connectionId))

    for (const id of [...this.managed.keys()]) {
      if (!targetIds.has(id)) {
        this.deactivate(id, { destroyOrigin: true })
        this.managed.delete(id)
      }
    }

    for (const target of targets) {
      const existing = this.managed.get(target.connectionId)
      if (!existing) {
        const entry: ManagedOrigin = {
          connectionId: target.connectionId,
          target,
          abortController: null,
          reprobeTimer: null,
          generation: 0,
        }
        this.managed.set(target.connectionId, entry)
        void this.activate(entry)
        continue
      }

      const urlChanged =
        existing.target.wsUrl !== target.wsUrl || existing.target.apiBaseUrl !== target.apiBaseUrl
      existing.target = target
      if (urlChanged) {
        void this.activate(existing, { forceFreshStore: true })
        continue
      }

      // Registry-change events double as auth-change notifications (the
      // settings sign-in flow dispatches one on success). Re-probe origins
      // parked in the unauthorized state so a completed sign-in connects
      // without a manual retry.
      const meta = originRegistry.getOrigin(target.connectionId)?.getMetaSnapshot()
      if (meta?.authState === 'unauthorized' && !entryIsProbing(existing)) {
        void this.activate(existing, { forceFreshStore: true })
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async activate(
    entry: ManagedOrigin,
    options: { forceFreshStore?: boolean } = {},
  ): Promise<void> {
    const generation = ++entry.generation
    entry.abortController?.abort()
    const controller = new AbortController()
    entry.abortController = controller
    this.clearReprobeTimer(entry)
    try {
      await this.runActivation(entry, generation, controller, options)
    } finally {
      if (entry.abortController === controller) {
        entry.abortController = null
      }
    }
  }

  private async runActivation(
    entry: ManagedOrigin,
    generation: number,
    controller: AbortController,
    options: { forceFreshStore?: boolean },
  ): Promise<void> {

    // A store whose transport already started cannot be restarted in place —
    // recreate it (snapshot-on-reconnect makes the state loss harmless).
    const existingStore = originRegistry.getOrigin(entry.connectionId)
    if (existingStore && (options.forceFreshStore || existingStore.wsUrl !== entry.target.wsUrl)) {
      originRegistry.destroyOrigin(entry.connectionId)
    }

    const store = originRegistry.createOrigin({
      originId: entry.connectionId,
      wsUrl: entry.target.wsUrl,
      offline: true,
    })
    store.patchMeta({
      connectionStatus: 'connecting',
      authState: 'pending',
      instanceName: store.getMetaSnapshot().instanceName ?? entry.target.label,
      lastError: null,
      versionBlocked: false,
    })

    // ---- 1. Instance handshake ------------------------------------------
    let status: CollaborationStatus
    try {
      const response = await this.fetchFn(
        new URL('/api/collaboration/status', entry.target.apiBaseUrl).toString(),
        { credentials: 'include', signal: controller.signal },
      )
      if (!response.ok) {
        throw new Error(`status probe failed (${response.status})`)
      }
      status = (await response.json()) as CollaborationStatus
    } catch {
      if (this.isStale(entry, generation, controller)) return
      store.patchMeta({
        connectionStatus: 'disconnected',
        lastError: 'Instance unreachable.',
      })
      this.scheduleReprobe(entry)
      return
    }
    if (this.isStale(entry, generation, controller)) return

    const protocolVersion = typeof status.protocolVersion === 'number' ? status.protocolVersion : null
    const capabilities = {
      collab: status.capabilities?.collab ?? status.enabled === true,
      remoteBuild: status.capabilities?.remoteBuild ?? false,
    }
    store.patchMeta({
      capabilities,
      protocolVersion,
      instanceName: typeof status.instanceName === 'string' ? status.instanceName : entry.target.label,
    })
    if (protocolVersion !== null) {
      cacheCollaborationConnectionCapabilities(entry.connectionId, {
        ...capabilities,
        protocolVersion,
      })
    }

    // ---- 2. Version gate -------------------------------------------------
    if (protocolVersion !== null && protocolVersion > BUILDER_PROTOCOL_MAX_SUPPORTED) {
      store.patchMeta({
        connectionStatus: 'disconnected',
        versionBlocked: true,
        lastError: 'This instance requires a newer Forge. Update Forge to connect.',
      })
      return
    }

    if (!capabilities.remoteBuild) {
      store.patchMeta({
        connectionStatus: 'disconnected',
        lastError: 'Remote projects are disabled on this instance.',
      })
      // Instance capabilities can flip server-side; keep probing gently so
      // enabling remote build shows up without a manual retry.
      this.scheduleReprobe(entry)
      return
    }

    // ---- 3. Auth probe ----------------------------------------------------
    let currentUser: OriginCurrentUser | null = null
    try {
      const response = await this.fetchFn(
        new URL('/api/collaboration/me', entry.target.apiBaseUrl).toString(),
        { credentials: 'include', signal: controller.signal },
      )
      if (!response.ok) {
        throw new Error(`auth probe failed (${response.status})`)
      }
      const session = (await response.json()) as AuthProbeResponse
      if (session.authenticated === true && session.user?.userId) {
        currentUser = {
          userId: session.user.userId,
          displayName: session.user.name ?? session.user.email ?? session.user.userId,
          role: session.user.role === 'admin' ? 'admin' : 'member',
        }
      }
    } catch {
      if (this.isStale(entry, generation, controller)) return
      store.patchMeta({
        connectionStatus: 'disconnected',
        lastError: 'Instance unreachable.',
      })
      this.scheduleReprobe(entry)
      return
    }
    if (this.isStale(entry, generation, controller)) return

    if (!currentUser) {
      store.patchMeta({
        connectionStatus: 'disconnected',
        authState: 'unauthorized',
        currentUser: null,
        lastError: null,
      })
      return
    }

    // ---- 4. Connect --------------------------------------------------------
    store.patchMeta({ authState: 'authenticated', currentUser, lastError: null })
    store.getClient().setSessionInvalidatedObserver(() => {
      this.handleSessionInvalidated(entry.connectionId, store)
    })
    store.startTransport()
  }

  private handleSessionInvalidated(connectionId: string, store: OriginStore): void {
    // The client already stopped its transport (4001 is permanent). Keep the
    // store so the section renders the sign-in sheet from meta.
    if (originRegistry.getOrigin(connectionId) !== store) return
    store.patchMeta({
      connectionStatus: 'disconnected',
      authState: 'unauthorized',
      currentUser: null,
    })
  }

  private deactivate(connectionId: string, options: { destroyOrigin: boolean }): void {
    const entry = this.managed.get(connectionId)
    if (entry) {
      entry.abortController?.abort()
      entry.abortController = null
      this.clearReprobeTimer(entry)
      entry.generation += 1
    }

    if (options.destroyOrigin && connectionId !== LOCAL_ORIGIN_ID) {
      originRegistry.destroyOrigin(connectionId)
    }
  }

  private scheduleReprobe(entry: ManagedOrigin): void {
    this.clearReprobeTimer(entry)
    entry.reprobeTimer = setTimeout(() => {
      entry.reprobeTimer = null
      if (this.managed.get(entry.connectionId) === entry) {
        void this.activate(entry)
      }
    }, UNREACHABLE_REPROBE_MS)
  }

  private clearReprobeTimer(entry: ManagedOrigin): void {
    if (entry.reprobeTimer !== null) {
      clearTimeout(entry.reprobeTimer)
      entry.reprobeTimer = null
    }
  }

  private isStale(entry: ManagedOrigin, generation: number, controller: AbortController): boolean {
    return (
      controller.signal.aborted ||
      entry.generation !== generation ||
      this.managed.get(entry.connectionId) !== entry
    )
  }
}

function entryIsProbing(entry: ManagedOrigin): boolean {
  return entry.abortController !== null && !entry.abortController.signal.aborted
}

/** The shared, module-level manager (mirrors `originRegistry`). */
export const forgeOriginManager = new ForgeOriginManager()
