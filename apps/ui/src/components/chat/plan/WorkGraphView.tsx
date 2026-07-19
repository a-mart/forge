import {
  Check,
  Circle,
  CircleAlert,
  Clock3,
  GitBranch,
  LoaderCircle,
  Pause,
  X,
} from 'lucide-react'
import type { WorkGraphNode, WorkGraphSnapshot } from '@forge/protocol'
import { cn } from '@/lib/utils'

export function WorkGraphView({
  graph,
  compact = false,
}: {
  graph: WorkGraphSnapshot
  compact?: boolean
}) {
  const titleById = new Map(graph.nodes.map((node) => [node.id, node.title]))
  const visible = graph.nodes.filter((node) => node.status !== 'cancelled')
  const completed = visible.filter((node) => node.status === 'completed').length

  return (
    <div className={cn('space-y-2.5', compact && 'space-y-2')}>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="size-3.5" />
          Dynamic work graph
        </span>
        <span className="tabular-nums">up to {graph.maxConcurrency} parallel</span>
      </div>
      <ol className="space-y-2" aria-label="Work graph nodes">
        {graph.nodes.map((node) => (
          <li
            key={node.id}
            className={cn(
              'rounded-lg border border-border/60 bg-background/35 px-3 py-2',
              node.status === 'cancelled' && 'opacity-50',
            )}
          >
            <div className="flex items-start gap-2">
              <NodeStatusIcon node={node} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cn(
                    'text-sm leading-snug',
                    node.status === 'completed' && 'text-muted-foreground line-through decoration-muted-foreground/50',
                    (node.status === 'running' || node.status === 'awaiting_review') && 'font-medium text-foreground',
                  )}>
                    {node.title}
                  </span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {node.kind}
                  </span>
                  <NodeRuntimeBadge node={node} />
                </div>
                {node.dependsOn.length > 0 ? (
                  <p className="mt-1 truncate text-[11px] text-muted-foreground">
                    After {node.dependsOn.map((id) => titleById.get(id) ?? id).join(', ')}
                  </p>
                ) : null}
                {!compact && node.acceptanceCriteria ? (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Accept when: {node.acceptanceCriteria}
                  </p>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-[11px] tabular-nums text-muted-foreground">
        {completed} of {visible.length} accepted
      </p>
    </div>
  )
}

function NodeStatusIcon({ node }: { node: WorkGraphNode }) {
  switch (node.status) {
    case 'completed':
      return <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-label="Accepted" />
    case 'running':
      return <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-violet-500" aria-label="Running" />
    case 'awaiting_review':
      return <Clock3 className="mt-0.5 size-4 shrink-0 text-amber-500" aria-label="Awaiting review" />
    case 'waiting':
      return <Pause className="mt-0.5 size-4 shrink-0 text-sky-500" aria-label="Waiting for decision" />
    case 'blocked':
      return <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Blocked" />
    case 'cancelled':
      return <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Cancelled" />
    default:
      return <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" aria-label="Pending" />
  }
}

function NodeRuntimeBadge({ node }: { node: WorkGraphNode }) {
  const attempt = node.attempts[node.attempts.length - 1]
  if (!attempt) {
    return node.effort !== 'auto' ? (
      <span className="text-[10px] text-muted-foreground">{node.effort} requested</span>
    ) : null
  }
  const label = node.status === 'awaiting_review'
    ? `Review ${attempt.executionPolicy}`
    : `${attempt.executionPolicy} · try ${attempt.number}`
  return (
    <span className={cn(
      'text-[10px] capitalize text-muted-foreground',
      attempt.executionPolicy === 'deep' && 'text-fuchsia-500',
    )}>
      {label}
    </span>
  )
}
