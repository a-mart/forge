import { useCallback, useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { GitRepoTarget } from '@forge/protocol'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { CommitMetadataBadges } from './CommitMetadataBadges'
import { formatCommitSummary } from './formatCommitSummary'
import type { GitLogEntry } from './use-diff-queries'

interface CommitListProps {
  commits: GitLogEntry[]
  selectedSha: string | null
  onSelectCommit: (sha: string) => void
  isLoading: boolean
  hasMore: boolean
  onLoadMore: () => void
  isLoadingMore: boolean
  repoTarget: GitRepoTarget
  emptyMessage?: string
}

export function CommitList({
  commits,
  selectedSha,
  onSelectCommit,
  isLoading,
  hasMore,
  onLoadMore,
  isLoadingMore,
  repoTarget,
  emptyMessage = 'No commits found',
}: CommitListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const useEnhancedRendering = repoTarget === 'versioning'

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (commits.length === 0) return
      const currentIndex = commits.findIndex((c) => c.sha === selectedSha)

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const nextIndex = currentIndex < commits.length - 1 ? currentIndex + 1 : currentIndex
        onSelectCommit(commits[nextIndex].sha)
        scrollItemIntoView(listRef.current, nextIndex)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : 0
        onSelectCommit(commits[prevIndex].sha)
        scrollItemIntoView(listRef.current, prevIndex)
      }
    },
    [commits, selectedSha, onSelectCommit],
  )

  useEffect(() => {
    if (selectedSha && listRef.current) {
      const idx = commits.findIndex((c) => c.sha === selectedSha)
      if (idx >= 0) scrollItemIntoView(listRef.current, idx)
    }
  }, [selectedSha, commits])

  if (isLoading) {
    return (
      <div className="flex h-full flex-col p-2">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-3 w-3/4 rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-3 text-center text-xs text-muted-foreground">
        <span>{emptyMessage}</span>
        {hasMore ? (
          <button
            type="button"
            className="inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Loading…
              </>
            ) : (
              'Load more'
            )}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto p-1"
        role="listbox"
        aria-label="Commit history"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {commits.map((commit) => {
          const isSelected = selectedSha === commit.sha
          const summary = useEnhancedRendering ? formatCommitSummary(commit) : commit.message.split('\n')[0]

          return (
            <button
              key={commit.sha}
              role="option"
              aria-selected={isSelected}
              aria-label={`${summary}, by ${commit.author}, ${formatRelativeTime(commit.date)}`}
              className={cn(
                'flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors',
                isSelected
                  ? 'bg-accent/80 text-foreground'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
              onClick={() => onSelectCommit(commit.sha)}
            >
              <span className="truncate text-xs font-medium leading-tight text-foreground">{summary}</span>
              <span className="flex items-center gap-1.5 text-[10px] leading-tight text-muted-foreground">
                <span className="truncate">{commit.author}</span>
                <span className="shrink-0 opacity-60">·</span>
                <span className="shrink-0">{formatRelativeTime(commit.date)}</span>
              </span>
              {useEnhancedRendering ? <CommitMetadataBadges metadata={commit.metadata} /> : null}
            </button>
          )
        })}

        {hasMore ? (
          <button
            type="button"
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded px-2 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Loading…
              </>
            ) : (
              'Load more'
            )}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function scrollItemIntoView(container: HTMLElement | null, index: number) {
  if (!container) return
  const items = container.querySelectorAll('[role="option"]')
  items[index]?.scrollIntoView({ block: 'nearest' })
}

function formatRelativeTime(isoDate: string): string {
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diffMs = now - then

  if (diffMs < 0) return 'just now'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`

  const years = Math.floor(months / 12)
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}
