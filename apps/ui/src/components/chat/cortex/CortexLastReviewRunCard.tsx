import type { CortexFileReviewHistoryEntry, CortexDocumentEntry } from '@forge/protocol'
import { ExternalLink, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ArtifactReference } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { formatRelativeTimeCompact } from './history-format'

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
  canViewChanges = true,
  canOpenSession,
  onOpenSession,
  onViewChanges,
}: CortexLastReviewRunCardProps) {
  if (!run) {
    return (
      <div className="rounded-md border border-dashed border-border/60 bg-muted/10 px-3 py-2 text-[10px] text-muted-foreground" data-testid="cortex-last-review-run-card">
        <span className="font-medium text-foreground">Last review run</span>
        <span className="ml-1.5">No review run has touched this file yet.</span>
      </div>
    )
  }

  const sessionAvailable = !!run.sessionAgentId && (canOpenSession ? canOpenSession(run.sessionAgentId) : true)
  const summaryParts = [run.scopeLabel || describeTrigger(run), formatRelativeTimeCompact(run.recordedAt)]
  if (run.sessionAgentId) {
    summaryParts.push(`session ${run.sessionAgentId}`)
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[10px]',
        selectedReviewRunId && run.reviewId === selectedReviewRunId
          ? 'border-primary/40 bg-primary/10'
          : 'border-border/60 bg-muted/10',
      )}
      data-testid="cortex-last-review-run-card"
    >
      <span className="font-medium text-foreground">Last review run</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{summaryParts.join(' • ')}</span>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[10px]"
          disabled={!canViewChanges}
          onClick={() => onViewChanges?.(run)}
        >
          <History className="size-3" />
          View changes
        </Button>
        {run.sessionAgentId ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[10px]"
            disabled={!sessionAvailable}
            onClick={() => {
              if (!run.sessionAgentId || !sessionAvailable) {
                return
              }
              onOpenSession?.(run.sessionAgentId)
            }}
          >
            <ExternalLink className="size-3" />
            Open session
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function describeTrigger(run: CortexFileReviewHistoryEntry): string {
  if (run.trigger === 'scheduled') {
    return run.scheduleName || 'scheduled review'
  }

  if (run.trigger === 'manual') {
    return 'manual review'
  }

  return 'review run'
}
