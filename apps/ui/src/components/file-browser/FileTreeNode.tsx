import { useCallback } from 'react'
import { ChevronRight, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileIcon } from './FileIcon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface FileTreeNodeProps {
  name: string
  path: string
  cwd: string
  type: 'file' | 'directory'
  depth: number
  isExpanded: boolean
  isSelected: boolean
  isFocused: boolean
  isLoading: boolean
  onClick: () => void
}

export function FileTreeNode({
  name,
  path,
  cwd,
  type,
  depth,
  isExpanded,
  isSelected,
  isFocused,
  isLoading,
  onClick,
}: FileTreeNodeProps) {
  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(cwd ? `${cwd.replace(/\/+$/, '')}/${path}` : path)
  }, [cwd, path])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex h-7 cursor-pointer items-center gap-1 pr-2 text-[13px] leading-7 select-none',
            'hover:bg-accent/50 transition-colors',
            isSelected && 'bg-accent text-accent-foreground',
            isFocused && !isSelected && 'outline outline-1 outline-ring/50 -outline-offset-1',
          )}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
          onClick={onClick}
          title={name}
        >
      {type === 'directory' ? (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150',
            isExpanded && 'rotate-90',
            isLoading && 'animate-spin',
          )}
        />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}

      <FileIcon
        fileName={name}
        isDirectory={type === 'directory'}
        isExpanded={isExpanded}
      />

      <span className="min-w-0 truncate">{name}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[160px]">
        <ContextMenuItem onClick={handleCopyPath} className="gap-2 text-xs">
          <Copy className="size-3.5" />
          Copy Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
