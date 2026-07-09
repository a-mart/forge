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
  type OriginId,
} from '@/lib/origin-store'

/**
 * Origin-parameterized builder connection (Wave R, SPEC §5.4).
 *
 * Generalizes `useWsConnection` from "the local origin" to "the ACTIVE
 * origin": the transcript/chat surface reads whichever origin the route
 * selects while the LOCAL origin stays alive underneath (the sidebar renders
 * every origin simultaneously).
 *
 * Lifecycle ownership differs by origin kind:
 * - LOCAL: created here (lazily, keyed on `wsUrl`) and destroyed on unmount —
 *   identical to `useWsConnection`, including the identity-guarded teardown.
 * - REMOTE: owned by `ForgeOriginManager` (probe → auth → connect). This hook
 *   only LOOKS UP remote stores; when the active remote origin has no store
 *   yet, consumers see the frozen empty state until the manager creates it
 *   (the registry-driven subscription self-heals — WP-U1 requirement 10).
 */
export function useOriginConnection(
  activeOriginId: OriginId,
  localWsUrl: string,
): {
  clientRef: MutableRefObject<ManagerWsClient | null>
  httpClientRef: MutableRefObject<SettingsApiClient | null>
  state: ManagerWsState
  setState: Dispatch<SetStateAction<ManagerWsState>>
} {
  // Always ensure the local origin exists (render-lazy, ref-guarded — the
  // established pattern from useWsConnection). Remote origins are never
  // created here.
  const localStore = originRegistry.createOrigin({
    originId: LOCAL_ORIGIN_ID,
    wsUrl: localWsUrl,
  })

  const activeStore =
    activeOriginId === LOCAL_ORIGIN_ID
      ? localStore
      : originRegistry.getOrigin(activeOriginId) ?? null

  const clientRef = useRef<ManagerWsClient | null>(activeStore?.getClient() ?? null)
  const httpClientRef = useRef<SettingsApiClient | null>(activeStore?.getHttpClient() ?? null)

  const state = useOriginSnapshot(activeOriginId)

  // Local-origin teardown, identical guards to useWsConnection: keyed on the
  // store identity, cleanup only destroys the origin it created.
  useEffect(() => {
    return () => {
      const current = originRegistry.getOrigin(LOCAL_ORIGIN_ID)
      if (current === localStore) {
        originRegistry.destroyOrigin(LOCAL_ORIGIN_ID)
      }
    }
  }, [localStore])

  // Keep the refs pointed at the ACTIVE origin's facades. Runs before other
  // effects in the consuming component (hook call order), so downstream
  // effects observe the switched client on the same commit.
  useEffect(() => {
    clientRef.current = activeStore?.getClient() ?? null
    httpClientRef.current = activeStore?.getHttpClient() ?? null
  }, [activeStore])

  const setState = useCallback<Dispatch<SetStateAction<ManagerWsState>>>(
    (update) => {
      const target = originRegistry.getOrigin(activeOriginId)
      if (!target) return
      const previous = target.getSnapshot()
      const next =
        typeof update === 'function'
          ? (update as (prev: ManagerWsState) => ManagerWsState)(previous)
          : update
      if (next === previous) return
      target.ingest({ type: 'snapshot', state: next })
    },
    [activeOriginId],
  )

  return useMemo(
    () => ({ clientRef, httpClientRef, state, setState }),
    [clientRef, httpClientRef, state, setState],
  )
}
