import { cn } from '@/lib/utils'

type FileStatusType = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'

interface FileStatusBadgeProps {
  status: FileStatusType
  className?: string
}

const STATUS_CONFIG: Record<FileStatusType, { label: string; className: string }> = {
  modified:  { label: 'M', className: 'bg-amber-500/20 text-amber-400 dark:text-amber-300' },
  added:     { label: 'A', className: 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' },
  deleted:   { label: 'D', className: 'bg-red-500/20 text-red-600 dark:text-red-400' },
  renamed:   { label: 'R', className: 'bg-blue-500/20 text-blue-600 dark:text-blue-400' },
  copied:    { label: 'C', className: 'bg-purple-500/20 text-purple-600 dark:text-purple-400' },
  untracked: { label: 'U', className: 'bg-muted text-muted-foreground' },
}

export function FileStatusBadge({ status, className }: FileStatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.modified

  return (
    <span
      className={cn(
        'inline-flex size-[18px] shrink-0 items-center justify-center rounded text-[10px] font-bold leading-none',
        config.className,
        className,
      )}
      title={status}
    >
      {config.label}
    </span>
  )
}
