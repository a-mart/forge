import { useEffect, useState } from 'react'
import {
  Check,
  ChevronDown,
  CirclePause,
  CirclePlay,
  Pencil,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import type { SessionGoalControlAction, SessionGoalSnapshotEvent } from '@forge/protocol'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatElapsed, formatTokenCount } from '@/lib/format-utils'
import { cn } from '@/lib/utils'

export function GoalBar({
  snapshot,
  onAction,
}: {
  snapshot?: SessionGoalSnapshotEvent | null
  onAction: (action: SessionGoalControlAction) => void
}) {
  const goal = snapshot?.goal
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [objective, setObjective] = useState('')
  const [tokenBudget, setTokenBudget] = useState('')
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (goal?.status !== 'active') return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [goal?.status])

  if (!snapshot || !goal || goal.status === 'completed' || goal.status === 'cancelled') return null

  const elapsedMs = goal.activeElapsedMs + (
    goal.status === 'active'
      ? Math.max(0, nowMs - Date.parse(snapshot.measuredAt))
      : 0
  )
  const statusLabel = goal.status === 'active'
    ? 'Pursuing goal'
    : goal.status === 'blocked'
      ? 'Goal blocked'
      : goal.pauseReason === 'token_budget_exhausted'
        ? 'Goal budget reached'
        : 'Goal paused'
  const startEditing = () => {
    setObjective(goal.objective)
    setTokenBudget(goal.tokenBudget?.toString() ?? '')
    setExpanded(true)
    setEditing(true)
  }
  const saveEdit = () => {
    const trimmed = objective.trim()
    if (!trimmed) return
    const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : null
    if (parsedBudget !== null && (!Number.isInteger(parsedBudget) || parsedBudget <= 0)) return
    onAction({ action: 'edit', objective: trimmed, tokenBudget: parsedBudget })
    setEditing(false)
  }

  return (
    <div className="relative z-20 h-0 shrink-0">
      <div className="absolute inset-x-0 top-1.5 px-3">
        <div className="mx-auto max-w-5xl rounded-lg border border-border/70 bg-card/90 shadow-sm backdrop-blur-sm">
        <div className="flex min-h-9 items-center gap-2 px-2.5 py-1.5">
          <Target className={cn(
            'size-3.5 shrink-0',
            goal.status === 'blocked' ? 'text-amber-500' : 'text-violet-500',
          )} />
          <span className="shrink-0 text-xs font-medium text-foreground">{statusLabel}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {goal.objective}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatElapsed(elapsedMs)}
          </span>
          {goal.tokenBudget !== undefined ? (
            <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground sm:inline">
              {formatTokenCount(goal.usage.total)} / {formatTokenCount(goal.tokenBudget)}
            </span>
          ) : null}

          <TooltipProvider delayDuration={200}>
            <GoalActionTooltip label="Edit goal">
              <Button variant="ghost" size="icon" className="size-7" onClick={startEditing} aria-label="Edit goal">
                <Pencil className="size-3.5" />
              </Button>
            </GoalActionTooltip>
            <GoalActionTooltip label={goal.status === 'active' ? 'Pause goal' : 'Resume goal'}>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => onAction({ action: goal.status === 'active' ? 'pause' : 'resume' })}
                aria-label={goal.status === 'active' ? 'Pause goal' : 'Resume goal'}
              >
                {goal.status === 'active'
                  ? <CirclePause className="size-3.5" />
                  : <CirclePlay className="size-3.5" />}
              </Button>
            </GoalActionTooltip>
            <AlertDialog>
              <GoalActionTooltip label="Cancel goal">
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" aria-label="Cancel goal">
                    <Trash2 className="size-3.5" />
                  </Button>
                </AlertDialogTrigger>
              </GoalActionTooltip>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel this goal?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Automatic pursuit will stop. The final goal record will remain available on disk.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep goal</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onAction({ action: 'cancel' })}>
                    Cancel goal
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </TooltipProvider>

          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setExpanded((current) => !current)}
            aria-label={expanded ? 'Collapse goal details' : 'Expand goal details'}
            aria-expanded={expanded}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
          </Button>
        </div>

          {expanded ? (
            <div className="border-t border-border/60 px-3 py-2.5">
              {editing ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={objective}
                    onChange={(event) => setObjective(event.target.value)}
                    maxLength={1_000}
                    aria-label="Goal objective"
                    className="h-8 flex-1 text-xs"
                  />
                  <Input
                    value={tokenBudget}
                    onChange={(event) => setTokenBudget(event.target.value)}
                    inputMode="numeric"
                    placeholder="No token budget"
                    aria-label="Goal token budget"
                    className="h-8 sm:w-40 text-xs"
                  />
                  <div className="flex gap-1">
                    <Button size="sm" className="h-8" onClick={saveEdit} disabled={!objective.trim()}>
                      <Check className="mr-1 size-3.5" /> Save
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditing(false)}>
                      <X className="mr-1 size-3.5" /> Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                  <span>{goal.turnCount} goal {goal.turnCount === 1 ? 'turn' : 'turns'}</span>
                  <span>{formatTokenCount(goal.usage.total)} tokens{goal.usageCoverage === 'partial' ? ' estimated' : ''}</span>
                  <span>Started {new Date(goal.createdAt).toLocaleString()}</span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function GoalActionTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={5}>{label}</TooltipContent>
    </Tooltip>
  )
}
