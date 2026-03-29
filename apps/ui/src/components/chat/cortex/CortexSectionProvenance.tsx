import type { GitFileSectionProvenanceEntry } from '@forge/protocol'

interface CortexSectionProvenanceProps {
  provenance: GitFileSectionProvenanceEntry
  testId?: string
}

export function CortexSectionProvenance({ provenance, testId }: CortexSectionProvenanceProps) {
  const timeLabel = formatInlineTimestamp(provenance.lastModifiedAt)
  const reviewLabel = provenance.reviewRunId ? formatReviewRunLabel(provenance.reviewRunId) : null
  const title = [
    provenance.lastModifiedSummary || 'Last modified',
    provenance.lastModifiedAt ? formatFullTimestamp(provenance.lastModifiedAt) : null,
    provenance.reviewRunId ? `Review run: ${provenance.reviewRunId}` : null,
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

function formatReviewRunLabel(reviewRunId: string): string {
  const trimmed = reviewRunId.trim()
  if (trimmed.length <= 18) {
    return trimmed
  }

  return `${trimmed.slice(0, 16)}…`
}
