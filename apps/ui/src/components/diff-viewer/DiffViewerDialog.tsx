import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { GitRepoTarget, GitWorktreeSummary, RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { DiffDialogHeader, type DiffTab } from './DiffDialogHeader'
import { DiffStatusBar } from './DiffStatusBar'
import { type HistoryStatusInfo } from './HistoryView'
import { SourceControlActivityView } from './SourceControlActivityView'
import { WorktreesView } from './WorktreesView'
import { PullRequestsTab } from './PullRequestsTab'
import type { KnowledgeQuickFilterId } from './knowledge-surface'
import { SourceControlBranchActions } from './SourceControlBranchActions'
import { RemoteUpdateAwarenessBanner, RemoteUpdateAwarenessIncoming } from './RemoteUpdateAwarenessIncoming'
import type { RemoteUpdateAwarenessSnapshotChange } from './remote-update-awareness-mutation'
import {
  useGitBranches,
  useGitPullRequests,
  useGitStatus,
  useGitWorktrees,
  invalidateGitCaches,
} from './use-diff-queries'

export interface DiffViewerInitialState {
  initialRepoTarget?: GitRepoTarget
  initialTab?: DiffTab
  initialSha?: string | null
  initialFile?: string | null
  initialQuickFilter?: KnowledgeQuickFilterId
}

/** A non-toggle navigation request that remains distinct even when its target is unchanged. */
export interface DiffViewerNavigationRequest extends DiffViewerInitialState {
  requestId: number
}

type SourceControlMutationGuard = (
  mutation: 'switch-branch' | 'create-branch' | 'pull-ff-only' | 'push',
  target: { agentId: string; worktreeId: string | null },
  run: () => void,
) => void

interface DiffViewerDialogProps extends DiffViewerInitialState {
  open: boolean
  onOpenChange: (open: boolean) => void
  wsUrl: string
  agentId: string | null
  isCortex: boolean
  onBrowseWorktreeFiles?: (worktree: GitWorktreeSummary) => void
  onRequestSourceControlMutation?: SourceControlMutationGuard
  onSourceControlMutationComplete?: () => void
  externalRefreshNonce?: number
  remoteUpdateSnapshot?: RemoteUpdateAwarenessProjectSnapshot | null
  onRemoteUpdateSnapshotChange?: RemoteUpdateAwarenessSnapshotChange
  navigationRequest?: DiffViewerNavigationRequest | null
}

interface DiffViewerContentProps extends DiffViewerInitialState {
  active: boolean
  wsUrl: string
  agentId: string | null
  isCortex: boolean
  onClose: () => void
  onBrowseWorktreeFiles?: (worktree: GitWorktreeSummary) => void
  onRequestSourceControlMutation?: SourceControlMutationGuard
  onSourceControlMutationComplete?: () => void
  externalRefreshNonce?: number
  remoteUpdateSnapshot?: RemoteUpdateAwarenessProjectSnapshot | null
  onRemoteUpdateSnapshotChange?: RemoteUpdateAwarenessSnapshotChange
  navigationRequest?: DiffViewerNavigationRequest | null
}

function getDefaultRepoTarget(isCortex: boolean): GitRepoTarget {
  return isCortex ? 'versioning' : 'workspace'
}

function getDefaultTab(isCortex: boolean): DiffTab {
  return isCortex ? 'history' : 'changes'
}

export function DiffViewerContent({
  active,
  wsUrl,
  agentId,
  isCortex,
  onClose,
  initialRepoTarget,
  initialTab,
  initialSha,
  initialFile,
  initialQuickFilter,
  onBrowseWorktreeFiles,
  onRequestSourceControlMutation,
  onSourceControlMutationComplete,
  externalRefreshNonce = 0,
  remoteUpdateSnapshot = null,
  onRemoteUpdateSnapshotChange,
  navigationRequest = null,
}: DiffViewerContentProps) {
  const defaultTab = useMemo(() => initialTab ?? getDefaultTab(isCortex), [initialTab, isCortex])
  const defaultRepoTarget = useMemo(
    () => initialRepoTarget ?? getDefaultRepoTarget(isCortex),
    [initialRepoTarget, isCortex],
  )
  const [activeTab, setActiveTab] = useState<DiffTab>(defaultTab)
  const [repoTarget, setRepoTarget] = useState<GitRepoTarget>(defaultRepoTarget)
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)
  const [selectedWorktreeSummary, setSelectedWorktreeSummary] = useState<GitWorktreeSummary | null>(null)
  const [historyStatus, setHistoryStatus] = useState<HistoryStatusInfo | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [hasVisitedPullRequests, setHasVisitedPullRequests] = useState(activeTab === 'pull-requests')
  const lastExternalRefreshNonceRef = useRef(externalRefreshNonce)
  const prevActiveRef = useRef(active)
  const prevContextKeyRef = useRef(`${agentId ?? ''}:${isCortex ? 'cortex' : 'workspace'}`)
  const lastNavigationRequestIdRef = useRef<number | null>(null)

  useEffect(() => {
    const contextKey = `${agentId ?? ''}:${isCortex ? 'cortex' : 'workspace'}`
    const opened = active && !prevActiveRef.current
    const contextChanged = contextKey !== prevContextKeyRef.current

    if (opened || contextChanged) {
      setActiveTab(defaultTab)
      setRepoTarget(defaultRepoTarget)
      setSelectedWorktreeId(null)
      setSelectedWorktreeSummary(null)
      setHistoryStatus(null)
      setHasVisitedPullRequests(defaultTab === 'pull-requests')
    }

    prevActiveRef.current = active
    prevContextKeyRef.current = contextKey
  }, [active, agentId, defaultRepoTarget, defaultTab, isCortex])

  useEffect(() => {
    if (
      !active ||
      !navigationRequest ||
      navigationRequest.requestId === lastNavigationRequestIdRef.current
    ) {
      return
    }

    lastNavigationRequestIdRef.current = navigationRequest.requestId
    setRepoTarget(navigationRequest.initialRepoTarget ?? defaultRepoTarget)
    setActiveTab(navigationRequest.initialTab ?? defaultTab)
    setSelectedWorktreeId(null)
    setSelectedWorktreeSummary(null)
    setHistoryStatus(null)
    setHasVisitedPullRequests(navigationRequest.initialTab === 'pull-requests')
  }, [active, defaultRepoTarget, defaultTab, navigationRequest])

  useEffect(() => {
    setHistoryStatus(null)
    setSelectedWorktreeId(null)
    setSelectedWorktreeSummary(null)
  }, [repoTarget])

  useEffect(() => {
    if (active && repoTarget === 'workspace' && activeTab === 'pull-requests') {
      setHasVisitedPullRequests(true)
    }
  }, [active, activeTab, repoTarget])

  const effectiveWorktreeId = repoTarget === 'workspace' ? selectedWorktreeId : null
  const shouldLoadWorktrees =
    active && !!agentId && repoTarget === 'workspace' && activeTab === 'worktrees'
  const shouldLoadPullRequests = active && !!agentId && repoTarget === 'workspace' && hasVisitedPullRequests
  const statusQuery = useGitStatus(wsUrl, active ? agentId : null, repoTarget, effectiveWorktreeId)
  const branchesQuery = useGitBranches(wsUrl, active ? agentId : null, repoTarget, effectiveWorktreeId, {
    enabled: active && !!agentId && repoTarget === 'workspace',
  })
  const worktreesQuery = useGitWorktrees(wsUrl, active ? agentId : null, repoTarget, {
    enabled: shouldLoadWorktrees,
  })
  const pullRequestsQuery = useGitPullRequests(wsUrl, active ? agentId : null, repoTarget, effectiveWorktreeId, {
    enabled: shouldLoadPullRequests,
  })

  const handleRefresh = useCallback(() => {
    invalidateGitCaches({ agentId, repoTarget })
    setRefreshToken((previous) => previous + 1)
    statusQuery.refetch()
    branchesQuery.refetch()
    if (activeTab === 'worktrees') {
      worktreesQuery.refetch()
    }
    if (activeTab === 'pull-requests') {
      pullRequestsQuery.refetch()
    }
  }, [activeTab, agentId, branchesQuery, pullRequestsQuery, repoTarget, statusQuery, worktreesQuery])

  const handleSourceControlMutationComplete = useCallback(() => {
    handleRefresh()
    onSourceControlMutationComplete?.()
  }, [handleRefresh, onSourceControlMutationComplete])

  useEffect(() => {
    if (!active || externalRefreshNonce === 0 || externalRefreshNonce === lastExternalRefreshNonceRef.current) return
    lastExternalRefreshNonceRef.current = externalRefreshNonce
    handleRefresh()
  }, [active, externalRefreshNonce, handleRefresh])

  const handleRepoTargetChange = useCallback((nextTarget: GitRepoTarget) => {
    setRepoTarget(nextTarget)
    setSelectedWorktreeId(null)
    setSelectedWorktreeSummary(null)
    setHistoryStatus(null)
    setHasVisitedPullRequests(activeTab === 'pull-requests' && nextTarget === 'workspace')
  }, [activeTab])

  const contextWorktree = selectedWorktreeSummary
  const worktreeCount =
    activeTab === 'worktrees' ? (worktreesQuery.data?.worktrees.length ?? null) : null
  const pullRequestCount =
    pullRequestsQuery.data?.providerStatus.available === true &&
    pullRequestsQuery.data.providerStatus.authenticated === true &&
    !pullRequestsQuery.data.listError
      ? pullRequestsQuery.data.open.length
      : null
  const pullRequestCountTruncated = pullRequestsQuery.data?.openCountTruncated === true
  const changesViewKey = `${agentId ?? 'none'}:${repoTarget}:${effectiveWorktreeId ?? 'session'}:changes`
  const historyViewKey = `${agentId ?? 'none'}:${repoTarget}:${effectiveWorktreeId ?? 'session'}:history`
  const activeRemoteUpdateSnapshot = repoTarget === 'workspace' ? remoteUpdateSnapshot : null

  const handleSelectWorktreeContext = useCallback((worktree: GitWorktreeSummary) => {
    setSelectedWorktreeId(worktree.id)
    setSelectedWorktreeSummary(worktree)
    setActiveTab('changes')
    setHistoryStatus(null)
  }, [])

  const handleBrowseWorktree = useCallback(
    (worktree: GitWorktreeSummary) => {
      onBrowseWorktreeFiles?.(worktree)
    },
    [onBrowseWorktreeFiles],
  )

  const summary = statusQuery.data?.summary ?? { filesChanged: 0, insertions: 0, deletions: 0 }

  return (
    <>
      {/* Header */}
      <DiffDialogHeader
        activeTab={activeTab}
        onTabChange={setActiveTab}
        repoTarget={repoTarget}
        onRepoTargetChange={handleRepoTargetChange}
        showRepoSelector={isCortex}
        repoLabel={statusQuery.data?.repoLabel ?? null}
        repoName={statusQuery.data?.repoName ?? null}
        branch={statusQuery.data?.branch ?? contextWorktree?.branch ?? null}
        currentWorktreePath={contextWorktree?.path ?? null}
        worktreeCount={worktreeCount}
        pullRequestCount={pullRequestCount}
        pullRequestCountTruncated={pullRequestCountTruncated}
        selectedWorktreeId={selectedWorktreeId}
        isRefreshing={
          statusQuery.isLoading ||
          branchesQuery.isLoading ||
          (shouldLoadWorktrees && worktreesQuery.isLoading) ||
          (activeTab === 'pull-requests' && pullRequestsQuery.isLoading)
        }
        onRefresh={handleRefresh}
        onClose={onClose}
        remoteUpdateSnapshot={activeRemoteUpdateSnapshot}
        branchActions={
          repoTarget === 'workspace' ? (
            <>
              <SourceControlBranchActions
              wsUrl={wsUrl}
              agentId={agentId}
              repoTarget={repoTarget}
              worktreeId={effectiveWorktreeId}
              selectedWorktreePath={contextWorktree?.path ?? null}
              branchesQuery={branchesQuery}
              isDirty={(statusQuery.data?.summary.filesChanged ?? 0) > 0}
              sourceControlActive={active}
              onMutationComplete={handleSourceControlMutationComplete}
              onRequestMutation={onRequestSourceControlMutation}
              />
            </>
          ) : null
        }
      />

      <RemoteUpdateAwarenessBanner
        wsUrl={wsUrl}
        snapshot={activeRemoteUpdateSnapshot}
        onInspect={() => setActiveTab('incoming')}
        onSnapshotChange={onRemoteUpdateSnapshotChange ?? (() => undefined)}
      />

      {/* Content */}
      <div className="min-h-0 flex-1">
        {activeTab === 'incoming' ? (
          activeRemoteUpdateSnapshot ? (
            <RemoteUpdateAwarenessIncoming
              wsUrl={wsUrl}
              projectId={activeRemoteUpdateSnapshot.projectId}
              generation={activeRemoteUpdateSnapshot.dismissalTarget?.generation ?? null}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="status">
              <p className="text-sm font-medium text-foreground">Incoming changes are unavailable.</p>
              <p className="max-w-md text-xs text-muted-foreground">
                Remote update evidence is not available for this project. Return to Changes and check again later.
              </p>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                onClick={() => setActiveTab('changes')}
              >
                Return to Changes
              </button>
            </div>
          )
        ) : activeTab === 'changes' || activeTab === 'history' ? (
          <SourceControlActivityView
            key={`${changesViewKey}:${historyViewKey}`}
            wsUrl={wsUrl}
            agentId={active ? agentId : null}
            repoTarget={repoTarget}
            worktreeId={effectiveWorktreeId}
            status={statusQuery.data}
            isStatusLoading={statusQuery.isLoading}
            statusError={statusQuery.error}
            refreshToken={refreshToken}
            initialSha={initialSha}
            initialFile={initialFile}
            initialQuickFilter={initialQuickFilter}
            focusSection={activeTab}
            onFocusSectionChange={setActiveTab}
            onHistoryStatusChange={setHistoryStatus}
          />
        ) : activeTab === 'worktrees' ? (
          <WorktreesView
            agentId={active ? agentId : null}
            worktreesQuery={worktreesQuery}
            selectedWorktreeId={selectedWorktreeId}
            onSelectWorktreeContext={handleSelectWorktreeContext}
            onBrowseWorktree={handleBrowseWorktree}
          />
        ) : activeTab === 'pull-requests' ? (
          <PullRequestsTab
            wsUrl={wsUrl}
            agentId={active ? agentId : null}
            repoTarget={repoTarget}
            worktreeId={effectiveWorktreeId}
            currentBranch={statusQuery.data?.branch ?? contextWorktree?.branch ?? null}
            pullRequestsQuery={pullRequestsQuery}
            onMergeComplete={() => {
              pullRequestsQuery.refetch()
              branchesQuery.refetch()
            }}
          />
        ) : null}
      </div>

      {/* Status bar */}
      {activeTab === 'changes' ? (
        <DiffStatusBar
          filesChanged={summary.filesChanged}
          insertions={summary.insertions}
          deletions={summary.deletions}
        />
      ) : activeTab === 'worktrees' ? (
        <div
          className="flex h-7 shrink-0 items-center border-t border-border/60 bg-card/80 px-3 text-xs text-muted-foreground"
          aria-live="polite"
        >
          <span>{worktreeCount ?? 0} {(worktreeCount ?? 0) === 1 ? 'worktree' : 'worktrees'}</span>
          {contextWorktree ? (
            <>
              <span className="mx-1.5 opacity-40">·</span>
              <span className="truncate">Selected: {contextWorktree.path}</span>
            </>
          ) : null}
        </div>
      ) : activeTab === 'pull-requests' ? (
        <div
          className="flex h-7 shrink-0 items-center border-t border-border/60 bg-card/80 px-3 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {pullRequestsQuery.data?.listError ? (
            <span className="truncate text-destructive">Pull request list unavailable</span>
          ) : (
            <>
              <span>{pullRequestsQuery.data?.open.length ?? 0} open</span>
              <span className="mx-1.5 opacity-40">·</span>
              <span>{pullRequestsQuery.data?.recentlyClosed.length ?? 0} recently closed</span>
              {pullRequestsQuery.data?.currentBranchPullRequest ? (
                <>
                  <span className="mx-1.5 opacity-40">·</span>
                  <span className="truncate">
                    Current branch PR #{pullRequestsQuery.data.currentBranchPullRequest.number}
                  </span>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : activeTab === 'history' && historyStatus ? (
        <div
          className="flex h-7 shrink-0 items-center border-t border-border/60 bg-card/80 px-3 text-xs text-muted-foreground"
          aria-live="polite"
        >
          <span className="font-mono text-[10px] text-muted-foreground/70">{historyStatus.shortSha}</span>
          <span className="mx-1.5 opacity-40">·</span>
          <span>{historyStatus.author}</span>
          <span className="mx-1.5 opacity-40">·</span>
          <span>
            {historyStatus.filesChanged} {historyStatus.filesChanged === 1 ? 'file' : 'files'}
          </span>
          {historyStatus.insertions > 0 ? (
            <span className="ml-1.5 text-emerald-500">+{historyStatus.insertions}</span>
          ) : null}
          {historyStatus.deletions > 0 ? (
            <span className="ml-1 text-red-500">-{historyStatus.deletions}</span>
          ) : null}
        </div>
      ) : activeTab === 'history' ? (
        <DiffStatusBar filesChanged={0} insertions={0} deletions={0} />
      ) : null}
    </>
  )
}

export function DiffViewerDialog({
  open,
  onOpenChange,
  wsUrl,
  agentId,
  isCortex,
  initialRepoTarget,
  initialTab,
  initialSha,
  initialFile,
  initialQuickFilter,
  onBrowseWorktreeFiles,
  onRequestSourceControlMutation,
  onSourceControlMutationComplete,
  externalRefreshNonce,
  remoteUpdateSnapshot,
  onRemoteUpdateSnapshotChange,
  navigationRequest,
}: DiffViewerDialogProps) {
  const handleClose = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            'fixed inset-0 z-[100] bg-black/70 backdrop-blur-[2px]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
        />

        <DialogPrimitive.Content
          className={cn(
            'diff-viewer',
            'fixed left-1/2 top-1/2 z-[101] flex h-[92vh] w-[95vw] max-w-[1800px]',
            '-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border',
            'bg-background shadow-[0_16px_80px_rgba(0,0,0,0.5)] outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
          aria-label="Source Control"
          onEscapeKeyDown={(e) => {
            e.preventDefault()
            handleClose()
          }}
        >
          <DialogTitle className="sr-only">Source Control</DialogTitle>
          <DiffViewerContent
            active={open}
            wsUrl={wsUrl}
            agentId={agentId}
            isCortex={isCortex}
            onClose={handleClose}
            onBrowseWorktreeFiles={onBrowseWorktreeFiles}
            onRequestSourceControlMutation={onRequestSourceControlMutation}
            onSourceControlMutationComplete={onSourceControlMutationComplete}
            externalRefreshNonce={externalRefreshNonce}
            remoteUpdateSnapshot={remoteUpdateSnapshot}
            onRemoteUpdateSnapshotChange={onRemoteUpdateSnapshotChange}
            navigationRequest={navigationRequest}
            initialRepoTarget={initialRepoTarget}
            initialTab={initialTab}
            initialSha={initialSha}
            initialFile={initialFile}
            initialQuickFilter={initialQuickFilter}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
