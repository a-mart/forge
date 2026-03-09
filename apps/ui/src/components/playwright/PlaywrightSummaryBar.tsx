import {
  Activity,
  Clock,
} from 'lucide-react'
import type { PlaywrightDiscoverySummary } from '@middleman/protocol'

interface PlaywrightSummaryBarProps {
  summary: PlaywrightDiscoverySummary
  lastScanCompletedAt: string | null
  /** Render as a minimal inline fragment (no wrapper div, for embedding in header) */
  inline?: boolean
}

/**
 * Compact summary strip — replaces the old 6-card stat grid.
 *
 * Two modes:
 * - `inline` (default false): wraps in a subtle bar suitable for standalone display
 * - `inline={true}`: renders as bare inline spans for embedding inside the header row
 */
export function PlaywrightSummaryBar({
  summary,
  lastScanCompletedAt,
  inline = false,
}: PlaywrightSummaryBarProps) {
  const lastScanLabel = lastScanCompletedAt
    ? formatRelativeTime(lastScanCompletedAt)
    : 'Never'

  const content = (
    <>
      {/* Active / total */}
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Activity className="size-3 text-emerald-500" />
        <span className="font-medium tabular-nums text-foreground">{summary.activeSessions}</span>
        <span>active</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="tabular-nums">{summary.totalSessions}</span>
        <span>total</span>
      </span>

      {/* Separator */}
      <span className="text-muted-foreground/30">|</span>

      {/* Last scan */}
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="size-3" />
        <span>{lastScanLabel}</span>
      </span>
    </>
  )

  if (inline) {
    return <>{content}</>
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-1.5">
      {content}
    </div>
  )
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  if (Number.isNaN(then)) return 'Unknown'

  const diffMs = now - then
  if (diffMs < 0) return 'Just now'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 10) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
