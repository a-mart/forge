import type { GitFileHistoryStats } from '@forge/protocol'

interface CortexDocumentMetaStripProps {
  stats: GitFileHistoryStats | null | undefined
  notInitialized?: boolean
  isLoading?: boolean
}

export function CortexDocumentMetaStrip({
  stats,
  notInitialized = false,
  isLoading = false,
}: CortexDocumentMetaStripProps) {
  if (notInitialized) {
    return (
      <p className="truncate text-[10px] text-muted-foreground" data-testid="cortex-document-meta-strip">
        No history available.
      </p>
    )
  }

  if (isLoading) {
    return (
      <p className="truncate text-[10px] text-muted-foreground" data-testid="cortex-document-meta-strip">
        Loading history…
      </p>
    )
  }

  if (!stats) {
    return null
  }

  const pieces = [
    stats.lastModifiedAt ? `Modified ${formatTimestamp(stats.lastModifiedAt)}` : 'No edits recorded yet',
    `${stats.totalEdits} ${stats.totalEdits === 1 ? 'edit' : 'edits'}`,
    formatRecencyLabel(stats),
  ]

  return (
    <p className="truncate text-[10px] text-muted-foreground" data-testid="cortex-document-meta-strip">
      {pieces.join(' • ')}
    </p>
  )
}

function formatTimestamp(isoString: string): string {
  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'unknown'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed))
}

function formatRecencyLabel(stats: GitFileHistoryStats): string {
  if (stats.editsToday > 0) {
    return 'active today'
  }

  if (stats.editsThisWeek > 0) {
    return 'active this week'
  }

  if (!stats.lastModifiedAt) {
    return 'no recent activity'
  }

  const diffMs = Date.now() - Date.parse(stats.lastModifiedAt)
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'recently updated'
  }

  const days = diffMs / (1000 * 60 * 60 * 24)
  if (days <= 30) {
    return 'updated this month'
  }

  return 'older history'
}
