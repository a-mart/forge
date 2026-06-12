import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { GitRepoTarget, GitWorktreeSummary } from '@forge/protocol'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { DiffDialogHeader, type DiffTab } from './DiffDialogHeader'
import { DiffStatusBar } from './DiffStatusBar'
import { ChangesView } from './ChangesView'
import { HistoryView, type HistoryStatusInfo } from './HistoryView'
import { WorktreesView } from './WorktreesView'
import type { KnowledgeQuickFilterId } from './knowledge-surface'
import { useGitStatus, useGitWorktrees, invalidateGitCaches } from './use-diff-queries'

export interface DiffViewerInitialState {
  initialRepoTarget?: GitRepoTarget
  initialTab?: DiffTab
  initialSha?: string | null
  initialFile?: string | null
  initialQuickFilter?: KnowledgeQuickFilterId
}

interface DiffViewerDialogProps extends DiffViewerInitialState {
  open: boolean
  onOpenChange: (open: boolean) => void
  wsUrl: string
  agentId: string | null
  isCortex: boolean
}

interface DiffViewerContentProps extends DiffViewerInitialState {
  active: boolean
  wsUrl: string
  agentId: string | null
  isCortex: boolean
  onClose: () => void
  onBrowseWorktreeFiles?: (worktree: GitWorktreeSummary) => void
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
}: DiffViewerContentProps) {
  const defaultTab = useMemo(() => initialTab ?? getDefaultTab(isCortex), [initialTab, isCortex])
  const defaultRepoTarget = useMemo(
    () => initialRepoTarget ?? getDefaultRepoTarget(isCortex),
    [initialRepoTarget, isCortex],
  )
  const [activeTab, setActiveTab] = useState<DiffTab>(defaultTab)
  const [repoTarget, setRepoTarget] = useState<GitRepoTarget>(defaultRepoTarget)
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)
  const [historyStatus, setHistoryStatus] = useState<HistoryStatusInfo | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const prevActiveRef = useRef(active)
  const prevContextKeyRef = useRef(`${agentId ?? ''}:${isCortex ? 'cortex' : 'workspace'}`)

  useEffect(() => {
    const contextKey = `${agentId ?? ''}:${isCortex ? 'cortex' : 'workspace'}`
    const opened = active && !prevActiveRef.current
    const contextChanged = contextKey !== prevContextKeyRef.current

    if (opened || contextChanged) {
      setActiveTab(defaultTab)
      setRepoTarget(defaultRepoTarget)
      setSelectedWorktreeId(null)
      setHistoryStatus(null)
    }

    prevActiveRef.current = active
    prevContextKeyRef.current = contextKey
  }, [active, agentId, defaultRepoTarget, defaultTab, isCortex])

  useEffect(() => {
    setHistoryStatus(null)
    setSelectedWorktreeId(null)
  }, [repoTarget])

  const effectiveWorktreeId = repoTarget === 'workspace' ? selectedWorktreeId : null
  const statusQuery = useGitStatus(wsUrl, active ? agentId : null, repoTarget, effectiveWorktreeId)
  const worktreesQuery = useGitWorktrees(wsUrl, active ? agentId : null, repoTarget, refreshToken)

  const handleRefresh = useCallback(() => {
    invalidateGitCaches({ agentId, repoTarget })
    setRefreshToken((previous) => previous + 1)
    statusQuery.refetch()
  }, [agentId, repoTarget, statusQuery])

  const handleRepoTargetChange = useCallback((nextTarget: GitRepoTarget) => {
    setRepoTarget(nextTarget)
    setSelectedWorktreeId(null)
    setHistoryStatus(null)
  }, [])

  const sessionWorktree =
    worktreesQuery.data?.worktrees.find((worktree) => worktree.isCurrentContext) ?? null
  const selectedWorktree =
    worktreesQuery.data?.worktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? null
  const contextWorktree = selectedWorktree ?? sessionWorktree
  const worktreeCount = worktreesQuery.data?.worktrees.length ?? null
  const changesViewKey = `${agentId ?? 'none'}:${repoTarget}:${effectiveWorktreeId ?? 'session'}:changes`
  const historyViewKey = `${agentId ?? 'none'}:${repoTarget}:${effectiveWorktreeId ?? 'session'}:history`

  const handleSelectWorktreeContext = useCallback((worktree: GitWorktreeSummary) => {
    setSelectedWorktreeId(worktree.id)
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
        selectedWorktreeId={selectedWorktreeId}
        isRefreshing={statusQuery.isLoading || worktreesQuery.isLoading}
        onRefresh={handleRefresh}
        onClose={onClose}
      />

      {/* Content */}
      <div className="min-h-0 flex-1">
        {activeTab === 'changes' ? (
          <ChangesView
            key={changesViewKey}
            wsUrl={wsUrl}
            agentId={agentId}
            repoTarget={repoTarget}
            worktreeId={effectiveWorktreeId}
            status={statusQuery.data}
            isStatusLoading={statusQuery.isLoading}
            statusError={statusQuery.error}
            refreshToken={refreshToken}
            initialFile={initialFile}
            initialQuickFilter={initialQuickFilter}
          />
        ) : activeTab === 'history' ? (
          <HistoryView
            key={historyViewKey}
            wsUrl={wsUrl}
            agentId={active ? agentId : null}
            repoTarget={repoTarget}
            worktreeId={effectiveWorktreeId}
            onStatusChange={setHistoryStatus}
            refreshToken={refreshToken}
            initialSha={initialSha}
            initialFile={initialFile}
            initialQuickFilter={initialQuickFilter}
          />
        ) : activeTab === 'worktrees' ? (
          <WorktreesView
            wsUrl={wsUrl}
            agentId={active ? agentId : null}
            repoTarget={repoTarget}
            refreshToken={refreshToken}
            selectedWorktreeId={selectedWorktreeId}
            onSelectWorktreeContext={handleSelectWorktreeContext}
            onBrowseWorktree={handleBrowseWorktree}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Pull request browsing is planned for a later Source Control phase. No PR or GitHub mutations are available here yet.
          </div>
        )}
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
              <span className="truncate">
                {selectedWorktree ? 'Selected' : 'Session'}: {contextWorktree.path}
              </span>
            </>
          ) : null}
        </div>
      ) : activeTab === 'pull-requests' ? (
        <div
          className="flex h-7 shrink-0 items-center border-t border-border/60 bg-card/80 px-3 text-xs text-muted-foreground"
          aria-live="polite"
        >
          Pull requests are read-only placeholder content in this phase.
        </div>
      ) : historyStatus ? (
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
      ) : (
        <DiffStatusBar filesChanged={0} insertions={0} deletions={0} />
      )}
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
