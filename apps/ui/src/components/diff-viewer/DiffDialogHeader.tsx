import { GitBranch, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type DiffTab = 'changes' | 'history'

interface DiffDialogHeaderProps {
  activeTab: DiffTab
  onTabChange: (tab: DiffTab) => void
  repoName: string | null
  branch: string | null
  isRefreshing: boolean
  onRefresh: () => void
  onClose: () => void
}

export function DiffDialogHeader({
  activeTab,
  onTabChange,
  repoName,
  branch,
  isRefreshing,
  onRefresh,
  onClose,
}: DiffDialogHeaderProps) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 bg-card px-3">
      {/* Tab switcher */}
      <div className="inline-flex h-7 items-center rounded-md border border-border/60 bg-muted/30 p-0.5">
        <TabButton
          label="Changes"
          active={activeTab === 'changes'}
          onClick={() => onTabChange('changes')}
        />
        <TabButton
          label="History"
          active={activeTab === 'history'}
          onClick={() => onTabChange('history')}
        />
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
        aria-label="Close diff viewer"
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string
  active: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={cn(
        'h-[22px] min-w-16 rounded-[4px] px-2 text-[11px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
        disabled && !active && 'cursor-not-allowed opacity-40',
      )}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}
