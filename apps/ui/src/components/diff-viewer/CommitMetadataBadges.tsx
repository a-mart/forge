import type { GitCommitMetadata } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface CommitMetadataBadgesProps {
  metadata: GitCommitMetadata | null | undefined
  className?: string
}

const SOURCE_STYLES: Record<string, { label: string; className: string }> = {
  'agent-edit-tool': {
    label: 'Edit tool',
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-500',
  },
  'agent-write-tool': {
    label: 'Write tool',
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-500',
  },
  'api-write-file': {
    label: 'API write',
    className: 'border-sky-500/30 bg-sky-500/10 text-sky-500',
  },
  'api-write-file-restore': {
    label: 'Restore',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
  },
  'profile-memory-merge': {
    label: 'Memory merge',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
  },
  'prompt-save': {
    label: 'Prompt save',
    className: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-500',
  },
  'prompt-delete': {
    label: 'Prompt delete',
    className: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-500',
  },
  'reference-doc': {
    label: 'Reference doc',
    className: 'border-violet-500/30 bg-violet-500/10 text-violet-500',
  },
  'reference-index': {
    label: 'Reference index',
    className: 'border-violet-500/30 bg-violet-500/10 text-violet-500',
  },
  'legacy-knowledge-migration': {
    label: 'Migration',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
  },
  bootstrap: {
    label: 'Bootstrap',
    className: 'border-muted-foreground/20 bg-muted/60 text-muted-foreground',
  },
  reconcile: {
    label: 'Reconcile',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
  },
}

export function CommitMetadataBadges({ metadata, className }: CommitMetadataBadgesProps) {
  if (!metadata) {
    return null
  }

  const sourceLabel = resolveSourceLabel(metadata)

  return (
    <div className={cn('mt-1 flex flex-wrap gap-1', className)} aria-label="Commit metadata">
      {sourceLabel ? (
        <Badge
          variant="outline"
          className={cn(
            'h-5 border px-1.5 py-0 text-[10px] font-medium',
            resolveSourceClassName(metadata),
          )}
        >
          {sourceLabel}
        </Badge>
      ) : null}
      {metadata.profileId ? (
        <Badge
          variant="outline"
          className="h-5 border-cyan-500/25 bg-cyan-500/10 px-1.5 py-0 text-[10px] font-medium text-cyan-500"
        >
          {`Profile ${metadata.profileId}`}
        </Badge>
      ) : null}
      {metadata.sessionId ? (
        <Badge
          variant="outline"
          className="h-5 border-border/60 bg-muted/40 px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
        >
          {`Session ${metadata.sessionId}`}
        </Badge>
      ) : null}
    </div>
  )
}

function resolveSourceLabel(metadata: GitCommitMetadata): string | null {
  const sources = metadata.sources?.length ? metadata.sources : metadata.source ? [metadata.source] : []
  if (sources.length === 0) {
    return null
  }

  if (sources.length > 1) {
    return 'Mixed sources'
  }

  return SOURCE_STYLES[sources[0]]?.label ?? humanizeSource(sources[0])
}

function resolveSourceClassName(metadata: GitCommitMetadata): string {
  const sources = metadata.sources?.length ? metadata.sources : metadata.source ? [metadata.source] : []
  if (sources.length !== 1) {
    return 'border-border/60 bg-muted/40 text-muted-foreground'
  }

  return SOURCE_STYLES[sources[0]]?.className ?? 'border-border/60 bg-muted/40 text-muted-foreground'
}

function humanizeSource(source: string): string {
  return source
    .split('-')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}
