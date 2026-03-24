/**
 * Format a duration in milliseconds as a human-readable elapsed time string.
 *
 * Examples:
 *   - 5_000   → "0:05"
 *   - 72_000  → "1:12"
 *   - 3_661_000 → "1:01:01"
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
