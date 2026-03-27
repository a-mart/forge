import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import type { GitRepoTarget } from '@forge/protocol'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { FileStatusBadge } from './FileStatusBadge'
import {
  KNOWLEDGE_QUICK_FILTERS,
  groupFilesByKnowledgeSurface,
  matchesKnowledgeQuickFilter,
  type KnowledgeQuickFilterId,
  type KnowledgeSurfaceId,
} from './knowledge-surface'
import type { GitFileStatus } from './use-diff-queries'

interface FileListProps {
  files: GitFileStatus[]
  selectedFile: string | null
  onSelectFile: (path: string) => void
  isLoading: boolean
  summary?: { filesChanged: number; insertions: number; deletions: number }
  repoTarget: GitRepoTarget
  quickFilter: KnowledgeQuickFilterId
  onQuickFilterChange: (filter: KnowledgeQuickFilterId) => void
}

export function FileList({
  files,
  selectedFile,
  onSelectFile,
  isLoading,
  summary,
  repoTarget,
  quickFilter,
  onQuickFilterChange,
}: FileListProps) {
  const [filter, setFilter] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Partial<Record<KnowledgeSurfaceId, boolean>>>({})
  const isKnowledgeMode = repoTarget === 'versioning'

  useEffect(() => {
    setCollapsedGroups({})
  }, [repoTarget, quickFilter])

  const filteredFiles = useMemo(() => {
    let nextFiles = files

    if (isKnowledgeMode) {
      nextFiles = nextFiles.filter((file) => matchesKnowledgeQuickFilter(file.path, quickFilter))
    }

    if (!filter.trim()) {
      return nextFiles
    }

    const lower = filter.toLowerCase()
    return nextFiles.filter((file) => file.path.toLowerCase().includes(lower))
  }, [files, filter, isKnowledgeMode, quickFilter])

  const groupedFiles = useMemo(() => groupFilesByKnowledgeSurface(filteredFiles), [filteredFiles])

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border/60 p-2">
          <Skeleton className="h-7 w-full rounded" />
        </div>
        <div className="flex-1 space-y-1 p-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full rounded" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/60 p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="h-7 w-full rounded border border-border/60 bg-muted/30 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none"
          />
        </div>
        {isKnowledgeMode ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {KNOWLEDGE_QUICK_FILTERS.map((option) => {
              const active = option.id === quickFilter
              return (
                <button
                  key={option.id}
                  type="button"
                  title={option.pathLabel}
                  className={cn(
                    'inline-flex h-6 items-center rounded-full border px-2 text-[10px] font-medium transition-colors',
                    active
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60 bg-muted/30 text-muted-foreground hover:border-border hover:text-foreground',
                  )}
                  aria-pressed={active}
                  onClick={() => onQuickFilterChange(option.id)}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto p-1" role="listbox" aria-label="Changed files">
        {filteredFiles.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {filter || (isKnowledgeMode && quickFilter !== 'all') ? 'No matching files' : 'No changed files'}
          </div>
        ) : isKnowledgeMode ? (
          groupedFiles.map((group) => {
            const isCollapsed = collapsedGroups[group.surface.id] ?? false
            return (
              <div key={group.surface.id} className="mb-2 last:mb-0">
                <button
                  type="button"
                  className="flex w-full items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
                  onClick={() =>
                    setCollapsedGroups((previous) => ({
                      ...previous,
                      [group.surface.id]: !isCollapsed,
                    }))
                  }
                  aria-expanded={!isCollapsed}
                >
                  <ChevronDown
                    className={cn('size-3 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
                  />
                  <span className="truncate">{group.surface.label}</span>
                  <span className="ml-auto shrink-0 text-[10px] normal-case text-muted-foreground/70">
                    {group.files.length}
                  </span>
                </button>
                {!isCollapsed ? group.files.map((file) => renderFileRow(file, selectedFile, onSelectFile)) : null}
              </div>
            )
          })
        ) : (
          filteredFiles.map((file) => renderFileRow(file, selectedFile, onSelectFile))
        )}
      </div>

      {summary ? (
        <div className="border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>{summary.filesChanged} changed</span>
          {summary.insertions > 0 ? (
            <span className="ml-1.5 text-emerald-500">+{summary.insertions}</span>
          ) : null}
          {summary.deletions > 0 ? (
            <span className="ml-1 text-red-500">-{summary.deletions}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function renderFileRow(
  file: GitFileStatus,
  selectedFile: string | null,
  onSelectFile: (path: string) => void,
) {
  const fileName = file.path.split('/').pop() ?? file.path
  const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
  const isSelected = selectedFile === file.path

  return (
    <button
      key={file.path}
      role="option"
      aria-selected={isSelected}
      aria-label={`${fileName}, ${file.status}${file.additions != null ? `, ${file.additions} additions` : ''}${file.deletions != null ? `, ${file.deletions} deletions` : ''}`}
      className={cn(
        'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors',
        isSelected
          ? 'bg-accent/80 text-foreground'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
      onClick={() => onSelectFile(file.path)}
      title={file.path}
    >
      <FileStatusBadge status={file.status} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground">{fileName}</span>
        {dirPath ? <span className="ml-1 text-muted-foreground/60">{dirPath}/</span> : null}
      </span>
      {file.additions != null || file.deletions != null ? (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {file.additions != null && file.additions > 0 ? (
            <span className="text-emerald-500">+{file.additions}</span>
          ) : null}
          {file.deletions != null && file.deletions > 0 ? (
            <span className="ml-0.5 text-red-500">-{file.deletions}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  )
}
