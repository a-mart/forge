import type { GitFileHistoryStats } from '@forge/protocol'

interface CortexFileHistoryStatsProps {
  stats: GitFileHistoryStats | null | undefined
  notInitialized?: boolean
  isLoading?: boolean
}

export function CortexFileHistoryStats({
  stats,
  notInitialized = false,
  isLoading = false,
}: CortexFileHistoryStatsProps) {
  const values = {
    lastModified: notInitialized ? 'Unavailable' : isLoading ? 'Loading…' : formatTimestamp(stats?.lastModifiedAt ?? null),
    totalEdits: notInitialized ? '—' : isLoading ? '…' : String(stats?.totalEdits ?? 0),
    editsToday: notInitialized ? '—' : isLoading ? '…' : String(stats?.editsToday ?? 0),
    editsThisWeek: notInitialized ? '—' : isLoading ? '…' : String(stats?.editsThisWeek ?? 0),
  }

  return (
    <div
      className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 bg-card/70 p-2"
      data-testid="cortex-file-history-stats"
    >
      <StatTile label="Last modified" value={values.lastModified} />
      <StatTile label="Total edits" value={values.totalEdits} />
      <StatTile label="Edits today" value={values.editsToday} />
      <StatTile label="This week" value={values.editsThisWeek} />
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-[11px] font-medium text-foreground">{value}</p>
    </div>
  )
}

function formatTimestamp(isoString: string | null): string {
  if (!isoString) {
    return 'No edits yet'
  }

  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'Unknown'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed))
}
