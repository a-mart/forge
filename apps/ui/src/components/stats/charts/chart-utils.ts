export function abbreviateNumber(value: number): string {
  if (value >= 1_000_000_000) {
    const n = value / 1_000_000_000
    return n >= 10 ? `${n.toFixed(0)}b` : `${n.toFixed(1)}b`
  }
  if (value >= 1_000_000) {
    const n = value / 1_000_000
    return n >= 10 ? `${n.toFixed(0)}m` : `${n.toFixed(1)}m`
  }
  if (value >= 1_000) {
    const n = value / 1_000
    return n >= 10 ? `${n.toFixed(0)}k` : `${n.toFixed(1)}k`
  }
  return value.toLocaleString()
}

export function timeAgo(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime()
  if (diff < 0) return 'just now'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
