import { GitBranch, GitCommit, HardDrive, Lock, RefreshCw, ShieldAlert, Users } from 'lucide-react'
import type { GitRepoTarget, GitWorktreeListResult, GitWorktreeSummary } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useGitWorktrees } from './use-diff-queries'

interface WorktreesViewProps {
  wsUrl: string
  agentId: string | null
  repoTarget: GitRepoTarget
  refreshToken: number
  onOpenCurrentWorktree: () => void
}

function formatShortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : 'unknown'
}

function formatPathLabel(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? path
}

function formatDirtySummary(worktree: GitWorktreeSummary): string {
  const { filesChanged, insertions, deletions } = worktree.dirtySummary
  if (!worktree.dirty || filesChanged === 0) {
    return 'Clean'
  }

  const parts = [`${filesChanged} ${filesChanged === 1 ? 'file' : 'files'}`]
  if (insertions > 0) parts.push(`+${insertions}`)
  if (deletions > 0) parts.push(`-${deletions}`)
  return parts.join(' ')
}

function WorktreeStateBadges({ worktree }: { worktree: GitWorktreeSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={worktree.dirty ? 'destructive' : 'secondary'} className="h-5 rounded-sm px-1.5 text-[10px]">
        {formatDirtySummary(worktree)}
      </Badge>
      {worktree.isCurrentContext ? (
        <Badge variant="outline" className="h-5 rounded-sm border-primary/40 px-1.5 text-[10px] text-primary">
          Current
        </Badge>
      ) : null}
      {worktree.isMainWorktree ? (
        <Badge variant="outline" className="h-5 rounded-sm px-1.5 text-[10px]">
          Main
        </Badge>
      ) : null}
      {worktree.locked ? (
        <Badge variant="outline" className="h-5 gap-1 rounded-sm px-1.5 text-[10px]">
          <Lock className="size-2.5" /> Locked
        </Badge>
      ) : null}
      {worktree.prunable ? (
        <Badge variant="outline" className="h-5 gap-1 rounded-sm border-amber-500/40 px-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          <ShieldAlert className="size-2.5" /> Prunable
        </Badge>
      ) : null}
      {worktree.activeAgents.length > 0 ? (
        <Badge variant="outline" className="h-5 gap-1 rounded-sm border-emerald-500/40 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
          <Users className="size-2.5" /> {worktree.activeAgents.length} active
        </Badge>
      ) : null}
    </div>
  )
}

function WorktreeCard({
  worktree,
  onOpenCurrentWorktree,
}: {
  worktree: GitWorktreeSummary
  onOpenCurrentWorktree: () => void
}) {
  return (
    <article
      className={cn(
        'rounded-lg border border-border/70 bg-card/60 p-3 transition-colors',
        worktree.isCurrentContext && 'border-primary/40 bg-primary/5',
      )}
    >
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <HardDrive className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="truncate text-sm font-medium text-foreground" title={worktree.path}>
              {formatPathLabel(worktree.path)}
            </h3>
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={worktree.path}>
              {worktree.path}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" />
              {worktree.branch ?? 'detached HEAD'}
            </span>
            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
              <GitCommit className="size-3" />
              {formatShortSha(worktree.headSha)}
            </span>
            <span className="truncate" title={worktree.repoRoot}>
              repo: {formatPathLabel(worktree.repoRoot)}
            </span>
          </div>
          <WorktreeStateBadges worktree={worktree} />
          {worktree.activeAgents.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
              {worktree.activeAgents.map((agent) => (
                <span key={agent.agentId} className="rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5">
                  {agent.displayName} · {agent.role} · {agent.status}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={onOpenCurrentWorktree}
            disabled={!worktree.isCurrentContext}
            title={worktree.isCurrentContext ? 'Open Changes for this context' : 'Opening another worktree context is planned for a later phase'}
          >
            Open Source Control
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled
            title="Browsing alternate worktrees is planned for the file-browser bridge phase"
          >
            Browse files
          </Button>
        </div>
      </div>
    </article>
  )
}

export function WorktreesView({
  wsUrl,
  agentId,
  repoTarget,
  refreshToken,
  onOpenCurrentWorktree,
}: WorktreesViewProps) {
  const worktreesQuery = useGitWorktrees(wsUrl, agentId, repoTarget, refreshToken)
  const payload: GitWorktreeListResult | null = worktreesQuery.data

  if (!agentId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a session to view worktrees.
      </div>
    )
  }

  if (worktreesQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="size-4 animate-spin" /> Loading worktrees…
      </div>
    )
  }

  if (worktreesQuery.error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load worktrees: {worktreesQuery.error}
        </div>
      </div>
    )
  }

  if (payload?.notInitialized) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        This workspace is not a Git repository.
      </div>
    )
  }

  const worktrees = payload?.worktrees ?? []

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border/60 bg-card/50 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Worktrees</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Read-only inventory for this repository. Actions that would switch, create, or remove worktrees are intentionally unavailable in this phase.
            </p>
          </div>
          {payload ? (
            <Badge variant="outline" className="rounded-sm text-[11px]">
              {payload.repoLabel} · {worktrees.length} {worktrees.length === 1 ? 'worktree' : 'worktrees'}
            </Badge>
          ) : null}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="space-y-3 p-4">
          {worktrees.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
              No worktrees were reported for this repository.
            </div>
          ) : (
            worktrees.map((worktree) => (
              <WorktreeCard
                key={worktree.id}
                worktree={worktree}
                onOpenCurrentWorktree={onOpenCurrentWorktree}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
