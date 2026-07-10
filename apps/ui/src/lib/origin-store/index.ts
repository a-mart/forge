/**
 * Origin-aware selector store (WP-U1).
 *
 * Public surface for the origin-keyed store registry, its per-slice
 * `useSyncExternalStore` hooks, composite `(originId, id)` identity, and the
 * origin meta slice.  Ships with only the reserved `"local"` origin live; the
 * shape is already multi-origin so remote projects (Wave R) plug in without
 * rework.
 *
 * @see .internal/forge-review-2026-07/97-remote/U1-REQUIREMENTS.md
 */

export {
  LOCAL_ORIGIN_ID,
  compositeKey,
  parseCompositeKey,
  type OriginId,
  type CompositeId,
} from './origin-key'

export {
  createInitialOriginMetaState,
  type OriginMetaState,
  type OriginConnectionStatus,
  type OriginAuthState,
  type OriginCurrentUser,
} from './origin-meta'

export {
  ForgeOriginManager,
  forgeOriginManager,
} from './forge-origin-manager'

export {
  OriginStore,
  type OriginSelector,
  type OriginStoreOptions,
} from './origin-store'

export {
  OriginRegistry,
  originRegistry,
} from './origin-registry'

export {
  useOriginSlice,
  useOriginSnapshot,
  useOriginMeta,
  useAllOrigins,
  type UseOriginSliceOptions,
  type OriginSliceResult,
} from './use-origin-store'
