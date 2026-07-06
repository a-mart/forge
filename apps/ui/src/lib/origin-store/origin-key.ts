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

/** A domain id (agentId / profileId / sessionAgentId) scoped to an origin. */
export interface CompositeId {
  originId: OriginId
  id: string
}

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

/**
 * Parse a flat composite key back into its `(originId, id)` parts.  Only the
 * first separator is significant, so ids that themselves contain `::` round
 * trip correctly.  Returns `null` for strings without a separator.
 */
export function parseCompositeKey(key: string): CompositeId | null {
  const index = key.indexOf(COMPOSITE_SEPARATOR)
  if (index < 0) return null
  return {
    originId: key.slice(0, index),
    id: key.slice(index + COMPOSITE_SEPARATOR.length),
  }
}
