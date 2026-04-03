const numberFormatter = new Intl.NumberFormat()

/**
 * Format a token count as a compact human-readable string (e.g. "128k", "1M").
 * Falls back to locale-formatted integers for values under 1,000.
 */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
  }
  return numberFormatter.format(value)
}

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
