import type { GitLogEntry } from '@forge/protocol'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { buildVersionNumber, describeTimelineContext, formatRelativeTimeCompact } from './history-format'

interface CortexVersionListProps {
  commits: GitLogEntry[]
  selectedSha: string | null
  totalEdits?: number | null
  currentVersionNumber?: number | null
  hasMore: boolean
  isLoading: boolean
  isLoadingMore: boolean
  notInitialized?: boolean
  showCurrentBadge?: boolean
  ariaLabel?: string
  dataTestId?: string
  className?: string
  onSelectCommit: (sha: string) => void
  onActivateCommit?: (sha: string) => void
  onLoadMore: () => void
}

export function CortexVersionList({
  commits,
  selectedSha,
  totalEdits,
  currentVersionNumber,
  hasMore,
  isLoading,
  isLoadingMore,
  notInitialized = false,
  showCurrentBadge = false,
  ariaLabel = 'Version history',
  dataTestId,
  className,
  onSelectCommit,
  onActivateCommit,
  onLoadMore,
}: CortexVersionListProps) {
  if (notInitialized) {
    return (
      <div className={cn('px-3 py-4 text-[11px] text-muted-foreground', className)} data-testid={dataTestId}>
        Initialize the versioning repo to unlock file-local history.
      </div>
    )
  }

  if (isLoading && commits.length === 0) {
    return (
      <div className={cn('flex items-center gap-2 px-3 py-4 text-[11px] text-muted-foreground', className)} data-testid={dataTestId}>
        <Loader2 className="size-3.5 animate-spin" />
        Loading version history…
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <div className={cn('px-3 py-4 text-[11px] text-muted-foreground', className)} data-testid={dataTestId}>
        No versions found for this file yet.
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} data-testid={dataTestId}>
      <ScrollArea className="min-h-0 flex-1" type="always">
        <div className="p-2" role="listbox" aria-label={ariaLabel}>
          {commits.map((commit, index) => {
            const active = commit.sha === selectedSha
            const versionNumber = buildVersionNumber(index, totalEdits, commits.length)
            const context = describeTimelineContext(commit)
            const relativeTime = formatRelativeTimeCompact(commit.date)
            const isCurrentVersion = currentVersionNumber != null && versionNumber === currentVersionNumber
            const parts = [`v${versionNumber}`, relativeTime, context, `by ${commit.author}`]
            if (showCurrentBadge && isCurrentVersion) {
              parts.push('current version')
            }

            return (
              <button
                key={commit.sha}
                type="button"
                role="option"
                aria-selected={active}
                aria-label={parts.filter(Boolean).join(', ')}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] transition-colors',
                  active ? 'bg-primary/10 text-foreground' : 'text-foreground hover:bg-accent/40',
                )}
                data-testid={`cortex-version-option-${commit.sha}`}
                onClick={() => {
                  onSelectCommit(commit.sha)
                  onActivateCommit?.(commit.sha)
                }}
              >
                <span className={cn('shrink-0 font-medium', active ? 'text-primary' : 'text-foreground')}>{`v${versionNumber}`}</span>
                <span className="shrink-0 text-muted-foreground">•</span>
                <span className="shrink-0 text-muted-foreground">{relativeTime}</span>
                <span className="shrink-0 text-muted-foreground">•</span>
                <span className="min-w-0 truncate text-muted-foreground">{context}</span>
                {showCurrentBadge && isCurrentVersion ? (
                  <span className="ml-auto shrink-0 rounded-full border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Current
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </ScrollArea>

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
              'Load more versions'
            )}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
