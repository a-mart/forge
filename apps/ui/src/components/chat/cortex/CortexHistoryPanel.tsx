import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CortexDocumentEntry, GitLogEntry } from '@forge/protocol'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ArtifactReference } from '@/lib/artifacts'
import type { DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
import { resolveKnowledgeQuickFilterForPath } from '@/components/diff-viewer/knowledge-surface'
import { buildVersionNumber } from './history-format'
import { CortexFileTimeline } from './CortexFileTimeline'
import { CortexLastReviewRunCard } from './CortexLastReviewRunCard'
import { CortexVersionDiffDialog } from './CortexVersionDiffDialog'
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
  onRestoreSuccess?: () => void
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
  onRestoreSuccess,
}: CortexHistoryPanelProps) {
  const [offset, setOffset] = useState(0)
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [selectedSha, setSelectedSha] = useState<string | null>(pendingSelection?.sha ?? null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [diffDialogOpen, setDiffDialogOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const fileLogQuery = useGitFileLog(wsUrl, agentId, document?.gitPath ?? null, PAGE_SIZE, offset)
  const reviewHistoryQuery = useCortexFileReviewHistory(wsUrl, document?.gitPath ?? null, 10)

  useEffect(() => {
    setOffset(0)
    setCommits([])
    setSelectedSha(pendingSelection?.sha ?? null)
    setIsLoadingMore(false)
    setDiffDialogOpen(false)
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

    setSelectedSha(commits[0]?.sha ?? null)
  }, [commits, pendingSelection?.sha, selectedSha])

  useEffect(() => {
    rootRef.current?.focus()
  }, [document?.gitPath])

  const latestRun = reviewHistoryQuery.data?.latestRun ?? null
  const notInitialized = fileLogQuery.data?.notInitialized === true
  const selectedCommit = selectedSha ? commits.find((commit) => commit.sha === selectedSha) ?? null : null
  const highlightedReviewRunId = selectedCommit?.metadata?.reviewRunId ?? pendingSelection?.reviewId ?? latestRun?.reviewId ?? null
  const totalEdits = fileLogQuery.data?.stats?.totalEdits ?? null
  const currentVersionNumber = commits.length > 0 ? buildVersionNumber(0, totalEdits, commits.length) : null
  const selectedIndex = selectedSha ? commits.findIndex((commit) => commit.sha === selectedSha) : -1
  const selectedVersionNumber = selectedIndex >= 0 ? buildVersionNumber(selectedIndex, totalEdits, commits.length) : null
  const comparisonVersionNumber = selectedVersionNumber && selectedVersionNumber > 1 ? selectedVersionNumber - 1 : null

  const handleLoadMore = useCallback(() => {
    setIsLoadingMore(true)
    setOffset((previous) => previous + PAGE_SIZE)
  }, [])

  const openCommitDialog = useCallback((sha: string) => {
    setSelectedSha(sha)
    setDiffDialogOpen(true)
  }, [])

  const handleSelectChangesForRun = useCallback(
    (reviewId: string | undefined) => {
      if (!reviewId) {
        return
      }

      const matchingCommit = commits.find((commit) => commit.metadata?.reviewRunId === reviewId)
      if (matchingCommit) {
        setSelectedSha(matchingCommit.sha)
        setDiffDialogOpen(true)
        return
      }

      if (commits[0]) {
        setSelectedSha(commits[0].sha)
        setDiffDialogOpen(true)
      }
    },
    [commits],
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

      if (event.key === 'Enter' && selectedSha) {
        event.preventDefault()
        setDiffDialogOpen(true)
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

  const documentGitPath = document?.gitPath ?? null
  const fullViewerDisabled = !documentGitPath || notInitialized
  const fullViewerState = useMemo<DiffViewerInitialState | null>(() => {
    if (!documentGitPath) {
      return null
    }

    return {
      initialRepoTarget: 'versioning',
      initialTab: 'history',
      initialSha: selectedSha,
      initialFile: documentGitPath,
      initialQuickFilter: resolveKnowledgeQuickFilterForPath(documentGitPath),
    }
  }, [documentGitPath, selectedSha])

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
            totalEdits={totalEdits}
            hasMore={fileLogQuery.data?.hasMore === true}
            isLoading={fileLogQuery.isLoading}
            isLoadingMore={isLoadingMore}
            notInitialized={notInitialized}
            onSelectCommit={setSelectedSha}
            onOpenCommit={openCommitDialog}
            onLoadMore={handleLoadMore}
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

      <CortexVersionDiffDialog
        open={diffDialogOpen}
        wsUrl={wsUrl}
        agentId={agentId}
        absolutePath={document?.absolutePath ?? null}
        gitPath={document?.gitPath ?? null}
        documentLabel={document?.label ?? null}
        commits={commits}
        totalEdits={totalEdits}
        selectedCommit={selectedCommit}
        selectedVersionNumber={selectedVersionNumber}
        comparisonVersionNumber={comparisonVersionNumber}
        currentVersionNumber={currentVersionNumber}
        hasMoreVersions={fileLogQuery.data?.hasMore === true}
        isLoadingVersions={fileLogQuery.isLoading}
        isLoadingMoreVersions={isLoadingMore}
        onSelectCommit={setSelectedSha}
        onLoadMoreVersions={handleLoadMore}
        onOpenChange={setDiffDialogOpen}
        onRestoreSuccess={onRestoreSuccess}
      />
    </div>
  )
}
