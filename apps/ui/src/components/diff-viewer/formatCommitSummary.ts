import type { GitCommitMetadata, GitLogEntry } from '@forge/protocol'
import { classifyKnowledgeSurface } from './knowledge-surface'

export function formatCommitSummary(commit: Pick<GitLogEntry, 'message' | 'metadata'>): string {
  const fallback = getCommitSubject(commit.message)
  const metadata = commit.metadata

  if (!metadata) {
    return fallback
  }

  const summary = buildSummaryFromMetadata(metadata)
  return summary ? appendContext(summary, metadata) : fallback
}

function buildSummaryFromMetadata(metadata: GitCommitMetadata): string | null {
  const source = metadata.source ?? (metadata.sources?.length === 1 ? metadata.sources[0] : undefined)

  switch (source) {
    case 'reconcile':
      return 'Reconcile: tracked knowledge changes'
    case 'bootstrap':
      return 'Bootstrapped tracked knowledge'
    case 'prompt-save':
      return 'Prompt override edited'
    case 'prompt-delete':
      return 'Prompt override deleted'
    case 'reference-doc':
    case 'reference-index':
      return 'Synced reference docs'
    case 'legacy-knowledge-migration':
      return 'Migrated legacy knowledge'
    case 'profile-memory-merge':
      return 'Updated profile memory'
    case 'api-write-file-restore':
      return summarizeFromPaths(metadata, 'restore')
    default:
      return summarizeFromPaths(metadata)
  }
}

function summarizeFromPaths(metadata: GitCommitMetadata, mode: 'update' | 'restore' = 'update'): string | null {
  const paths = metadata.paths ?? []
  if (paths.length === 0) {
    return null
  }

  const surfaceIds = Array.from(new Set(paths.map((path) => classifyKnowledgeSurface(path).id)))
  if (surfaceIds.length !== 1) {
    return mode === 'restore' ? 'Restored tracked knowledge' : 'Updated tracked knowledge'
  }

  switch (surfaceIds[0]) {
    case 'common-knowledge':
      return mode === 'restore' ? 'Restored common knowledge' : 'Updated common knowledge'
    case 'cortex-notes':
      return mode === 'restore' ? 'Restored Cortex notes' : 'Updated Cortex notes'
    case 'cortex-worker-prompts':
      return mode === 'restore' ? 'Restored Cortex worker prompts' : 'Updated Cortex worker prompts'
    case 'profile-knowledge':
      return mode === 'restore' ? 'Restored profile knowledge' : 'Updated profile knowledge'
    case 'profile-memory':
      return mode === 'restore' ? 'Restored profile memory' : 'Updated profile memory'
    case 'reference-docs':
      return mode === 'restore' ? 'Restored reference docs' : 'Synced reference docs'
    case 'prompt-overrides':
      return mode === 'restore' ? 'Restored prompt override' : 'Prompt override edited'
    case 'other-tracked':
    default:
      return mode === 'restore' ? 'Restored tracked knowledge' : 'Updated tracked knowledge'
  }
}

function appendContext(summary: string, metadata: GitCommitMetadata): string {
  if (metadata.profileId && metadata.sessionId) {
    return `${summary} for ${metadata.profileId} (session ${metadata.sessionId})`
  }

  if (metadata.profileId) {
    return `${summary} for ${metadata.profileId}`
  }

  if (metadata.sessionId) {
    return `${summary} (session ${metadata.sessionId})`
  }

  return summary
}

function getCommitSubject(message: string): string {
  const subject = message.split('\n')[0]?.trim()
  return subject || 'Untitled commit'
}
