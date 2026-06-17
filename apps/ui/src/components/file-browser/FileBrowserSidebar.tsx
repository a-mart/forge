import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, FolderPlus, GitBranch, HardDrive, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useResizablePanel } from '@/components/diff-viewer/useResizablePanel'
import { useLatestRef } from '@/hooks/useLatestRef'
import { FileTree } from './FileTree'
import type { FileTreeHandle } from './FileTree'
import { FileDeleteConfirmDialog } from './FileDeleteConfirmDialog'
import {
  useDirectoryListing,
  useFileCount,
  useProjectResourcesSnapshot,
  seedProjectResources,
  invalidateFileBrowserCaches,
} from './use-file-browser-queries'
import type { FileBrowserWorktreeSelection } from '@/hooks/index-page/use-panel-state'

/* Deterministic skeleton widths */
const SKELETON_WIDTHS = [72, 85, 63, 90, 68, 78, 82, 65, 88, 70, 76, 84]

interface FileBrowserSidebarProps {
  wsUrl: string
  agentId: string | null
  isOpen: boolean
  onClose: () => void
  onSelectFile: (path: string) => void
  selectedFile: string | null
  worktreeContext?: FileBrowserWorktreeSelection | null
  onClearWorktreeContext?: () => void
  projectResourceProfileId?: string | null
  projectResourceSessionAgentId?: string | null
  desktopPlacement?: 'left' | 'right'
  desktopOnly?: boolean
  mobileOnly?: boolean
  refreshNonce?: number
  onDeleteEntry?: (path: string, entryType: 'file' | 'directory') => Promise<boolean>
}

export function FileBrowserSidebar({
  wsUrl,
  agentId,
  isOpen,
  onClose,
  onSelectFile,
  selectedFile,
  worktreeContext = null,
  onClearWorktreeContext,
  projectResourceProfileId,
  projectResourceSessionAgentId,
  desktopPlacement = 'right',
  desktopOnly = false,
  mobileOnly = false,
  refreshNonce = 0,
  onDeleteEntry,
}: FileBrowserSidebarProps) {
  const fileTreeRef = useRef<FileTreeHandle>(null)
  const [seedStatus, setSeedStatus] = useState<'idle' | 'saving' | 'success'>('idle')
  const [seedError, setSeedError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ path: string; entryType: 'file' | 'directory' } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const gatedAgentId = isOpen ? agentId : null
  const worktreeId = worktreeContext?.worktreeId ?? null

  const rootList = useDirectoryListing(wsUrl, gatedAgentId, '', worktreeId)
  const fileCount = useFileCount(wsUrl, gatedAgentId, worktreeId)
  const projectResources = useProjectResourcesSnapshot(wsUrl, {
    profileId: isOpen ? (projectResourceProfileId ?? null) : null,
    sessionAgentId: isOpen ? (projectResourceSessionAgentId ?? null) : null,
  })

  const rootListRefetchRef = useLatestRef(rootList.refetch)
  const fileCountRefetchRef = useLatestRef(fileCount.refetch)
  const projectResourcesRefetchRef = useLatestRef(projectResources.refetch)

  useEffect(() => {
    setSeedStatus('idle')
    setSeedError(null)
  }, [agentId, projectResourceProfileId, projectResourceSessionAgentId, worktreeId])

  const handleRefresh = useCallback((options: { resetSeedStatus?: boolean } = {}) => {
    if (options.resetSeedStatus !== false) {
      setSeedStatus('idle')
      setSeedError(null)
    }
    invalidateFileBrowserCaches()
    rootListRefetchRef.current()
    fileCountRefetchRef.current()
    projectResourcesRefetchRef.current()
    fileTreeRef.current?.refresh()
  }, [rootListRefetchRef, fileCountRefetchRef, projectResourcesRefetchRef])

  const { width: sidebarWidth, isDragging: isSidebarDragging, handleRef: sidebarHandleRef } = useResizablePanel({
    storageKey: desktopPlacement === 'left' ? 'forge-file-tree-width' : 'forge-file-sidebar-width',
    defaultWidth: 300,
    minWidth: 200,
    maxWidth: 500,
    invertDelta: desktopPlacement === 'right',
  })

  const repoName = rootList.data?.repoName ?? null
  const branch = worktreeContext?.branch ?? rootList.data?.branch ?? null
  const isRefreshing = rootList.isLoading
  const canSeedProjectForge = useMemo(() => {
    if (worktreeContext) {
      return false
    }
    const scaffold = projectResources.data?.scaffold
    return !!scaffold?.canSeed && scaffold.missing.length > 0
  }, [projectResources.data, worktreeContext])

  useEffect(() => {
    if (refreshNonce > 0) {
      handleRefresh({ resetSeedStatus: false })
    }
  }, [handleRefresh, refreshNonce])

  const handleSeedProjectForge = useCallback(() => {
    if (!projectResourceProfileId || !projectResourceSessionAgentId || seedStatus === 'saving') return
    setSeedStatus('saving')
    setSeedError(null)
    void seedProjectResources(wsUrl, {
      profileId: projectResourceProfileId,
      sessionAgentId: projectResourceSessionAgentId,
    })
      .then(() => {
        setSeedStatus('success')
        handleRefresh({ resetSeedStatus: false })
      })
      .catch((error: unknown) => {
        setSeedStatus('idle')
        setSeedError(error instanceof Error ? error.message : 'Could not create .forge resources')
      })
  }, [handleRefresh, projectResourceProfileId, projectResourceSessionAgentId, seedStatus, wsUrl])

  const handleRequestDelete = useCallback((path: string, entryType: 'file' | 'directory') => {
    if (!onDeleteEntry) return
    setDeleteError(null)
    setPendingDelete({ path, entryType })
  }, [onDeleteEntry])

  const handleConfirmDelete = useCallback(() => {
    if (!pendingDelete || !onDeleteEntry || isDeleting) return

    setIsDeleting(true)
    setDeleteError(null)
    void onDeleteEntry(pendingDelete.path, pendingDelete.entryType)
      .then((deleted) => {
        if (deleted) {
          setPendingDelete(null)
        }
      })
      .catch((error: unknown) => {
        setDeleteError(error instanceof Error ? error.message : 'Unknown error')
      })
      .finally(() => {
        setIsDeleting(false)
      })
  }, [isDeleting, onDeleteEntry, pendingDelete])

  const handleCloseDeleteDialog = useCallback(() => {
    if (isDeleting) return
    setPendingDelete(null)
    setDeleteError(null)
  }, [isDeleting])

  return (
    <>
      {/* Drag handle (left edge for right drawers) */}
      {isOpen && desktopPlacement === 'right' ? (
        <FileBrowserResizeHandle
          handleRef={sidebarHandleRef}
          isDragging={isSidebarDragging}
          className={cn(desktopOnly && 'max-md:hidden', mobileOnly && 'md:hidden')}
        />
      ) : null}

      <div
        className={cn(
          'flex h-full shrink-0 flex-col bg-card/50',
          desktopPlacement === 'left' ? 'md:border-r md:border-border/80' : 'md:border-l md:border-border/80',
          'transition-opacity duration-200 ease-out',
          desktopOnly && 'max-md:hidden',
          mobileOnly && 'md:hidden',
          isOpen
            ? 'max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-l-0 md:opacity-100'
            : 'w-0 opacity-0 overflow-hidden max-md:hidden',
          isOpen && 'opacity-100',
        )}
        style={isOpen ? { width: sidebarWidth } : undefined}
        aria-label="File browser"
        aria-hidden={!isOpen}
      >
      {/* Header */}
      <div className="flex h-[62px] shrink-0 items-center gap-2 border-b border-border/80 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-[11px] font-medium text-foreground">Files</span>

          {repoName ? (
            <>
              <span className="text-muted-foreground/30" aria-hidden>·</span>
              <span className="truncate text-[11px] text-muted-foreground">{repoName}</span>
            </>
          ) : null}

          {branch ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/70">
              <GitBranch className="size-2.5" />
              <span className="truncate max-w-[60px]">{branch}</span>
            </span>
          ) : null}
        </div>

        <TooltipProvider delayDuration={200}>
          {canSeedProjectForge ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                  onClick={handleSeedProjectForge}
                  disabled={seedStatus === 'saving'}
                  aria-label="Create .forge project resources"
                >
                  {seedStatus === 'saving' ? <Loader2 className="size-3 animate-spin" /> : <FolderPlus className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                Create .forge project resources
              </TooltipContent>
            </Tooltip>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                onClick={() => handleRefresh()}
                disabled={isRefreshing}
                aria-label="Refresh"
              >
                <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              Refresh
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          onClick={onClose}
          aria-label="Close file browser"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {seedError || seedStatus === 'success' ? (
        <div className={cn(
          'border-b border-border/80 px-3 py-2 text-[11px]',
          seedError ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400',
        )}>
          {seedError ?? 'Created .forge project resources.'}
        </div>
      ) : null}

      {worktreeContext ? (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-1.5 font-medium">
                <HardDrive className="size-3 shrink-0" />
                <span>Browsing linked worktree</span>
              </div>
              <p className="truncate text-amber-900/80 dark:text-amber-100/80" title={worktreeContext.worktreePath}>
                {worktreeContext.worktreePath}
              </p>
              <p className="text-amber-900/70 dark:text-amber-100/70">
                {worktreeContext.branch ?? 'detached HEAD'} · Chat session CWD unchanged
              </p>
            </div>
            {onClearWorktreeContext ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-[10px] text-amber-900 hover:bg-amber-500/20 dark:text-amber-100"
                onClick={onClearWorktreeContext}
              >
                Use session
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Tree content */}
      <div className="flex min-h-0 flex-1 flex-col">
        {rootList.error ? (
          <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
            <div>
              <p className="font-medium text-destructive">Failed to load files</p>
              <p className="mt-1 opacity-70">{rootList.error}</p>
            </div>
          </div>
        ) : !gatedAgentId ? (
          <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
            No agent selected
          </div>
        ) : rootList.isLoading && !rootList.data ? (
          <div className="flex flex-1 flex-col gap-1 p-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="h-7 animate-pulse rounded bg-muted/40"
                style={{ width: `${SKELETON_WIDTHS[i]}%` }}
              />
            ))}
          </div>
        ) : gatedAgentId ? (
          <FileTree
            key={`${gatedAgentId}:${worktreeId ?? 'session'}`}
            ref={fileTreeRef}
            wsUrl={wsUrl}
            agentId={gatedAgentId}
            cwd={rootList.data?.cwd ?? ''}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            fileCount={fileCount.data?.count ?? null}
            fileCountMethod={fileCount.data?.method ?? null}
            worktreeId={worktreeId}
            onRequestDelete={onDeleteEntry ? handleRequestDelete : undefined}
          />
        ) : null}
      </div>
    </div>

      {/* Drag handle (right edge for left workspace panes) */}
      {isOpen && desktopPlacement === 'left' ? (
        <FileBrowserResizeHandle
          handleRef={sidebarHandleRef}
          isDragging={isSidebarDragging}
          className={cn(desktopOnly && 'max-md:hidden', mobileOnly && 'md:hidden')}
        />
      ) : null}

      <FileDeleteConfirmDialog
        open={Boolean(pendingDelete)}
        entryName={pendingDelete?.path.split('/').pop() ?? ''}
        entryType={pendingDelete?.entryType ?? 'file'}
        errorMessage={deleteError}
        isDeleting={isDeleting}
        onConfirm={handleConfirmDelete}
        onClose={handleCloseDeleteDialog}
      />
    </>
  )
}

function FileBrowserResizeHandle({
  handleRef,
  isDragging,
  className,
}: {
  handleRef: (node: HTMLDivElement | null) => void
  isDragging: boolean
  className?: string
}) {
  return (
    <div
      ref={handleRef}
      className={cn(
        'group relative h-full shrink-0 cursor-col-resize transition-colors',
        isDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border',
        className,
      )}
      style={{ width: 6 }}
    >
      <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
    </div>
  )
}
