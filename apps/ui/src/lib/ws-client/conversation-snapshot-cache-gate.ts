/**
 * Presentation-cache build gate. Only the literal string `true` enables cache
 * allocation; missing and malformed values intentionally fail closed.
 */
export function resolveSessionSwitchSnapshotCacheEnabled(value: unknown): boolean {
  return value === 'true'
}

export const SESSION_SWITCH_SNAPSHOT_CACHE_ENABLED =
  resolveSessionSwitchSnapshotCacheEnabled(import.meta.env.VITE_SESSION_SWITCH_SNAPSHOT_CACHE)
