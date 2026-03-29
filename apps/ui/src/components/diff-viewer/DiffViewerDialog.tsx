import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { GitRepoTarget } from '@forge/protocol'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { DiffDialogHeader, type DiffTab } from './DiffDialogHeader'
import { DiffStatusBar } from './DiffStatusBar'
import { ChangesView } from './ChangesView'
import { HistoryView, type HistoryStatusInfo } from './HistoryView'
import type { KnowledgeQuickFilterId } from './knowledge-surface'
import { useGitStatus, invalidateGitCaches } from './use-diff-queries'

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

function getDefaultRepoTarget(isCortex: boolean): GitRepoTarget {
  return isCortex ? 'versioning' : 'workspace'
}

function getDefaultTab(isCortex: boolean): DiffTab {
  return isCortex ? 'history' : 'changes'
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
  const defaultTab = useMemo(() => initialTab ?? getDefaultTab(isCortex), [initialTab, isCortex])
  const defaultRepoTarget = useMemo(
    () => initialRepoTarget ?? getDefaultRepoTarget(isCortex),
    [initialRepoTarget, isCortex],
  )
  const [activeTab, setActiveTab] = useState<DiffTab>(defaultTab)
  const [repoTarget, setRepoTarget] = useState<GitRepoTarget>(defaultRepoTarget)
  const [historyStatus, setHistoryStatus] = useState<HistoryStatusInfo | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const prevOpenRef = useRef(open)
  const prevContextKeyRef = useRef(`${agentId ?? ''}:${isCortex ? 'cortex' : 'workspace'}`)

  useEffect(() => {
    const contextKey = `${agentId ?? ''}:${isCortex ? 'cortex' : 'workspace'}`
    const opened = open && !prevOpenRef.current
    const contextChanged = contextKey !== prevContextKeyRef.current

    if (opened || contextChanged) {
      setActiveTab(defaultTab)
      setRepoTarget(defaultRepoTarget)
      setHistoryStatus(null)
    }

    prevOpenRef.current = open
    prevContextKeyRef.current = contextKey
  }, [agentId, defaultRepoTarget, defaultTab, isCortex, open])

  useEffect(() => {
    setHistoryStatus(null)
  }, [repoTarget])

  const statusQuery = useGitStatus(wsUrl, open ? agentId : null, repoTarget)

  const handleRefresh = useCallback(() => {
    invalidateGitCaches({ agentId, repoTarget })
    setRefreshToken((previous) => previous + 1)
    statusQuery.refetch()
  }, [agentId, repoTarget, statusQuery])

  const handleClose = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const handleRepoTargetChange = useCallback((nextTarget: GitRepoTarget) => {
    setRepoTarget(nextTarget)
    setHistoryStatus(null)
  }, [])

  const summary = statusQuery.data?.summary ?? { filesChanged: 0, insertions: 0, deletions: 0 }
  const changesViewKey = `${agentId ?? 'none'}:${repoTarget}:changes`
  const historyViewKey = `${agentId ?? 'none'}:${repoTarget}:history`

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
          aria-label="Diff viewer"
          onEscapeKeyDown={(e) => {
            e.preventDefault()
            handleClose()
          }}
        >
          <DialogTitle className="sr-only">Diff Viewer</DialogTitle>

          {/* Header */}
          <DiffDialogHeader
            activeTab={activeTab}
            onTabChange={setActiveTab}
            repoTarget={repoTarget}
            onRepoTargetChange={handleRepoTargetChange}
            showRepoSelector={isCortex}
            repoLabel={statusQuery.data?.repoLabel ?? null}
            repoName={statusQuery.data?.repoName ?? null}
            branch={statusQuery.data?.branch ?? null}
            isRefreshing={statusQuery.isLoading}
            onRefresh={handleRefresh}
            onClose={handleClose}
          />

          {/* Content */}
          <div className="min-h-0 flex-1">
            {activeTab === 'changes' ? (
              <ChangesView
                key={changesViewKey}
                wsUrl={wsUrl}
                agentId={agentId}
                repoTarget={repoTarget}
                status={statusQuery.data}
                isStatusLoading={statusQuery.isLoading}
                statusError={statusQuery.error}
                refreshToken={refreshToken}
                initialFile={initialFile}
                initialQuickFilter={initialQuickFilter}
              />
            ) : (
              <HistoryView
                key={historyViewKey}
                wsUrl={wsUrl}
                agentId={open ? agentId : null}
                repoTarget={repoTarget}
                onStatusChange={setHistoryStatus}
                refreshToken={refreshToken}
                initialSha={initialSha}
                initialFile={initialFile}
                initialQuickFilter={initialQuickFilter}
              />
            )}
          </div>

          {/* Status bar */}
          {activeTab === 'changes' ? (
            <DiffStatusBar
              filesChanged={summary.filesChanged}
              insertions={summary.insertions}
              deletions={summary.deletions}
            />
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
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
