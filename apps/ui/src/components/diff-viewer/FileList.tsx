import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { FileStatusBadge } from './FileStatusBadge'
import type { GitFileStatus } from './use-diff-queries'

interface FileListProps {
  files: GitFileStatus[]
  selectedFile: string | null
  onSelectFile: (path: string) => void
  isLoading: boolean
  summary?: { filesChanged: number; insertions: number; deletions: number }
}

export function FileList({
  files,
  selectedFile,
  onSelectFile,
  isLoading,
  summary,
}: FileListProps) {
  const [filter, setFilter] = useState('')

  const filteredFiles = useMemo(() => {
    if (!filter.trim()) return files
    const lower = filter.toLowerCase()
    return files.filter((f) => f.path.toLowerCase().includes(lower))
  }, [files, filter])

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
      {/* Filter input */}
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
      </div>

      {/* File items */}
      <div className="flex-1 overflow-y-auto p-1" role="listbox" aria-label="Changed files">
        {filteredFiles.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {filter ? 'No matching files' : 'No changed files'}
          </div>
        ) : (
          filteredFiles.map((file) => {
            const fileName = file.path.split('/').pop() ?? file.path
            const dirPath = file.path.includes('/')
              ? file.path.slice(0, file.path.lastIndexOf('/'))
              : ''
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
                  {dirPath ? (
                    <span className="ml-1 text-muted-foreground/60">{dirPath}/</span>
                  ) : null}
                </span>
                {(file.additions != null || file.deletions != null) ? (
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
          })
        )}
      </div>

      {/* Summary footer */}
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
