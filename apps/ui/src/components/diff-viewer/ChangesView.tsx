import { useEffect, useMemo, useRef, useState } from 'react'
import { FileX2 } from 'lucide-react'
import { FileList } from './FileList'
import { DiffPane } from './DiffPane'
import { matchesKnowledgeQuickFilter, type KnowledgeQuickFilterId } from './knowledge-surface'
import { useGitDiff } from './use-diff-queries'
import type { GitRepoTarget, GitStatusResult } from './use-diff-queries'
import { useResizablePanel } from './useResizablePanel'

interface ChangesViewProps {
  wsUrl: string
  agentId: string | null
  repoTarget: GitRepoTarget
  status: GitStatusResult | null
  isStatusLoading: boolean
  statusError: string | null
  refreshToken?: number
  initialFile?: string | null
  initialQuickFilter?: KnowledgeQuickFilterId
}

export function ChangesView({
  wsUrl,
  agentId,
  repoTarget,
  status,
  isStatusLoading,
  statusError,
  refreshToken = 0,
  initialFile = null,
  initialQuickFilter = 'all',
}: ChangesViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile)
  const [quickFilter, setQuickFilter] = useState<KnowledgeQuickFilterId>(initialQuickFilter)
  const files = status?.files ?? []
  const diffQuery = useGitDiff(wsUrl, agentId, repoTarget, selectedFile)
  const prevRefreshTokenRef = useRef(refreshToken)

  useEffect(() => {
    setSelectedFile(initialFile)
    setQuickFilter(initialQuickFilter)
  }, [agentId, initialFile, initialQuickFilter, repoTarget])

  const visibleFiles = useMemo(() => {
    if (repoTarget !== 'versioning') {
      return files
    }

    return files.filter((file) => matchesKnowledgeQuickFilter(file.path, quickFilter))
  }, [files, quickFilter, repoTarget])

  useEffect(() => {
    if (visibleFiles.length > 0 && (!selectedFile || !visibleFiles.some((file) => file.path === selectedFile))) {
      setSelectedFile(visibleFiles[0].path)
    } else if (visibleFiles.length === 0) {
      setSelectedFile(null)
    }
  }, [visibleFiles, selectedFile])

  useEffect(() => {
    if (refreshToken === prevRefreshTokenRef.current) {
      return
    }

    prevRefreshTokenRef.current = refreshToken
    diffQuery.refetch()
  }, [diffQuery, refreshToken])

  const { width: sidebarWidth, isDragging, handleRef } = useResizablePanel({
    storageKey: 'forge-diff-sidebar-width',
    defaultWidth: 250,
    minWidth: 150,
    maxWidth: 500,
  })

  if (statusError) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <FileX2 className="mb-3 size-12 opacity-25" />
        <span className="text-sm font-medium">Unable to read repository</span>
        <span className="mt-1 max-w-sm text-center text-xs opacity-60">{statusError}</span>
      </div>
    )
  }

  if (!isStatusLoading && files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <FileX2 className="mb-3 size-12 opacity-25" />
        <span className="text-sm font-medium">No uncommitted changes</span>
        <span className="mt-1 text-xs opacity-60">Working directory is clean</span>
      </div>
    )
  }

  const visibleSummary = {
    filesChanged: visibleFiles.length,
    insertions: visibleFiles.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: visibleFiles.reduce((total, file) => total + (file.deletions ?? 0), 0),
  }

  return (
    <div className="flex h-full">
      <div className="shrink-0 border-r border-border/60" style={{ width: sidebarWidth }}>
        <FileList
          files={files}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          isLoading={isStatusLoading}
          summary={visibleSummary}
          repoTarget={repoTarget}
          quickFilter={quickFilter}
          onQuickFilterChange={setQuickFilter}
        />
      </div>

      <div
        ref={handleRef}
        className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
          isDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
        }`}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

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
