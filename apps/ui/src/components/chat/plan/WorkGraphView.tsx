import { useState } from 'react'
import { GitBranch, List } from 'lucide-react'
import type { WorkGraphSnapshot } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { WorkGraphDiagram } from './WorkGraphDiagram'
import { WorkGraphNodeRuntime, WorkGraphNodeStatusIcon } from './WorkGraphNodeMeta'

export function WorkGraphView({
  graph,
  compact = false,
}: {
  graph: WorkGraphSnapshot
  compact?: boolean
}) {
  const [view, setView] = useState<'graph' | 'list'>('graph')
  const titleById = new Map(graph.nodes.map((node) => [node.id, node.title]))
  const visible = graph.nodes.filter((node) => node.status !== 'cancelled')
  const completed = visible.filter((node) => node.status === 'completed').length

  return (
    <div className={cn('space-y-2.5', compact && 'space-y-2')}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="size-3.5" />
          Dynamic work graph
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="tabular-nums">up to {graph.maxConcurrency} parallel</span>
          <span className="inline-flex rounded-md bg-muted p-0.5" role="group" aria-label="Work graph view">
            <Button
              type="button"
              size="sm"
              variant={view === 'graph' ? 'secondary' : 'ghost'}
              className="h-6 gap-1 px-2 text-[10px]"
              aria-pressed={view === 'graph'}
              onClick={() => setView('graph')}
            >
              <GitBranch className="size-3" />
              Graph
            </Button>
            <Button
              type="button"
              size="sm"
              variant={view === 'list' ? 'secondary' : 'ghost'}
              className="h-6 gap-1 px-2 text-[10px]"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <List className="size-3" />
              List
            </Button>
          </span>
        </span>
      </div>
      {view === 'graph' ? (
        <WorkGraphDiagram graph={graph} compact={compact} />
      ) : (
        <ol className="space-y-2" aria-label="Work graph nodes" data-work-graph-view="list">
          {graph.nodes.map((node) => (
            <li
              key={node.id}
              className={cn(
                'rounded-lg border border-border/60 bg-background/35 px-3 py-2',
                node.status === 'cancelled' && 'opacity-50',
              )}
            >
              <div className="flex items-start gap-2">
                <WorkGraphNodeStatusIcon node={node} className="mt-0.5" />
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
                    <WorkGraphNodeRuntime node={node} />
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
      )}
      <p className="text-[11px] tabular-nums text-muted-foreground">
        {completed} of {visible.length} accepted
      </p>
    </div>
  )
}
