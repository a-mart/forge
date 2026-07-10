/**
 * Local Builder instance preference for the unified local + remote project list.
 *
 * The preference is intentionally owned by the local Builder backend. Remote
 * collaboration servers never expose this API or receive these values.
 */

export const BUILDER_SIDEBAR_ORDER_VERSION = 1 as const
export const BUILDER_SIDEBAR_ORDER_MAX_REFS = 2_000
export const BUILDER_SIDEBAR_ORDER_MAX_ID_CODE_POINTS = 256
export const BUILDER_SIDEBAR_ORDER_MAX_SERIALIZED_BYTES = 256 * 1024

export interface BuilderSidebarOrderRef {
  originId: string
  profileId: string
}

export interface BuilderSidebarOrderState {
  version: typeof BUILDER_SIDEBAR_ORDER_VERSION
  revision: number
  order: BuilderSidebarOrderRef[]
  updatedAt: string | null
}

export interface UpdateBuilderSidebarOrderRequest {
  baseRevision: number
  order: BuilderSidebarOrderRef[]
}

export interface BuilderSidebarOrderConflictResponse {
  error: string
  current: BuilderSidebarOrderState
}

/**
 * Small invalidation broadcast emitted only by the local Builder backend after
 * a successful write. Clients refetch the authoritative preference over HTTP;
 * the potentially large order never consumes the WebSocket event budget.
 */
export interface BuilderSidebarOrderUpdatedEvent {
  type: 'builder_sidebar_order_updated'
  revision: number
}
