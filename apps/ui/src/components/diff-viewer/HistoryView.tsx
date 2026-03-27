import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileList } from './FileList'
import { DiffPane } from './DiffPane'
import { CommitList } from './CommitList'
import {
  KNOWLEDGE_QUICK_FILTERS,
  commitMatchesKnowledgeQuickFilter,
  matchesKnowledgeQuickFilter,
  type KnowledgeQuickFilterId,
} from './knowledge-surface'
import { useGitLog, useGitCommitDetail, useGitCommitDiff } from './use-diff-queries'
import { useResizablePanel } from './useResizablePanel'
import type { GitLogEntry, GitRepoTarget } from './use-diff-queries'

const PAGE_SIZE = 50

export interface HistoryStatusInfo {
  sha: string
  shortSha: string
  author: string
  date: string
  filesChanged: number
  insertions: number
  deletions: number
}

interface HistoryViewProps {
  wsUrl: string
  agentId: string | null
  repoTarget: GitRepoTarget
  onStatusChange?: (info: HistoryStatusInfo | null) => void
  refreshToken?: number
}

export function HistoryView({ wsUrl, agentId, repoTarget, onStatusChange, refreshToken = 0 }: HistoryViewProps) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [allCommits, setAllCommits] = useState<GitLogEntry[]>([])
  const [currentOffset, setCurrentOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [quickFilter, setQuickFilter] = useState<KnowledgeQuickFilterId>('all')
  const prevContextKeyRef = useRef(`${agentId ?? ''}:${repoTarget}`)
  const prevRefreshTokenRef = useRef(refreshToken)
  const isKnowledgeMode = repoTarget === 'versioning'

  const logQuery = useGitLog(wsUrl, agentId, repoTarget, PAGE_SIZE, currentOffset)

  useEffect(() => {
    const contextKey = `${agentId ?? ''}:${repoTarget}`
    if (contextKey !== prevContextKeyRef.current) {
      prevContextKeyRef.current = contextKey
      setAllCommits([])
      setCurrentOffset(0)
      setHasMore(false)
      setSelectedSha(null)
      setSelectedFile(null)
      setQuickFilter('all')
      onStatusChange?.(null)
    }
  }, [agentId, onStatusChange, repoTarget])

  useEffect(() => {
    if (!logQuery.data) return

    const newCommits = logQuery.data.commits
    setHasMore(logQuery.data.hasMore)
    setIsLoadingMore(false)

    if (currentOffset === 0) {
      setAllCommits(newCommits)
    } else {
      setAllCommits((prev) => {
        const existingShas = new Set(prev.map((commit) => commit.sha))
        const unique = newCommits.filter((commit) => !existingShas.has(commit.sha))
        return [...prev, ...unique]
      })
    }
  }, [logQuery.data, currentOffset])

  const filteredCommits = useMemo(() => {
    if (!isKnowledgeMode) {
      return allCommits
    }

    return allCommits.filter((commit) => commitMatchesKnowledgeQuickFilter(commit.metadata, quickFilter))
  }, [allCommits, isKnowledgeMode, quickFilter])

  useEffect(() => {
    if (filteredCommits.length === 0) {
      if (selectedSha !== null) {
        setSelectedSha(null)
      }
      return
    }

    if (!selectedSha || !filteredCommits.some((commit) => commit.sha === selectedSha)) {
      setSelectedSha(filteredCommits[0].sha)
    }
  }, [filteredCommits, selectedSha])

  const commitDetailQuery = useGitCommitDetail(wsUrl, agentId, repoTarget, selectedSha)
  const commitFiles = commitDetailQuery.data?.files ?? []

  const filteredCommitFiles = useMemo(() => {
    if (!isKnowledgeMode) {
      return commitFiles
    }

    return commitFiles.filter((file) => matchesKnowledgeQuickFilter(file.path, quickFilter))
  }, [commitFiles, isKnowledgeMode, quickFilter])

  useEffect(() => {
    if (selectedSha == null) {
      if (selectedFile !== null) {
        setSelectedFile(null)
      }
      return
    }

    if (
      filteredCommitFiles.length > 0 &&
      (!selectedFile || !filteredCommitFiles.some((file) => file.path === selectedFile))
    ) {
      setSelectedFile(filteredCommitFiles[0].path)
    } else if (filteredCommitFiles.length === 0) {
      setSelectedFile(null)
    }
  }, [filteredCommitFiles, selectedFile, selectedSha])

  const fileDiffQuery = useGitCommitDiff(wsUrl, agentId, repoTarget, selectedSha, selectedFile)

  useEffect(() => {
    if (refreshToken === prevRefreshTokenRef.current) {
      return
    }

    prevRefreshTokenRef.current = refreshToken
    setAllCommits([])
    setHasMore(false)
    setIsLoadingMore(false)
    setSelectedSha(null)
    setSelectedFile(null)

    if (currentOffset !== 0) {
      setCurrentOffset(0)
      return
    }

    logQuery.refetch()
    commitDetailQuery.refetch()
    fileDiffQuery.refetch()
  }, [commitDetailQuery, currentOffset, fileDiffQuery, logQuery, refreshToken])

  useEffect(() => {
    if (!onStatusChange) return

    if (!selectedSha || !commitDetailQuery.data) {
      onStatusChange(null)
      return
    }

    const commit = allCommits.find((entry) => entry.sha === selectedSha)
    const detail = commitDetailQuery.data
    const visibleFiles = isKnowledgeMode && quickFilter !== 'all' ? filteredCommitFiles : detail.files
    const summary = computeCommitSummary(visibleFiles)

    onStatusChange({
      sha: detail.sha,
      shortSha: commit?.shortSha ?? detail.sha.slice(0, 7),
      author: detail.author,
      date: detail.date,
      filesChanged: visibleFiles.length,
      insertions: summary.insertions,
      deletions: summary.deletions,
    })
  }, [selectedSha, commitDetailQuery.data, allCommits, filteredCommitFiles, isKnowledgeMode, onStatusChange, quickFilter])

  const handleLoadMore = useCallback(() => {
    setIsLoadingMore(true)
    setCurrentOffset((prev) => prev + PAGE_SIZE)
  }, [])

  const { width: commitListWidth, isDragging: isCommitListDragging, handleRef: commitListHandleRef } =
    useResizablePanel({
      storageKey: 'forge-diff-history-commits-width',
      defaultWidth: 260,
      minWidth: 190,
      maxWidth: 420,
    })

  const { width: fileListWidth, isDragging: isFileListDragging, handleRef: fileListHandleRef } =
    useResizablePanel({
      storageKey: 'forge-diff-history-files-width',
      defaultWidth: 220,
      minWidth: 170,
      maxWidth: 420,
    })

  const isInitialLoading = logQuery.isLoading && allCommits.length === 0
  const hasPendingData = !!logQuery.data?.commits?.length && allCommits.length === 0
  if (!isInitialLoading && !hasPendingData && allCommits.length === 0 && !logQuery.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <History className="mb-3 size-12 opacity-25" />
        <span className="text-sm font-medium">No commits found</span>
        <span className="mt-1 text-xs opacity-60">This repository has no commit history</span>
      </div>
    )
  }

  if (logQuery.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <History className="mb-3 size-12 opacity-25" />
        <span className="text-sm font-medium">Unable to load history</span>
        <span className="mt-1 max-w-sm text-center text-xs opacity-60">{logQuery.error}</span>
      </div>
    )
  }

  const visibleFileSummary = {
    filesChanged: filteredCommitFiles.length,
    ...computeCommitSummary(filteredCommitFiles),
  }

  return (
    <div className="flex h-full">
      <div className="shrink-0 border-r border-border/60" style={{ width: commitListWidth }}>
        <div className="flex h-full flex-col">
          {isKnowledgeMode ? (
            <div className="border-b border-border/60 p-2">
              <div className="flex flex-wrap gap-1">
                {KNOWLEDGE_QUICK_FILTERS.map((option) => {
                  const active = option.id === quickFilter
                  return (
                    <button
                      key={option.id}
                      type="button"
                      title={option.pathLabel}
                      className={cn(
                        'inline-flex h-6 items-center rounded-full border px-2 text-[10px] font-medium transition-colors',
                        active
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border/60 bg-muted/30 text-muted-foreground hover:border-border hover:text-foreground',
                      )}
                      aria-pressed={active}
                      onClick={() => setQuickFilter(option.id)}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <CommitList
              commits={filteredCommits}
              selectedSha={selectedSha}
              onSelectCommit={setSelectedSha}
              isLoading={isInitialLoading}
              hasMore={hasMore}
              onLoadMore={handleLoadMore}
              isLoadingMore={isLoadingMore}
              repoTarget={repoTarget}
              emptyMessage={isKnowledgeMode && quickFilter !== 'all' ? 'No commits match this filter' : 'No commits found'}
            />
          </div>
        </div>
      </div>

      <div
        ref={commitListHandleRef}
        className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
          isCommitListDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
        }`}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

      <div className="shrink-0 border-r border-border/60" style={{ width: fileListWidth }}>
        {selectedSha ? (
          <FileList
            files={commitFiles}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
            isLoading={commitDetailQuery.isLoading}
            summary={visibleFileSummary}
            repoTarget={repoTarget}
            quickFilter={quickFilter}
            onQuickFilterChange={setQuickFilter}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
            {isKnowledgeMode && quickFilter !== 'all' ? 'No commit matches the selected filter' : 'Select a commit to view files'}
          </div>
        )}
      </div>

      <div
        ref={fileListHandleRef}
        className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
          isFileListDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
        }`}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

      <div className="min-w-0 flex-1">
        <DiffPane
          fileName={selectedFile}
          oldContent={fileDiffQuery.data?.oldContent ?? null}
          newContent={fileDiffQuery.data?.newContent ?? null}
          isLoading={fileDiffQuery.isLoading}
          error={fileDiffQuery.error}
          truncated={fileDiffQuery.data?.truncated}
          truncatedReason={fileDiffQuery.data?.reason}
        />
      </div>
    </div>
  )
}

function computeCommitSummary(files: { additions?: number; deletions?: number }[]): {
  insertions: number
  deletions: number
} {
  let insertions = 0
  let deletions = 0
  for (const file of files) {
    insertions += file.additions ?? 0
    deletions += file.deletions ?? 0
  }
  return { insertions, deletions }
}
