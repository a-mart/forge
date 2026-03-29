import type { CortexFileReviewHistoryEntry, CortexDocumentEntry } from '@forge/protocol'
import { ExternalLink, FileText, GitCommitHorizontal, History } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ArtifactReference } from '@/lib/artifacts'
import { toSwarmFileHref } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { classifyKnowledgeSurface } from '@/components/diff-viewer/knowledge-surface'

interface CortexLastReviewRunCardProps {
  run: CortexFileReviewHistoryEntry | null | undefined
  selectedReviewRunId?: string | null
  currentFilePath: string | null | undefined
  documents: CortexDocumentEntry[]
  canViewChanges?: boolean
  canOpenSession?: (agentId: string) => boolean
  onArtifactClick?: (artifact: ArtifactReference) => void
  onOpenSession?: (agentId: string) => void
  onViewChanges?: (run: CortexFileReviewHistoryEntry) => void
  onSelectDocument?: (documentId: string) => void
}

export function CortexLastReviewRunCard({
  run,
  selectedReviewRunId = null,
  currentFilePath,
  documents,
  canViewChanges = true,
  canOpenSession,
  onArtifactClick,
  onOpenSession,
  onViewChanges,
  onSelectDocument,
}: CortexLastReviewRunCardProps) {
  if (!run) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/10 px-3 py-3" data-testid="cortex-last-review-run-card">
        <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
          <History className="size-3.5 text-muted-foreground" />
          Last review run
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">No review run has touched this file yet.</p>
      </div>
    )
  }

  const sessionAvailable = !!run.sessionAgentId && (canOpenSession ? canOpenSession(run.sessionAgentId) : true)
  const changedTogether = run.changedFiles.filter((path) => path !== currentFilePath)

  return (
    <div
      className={cn(
        'rounded-lg border bg-card/80 px-3 py-3 shadow-sm',
        selectedReviewRunId && run.reviewId === selectedReviewRunId
          ? 'border-primary/50 ring-1 ring-primary/20'
          : 'border-border/60',
      )}
      data-testid="cortex-last-review-run-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-foreground">Last review run</p>
          <p className="mt-1 text-[10px] text-muted-foreground">{describeRun(run)}</p>
        </div>
        <StatusBadge status={run.status} />
      </div>

      <div className="mt-3 space-y-2">
        <div className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <GitCommitHorizontal className="size-3" />
            Changed files
          </div>
          <div className="mt-2 space-y-1.5">
            {run.changedFiles.map((path) => {
              const document = documents.find((entry) => entry.gitPath === path)
              const surface = classifyKnowledgeSurface(path)
              const selectable = !!document && !!onSelectDocument
              const rowContent = (
                <>
                  <Badge variant="outline" className="h-5 border-border/60 bg-muted/30 px-1.5 py-0 text-[10px] text-muted-foreground">
                    {surface.label}
                  </Badge>
                  <span className="truncate">{path}</span>
                </>
              )

              return selectable ? (
                <button
                  key={path}
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[10px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                  onClick={() => onSelectDocument?.(document.id)}
                >
                  {rowContent}
                </button>
              ) : (
                <div key={path} className="flex items-center gap-1.5 px-1.5 py-1 text-[10px] text-muted-foreground">
                  {rowContent}
                </div>
              )
            })}
          </div>
        </div>

        {changedTogether.length > 0 ? (
          <p className="text-[10px] text-muted-foreground">
            {changedTogether.length} sibling {changedTogether.length === 1 ? 'file was' : 'files were'} updated in the same run.
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[10px]"
          disabled={!run.manifestPath || !run.manifestExists}
          onClick={() => {
            if (!run.manifestPath || !run.manifestExists) {
              return
            }
            onArtifactClick?.({
              path: run.manifestPath,
              fileName: run.manifestPath.split('/').pop() ?? 'manifest.md',
              href: toSwarmFileHref(run.manifestPath),
              title: 'Review manifest',
            })
          }}
        >
          <FileText className="size-3" />
          View manifest
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[10px]"
          disabled={!run.sessionAgentId || !sessionAvailable}
          onClick={() => {
            if (!run.sessionAgentId || !sessionAvailable) {
              return
            }
            onOpenSession?.(run.sessionAgentId)
          }}
        >
          <ExternalLink className="size-3" />
          Open review session
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[10px]"
          disabled={!canViewChanges}
          onClick={() => onViewChanges?.(run)}
        >
          <History className="size-3" />
          View changes
        </Button>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: CortexFileReviewHistoryEntry['status'] }) {
  const className = {
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
    'no-op': 'border-border/60 bg-muted/30 text-muted-foreground',
    blocked: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
    failed: 'border-red-500/30 bg-red-500/10 text-red-500',
  }[status]

  return (
    <Badge variant="outline" className={cn('h-5 px-1.5 py-0 text-[10px] font-medium capitalize', className)}>
      {status}
    </Badge>
  )
}

function describeRun(run: CortexFileReviewHistoryEntry): string {
  const triggerLabel =
    run.trigger === 'scheduled'
      ? run.scheduleName || 'Scheduled review'
      : run.trigger === 'manual'
        ? 'Manual review'
        : 'Review run'

  const timeLabel = formatTimestamp(run.recordedAt)
  return [run.scopeLabel || triggerLabel, triggerLabel, timeLabel].filter(Boolean).join(' • ')
}

function formatTimestamp(isoString: string): string {
  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'Unknown time'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed))
}
