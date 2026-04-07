import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Loader2, AlertTriangle, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileIcon } from '@/components/file-browser/FileIcon'
import { fetchSkillFiles } from './skills-viewer-api'
import type { SkillFileEntry } from './skills-viewer-types'

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface TreeNode {
  entry: SkillFileEntry
  children: TreeNode[] | null // null = not loaded yet
  isExpanded: boolean
  isLoading: boolean
}

interface SkillFileTreeProps {
  wsUrl: string
  skillId: string
  selectedFilePath: string | null
  onSelectFile: (path: string) => void
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function SkillFileTree({
  wsUrl,
  skillId,
  selectedFilePath,
  onSelectFile,
}: SkillFileTreeProps) {
  const [rootEntries, setRootEntries] = useState<TreeNode[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track expanded directory children keyed by directory path
  const [expandedDirs, setExpandedDirs] = useState<Record<string, TreeNode[]>>({})
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())

  // Load root entries when skill changes
  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)
    setRootEntries([])
    setExpandedDirs({})
    setLoadingDirs(new Set())

    fetchSkillFiles(wsUrl, skillId)
      .then((result) => {
        if (cancelled) return
        const nodes = entriesToNodes(result.entries)
        setRootEntries(nodes)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load files')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [wsUrl, skillId])

  const handleToggleDirectory = useCallback(
    async (dirPath: string) => {
      // If already expanded, collapse
      if (expandedDirs[dirPath]) {
        setExpandedDirs((prev) => {
          const next = { ...prev }
          delete next[dirPath]
          return next
        })
        return
      }

      // Load directory contents
      setLoadingDirs((prev) => new Set(prev).add(dirPath))
      try {
        const result = await fetchSkillFiles(wsUrl, skillId, dirPath)
        const nodes = entriesToNodes(result.entries)
        setExpandedDirs((prev) => ({ ...prev, [dirPath]: nodes }))
      } catch {
        // Silently fail — directory just won't expand
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev)
          next.delete(dirPath)
          return next
        })
      }
    },
    [wsUrl, skillId, expandedDirs],
  )

  const handleClick = useCallback(
    (entry: SkillFileEntry) => {
      if (entry.type === 'directory') {
        void handleToggleDirectory(entry.path)
      } else {
        onSelectFile(entry.path)
      }
    },
    [handleToggleDirectory, onSelectFile],
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-1 py-6 text-center">
        <AlertTriangle className="size-4 text-destructive/60" />
        <p className="text-xs text-muted-foreground">{error}</p>
      </div>
    )
  }

  if (rootEntries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 py-6 text-center">
        <FolderOpen className="size-5 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">No files</p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'overflow-y-auto',
        '[&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent',
        '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent',
        '[scrollbar-width:thin] [scrollbar-color:transparent_transparent]',
        'hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]',
      )}
    >
      {rootEntries.map((node) => (
        <TreeRow
          key={node.entry.path}
          node={node}
          depth={0}
          selectedFilePath={selectedFilePath}
          expandedDirs={expandedDirs}
          loadingDirs={loadingDirs}
          onClick={handleClick}
        />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Tree row                                                          */
/* ------------------------------------------------------------------ */

function TreeRow({
  node,
  depth,
  selectedFilePath,
  expandedDirs,
  loadingDirs,
  onClick,
}: {
  node: TreeNode
  depth: number
  selectedFilePath: string | null
  expandedDirs: Record<string, TreeNode[]>
  loadingDirs: Set<string>
  onClick: (entry: SkillFileEntry) => void
}) {
  const { entry } = node
  const isDir = entry.type === 'directory'
  const isExpanded = isDir && Boolean(expandedDirs[entry.path])
  const isLoadingDir = isDir && loadingDirs.has(entry.path)
  const isSelected = !isDir && entry.path === selectedFilePath

  const children = isExpanded ? expandedDirs[entry.path] : null

  return (
    <>
      <div
        className={cn(
          'flex h-7 cursor-pointer items-center gap-1 pr-2 text-[13px] leading-7 select-none',
          'hover:bg-accent/50 transition-colors',
          isSelected && 'bg-accent text-accent-foreground',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onClick(entry)}
        title={entry.name}
      >
        {isDir ? (
          isLoadingDir ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/60" />
          ) : (
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150',
                isExpanded && 'rotate-90',
              )}
            />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}

        <FileIcon
          fileName={entry.name}
          isDirectory={isDir}
          isExpanded={isExpanded}
        />

        <span className="min-w-0 truncate">{entry.name}</span>
      </div>

      {children &&
        children.map((child) => (
          <TreeRow
            key={child.entry.path}
            node={child}
            depth={depth + 1}
            selectedFilePath={selectedFilePath}
            expandedDirs={expandedDirs}
            loadingDirs={loadingDirs}
            onClick={onClick}
          />
        ))}
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function entriesToNodes(entries: SkillFileEntry[]): TreeNode[] {
  // Sort: directories first, then files, alphabetical within each group
  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return sorted.map((entry) => ({
    entry,
    children: null,
    isExpanded: false,
    isLoading: false,
  }))
}
