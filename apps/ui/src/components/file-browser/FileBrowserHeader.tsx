import { FolderOpen, GitBranch, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface FileBrowserHeaderProps {
  repoName: string | null
  branch: string | null
  isRefreshing: boolean
  onRefresh: () => void
  onClose: () => void
}

export function FileBrowserHeader({
  repoName,
  branch,
  isRefreshing,
  onRefresh,
  onClose,
}: FileBrowserHeaderProps) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 bg-card px-3">
      {/* Title */}
      <div className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
        <FolderOpen className="size-4 text-muted-foreground" />
        <span>File Browser</span>
      </div>

      {/* Separator */}
      <span className="text-muted-foreground/30" aria-hidden>·</span>

      {/* Repo info */}
      {repoName ? (
        <span className="text-xs font-medium text-foreground">{repoName}</span>
      ) : null}

      {branch ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="size-3" />
          {branch}
        </span>
      ) : null}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Refresh button */}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
              aria-label="Refresh"
            >
              <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            Refresh
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Close button */}
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        onClick={onClose}
        aria-label="Close file browser"
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}
