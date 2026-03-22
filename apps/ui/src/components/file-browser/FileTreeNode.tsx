import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileIcon } from './FileIcon'

interface FileTreeNodeProps {
  name: string
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
  type,
  depth,
  isExpanded,
  isSelected,
  isFocused,
  isLoading,
  onClick,
}: FileTreeNodeProps) {
  return (
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
  )
}
