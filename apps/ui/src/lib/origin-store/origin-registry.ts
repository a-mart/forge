/**
 * Origin store registry (WP-U1, requirement 1).
 *
 * A map of `originId → OriginStore`.  Store create/destroy is an EXPLICIT
 * registry operation driven by connection lifecycle — never constructed inside
 * a React effect (this replaces the `use-ws-connection.ts` construct-in-effect
 * pattern).  Today only the reserved `"local"` origin is created; the registry
 * shape is already multi-origin so Wave R backends plug in without rework.
 *
 * The module exposes a single shared registry (`originRegistry`).  A registry
 * is intentionally tiny state — do not add per-origin domain logic here; that
 * lives in {@link OriginStore}.
 *
 * @see .internal/forge-review-2026-07/97-remote/U1-REQUIREMENTS.md (req. 1)
 */

import { OriginStore, type OriginStoreOptions } from './origin-store'
import type { OriginId } from './origin-key'

type Unsubscribe = () => void

export class OriginRegistry {
  private readonly stores = new Map<OriginId, OriginStore>()
  /** Listeners notified when an origin is added or removed. */
  private readonly listeners = new Set<() => void>()

  /**
   * Create (or return the existing) store for an origin.  Idempotent per
   * `originId`: if a store already exists with the SAME `wsUrl`, it is reused;
   * a create with a different `wsUrl` recreates the store (URL change is a new
   * backend).  Notifies registry listeners on add.
   */
  createOrigin(options: OriginStoreOptions): OriginStore {
    const existing = this.stores.get(options.originId)
    if (existing) {
      if (existing.wsUrl === options.wsUrl) {
        return existing
      }
      // URL changed → tear down and recreate.
      existing.destroy()
      this.stores.delete(options.originId)
    }

    const store = new OriginStore(options)
    this.stores.set(options.originId, store)
    this.notifyRegistry()
    return store
  }

  /** Get the store for an origin, or `undefined` if not created. */
  getOrigin(originId: OriginId): OriginStore | undefined {
    return this.stores.get(originId)
  }

  /** Whether an origin currently has a live store. */
  hasOrigin(originId: OriginId): boolean {
    return this.stores.has(originId)
  }

  /**
   * Destroy and remove an origin's store.  Notifies registry listeners on
   * removal.  Destroying one origin leaves every other origin's store and its
   * subscriptions intact (requirement 10c).
   */
  destroyOrigin(originId: OriginId): void {
    const store = this.stores.get(originId)
    if (!store) return
    store.destroy()
    this.stores.delete(originId)
    this.notifyRegistry()
  }

  /** All currently-live origin ids, in insertion order. */
  getOriginIds(): OriginId[] {
    return [...this.stores.keys()]
  }

  /** All currently-live stores, in insertion order. */
  getStores(): OriginStore[] {
    return [...this.stores.values()]
  }

  /** Subscribe to origin add/remove events (for `useAllOrigins`). */
  subscribeRegistry(listener: () => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Destroy every store (test cleanup / full teardown). */
  destroyAll(): void {
    for (const store of this.stores.values()) {
      store.destroy()
    }
    this.stores.clear()
    this.notifyRegistry()
  }

  private notifyRegistry(): void {
    for (const listener of this.listeners) listener()
  }
}

/** The shared, module-level registry. */
export const originRegistry = new OriginRegistry()
