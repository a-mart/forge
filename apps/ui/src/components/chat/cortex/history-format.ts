import type { GitLogEntry } from '@forge/protocol'

const SOURCE_LABELS: Record<string, string> = {
  reconcile: 'reconcile',
  bootstrap: 'bootstrap',
  'prompt-save': 'prompt save',
  'prompt-delete': 'prompt delete',
  'reference-doc': 'reference sync',
  'reference-index': 'reference sync',
  'legacy-knowledge-migration': 'migration',
  'profile-memory-merge': 'memory merge',
  'agent-edit-tool': 'edit tool',
  'api-write-file-restore': 'restore',
}

export function formatRelativeTimeCompact(isoString: string): string {
  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'unknown time'
  }

  const diffMs = Date.now() - parsed
  if (diffMs <= 0) {
    return 'just now'
  }

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) {
    return 'just now'
  }

  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.floor(hours / 24)
  if (days < 30) {
    return `${days}d ago`
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(parsed))
}

export function formatTimestampWithTime(isoString: string): string {
  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'unknown time'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed))
}

export function describeTimelineContext(commit: Pick<GitLogEntry, 'message' | 'metadata'>): string {
  const sessionId = commit.metadata?.sessionId?.trim()
  if (sessionId) {
    return `session ${sessionId}`
  }

  const reason = commit.metadata?.reason?.trim()
  if (reason) {
    return reason
  }

  const source = commit.metadata?.source ?? commit.metadata?.sources?.[0]
  if (source) {
    return SOURCE_LABELS[source] ?? humanizeSource(source)
  }

  const subject = commit.message.split('\n')[0]?.trim()
  return subject || 'change'
}

export function buildVersionNumber(index: number, totalEdits: number | null | undefined, loadedCommitCount: number): number {
  if (typeof totalEdits === 'number' && Number.isFinite(totalEdits) && totalEdits > 0) {
    return Math.max(totalEdits - index, 1)
  }

  return Math.max(loadedCommitCount - index, 1)
}

function humanizeSource(source: string): string {
  return source
    .split(/[-_]/g)
    .filter(Boolean)
    .join(' ')
}
