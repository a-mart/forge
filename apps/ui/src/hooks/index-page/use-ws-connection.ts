import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  LOCAL_ORIGIN_ID,
  originRegistry,
  useOriginSnapshot,
} from '@/lib/origin-store'

/**
 * Builder's connection to the local origin store (WP-U1).
 *
 * The `ManagerWsClient` is no longer constructed inside an effect.  Instead the
 * reserved `"local"` origin is created as an EXPLICIT registry operation keyed
 * on `wsUrl` (requirement 1 — replaces the construct-in-effect pattern), and
 * this component reads the origin's snapshot via `useSyncExternalStore`.  The
 * returned shape (`clientRef` / `state` / `setState`) is unchanged so existing
 * consumers (BuilderSurface, `use-manager-actions`) keep working while lower-
 * traffic surfaces continue to read the whole snapshot as a compatibility shim.
 *
 * Higher-churn surfaces (sidebar tree/counts, transcript, chat header) should
 * subscribe to their own slices via `useOriginSlice(LOCAL_ORIGIN_ID, …)` rather
 * than re-render through this whole-snapshot read.
 */
export function useWsConnection(wsUrl: string): {
  clientRef: MutableRefObject<ManagerWsClient | null>
  /** Per-origin target-aware HTTP client (requirement 9). */
  httpClientRef: MutableRefObject<SettingsApiClient | null>
  state: ManagerWsState
  setState: Dispatch<SetStateAction<ManagerWsState>>
} {
  // Lazily ensure the local origin store exists for this wsUrl.  Creating it
  // during render (ref-guarded) keeps the client live before the first
  // snapshot read — the React-recommended lazy-init pattern, mirroring
  // `use-collab-connections.ts`.
  const store = originRegistry.createOrigin({ originId: LOCAL_ORIGIN_ID, wsUrl })

  // Lazy-init the refs from the (stable-per-wsUrl) store so consumers have a
  // live client on the first render; the effect below keeps them fresh if the
  // store is recreated on a wsUrl change.
  const clientRef = useRef<ManagerWsClient | null>(store.getClient())
  const httpClientRef = useRef<SettingsApiClient | null>(store.getHttpClient())

  const state = useOriginSnapshot(LOCAL_ORIGIN_ID)

  // Keep the refs pointed at the current store's client/http facades (updated
  // in an effect, not during render) and tear the local origin down when the
  // surface unmounts or the backend URL changes.  Lifecycle-driven teardown
  // (requirement 1), not GC-by-effect.
  useEffect(() => {
    clientRef.current = store.getClient()
    httpClientRef.current = store.getHttpClient()
    return () => {
      // Only destroy if this wsUrl is still the live one — a URL change already
      // recreated the store under createOrigin, and destroying then would kill
      // the fresh connection.
      const current = originRegistry.getOrigin(LOCAL_ORIGIN_ID)
      if (current && current.wsUrl === wsUrl) {
        originRegistry.destroyOrigin(LOCAL_ORIGIN_ID)
      }
    }
  }, [store, wsUrl])

  // Compatibility `setState`: apply a React-style updater against the current
  // local-origin snapshot and ingest the result as a snapshot patch.  Existing
  // call sites use this only for local UI fields (lastError / lastSuccess /
  // terminals); optimistic domain mutations go through the client facade.
  const setState = useCallback<Dispatch<SetStateAction<ManagerWsState>>>((update) => {
    const target = originRegistry.getOrigin(LOCAL_ORIGIN_ID)
    if (!target) return
    const previous = target.getSnapshot()
    const next =
      typeof update === 'function'
        ? (update as (prev: ManagerWsState) => ManagerWsState)(previous)
        : update
    if (next === previous) return
    target.ingest({ type: 'snapshot', state: next })
  }, [])

  return useMemo(
    () => ({ clientRef, httpClientRef, state, setState }),
    [clientRef, httpClientRef, state, setState],
  )
}
