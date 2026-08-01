export function formatThroughputRate(value: number | null | undefined, precision = 0): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  return value.toLocaleString(undefined, {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision > 0 ? 1 : 0,
  })
}
