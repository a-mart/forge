import type { GitLogEntry } from '@forge/protocol'
import { History, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { CommitMetadataBadges } from '@/components/diff-viewer/CommitMetadataBadges'
import { formatCommitSummary } from '@/components/diff-viewer/formatCommitSummary'

interface CortexFileTimelineProps {
  commits: GitLogEntry[]
  selectedSha: string | null
  hasMore: boolean
  isLoading: boolean
  isLoadingMore: boolean
  notInitialized?: boolean
  searchQuery: string
  onSearchChange: (value: string) => void
  onSelectCommit: (sha: string) => void
  onLoadMore: () => void
}

export function CortexFileTimeline({
  commits,
  selectedSha,
  hasMore,
  isLoading,
  isLoadingMore,
  notInitialized = false,
  searchQuery,
  onSearchChange,
  onSelectCommit,
  onLoadMore,
}: CortexFileTimelineProps) {
  const hasActiveSearch = searchQuery.trim().length > 0

  return (
    <section className="rounded-lg border border-border/60 bg-card/70" data-testid="cortex-file-timeline">
      <div className="border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
          <History className="size-3.5 text-muted-foreground" />
          Timeline
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">Arrow keys move through commits. Esc returns to content mode.</p>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search loaded history"
            className="h-8 border-border/60 bg-background/70 pl-8 text-[11px]"
            data-testid="cortex-file-timeline-search"
          />
        </div>
      </div>

      {notInitialized ? (
        <div className="px-3 py-4 text-[11px] text-muted-foreground">Initialize the versioning repo to unlock file-local history.</div>
      ) : isLoading && commits.length === 0 && !hasActiveSearch ? (
        <div className="flex items-center gap-2 px-3 py-4 text-[11px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading commit history…
        </div>
      ) : commits.length === 0 ? (
        <div className="px-3 py-4 text-[11px] text-muted-foreground">
          {hasActiveSearch ? 'No loaded commits match this search yet.' : 'No commits found for this file yet.'}
        </div>
      ) : (
        <>
          <div className="space-y-1 p-2">
            {commits.map((commit) => {
              const active = commit.sha === selectedSha
              return (
                <button
                  key={commit.sha}
                  type="button"
                  className={cn(
                    'w-full rounded-md border px-2.5 py-2 text-left transition-colors',
                    active
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border/50 bg-background/60 text-foreground hover:bg-accent/40',
                  )}
                  aria-pressed={active}
                  onClick={() => onSelectCommit(commit.sha)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">{commit.shortSha}</span>
                    <span className="text-[10px] text-muted-foreground">{formatTimestamp(commit.date)}</span>
                  </div>
                  <p className="mt-1 text-[11px] font-medium leading-snug">{formatCommitSummary(commit)}</p>
                  <CommitMetadataBadges metadata={commit.metadata} className="mt-2" />
                </button>
              )
            })}
          </div>

          {hasMore ? (
            <div className="border-t border-border/60 px-2 py-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-full text-[10px]"
                onClick={onLoadMore}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? (
                  <>
                    <Loader2 className="mr-1 size-3 animate-spin" />
                    Loading…
                  </>
                ) : (
                  hasActiveSearch ? 'Load more for search completeness' : 'Load more'
                )}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

function formatTimestamp(isoString: string): string {
  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'Unknown time'
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(parsed))
}
