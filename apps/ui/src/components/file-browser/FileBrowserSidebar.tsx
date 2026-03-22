import { useCallback, useRef } from 'react'
import { FolderOpen, GitBranch, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { FileTree } from './FileTree'
import type { FileTreeHandle } from './FileTree'
import {
  useDirectoryListing,
  useFileCount,
  invalidateFileBrowserCaches,
} from './use-file-browser-queries'

/* Deterministic skeleton widths */
const SKELETON_WIDTHS = [72, 85, 63, 90, 68, 78, 82, 65, 88, 70, 76, 84]

interface FileBrowserSidebarProps {
  wsUrl: string
  agentId: string | null
  isOpen: boolean
  onClose: () => void
  onSelectFile: (path: string) => void
  selectedFile: string | null
}

export function FileBrowserSidebar({
  wsUrl,
  agentId,
  isOpen,
  onClose,
  onSelectFile,
  selectedFile,
}: FileBrowserSidebarProps) {
  const fileTreeRef = useRef<FileTreeHandle>(null)

  const gatedAgentId = isOpen ? agentId : null

  const rootList = useDirectoryListing(wsUrl, gatedAgentId, '')
  const fileCount = useFileCount(wsUrl, gatedAgentId)

  const rootListRefetchRef = useRef(rootList.refetch)
  rootListRefetchRef.current = rootList.refetch
  const fileCountRefetchRef = useRef(fileCount.refetch)
  fileCountRefetchRef.current = fileCount.refetch

  const handleRefresh = useCallback(() => {
    invalidateFileBrowserCaches()
    rootListRefetchRef.current()
    fileCountRefetchRef.current()
    fileTreeRef.current?.refresh()
  }, [])

  const repoName = rootList.data?.repoName ?? null
  const branch = rootList.data?.branch ?? null
  const isRefreshing = rootList.isLoading

  return (
    <div
      className={cn(
        'flex h-full shrink-0 flex-col border-l border-border/80 bg-card/50',
        'transition-[width,opacity] duration-200 ease-out',
        isOpen
          ? 'max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-l-0 md:w-[300px] md:opacity-100'
          : 'w-0 opacity-0 overflow-hidden max-md:hidden',
        isOpen && 'opacity-100',
      )}
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                onClick={handleRefresh}
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
            ref={fileTreeRef}
            wsUrl={wsUrl}
            agentId={gatedAgentId}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            fileCount={fileCount.data?.count ?? null}
            fileCountMethod={fileCount.data?.method ?? null}
          />
        ) : null}
      </div>
    </div>
  )
}
