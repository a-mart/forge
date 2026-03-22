import { useCallback, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useResizablePanel } from '@/components/diff-viewer/useResizablePanel'
import { FileBrowserHeader } from './FileBrowserHeader'
import { FileTree } from './FileTree'
import type { FileTreeHandle } from './FileTree'
import { FileStatusBar } from './FileStatusBar'
import { FileContentViewer, useFileViewerInfo } from './FileContentViewer'
import {
  useDirectoryListing,
  useFileCount,
  useFileContent,
  invalidateFileBrowserCaches,
} from './use-file-browser-queries'
import { isImageFile } from './file-browser-utils'
import './file-browser.css'

/* Deterministic skeleton widths — avoids jitter from Math.random() in render */
const SKELETON_WIDTHS = [72, 85, 63, 90, 68, 78, 82, 65, 88, 70, 76, 84]

interface FileBrowserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  wsUrl: string
  agentId: string | null
}

export function FileBrowserDialog({
  open,
  onOpenChange,
  wsUrl,
  agentId,
}: FileBrowserDialogProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const fileTreeRef = useRef<FileTreeHandle>(null)

  // ALL hooks must be called before any early returns (React rules of hooks)
  const gatedAgentId = open ? agentId : null

  const rootList = useDirectoryListing(wsUrl, gatedAgentId, '')
  const fileCount = useFileCount(wsUrl, gatedAgentId)

  // Only fetch file content for non-image files
  const shouldFetchContent = useMemo(
    () => selectedFile && !isImageFile(selectedFile),
    [selectedFile],
  )
  const fileContent = useFileContent(
    wsUrl,
    gatedAgentId,
    shouldFetchContent ? selectedFile : null,
  )

  // File viewer info for status bar
  const viewerInfo = useFileViewerInfo(
    selectedFile,
    fileContent.data,
  )

  const { width: treeWidth, isDragging, handleRef } = useResizablePanel({
    storageKey: 'forge-file-browser-tree-width',
    defaultWidth: 280,
    minWidth: 180,
    maxWidth: 450,
  })

  // Use refs for refetch functions to avoid unstable deps
  const rootListRefetchRef = useRef(rootList.refetch)
  rootListRefetchRef.current = rootList.refetch
  const fileCountRefetchRef = useRef(fileCount.refetch)
  fileCountRefetchRef.current = fileCount.refetch

  const handleRefresh = useCallback(() => {
    invalidateFileBrowserCaches()
    rootListRefetchRef.current()
    fileCountRefetchRef.current()
    // Also clear FileTree's internal caches and rebuild
    fileTreeRef.current?.refresh()
  }, [])

  const handleClose = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const handleSelectFile = useCallback((path: string) => {
    setSelectedFile(path)
  }, [])

  // Breadcrumb navigation: expand tree to directory, clear file selection
  const handleNavigateToDirectory = useCallback((dirPath: string) => {
    setSelectedFile(null)
    fileTreeRef.current?.expandToPath(dirPath)
  }, [])

  const repoName = rootList.data?.repoName ?? null
  const branch = rootList.data?.branch ?? null
  const cwd = rootList.data?.cwd ?? ''

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
            'file-browser',
            'fixed left-1/2 top-1/2 z-[101] flex h-[92vh] w-[95vw] max-w-[1800px]',
            '-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border',
            'bg-background shadow-[0_16px_80px_rgba(0,0,0,0.5)] outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
          aria-label="File browser"
          onEscapeKeyDown={(e) => {
            e.preventDefault()
            handleClose()
          }}
          onOpenAutoFocus={(e) => {
            // Prevent default Radix focus; the FileTree filter input has autoFocus
            e.preventDefault()
          }}
        >
          <DialogTitle className="sr-only">File Browser</DialogTitle>

          {/* Header */}
          <FileBrowserHeader
            repoName={repoName}
            branch={branch}
            isRefreshing={rootList.isLoading}
            onRefresh={handleRefresh}
            onClose={handleClose}
          />

          {/* Content area: tree sidebar + content pane */}
          <div className="flex min-h-0 flex-1">
            {/* Tree sidebar */}
            <div
              className="flex shrink-0 flex-col border-r border-border/40 bg-card/30"
              style={{ width: treeWidth }}
            >
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
                  onSelectFile={handleSelectFile}
                  fileCount={fileCount.data?.count ?? null}
                  fileCountMethod={fileCount.data?.method ?? null}
                />
              ) : null}
            </div>

            {/* Resize handle */}
            <div
              ref={handleRef}
              className={cn(
                'group relative h-full shrink-0 cursor-col-resize transition-colors',
                isDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border',
              )}
              style={{ width: 6 }}
            />

            {/* Content pane */}
            <div className="flex min-w-0 flex-1 flex-col">
              {gatedAgentId ? (
                <FileContentViewer
                  wsUrl={wsUrl}
                  agentId={gatedAgentId}
                  cwd={cwd}
                  filePath={selectedFile}
                  content={fileContent.data}
                  isLoading={fileContent.isLoading}
                  error={fileContent.error}
                  onNavigateToDirectory={handleNavigateToDirectory}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
                  <FileText className="size-10 opacity-20" />
                  <p className="text-sm">Select a file to view</p>
                </div>
              )}
            </div>
          </div>

          {/* Status bar */}
          <FileStatusBar
            fileCount={fileCount.data?.count ?? null}
            fileCountMethod={fileCount.data?.method ?? null}
            selectedFile={selectedFile}
            languageDisplayName={viewerInfo.languageDisplayName}
            lineCount={viewerInfo.lineCount}
            fileSize={viewerInfo.fileSize}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
