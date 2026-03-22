import { useCallback, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { DiffDialogHeader, type DiffTab } from './DiffDialogHeader'
import { DiffStatusBar } from './DiffStatusBar'
import { ChangesView } from './ChangesView'
import { HistoryView, type HistoryStatusInfo } from './HistoryView'
import { useGitStatus, invalidateGitCaches } from './use-diff-queries'

interface DiffViewerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  wsUrl: string
  agentId: string | null
}

export function DiffViewerDialog({
  open,
  onOpenChange,
  wsUrl,
  agentId,
}: DiffViewerDialogProps) {
  const [activeTab, setActiveTab] = useState<DiffTab>('changes')
  const [historyStatus, setHistoryStatus] = useState<HistoryStatusInfo | null>(null)

  const statusQuery = useGitStatus(wsUrl, open ? agentId : null)

  const handleRefresh = useCallback(() => {
    invalidateGitCaches()
    statusQuery.refetch()
  }, [statusQuery])

  const handleClose = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const summary = statusQuery.data?.summary ?? { filesChanged: 0, insertions: 0, deletions: 0 }

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
                wsUrl={wsUrl}
                agentId={agentId}
                status={statusQuery.data}
                isStatusLoading={statusQuery.isLoading}
                statusError={statusQuery.error}
              />
            ) : (
              <HistoryView
                wsUrl={wsUrl}
                agentId={open ? agentId : null}
                onStatusChange={setHistoryStatus}
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
