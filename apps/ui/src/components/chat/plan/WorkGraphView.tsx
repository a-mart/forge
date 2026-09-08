import { useId, useState } from 'react'
import { GitBranch, List } from 'lucide-react'
import type { WorkGraphSnapshot } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getWorkGraphNodeWorkerId } from '../work-graph-node-worker'
import { useWorkGraphWorkerHighlight } from '../work-graph-worker-highlight-context'
import { WorkGraphInspector } from './WorkGraphInspector'
import { workGraphNodeStatusLabel } from './work-graph-node-status'
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
  const [selection, setSelection] = useState<string | null>(null)
  const inspectorId = useId()
  const { highlightWorker } = useWorkGraphWorkerHighlight()
  const selectNode = (id: string) => {
    setSelection(id)
    const node = graph.nodes.find((candidate) => candidate.id === id)
    if (node) highlightWorker(getWorkGraphNodeWorkerId(node))
  }
  const selectedNode = graph.nodes.find((node) => node.id === selection)
    ?? graph.nodes.find((node) => ['running', 'awaiting_review', 'waiting', 'blocked'].includes(node.status))
    ?? graph.nodes.find((node) => node.status === 'pending')
    ?? graph.nodes.at(-1)
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
        <span className="inline-flex flex-wrap items-center gap-2">
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
        <WorkGraphDiagram graph={graph} compact={compact} selectedNodeId={selectedNode?.id ?? ''} onSelectNode={selectNode} inspectorId={inspectorId} />
      ) : (
        <ol className="space-y-2" aria-label="Work graph nodes" data-work-graph-view="list">
          {graph.nodes.map((node) => (
            <li
              key={node.id}
              className={cn(
                'rounded-lg border border-border/60 bg-background/35 px-3 py-2 [overflow-wrap:anywhere]',
                selectedNode?.id === node.id && 'border-ring ring-1 ring-ring',
                node.status === 'cancelled' && 'opacity-50',
              )}
            >
              <button type="button" className="flex w-full min-w-0 items-start gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${node.title}, ${workGraphNodeStatusLabel(node.status)}`} aria-pressed={selectedNode?.id === node.id} aria-controls={inspectorId} onClick={() => selectNode(node.id)}>
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
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      Accept when: {node.acceptanceCriteria}
                    </p>
                  ) : null}
                </div>
              </button>
            </li>
          ))}
        </ol>
      )}
      {selectedNode ? <WorkGraphInspector key={selectedNode.id} id={inspectorId} node={selectedNode} graph={graph} /> : <p className="text-xs text-muted-foreground">No steps in this graph.</p>}
      <p className="text-[11px] tabular-nums text-muted-foreground">
        {completed} of {visible.length} accepted
      </p>
    </div>
  )
}
