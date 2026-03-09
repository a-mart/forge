import {
  Activity,
  AlertTriangle,
  Clock,
  Globe,
  Link2,
  Monitor,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import type { PlaywrightDiscoverySummary } from '@middleman/protocol'

interface PlaywrightSummaryBarProps {
  summary: PlaywrightDiscoverySummary
  lastScanCompletedAt: string | null
}

function StatCard({
  icon: Icon,
  label,
  value,
  variant,
}: {
  icon: React.ElementType
  label: string
  value: number | string
  variant?: 'default' | 'success' | 'warning' | 'muted'
}) {
  const iconClasses = {
    default: 'text-muted-foreground',
    success: 'text-emerald-500',
    warning: 'text-amber-500',
    muted: 'text-muted-foreground/60',
  }

  return (
    <Card className="flex-1 min-w-[120px]">
      <CardContent className="flex items-center gap-3 p-3">
        <Icon className={`size-4 shrink-0 ${iconClasses[variant ?? 'default']}`} />
        <div className="min-w-0">
          <p className="text-lg font-semibold leading-tight tabular-nums">{value}</p>
          <p className="text-[11px] text-muted-foreground truncate">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

export function PlaywrightSummaryBar({
  summary,
  lastScanCompletedAt,
}: PlaywrightSummaryBarProps) {
  const lastScanLabel = lastScanCompletedAt
    ? formatRelativeTime(lastScanCompletedAt)
    : 'Never'

  return (
    <div className="flex flex-wrap gap-2">
      <StatCard
        icon={Monitor}
        label="Total Sessions"
        value={summary.totalSessions}
      />
      <StatCard
        icon={Activity}
        label="Active"
        value={summary.activeSessions}
        variant={summary.activeSessions > 0 ? 'success' : 'muted'}
      />
      <StatCard
        icon={Clock}
        label="Stale"
        value={summary.staleSessions}
        variant={summary.staleSessions > 0 ? 'warning' : 'muted'}
      />
      <StatCard
        icon={Link2}
        label="Correlated"
        value={summary.correlatedSessions}
        variant={summary.correlatedSessions > 0 ? 'success' : 'muted'}
      />
      <StatCard
        icon={Globe}
        label="Worktrees"
        value={summary.worktreeCount}
      />
      <StatCard
        icon={AlertTriangle}
        label="Last Scan"
        value={lastScanLabel}
        variant="muted"
      />
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
