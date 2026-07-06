import type { CortexKnowledgeEntry, GitFileSectionProvenanceEntry } from '@forge/protocol'

interface CortexSectionProvenanceProps {
  entry?: CortexKnowledgeEntry
  provenance?: GitFileSectionProvenanceEntry
  testId?: string
}

export function CortexSectionProvenance({ entry, provenance, testId }: CortexSectionProvenanceProps) {
  if (!entry && provenance) {
    return <FileProvenancePill provenance={provenance} testId={testId} />
  }
  if (!entry) {
    return null
  }

  const timeLabel = formatInlineTimestamp(entry.last_confirmed)
  const sourceLabel = entry.sources.length > 0 ? `${entry.sources.length} source${entry.sources.length === 1 ? '' : 's'}` : 'no sources'
  const title = [
    `First seen: ${formatFullTimestamp(entry.first_seen)}`,
    `Last confirmed: ${formatFullTimestamp(entry.last_confirmed)}`,
    `Support: ${entry.support_count}`,
    entry.supersedes.length > 0 ? `Supersedes: ${entry.supersedes.join(', ')}` : null,
    entry.source_entry_ids.length > 0 ? `Merged from: ${entry.source_entry_ids.join(', ')}` : null,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' • ')

  return (
    <span
      className="ml-2 inline-flex max-w-full items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 align-middle text-[10px] font-normal text-muted-foreground"
      title={title || undefined}
      data-testid={testId ?? 'cortex-section-provenance'}
    >
      <span className="truncate">{timeLabel}</span>
      <span className="truncate text-muted-foreground/80">• {sourceLabel}</span>
      <span className="truncate text-muted-foreground/80">• x{entry.support_count}</span>
    </span>
  )
}

function FileProvenancePill({ provenance, testId }: { provenance: GitFileSectionProvenanceEntry; testId?: string }) {
  const timeLabel = formatInlineTimestamp(provenance.lastModifiedAt)
  const reviewLabel = provenance.reviewRunId ? formatShortLabel(provenance.reviewRunId) : null
  const title = [
    provenance.lastModifiedSummary || 'Last modified',
    provenance.lastModifiedAt ? formatFullTimestamp(provenance.lastModifiedAt) : null,
    provenance.reviewRunId ? `Run: ${provenance.reviewRunId}` : null,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' • ')

  return (
    <span
      className="ml-2 inline-flex max-w-full items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 align-middle text-[10px] font-normal text-muted-foreground"
      title={title || undefined}
      data-testid={testId ?? 'cortex-section-provenance'}
    >
      <span className="truncate">{timeLabel}</span>
      {reviewLabel ? <span className="truncate text-muted-foreground/80">• {reviewLabel}</span> : null}
    </span>
  )
}

function formatInlineTimestamp(isoString: string | null): string {
  if (!isoString) {
    return 'unknown change'
  }

  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'unknown change'
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(parsed))
}

function formatFullTimestamp(isoString: string): string {
  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'unknown time'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed))
}

function formatShortLabel(value: string): string {
  const trimmed = value.trim()
  return trimmed.length <= 18 ? trimmed : `${trimmed.slice(0, 16)}...`
}
