/**
 * Composite `(originId, id)` identity for the origin-aware store (WP-U1).
 *
 * No consumer outside a store may treat `agentId` / `profileId` / `sessionId`
 * as globally unique — remote projects (Wave R) will surface colliding ids
 * across origins.  Store keys, React list keys, and navigation state all carry
 * the pair.  Today only the reserved `"local"` origin is live, so the pair is
 * a superset of today's single-origin behavior.
 *
 * @see .internal/forge-review-2026-07/97-remote/U1-REQUIREMENTS.md (req. 4)
 */

/** Opaque origin identifier.  `"local"` is reserved for the on-device backend. */
export type OriginId = string

/** The reserved origin id for the local Builder backend. */
export const LOCAL_ORIGIN_ID: OriginId = 'local'

/**
 * Separator between origin and id in a flat composite key string.  Chosen to
 * not collide with agent/profile id characters (which are hex-ish handles).
 */
const COMPOSITE_SEPARATOR = '::'

/**
 * Build a stable, flat key from an `(originId, id)` pair — suitable for `Map`
 * keys, React `key` props, and per-slice subscription keys.
 */
export function compositeKey(originId: OriginId, id: string): string {
  return `${originId}${COMPOSITE_SEPARATOR}${id}`
}
