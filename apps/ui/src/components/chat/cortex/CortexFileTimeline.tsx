import type { GitLogEntry } from '@forge/protocol'
import { History } from 'lucide-react'
import { CortexVersionList } from './CortexVersionList'

interface CortexFileTimelineProps {
  commits: GitLogEntry[]
  selectedSha: string | null
  totalEdits?: number | null
  hasMore: boolean
  isLoading: boolean
  isLoadingMore: boolean
  notInitialized?: boolean
  onSelectCommit: (sha: string) => void
  onOpenCommit: (sha: string) => void
  onLoadMore: () => void
}

export function CortexFileTimeline({
  commits,
  selectedSha,
  totalEdits,
  hasMore,
  isLoading,
  isLoadingMore,
  notInitialized = false,
  onSelectCommit,
  onOpenCommit,
  onLoadMore,
}: CortexFileTimelineProps) {
  return (
    <section className="rounded-lg border border-border/60 bg-card/70" data-testid="cortex-file-timeline">
      <div className="border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
          <History className="size-3.5 text-muted-foreground" />
          Version history
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">Compact file history for this document. Click a version to open its diff.</p>
      </div>

      <CortexVersionList
        commits={commits}
        selectedSha={selectedSha}
        totalEdits={totalEdits}
        hasMore={hasMore}
        isLoading={isLoading}
        isLoadingMore={isLoadingMore}
        notInitialized={notInitialized}
        dataTestId="cortex-file-timeline-list"
        onSelectCommit={onSelectCommit}
        onActivateCommit={onOpenCommit}
        onLoadMore={onLoadMore}
      />
    </section>
  )
}
