import { useCallback, useEffect, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { FileList } from './FileList'
import { DiffPane } from './DiffPane'
import { CommitList } from './CommitList'
import { useGitLog, useGitCommitDetail, useGitCommitFileDiff } from './use-diff-queries'
import { useResizablePanel } from './useResizablePanel'
import type { GitLogEntry } from './use-diff-queries'

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
  onStatusChange?: (info: HistoryStatusInfo | null) => void
}

export function HistoryView({ wsUrl, agentId, onStatusChange }: HistoryViewProps) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [allCommits, setAllCommits] = useState<GitLogEntry[]>([])
  const [currentOffset, setCurrentOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const prevAgentIdRef = useRef(agentId)

  // Fetch the current page of commits
  const logQuery = useGitLog(wsUrl, agentId, PAGE_SIZE, currentOffset)

  // Reset state when agentId changes
  useEffect(() => {
    if (agentId !== prevAgentIdRef.current) {
      prevAgentIdRef.current = agentId
      setAllCommits([])
      setCurrentOffset(0)
      setHasMore(false)
      setSelectedSha(null)
      setSelectedFile(null)
    }
  }, [agentId])

  // Accumulate commits from paginated results
  useEffect(() => {
    if (!logQuery.data) return

    const newCommits = logQuery.data.commits
    setHasMore(logQuery.data.hasMore)
    setIsLoadingMore(false)

    if (currentOffset === 0) {
      // First page — replace
      setAllCommits(newCommits)
    } else {
      // Subsequent page — append (deduplicate by sha)
      setAllCommits((prev) => {
        const existingShas = new Set(prev.map((c) => c.sha))
        const unique = newCommits.filter((c) => !existingShas.has(c.sha))
        return [...prev, ...unique]
      })
    }
  }, [logQuery.data, currentOffset])

  // Auto-select first commit when commit list first loads
  useEffect(() => {
    if (allCommits.length > 0 && !selectedSha) {
      setSelectedSha(allCommits[0].sha)
    }
  }, [allCommits, selectedSha])

  // Fetch details for selected commit
  const commitDetailQuery = useGitCommitDetail(wsUrl, agentId, selectedSha)

  // Reset file selection when commit changes
  const prevShaRef = useRef(selectedSha)
  useEffect(() => {
    if (selectedSha !== prevShaRef.current) {
      prevShaRef.current = selectedSha
      setSelectedFile(null)
    }
  }, [selectedSha])

  // Auto-select first file when commit detail loads
  const commitFiles = commitDetailQuery.data?.files ?? []
  useEffect(() => {
    if (commitFiles.length > 0 && !selectedFile) {
      setSelectedFile(commitFiles[0].path)
    }
  }, [commitFiles, selectedFile])

  // Fetch diff for selected file in selected commit
  const fileDiffQuery = useGitCommitFileDiff(wsUrl, agentId, selectedSha, selectedFile)

  // Report status info to parent
  useEffect(() => {
    if (!onStatusChange) return

    if (!selectedSha || !commitDetailQuery.data) {
      onStatusChange(null)
      return
    }

    const commit = allCommits.find((c) => c.sha === selectedSha)
    const detail = commitDetailQuery.data
    const summary = computeCommitSummary(detail.files)

    onStatusChange({
      sha: detail.sha,
      shortSha: commit?.shortSha ?? detail.sha.slice(0, 7),
      author: detail.author,
      date: detail.date,
      filesChanged: detail.files.length,
      insertions: summary.insertions,
      deletions: summary.deletions,
    })
  }, [selectedSha, commitDetailQuery.data, allCommits, onStatusChange])

  // Load more handler
  const handleLoadMore = useCallback(() => {
    setIsLoadingMore(true)
    setCurrentOffset((prev) => prev + PAGE_SIZE)
  }, [])

  // Handle commit selection
  const handleSelectCommit = useCallback((sha: string) => {
    setSelectedSha(sha)
  }, [])

  const { width: commitListWidth, isDragging: isCommitListDragging, handleRef: commitListHandleRef } =
    useResizablePanel({
      storageKey: 'forge-diff-history-commits-width',
      defaultWidth: 220,
      minWidth: 150,
      maxWidth: 400,
    })

  const { width: fileListWidth, isDragging: isFileListDragging, handleRef: fileListHandleRef } =
    useResizablePanel({
      storageKey: 'forge-diff-history-files-width',
      defaultWidth: 200,
      minWidth: 150,
      maxWidth: 400,
    })

  const isInitialLoading = logQuery.isLoading && allCommits.length === 0

  // Empty state — no commits at all.
  // Also guard against the intermediate render where logQuery.data has arrived
  // but allCommits hasn't been populated yet (it's set in a useEffect).
  const hasPendingData = !!logQuery.data?.commits?.length && allCommits.length === 0
  if (!isInitialLoading && !hasPendingData && allCommits.length === 0 && !logQuery.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <History className="mb-3 size-12 opacity-25" />
        <span className="text-sm font-medium">No commits found</span>
        <span className="mt-1 text-xs opacity-60">
          This repository has no commit history
        </span>
      </div>
    )
  }

  // Error state
  if (logQuery.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <History className="mb-3 size-12 opacity-25" />
        <span className="text-sm font-medium">Unable to load history</span>
        <span className="mt-1 max-w-sm text-center text-xs opacity-60">
          {logQuery.error}
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Left panel — commit list */}
      <div className="shrink-0 border-r border-border/60" style={{ width: commitListWidth }}>
        <CommitList
          commits={allCommits}
          selectedSha={selectedSha}
          onSelectCommit={handleSelectCommit}
          isLoading={isInitialLoading}
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
          isLoadingMore={isLoadingMore}
        />
      </div>

      {/* Drag handle */}
      <div
        ref={commitListHandleRef}
        className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
          isCommitListDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
        }`}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

      {/* Center panel — file list */}
      <div className="shrink-0 border-r border-border/60" style={{ width: fileListWidth }}>
        {selectedSha ? (
          <FileList
            files={commitFiles}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
            isLoading={commitDetailQuery.isLoading}
            summary={
              commitFiles.length > 0
                ? {
                    filesChanged: commitFiles.length,
                    ...computeCommitSummary(commitFiles),
                  }
                : undefined
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
            Select a commit to view files
          </div>
        )}
      </div>

      {/* Drag handle */}
      <div
        ref={fileListHandleRef}
        className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
          isFileListDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
        }`}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

      {/* Right panel — diff pane */}
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function computeCommitSummary(files: { additions?: number; deletions?: number }[]): {
  insertions: number
  deletions: number
} {
  let insertions = 0
  let deletions = 0
  for (const f of files) {
    insertions += f.additions ?? 0
    deletions += f.deletions ?? 0
  }
  return { insertions, deletions }
}
