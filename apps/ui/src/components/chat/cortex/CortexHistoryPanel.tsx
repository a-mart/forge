import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CortexDocumentEntry, GitLogEntry } from '@forge/protocol'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ArtifactReference } from '@/lib/artifacts'
import type { DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
import { resolveKnowledgeQuickFilterForPath } from '@/components/diff-viewer/knowledge-surface'
import { CortexFileHistoryStats } from './CortexFileHistoryStats'
import { CortexFileTimeline } from './CortexFileTimeline'
import { CortexHistoryActivitySummary } from './CortexHistoryActivitySummary'
import { CortexInlineHistoryDiff } from './CortexInlineHistoryDiff'
import { CortexLastReviewRunCard } from './CortexLastReviewRunCard'
import { useCortexFileReviewHistory, useGitFileLog } from './use-cortex-history'

const PAGE_SIZE = 12

interface CortexHistoryPanelProps {
  wsUrl: string
  agentId?: string | null
  document: Pick<CortexDocumentEntry, 'absolutePath' | 'gitPath' | 'label'> | null
  documents: CortexDocumentEntry[]
  refreshKey?: number
  pendingSelection?: { reviewId: string | null; sha: string | null } | null
  onExitHistoryMode: () => void
  onArtifactClick?: (artifact: ArtifactReference) => void
  onOpenSession?: (agentId: string) => void
  canOpenSession?: (agentId: string) => boolean
  onSelectDocument?: (documentId: string) => void
  onOpenDiffViewer?: (initialState: DiffViewerInitialState) => void
}

export function CortexHistoryPanel({
  wsUrl,
  agentId,
  document,
  documents,
  refreshKey = 0,
  pendingSelection,
  onExitHistoryMode,
  onArtifactClick,
  onOpenSession,
  canOpenSession,
  onSelectDocument,
  onOpenDiffViewer,
}: CortexHistoryPanelProps) {
  const [offset, setOffset] = useState(0)
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [selectedSha, setSelectedSha] = useState<string | null>(pendingSelection?.sha ?? null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const fileLogQuery = useGitFileLog(wsUrl, agentId, document?.gitPath ?? null, PAGE_SIZE, offset)
  const reviewHistoryQuery = useCortexFileReviewHistory(wsUrl, document?.gitPath ?? null, 10)

  useEffect(() => {
    setOffset(0)
    setCommits([])
    setSelectedSha(pendingSelection?.sha ?? null)
    setIsLoadingMore(false)
  }, [document?.absolutePath, document?.gitPath, pendingSelection?.reviewId, pendingSelection?.sha, refreshKey])

  useEffect(() => {
    if (!fileLogQuery.data) {
      return
    }

    setIsLoadingMore(false)
    if (offset === 0) {
      setCommits(fileLogQuery.data.commits)
      return
    }

    setCommits((previous) => {
      const existing = new Set(previous.map((commit) => commit.sha))
      const nextCommits = fileLogQuery.data?.commits.filter((commit) => !existing.has(commit.sha)) ?? []
      return [...previous, ...nextCommits]
    })
  }, [fileLogQuery.data, offset])

  useEffect(() => {
    if (commits.length === 0) {
      if (!pendingSelection?.sha) {
        setSelectedSha(null)
      }
      return
    }

    if (selectedSha && commits.some((commit) => commit.sha === selectedSha)) {
      return
    }

    if (pendingSelection?.sha && commits.some((commit) => commit.sha === pendingSelection.sha)) {
      setSelectedSha(pendingSelection.sha)
      return
    }

    setSelectedSha((current) => current ?? commits[0]?.sha ?? null)
  }, [commits, pendingSelection?.sha, selectedSha])

  useEffect(() => {
    rootRef.current?.focus()
  }, [document?.gitPath])

  const latestCommit = commits[0] ?? fileLogQuery.data?.commits[0] ?? null
  const latestRun = reviewHistoryQuery.data?.latestRun ?? null
  const notInitialized = fileLogQuery.data?.notInitialized === true
  const selectedCommit = selectedSha ? commits.find((commit) => commit.sha === selectedSha) ?? null : null
  const highlightedReviewRunId = selectedCommit?.metadata?.reviewRunId ?? pendingSelection?.reviewId ?? latestRun?.reviewId ?? null

  const handleLoadMore = useCallback(() => {
    setIsLoadingMore(true)
    setOffset((previous) => previous + PAGE_SIZE)
  }, [])

  const handleSelectChangesForRun = useCallback(
    (reviewId: string | undefined) => {
      if (!reviewId) {
        return
      }

      const matchingCommit = commits.find((commit) => commit.metadata?.reviewRunId === reviewId)
      if (matchingCommit) {
        setSelectedSha(matchingCommit.sha)
        return
      }

      if (!selectedSha && commits[0]) {
        setSelectedSha(commits[0].sha)
      }
    },
    [commits, selectedSha],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!commits.length) {
        if (event.key === 'Escape') {
          event.preventDefault()
          onExitHistoryMode()
        }
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        onExitHistoryMode()
        return
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
        return
      }

      event.preventDefault()
      const currentIndex = selectedSha ? commits.findIndex((commit) => commit.sha === selectedSha) : -1
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const fallbackIndex = event.key === 'ArrowDown' ? 0 : commits.length - 1
      const nextIndex = currentIndex === -1 ? fallbackIndex : Math.min(Math.max(currentIndex + delta, 0), commits.length - 1)
      const nextCommit = commits[nextIndex]
      if (nextCommit) {
        setSelectedSha(nextCommit.sha)
      }
    },
    [commits, onExitHistoryMode, selectedSha],
  )

  const fullViewerDisabled = !document?.gitPath || notInitialized
  const fullViewerState = useMemo<DiffViewerInitialState | null>(() => {
    if (!document?.gitPath) {
      return null
    }

    return {
      initialRepoTarget: 'versioning',
      initialTab: 'history',
      initialSha: selectedSha,
      initialFile: document.gitPath,
      initialQuickFilter: resolveKnowledgeQuickFilterForPath(document.gitPath),
    }
  }, [document?.gitPath, selectedSha])

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex h-full flex-col outline-none"
      data-testid="cortex-history-panel"
    >
      <ScrollArea
        className="min-h-0 flex-1"
        type="always"
      >
        <div className="space-y-3 px-3 py-3">
          <CortexHistoryActivitySummary
            stats={fileLogQuery.data?.stats}
            latestRun={latestRun}
            latestCommit={latestCommit}
            notInitialized={notInitialized}
          />

          <CortexFileHistoryStats
            stats={fileLogQuery.data?.stats}
            notInitialized={notInitialized}
            isLoading={fileLogQuery.isLoading && commits.length === 0}
          />

          <CortexLastReviewRunCard
            run={latestRun}
            selectedReviewRunId={highlightedReviewRunId}
            currentFilePath={document?.gitPath ?? null}
            documents={documents}
            canViewChanges={!notInitialized && commits.length > 0}
            canOpenSession={canOpenSession}
            onArtifactClick={onArtifactClick}
            onOpenSession={onOpenSession}
            onViewChanges={(run) => handleSelectChangesForRun(run.reviewId)}
            onSelectDocument={onSelectDocument}
          />

          <CortexFileTimeline
            commits={commits}
            selectedSha={selectedSha}
            hasMore={fileLogQuery.data?.hasMore === true}
            isLoading={fileLogQuery.isLoading}
            isLoadingMore={isLoadingMore}
            notInitialized={notInitialized}
            onSelectCommit={setSelectedSha}
            onLoadMore={handleLoadMore}
          />

          <CortexInlineHistoryDiff
            wsUrl={wsUrl}
            agentId={agentId}
            absolutePath={document?.absolutePath ?? null}
            currentFilePath={document?.gitPath ?? null}
            fileLabel={document?.label ?? null}
            selectedSha={selectedSha}
            documents={documents}
            notInitialized={notInitialized}
            onSelectDocument={onSelectDocument}
          />
        </div>
      </ScrollArea>

      <div className="border-t border-border/60 px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full gap-1.5 text-[11px]"
          disabled={fullViewerDisabled || !fullViewerState}
          onClick={() => {
            if (!fullViewerState) {
              return
            }
            onOpenDiffViewer?.(fullViewerState)
          }}
          data-testid="cortex-open-full-viewer"
        >
          <ExternalLink className="size-3.5" />
          Open in full viewer
        </Button>
      </div>
    </div>
  )
}
