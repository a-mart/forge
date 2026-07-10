/**
 * React hooks over the origin store (WP-U1, requirements 2 & 3).
 *
 * `useOriginSlice(originId, selector, equalityFn?)` subscribes a component to a
 * single slice of one origin's state via `useSyncExternalStore`.  Notifications
 * are per (origin, selector): the store only wakes this subscriber when the
 * selected value changes, and an event on origin A never wakes origin B (they
 * are separate store instances).  This is the fix for the whole-snapshot
 * re-render; the `use-collab-connections.ts` `forceRender` fan-out is the
 * explicit anti-goal.
 *
 * The selector+equality memoization is a hand-rolled
 * `useSyncExternalStoreWithSelector` (React 19 ships only the base
 * `useSyncExternalStore`; we avoid adding the shim dependency for a few lines).
 *
 * @see apps/ui/src/lib/connection-health-store.ts (precedent)
 * @see .internal/forge-review-2026-07/97-remote/U1-REQUIREMENTS.md (req. 2, 3)
 */

import { useCallback, useDebugValue, useRef, useSyncExternalStore } from 'react'
import type { ManagerWsState } from '@/lib/ws-state'
import { originRegistry } from './origin-registry'
import type { OriginSelector } from './origin-store'
import type { OriginMetaState } from './origin-meta'
import { compositeKey, type OriginId } from './origin-key'

type Unsubscribe = () => void

/**
 * Subscribe `onStoreChange` to a store-level source that may not exist yet.
 *
 * `useSyncExternalStore` does not re-invoke `subscribe` on its own, so a naive
 * "subscribe to the slice if the store exists" closure would permanently miss
 * slice notifications for a component that mounted BEFORE its origin was
 * created.  This helper subscribes to the registry once and (re)attaches the
 * store-level subscription (`attach`) every time the set of origins changes —
 * so the subscription self-heals across origin create/destroy regardless of
 * mount order.
 */
function subscribeViaRegistry(
  onStoreChange: () => void,
  attach: (onStoreChange: () => void) => Unsubscribe,
): Unsubscribe {
  let detach: Unsubscribe = attach(onStoreChange)
  const registryUnsub = originRegistry.subscribeRegistry(() => {
    // The origin set changed — reattach so we start/stop tracking the store,
    // then notify so the consumer re-reads via getSnapshot.
    detach()
    detach = attach(onStoreChange)
    onStoreChange()
  })
  return () => {
    detach()
    registryUnsub()
  }
}

const NO_STORE_UNSUB: Unsubscribe = () => {}

/**
 * A stable string key identifying a selector, so two components using the same
 * logical slice share the store's memoized selection.  Callers pass an
 * explicit key; when omitted we fall back to the selector's identity (fine for
 * module-level selector constants).
 */
function selectorKeyFor(originId: OriginId, key: string): string {
  return compositeKey(originId, key)
}

let anonymousSelectorSeq = 0
const anonymousSelectorKeys = new WeakMap<object, string>()

function resolveSelectorKey<T>(
  originId: OriginId,
  selector: OriginSelector<T>,
  explicitKey: string | undefined,
): string {
  if (explicitKey) return selectorKeyFor(originId, explicitKey)
  let key = anonymousSelectorKeys.get(selector)
  if (!key) {
    key = `anon:${anonymousSelectorSeq++}`
    anonymousSelectorKeys.set(selector, key)
  }
  return selectorKeyFor(originId, key)
}

export interface UseOriginSliceOptions<T> {
  /**
   * Stable key sharing this slice's memoized selection across components.
   * Strongly recommended for object-returning selectors defined inline.
   */
  selectorKey?: string
  /** Value equality; defaults to `Object.is`.  Use a shallow compare for objects. */
  equalityFn?: (a: T, b: T) => boolean
}

/**
 * Subscribe to a slice of `originId`'s state.  Returns a default value derived
 * from the initial state when the origin is not (yet) in the registry, so
 * consumers can render before the connection is created.
 */
export function useOriginSlice<T>(
  originId: OriginId,
  selector: OriginSelector<T>,
  options: UseOriginSliceOptions<T> = {},
): T {
  const equalityFn = options.equalityFn ?? Object.is
  const selectorKey = resolveSelectorKey(originId, selector, options.selectorKey)

  // Cache the last selected value so getSnapshot returns a stable reference for
  // object selectors whose contents are unchanged (tear-free + no render loop).
  const cacheRef = useRef<{ value: T; has: boolean }>({ value: undefined as unknown as T, has: false })

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeViaRegistry(onStoreChange, (cb) => {
        const store = originRegistry.getOrigin(originId)
        return store ? store.subscribeSlice(selectorKey, selector, cb, equalityFn) : NO_STORE_UNSUB
      }),
    [originId, selectorKey, selector, equalityFn],
  )

  const getSnapshot = useCallback((): T => {
    const store = originRegistry.getOrigin(originId)
    const next = store ? store.readSlice(selector) : selector(EMPTY_STATE)
    const cache = cacheRef.current
    if (cache.has && equalityFn(cache.value, next)) {
      return cache.value
    }
    cache.value = next
    cache.has = true
    return next
  }, [originId, selector, equalityFn])

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useDebugValue(value)
  return value
}

/**
 * Subscribe to the whole domain snapshot of one origin.  Compatibility path for
 * surfaces not yet decomposed into slices (e.g. BuilderSurface today) — routes
 * their reads through the registry without per-slice granularity.
 */
export function useOriginSnapshot(originId: OriginId): ManagerWsState {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeViaRegistry(onStoreChange, (cb) => {
        const store = originRegistry.getOrigin(originId)
        return store
          ? store.subscribeSlice(compositeKey(originId, '__snapshot__'), identitySelector, cb, Object.is)
          : NO_STORE_UNSUB
      }),
    [originId],
  )

  const getSnapshot = useCallback((): ManagerWsState => {
    return originRegistry.getOrigin(originId)?.getSnapshot() ?? EMPTY_STATE
  }, [originId])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Subscribe to one origin's meta slice (requirement 5). */
export function useOriginMeta(originId: OriginId): OriginMetaState | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeViaRegistry(onStoreChange, (cb) => {
        const store = originRegistry.getOrigin(originId)
        return store ? store.subscribeMeta(cb) : NO_STORE_UNSUB
      }),
    [originId],
  )

  const getSnapshot = useCallback(
    (): OriginMetaState | null => originRegistry.getOrigin(originId)?.getMetaSnapshot() ?? null,
    [originId],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export interface OriginSliceResult<T> {
  originId: OriginId
  value: T
}

/**
 * Cross-origin composition (requirement 3): subscribe narrowly to `selector`
 * across ALL live origins and return per-origin results.  Single-origin today
 * is the one-entry case.  Re-subscribes when origins are added/removed.
 *
 * Note: this hook re-runs the selector for every origin on any subscribed
 * change; it is intended for sidebar/global surfaces (bounded origin count),
 * not hot per-event slices.
 */
export function useAllOrigins<T>(
  selector: OriginSelector<T>,
  options: { selectorKey?: string; equalityFn?: (a: T, b: T) => boolean } = {},
): OriginSliceResult<T>[] {
  const equalityFn = options.equalityFn ?? Object.is
  const baseKey = options.selectorKey ?? getAnonymousKey(selector)
  const cacheRef = useRef<OriginSliceResult<T>[]>([])

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeViaRegistry(onStoreChange, (cb) => {
        // Attach to every currently-live store; re-run on registry changes so
        // stores added after mount are tracked and removed ones are dropped.
        const sliceUnsubs = originRegistry.getStores().map((store) =>
          store.subscribeSlice(compositeKey(store.originId, baseKey), selector, cb, equalityFn),
        )
        return () => {
          for (const unsub of sliceUnsubs) unsub()
        }
      }),
    [baseKey, selector, equalityFn],
  )

  const getSnapshot = useCallback((): OriginSliceResult<T>[] => {
    const stores = originRegistry.getStores()
    const next = stores.map((store) => ({ originId: store.originId, value: store.readSlice(selector) }))
    // Preserve array + element identity when nothing changed so consumers that
    // depend on the returned array do not re-render spuriously.
    const prev = cacheRef.current
    if (
      prev.length === next.length &&
      next.every((entry, index) =>
        prev[index]?.originId === entry.originId && equalityFn(prev[index]!.value, entry.value),
      )
    ) {
      return prev
    }
    cacheRef.current = next
    return next
  }, [selector, equalityFn])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const identitySelector: OriginSelector<ManagerWsState> = (state) => state

/**
 * A frozen empty state used when a component reads a slice before its origin's
 * store exists.  Reused so identity is stable across renders.
 */
import { createInitialManagerWsState } from '@/lib/ws-state'
const EMPTY_STATE: ManagerWsState = createInitialManagerWsState(null)

let anonSeq = 0
const anonKeys = new WeakMap<object, string>()
function getAnonymousKey(selector: object): string {
  let key = anonKeys.get(selector)
  if (!key) {
    key = `all-anon:${anonSeq++}`
    anonKeys.set(selector, key)
  }
  return key
}
