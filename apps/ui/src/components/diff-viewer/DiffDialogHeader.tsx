import type { GitRepoTarget } from '@forge/protocol'
import { GitBranch, HardDrive, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type DiffTab = 'changes' | 'history' | 'worktrees' | 'pull-requests'

function formatPathLabel(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? path
}

interface DiffDialogHeaderProps {
  activeTab: DiffTab
  onTabChange: (tab: DiffTab) => void
  repoTarget: GitRepoTarget
  onRepoTargetChange: (target: GitRepoTarget) => void
  showRepoSelector: boolean
  repoLabel: string | null
  repoName: string | null
  branch: string | null
  currentWorktreePath?: string | null
  worktreeCount?: number | null
  selectedWorktreeId?: string | null
  isRefreshing: boolean
  onRefresh: () => void
  onClose: () => void
}

export function DiffDialogHeader({
  activeTab,
  onTabChange,
  repoTarget,
  onRepoTargetChange,
  showRepoSelector,
  repoLabel,
  repoName,
  branch,
  currentWorktreePath,
  worktreeCount,
  selectedWorktreeId,
  isRefreshing,
  onRefresh,
  onClose,
}: DiffDialogHeaderProps) {
  const workspaceLabel = repoTarget === 'workspace' ? (repoLabel ?? 'Workspace') : 'Workspace'
  const versioningLabel = repoTarget === 'versioning' ? (repoLabel ?? 'Cortex Knowledge') : 'Cortex Knowledge'

  const worktreeLabel = currentWorktreePath ? formatPathLabel(currentWorktreePath) : null
  const worktreeChipTitle = currentWorktreePath
    ? selectedWorktreeId
      ? `Selected worktree: ${currentWorktreePath} (chat session CWD unchanged)`
      : currentWorktreePath
    : undefined

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 bg-card px-3">
      <div className="hidden items-center gap-2 text-xs font-semibold text-foreground sm:flex">
        <GitBranch className="size-3.5 text-primary" />
        Source Control
      </div>

      {/* Tab switcher */}
      <div className="inline-flex h-7 min-w-0 items-center overflow-x-auto rounded-md border border-border/60 bg-muted/30 p-0.5">
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
        <TabButton
          label="Worktrees"
          active={activeTab === 'worktrees'}
          onClick={() => onTabChange('worktrees')}
        />
        <TabButton
          label="Pull Requests"
          active={activeTab === 'pull-requests'}
          onClick={() => onTabChange('pull-requests')}
        />
      </div>

      {showRepoSelector ? (
        <>
          <span className="text-muted-foreground/30" aria-hidden>·</span>
          <div
            className="inline-flex h-7 items-center rounded-md border border-border/60 bg-muted/30 p-0.5"
            role="group"
            aria-label="Repository target"
          >
            <TabButton
              label={workspaceLabel}
              active={repoTarget === 'workspace'}
              onClick={() => onRepoTargetChange('workspace')}
            />
            <TabButton
              label={versioningLabel}
              active={repoTarget === 'versioning'}
              onClick={() => onRepoTargetChange('versioning')}
            />
          </div>
        </>
      ) : null}

      {(repoName || branch) ? (
        <span className="text-muted-foreground/30" aria-hidden>·</span>
      ) : null}

      {/* Repo info */}
      {repoName ? (
        <span className="hidden text-xs font-medium text-foreground md:inline">{repoName}</span>
      ) : null}

      {worktreeLabel ? (
        <span className={cn(
          'hidden max-w-44 items-center gap-1 truncate rounded-md border px-1.5 py-1 text-xs lg:inline-flex',
          selectedWorktreeId
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200'
            : 'border-border/60 bg-muted/25 text-muted-foreground',
        )} title={worktreeChipTitle}>
          <HardDrive className="size-3 shrink-0" />
          <span className="truncate">{selectedWorktreeId ? `Selected · ${worktreeLabel}` : worktreeLabel}</span>
          {typeof worktreeCount === 'number' && worktreeCount > 1 ? (
            <span className="text-[10px] text-muted-foreground/70">+{worktreeCount - 1}</span>
          ) : null}
        </span>
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
        aria-label="Close Source Control"
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
        'h-[22px] min-w-14 shrink-0 rounded-[4px] px-2 text-[11px] font-medium transition-colors',
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
