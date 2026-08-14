import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileX2, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CommitList } from './CommitList'
import { DiffPane } from './DiffPane'
import { FileList } from './FileList'
import {
  KNOWLEDGE_QUICK_FILTERS,
  commitMatchesKnowledgeQuickFilter,
  matchesKnowledgeQuickFilter,
  type KnowledgeQuickFilterId,
} from './knowledge-surface'
import { SourceControlExplorer } from './SourceControlExplorer'
import {
  useGitCommitDetail,
  useGitCommitDiff,
  useGitDiff,
  useGitLog,
  type GitLogEntry,
  type GitRepoTarget,
  type GitStatusResult,
} from './use-diff-queries'
import { useResizablePanel } from './useResizablePanel'
import type { HistoryStatusInfo } from './HistoryView'

const PAGE_SIZE = 50

interface SourceControlActivityViewProps {
  wsUrl: string
  agentId: string | null
  repoTarget: GitRepoTarget
  worktreeId?: string | null
  status: GitStatusResult | null
  isStatusLoading: boolean
  statusError: string | null
  refreshToken?: number
  initialSha?: string | null
  initialFile?: string | null
  initialQuickFilter?: KnowledgeQuickFilterId
  focusSection: 'changes' | 'history'
  onFocusSectionChange: (section: 'changes' | 'history') => void
  onHistoryStatusChange?: (info: HistoryStatusInfo | null) => void
}

export function SourceControlActivityView({
  wsUrl,
  agentId,
  repoTarget,
  worktreeId = null,
  status,
  isStatusLoading,
  statusError,
  refreshToken = 0,
  initialSha = null,
  initialFile = null,
  initialQuickFilter = 'all',
  focusSection,
  onFocusSectionChange,
  onHistoryStatusChange,
}: SourceControlActivityViewProps) {
  const [selectedWorkingFile, setSelectedWorkingFile] = useState<string | null>(initialFile)
  const [workingQuickFilter, setWorkingQuickFilter] = useState<KnowledgeQuickFilterId>(initialQuickFilter)
  const [selectedSha, setSelectedSha] = useState<string | null>(initialSha)
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(initialFile)
  const [historyQuickFilter, setHistoryQuickFilter] = useState<KnowledgeQuickFilterId>(initialQuickFilter)
  const [allCommits, setAllCommits] = useState<GitLogEntry[]>([])
  const [currentOffset, setCurrentOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [detailFocus, setDetailFocus] = useState<'working-tree' | 'commit'>(
    focusSection === 'history' ? 'commit' : 'working-tree',
  )
  const prevContextKeyRef = useRef(`${agentId ?? ''}:${repoTarget}:${worktreeId ?? ''}`)
  const prevRefreshTokenRef = useRef(refreshToken)
  const isKnowledgeMode = repoTarget === 'versioning'
  const files = useMemo(() => status?.files ?? [], [status?.files])
  const workingDiffQuery = useGitDiff(wsUrl, agentId, repoTarget, selectedWorkingFile, worktreeId)
  const logQuery = useGitLog(wsUrl, agentId, repoTarget, PAGE_SIZE, currentOffset, worktreeId)

  useEffect(() => {
    const contextKey = `${agentId ?? ''}:${repoTarget}:${worktreeId ?? ''}`
    if (contextKey !== prevContextKeyRef.current) {
      prevContextKeyRef.current = contextKey
      setSelectedWorkingFile(initialFile)
      setWorkingQuickFilter(initialQuickFilter)
      setAllCommits([])
      setCurrentOffset(0)
      setHasMore(false)
      setSelectedSha(initialSha)
      setSelectedCommitFile(initialFile)
      setHistoryQuickFilter(initialQuickFilter)
      setDetailFocus(focusSection === 'history' ? 'commit' : 'working-tree')
      onHistoryStatusChange?.(null)
    }
  }, [agentId, focusSection, initialFile, initialQuickFilter, initialSha, onHistoryStatusChange, repoTarget, worktreeId])

  useEffect(() => {
    setSelectedWorkingFile(initialFile)
    setWorkingQuickFilter(initialQuickFilter)
  }, [agentId, initialFile, initialQuickFilter, repoTarget])

  const visibleWorkingFiles = useMemo(() => {
    if (repoTarget !== 'versioning') {
      return files
    }

    return files.filter((file) => matchesKnowledgeQuickFilter(file.path, workingQuickFilter))
  }, [files, repoTarget, workingQuickFilter])

  useEffect(() => {
    if (visibleWorkingFiles.length > 0 && (!selectedWorkingFile || !visibleWorkingFiles.some((file) => file.path === selectedWorkingFile))) {
      setSelectedWorkingFile(visibleWorkingFiles[0].path)
    } else if (visibleWorkingFiles.length === 0) {
      setSelectedWorkingFile(null)
    }
  }, [selectedWorkingFile, visibleWorkingFiles])

  useEffect(() => {
    if (!logQuery.data) return

    const newCommits = logQuery.data.commits
    setHasMore(logQuery.data.hasMore)
    setIsLoadingMore(false)

    if (currentOffset === 0) {
      setAllCommits(newCommits)
    } else {
      setAllCommits((previous) => {
        const existingShas = new Set(previous.map((commit) => commit.sha))
        return [...previous, ...newCommits.filter((commit) => !existingShas.has(commit.sha))]
      })
    }
  }, [currentOffset, logQuery.data])

  const filteredCommits = useMemo(() => {
    if (!isKnowledgeMode) {
      return allCommits
    }

    return allCommits.filter((commit) => commitMatchesKnowledgeQuickFilter(commit.metadata, historyQuickFilter))
  }, [allCommits, historyQuickFilter, isKnowledgeMode])

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

  const commitDetailQuery = useGitCommitDetail(wsUrl, agentId, repoTarget, selectedSha, worktreeId)
  const commitFiles = useMemo(() => commitDetailQuery.data?.files ?? [], [commitDetailQuery.data?.files])
  const filteredCommitFiles = useMemo(() => {
    if (!isKnowledgeMode) {
      return commitFiles
    }

    return commitFiles.filter((file) => matchesKnowledgeQuickFilter(file.path, historyQuickFilter))
  }, [commitFiles, historyQuickFilter, isKnowledgeMode])

  useEffect(() => {
    if (selectedSha == null) {
      if (selectedCommitFile !== null) {
        setSelectedCommitFile(null)
      }
      return
    }

    if (
      filteredCommitFiles.length > 0 &&
      (!selectedCommitFile || !filteredCommitFiles.some((file) => file.path === selectedCommitFile))
    ) {
      setSelectedCommitFile(filteredCommitFiles[0].path)
    } else if (filteredCommitFiles.length === 0) {
      setSelectedCommitFile(null)
    }
  }, [filteredCommitFiles, selectedCommitFile, selectedSha])

  const commitDiffQuery = useGitCommitDiff(wsUrl, agentId, repoTarget, selectedSha, selectedCommitFile, worktreeId)

  useEffect(() => {
    if (refreshToken === prevRefreshTokenRef.current) {
      return
    }

    prevRefreshTokenRef.current = refreshToken
    setAllCommits([])
    setHasMore(false)
    setIsLoadingMore(false)
    setSelectedSha(null)
    setSelectedCommitFile(null)
    workingDiffQuery.refetch()

    if (currentOffset !== 0) {
      setCurrentOffset(0)
      return
    }

    logQuery.refetch()
    commitDetailQuery.refetch()
    commitDiffQuery.refetch()
  }, [commitDetailQuery, commitDiffQuery, currentOffset, logQuery, refreshToken, workingDiffQuery])

  useEffect(() => {
    if (!onHistoryStatusChange) return
    if (detailFocus !== 'commit' || !selectedSha || !commitDetailQuery.data) {
      onHistoryStatusChange(null)
      return
    }

    const commit = allCommits.find((entry) => entry.sha === selectedSha)
    const detail = commitDetailQuery.data
    const visibleFiles = isKnowledgeMode && historyQuickFilter !== 'all' ? filteredCommitFiles : detail.files
    const summary = computeCommitSummary(visibleFiles)
    onHistoryStatusChange({
      sha: detail.sha,
      shortSha: commit?.shortSha ?? detail.sha.slice(0, 7),
      author: detail.author,
      date: detail.date,
      filesChanged: visibleFiles.length,
      insertions: summary.insertions,
      deletions: summary.deletions,
    })
  }, [
    allCommits,
    commitDetailQuery.data,
    detailFocus,
    filteredCommitFiles,
    historyQuickFilter,
    isKnowledgeMode,
    onHistoryStatusChange,
    selectedSha,
  ])

  const handleSelectWorkingFile = useCallback((path: string) => {
    setSelectedWorkingFile(path)
    setDetailFocus('working-tree')
    onFocusSectionChange('changes')
  }, [onFocusSectionChange])

  const handleSelectCommit = useCallback((sha: string) => {
    setSelectedSha(sha)
    setDetailFocus('commit')
    onFocusSectionChange('history')
  }, [onFocusSectionChange])

  const handleLoadMore = useCallback(() => {
    setIsLoadingMore(true)
    setCurrentOffset((previous) => previous + PAGE_SIZE)
  }, [])

  const { width: sidebarWidth, isDragging: isSidebarDragging, handleRef: sidebarHandleRef } = useResizablePanel({
    storageKey: 'forge-diff-sidebar-width',
    defaultWidth: repoTarget === 'workspace' ? 320 : 260,
    minWidth: repoTarget === 'workspace' ? 220 : 170,
    maxWidth: 520,
  })

  const { width: commitFileListWidth, isDragging: isCommitFileListDragging, handleRef: commitFileListHandleRef } =
    useResizablePanel({
      storageKey: 'forge-diff-history-files-width',
      defaultWidth: 220,
      minWidth: 170,
      maxWidth: 420,
    })

  const visibleWorkingSummary = {
    filesChanged: visibleWorkingFiles.length,
    insertions: visibleWorkingFiles.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: visibleWorkingFiles.reduce((total, file) => total + (file.deletions ?? 0), 0),
  }
  const visibleCommitSummary = {
    filesChanged: filteredCommitFiles.length,
    ...computeCommitSummary(filteredCommitFiles),
  }
  const isInitialHistoryLoading = logQuery.isLoading && allCommits.length === 0
  const historyEmptyState = logQuery.error
    ? { title: 'Unable to load history', description: logQuery.error }
    : !isInitialHistoryLoading && allCommits.length === 0
      ? { title: 'No commits found', description: 'This repository has no commit history' }
      : null
  const showWorkingFileList = !statusError && (isStatusLoading || files.length > 0)
  const showingCommitDetail = detailFocus === 'commit' && !historyEmptyState

  return (
    <div className="flex h-full">
      <div className="shrink-0 border-r border-border/60" style={{ width: sidebarWidth }}>
        <SourceControlExplorer
          changesCount={visibleWorkingSummary.filesChanged}
          focusSection={focusSection}
          onSectionFocus={onFocusSectionChange}
          changes={
            showWorkingFileList ? (
              <FileList
                files={files}
                selectedFile={detailFocus === 'working-tree' ? selectedWorkingFile : null}
                onSelectFile={handleSelectWorkingFile}
                isLoading={isStatusLoading}
                summary={visibleWorkingSummary}
                repoTarget={repoTarget}
                quickFilter={workingQuickFilter}
                onQuickFilterChange={setWorkingQuickFilter}
              />
            ) : (
              <CompactEmptyState
                title={statusError ? 'Unable to read repository' : 'No uncommitted changes'}
                description={statusError ?? 'Working directory is clean'}
              />
            )
          }
          history={
            historyEmptyState ? (
              <CompactEmptyState title={historyEmptyState.title} description={historyEmptyState.description} />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                {isKnowledgeMode ? (
                  <div className="border-b border-border/60 p-2">
                    <div className="flex flex-wrap gap-1">
                      {KNOWLEDGE_QUICK_FILTERS.map((option) => {
                        const active = option.id === historyQuickFilter
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
                            onClick={() => setHistoryQuickFilter(option.id)}
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
                    selectedSha={detailFocus === 'commit' ? selectedSha : null}
                    onSelectCommit={handleSelectCommit}
                    isLoading={isInitialHistoryLoading}
                    hasMore={hasMore}
                    onLoadMore={handleLoadMore}
                    isLoadingMore={isLoadingMore}
                    repoTarget={repoTarget}
                    emptyMessage={isKnowledgeMode && historyQuickFilter !== 'all' ? 'No commits match this filter' : 'No commits found'}
                  />
                </div>
              </div>
            )
          }
        />
      </div>

      <div
        ref={sidebarHandleRef}
        className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
          isSidebarDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
        }`}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

      {showingCommitDetail ? (
        <div className="shrink-0 border-r border-border/60" style={{ width: commitFileListWidth }}>
          {selectedSha ? (
            <FileList
              files={commitFiles}
              selectedFile={selectedCommitFile}
              onSelectFile={setSelectedCommitFile}
              isLoading={commitDetailQuery.isLoading}
              summary={visibleCommitSummary}
              repoTarget={repoTarget}
              quickFilter={historyQuickFilter}
              onQuickFilterChange={setHistoryQuickFilter}
              listLabel="Commit files"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
              {isKnowledgeMode && historyQuickFilter !== 'all' ? 'No commit matches the selected filter' : 'Select a commit to view files'}
            </div>
          )}
        </div>
      ) : null}

      {showingCommitDetail ? (
        <div
          ref={commitFileListHandleRef}
          className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
            isCommitFileListDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
          }`}
          style={{ width: 6 }}
        >
          <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        {showingCommitDetail ? (
          <DiffPane
            fileName={selectedCommitFile}
            oldContent={commitDiffQuery.data?.oldContent ?? null}
            newContent={commitDiffQuery.data?.newContent ?? null}
            isLoading={commitDiffQuery.isLoading}
            error={commitDiffQuery.error}
            truncated={commitDiffQuery.data?.truncated}
            truncatedReason={commitDiffQuery.data?.reason}
          />
        ) : statusError ? (
          <FullEmptyState icon="changes" title="Unable to read repository" description={statusError} />
        ) : !isStatusLoading && files.length === 0 ? (
          <FullEmptyState icon="changes" title="No uncommitted changes" description="Working directory is clean" />
        ) : (
          <DiffPane
            fileName={selectedWorkingFile}
            oldContent={workingDiffQuery.data?.oldContent ?? null}
            newContent={workingDiffQuery.data?.newContent ?? null}
            isLoading={workingDiffQuery.isLoading}
            error={workingDiffQuery.error}
            truncated={workingDiffQuery.data?.truncated}
            truncatedReason={workingDiffQuery.data?.reason}
          />
        )}
      </div>
    </div>
  )
}

function CompactEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-3 text-center text-muted-foreground">
      <span className="text-xs font-medium">{title}</span>
      <span className="mt-1 text-[11px] opacity-60">{description}</span>
    </div>
  )
}

function FullEmptyState({
  icon,
  title,
  description,
}: {
  icon: 'changes' | 'history'
  title: string
  description: string
}) {
  const Icon = icon === 'history' ? History : FileX2
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
      <Icon className="mb-3 size-12 opacity-25" />
      <span className="text-sm font-medium">{title}</span>
      <span className="mt-1 max-w-sm text-center text-xs opacity-60">{description}</span>
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
