import type { CortexFileReviewHistoryEntry, GitFileHistoryStats, GitLogEntry } from '@forge/protocol'

interface CortexHistoryActivitySummaryProps {
  stats: GitFileHistoryStats | null | undefined
  latestRun: CortexFileReviewHistoryEntry | null | undefined
  latestCommit: GitLogEntry | null | undefined
  notInitialized?: boolean
}

export function CortexHistoryActivitySummary({
  stats,
  latestRun,
  latestCommit,
  notInitialized = false,
}: CortexHistoryActivitySummaryProps) {
  const primary = buildPrimarySummary(stats, notInitialized)
  const secondary = buildSecondarySummary({ latestRun, latestCommit, notInitialized })

  return (
    <div
      className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
      data-testid="cortex-history-activity-summary"
    >
      <p className="text-[11px] font-medium text-foreground">{primary}</p>
      {secondary ? <p className="mt-1 text-[10px] text-muted-foreground">{secondary}</p> : null}
    </div>
  )
}

function buildPrimarySummary(stats: GitFileHistoryStats | null | undefined, notInitialized: boolean): string {
  if (notInitialized) {
    return 'Versioning history is not available for this document yet.'
  }

  if (!stats) {
    return 'Loading document activity…'
  }

  if (stats.totalEdits === 0) {
    return 'No recorded edits yet.'
  }

  if (stats.editsToday > 0 || stats.editsThisWeek > 0) {
    return `${pluralize(stats.editsToday, 'edit')} today, ${pluralize(stats.editsThisWeek, 'edit')} this week.`
  }

  return `${pluralize(stats.totalEdits, 'edit')} recorded for this file.`
}

function buildSecondarySummary({
  latestRun,
  latestCommit,
  notInitialized,
}: {
  latestRun: CortexFileReviewHistoryEntry | null | undefined
  latestCommit: GitLogEntry | null | undefined
  notInitialized: boolean
}): string | null {
  if (latestCommit?.metadata?.reviewRunId && latestRun?.reviewId === latestCommit.metadata.reviewRunId) {
    return `Most recent change came from ${describeReviewRun(latestRun)}.`
  }

  if (latestRun) {
    return `Latest review touchpoint: ${describeReviewRun(latestRun)} ${formatRelativeTime(latestRun.recordedAt)}.`
  }

  if (notInitialized) {
    return 'Initialize the versioning repository to unlock commit-by-commit history in this sidebar.'
  }

  if (latestCommit) {
    return `Most recent change landed ${formatRelativeTime(latestCommit.date)}.`
  }

  return 'Select a commit to inspect the inline diff below.'
}

function describeReviewRun(run: CortexFileReviewHistoryEntry): string {
  if (run.scopeLabel) {
    return run.scopeLabel
  }

  if (run.trigger === 'scheduled') {
    return run.scheduleName ? `${run.scheduleName} review run` : 'a scheduled review run'
  }

  if (run.trigger === 'manual') {
    return 'a manual review run'
  }

  return 'a Cortex review run'
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function formatRelativeTime(isoString: string): string {
  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'at an unknown time'
  }

  const diffMs = Date.now() - parsed
  if (!Number.isFinite(diffMs)) {
    return 'at an unknown time'
  }

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const minutes = Math.round(diffMs / (60_000))
  if (Math.abs(minutes) < 60) {
    return rtf.format(-minutes, 'minute')
  }

  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 48) {
    return rtf.format(-hours, 'hour')
  }

  const days = Math.round(hours / 24)
  if (Math.abs(days) < 14) {
    return rtf.format(-days, 'day')
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed))
}
