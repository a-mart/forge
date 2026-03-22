import { useEffect, useState } from 'react'
import { FileX2 } from 'lucide-react'
import { FileList } from './FileList'
import { DiffPane } from './DiffPane'
import { useGitFileDiff } from './use-diff-queries'
import type { GitStatusResult } from './use-diff-queries'
import { useResizablePanel } from './useResizablePanel'

interface ChangesViewProps {
  wsUrl: string
  agentId: string | null
  status: GitStatusResult | null
  isStatusLoading: boolean
  statusError: string | null
}

export function ChangesView({
  wsUrl,
  agentId,
  status,
  isStatusLoading,
  statusError,
}: ChangesViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const files = status?.files ?? []

  // Auto-select first file when file list loads or changes
  useEffect(() => {
    if (files.length > 0 && (!selectedFile || !files.some((f) => f.path === selectedFile))) {
      setSelectedFile(files[0].path)
    } else if (files.length === 0) {
      setSelectedFile(null)
    }
  }, [files, selectedFile])

  const diffQuery = useGitFileDiff(wsUrl, agentId, selectedFile)
  const { width: sidebarWidth, isDragging, handleRef } = useResizablePanel({
    storageKey: 'forge-diff-sidebar-width',
    defaultWidth: 250,
    minWidth: 150,
    maxWidth: 500,
  })

  // Error state — git not available or not a repo
  if (statusError) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <FileX2 className="mb-3 size-12 opacity-25" />
        <span className="text-sm font-medium">Unable to read repository</span>
        <span className="mt-1 max-w-sm text-center text-xs opacity-60">
          {statusError}
        </span>
      </div>
    )
  }

  // Empty state — no changes
  if (!isStatusLoading && files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <FileX2 className="mb-3 size-12 opacity-25" />
        <span className="text-sm font-medium">No uncommitted changes</span>
        <span className="mt-1 text-xs opacity-60">
          Working directory is clean
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Left panel — file list (resizable) */}
      <div className="shrink-0 border-r border-border/60" style={{ width: sidebarWidth }}>
        <FileList
          files={files}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          isLoading={isStatusLoading}
          summary={status?.summary}
        />
      </div>

      {/* Drag handle */}
      <div
        ref={handleRef}
        className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
          isDragging
            ? 'bg-primary/40'
            : 'bg-transparent hover:bg-border'
        }`}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

      {/* Right panel — diff viewer */}
      <div className="min-w-0 flex-1">
        <DiffPane
          fileName={selectedFile}
          oldContent={diffQuery.data?.oldContent ?? null}
          newContent={diffQuery.data?.newContent ?? null}
          isLoading={diffQuery.isLoading}
          error={diffQuery.error}
          truncated={diffQuery.data?.truncated}
          truncatedReason={diffQuery.data?.reason}
        />
      </div>
    </div>
  )
}
