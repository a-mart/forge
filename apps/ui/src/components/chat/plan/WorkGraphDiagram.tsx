import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { WorkGraphNode, WorkGraphSnapshot } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  WorkGraphNodeRuntime,
  WorkGraphNodeStatusIcon,
} from './WorkGraphNodeMeta'
import { workGraphNodeStatusLabel } from './work-graph-node-status'
import { getWorkGraphNodeWorkerId } from '../work-graph-node-worker'
import { useWorkGraphWorkerHighlight } from '../work-graph-worker-highlight-context'
import { workGraphColumnCount } from './plan-surface'

interface PositionedNode {
  node: WorkGraphNode
  row: number
  column: number | 'center'
}

interface GraphEdge {
  id: string
  path: string
  state: 'complete' | 'active' | 'inactive'
  targetX: number
  targetY: number
}

export function WorkGraphDiagram({
  graph,
  compact,
}: {
  graph: WorkGraphSnapshot
  compact: boolean
}) {
  const { highlightWorker } = useWorkGraphWorkerHighlight()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const userSelectedRef = useRef(false)
  const [stageWidth, setStageWidth] = useState(720)
  const [selectedNodeId, setSelectedNodeId] = useState(() => defaultSelectedNodeId(graph.nodes))
  const [edges, setEdges] = useState<GraphEdge[]>([])
  // Column count is always width-driven so dock and inline surfaces share layout.
  const columnCount = workGraphColumnCount(stageWidth)
  const positionedNodes = useMemo(
    () => positionGraphNodes(graph.nodes, columnCount),
    [columnCount, graph.nodes],
  )
  const titleById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node.title])),
    [graph.nodes],
  )
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? graph.nodes[0]

  useEffect(() => {
    const fallback = defaultSelectedNodeId(graph.nodes)
    if (!graph.nodes.some((node) => node.id === selectedNodeId)) {
      userSelectedRef.current = false
      setSelectedNodeId(fallback)
    } else if (!userSelectedRef.current && fallback !== selectedNodeId) {
      setSelectedNodeId(fallback)
    }
  }, [graph.nodes, selectedNodeId])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const updateWidth = () => setStageWidth(Math.round(stage.getBoundingClientRect().width))
    updateWidth()
    const ownerWindow = stage.ownerDocument.defaultView
    const ResizeObserverImpl = ownerWindow?.ResizeObserver
    if (!ResizeObserverImpl) return
    const observer = new ResizeObserverImpl(updateWidth)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const measureEdges = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const stageRect = stage.getBoundingClientRect()
    if (stageRect.width <= 0 || stageRect.height <= 0) {
      setEdges([])
      return
    }
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
    const measured: GraphEdge[] = []
    for (const targetNode of graph.nodes) {
      const targetElement = nodeRefs.current.get(targetNode.id)
      if (!targetElement) continue
      const targetRect = targetElement.getBoundingClientRect()
      for (const sourceId of targetNode.dependsOn) {
        const sourceElement = nodeRefs.current.get(sourceId)
        const sourceNode = nodeById.get(sourceId)
        if (!sourceElement || !sourceNode) continue
        const sourceRect = sourceElement.getBoundingClientRect()
        const sourceX = sourceRect.left + sourceRect.width / 2 - stageRect.left
        const sourceY = sourceRect.bottom - stageRect.top
        const targetX = targetRect.left + targetRect.width / 2 - stageRect.left
        const targetY = targetRect.top - stageRect.top
        const dependencyIndex = targetNode.dependsOn.indexOf(sourceId)
        const path = columnCount === 1 && targetY - sourceY > 56
          ? compactEdgePath({
              sourceX,
              sourceY,
              targetX,
              targetY,
              stageWidth: stageRect.width,
              dependencyIndex,
            })
          : curvedEdgePath(sourceX, sourceY, targetX, targetY)
        measured.push({
          id: `${sourceId}:${targetNode.id}`,
          path,
          state: edgeState(sourceNode, targetNode),
          targetX,
          targetY,
        })
      }
    }
    setEdges(measured)
  }, [columnCount, graph.nodes])

  useLayoutEffect(() => {
    measureEdges()
  }, [measureEdges, positionedNodes, stageWidth])

  const setNodeRef = useCallback((nodeId: string, element: HTMLButtonElement | null) => {
    if (element) nodeRefs.current.set(nodeId, element)
    else nodeRefs.current.delete(nodeId)
  }, [])

  if (!selectedNode) return null

  const dependencyLabel = selectedNode.dependsOn.length > 0
    ? selectedNode.dependsOn.map((id) => titleById.get(id) ?? id).join(' + ')
    : 'Ready immediately'

  return (
    <div className={cn('space-y-2.5', compact && 'space-y-2')} data-work-graph-view="graph">
      <div
        ref={stageRef}
        className={cn('relative isolate', columnCount === 1 && 'px-5')}
        role="group"
        aria-label="Work graph nodes"
      >
        <svg
          className="pointer-events-none absolute inset-0 z-0 size-full overflow-visible"
          aria-hidden="true"
        >
          {edges.map((edge) => (
            <g key={edge.id}>
              <path
                d={edge.path}
                fill="none"
                className={cn(
                  'stroke-border [vector-effect:non-scaling-stroke]',
                  edge.state === 'complete' && 'stroke-emerald-500/60',
                  edge.state === 'active' && 'stroke-violet-500/70',
                )}
                strokeWidth="1.5"
              />
              <circle
                cx={edge.targetX}
                cy={edge.targetY}
                r="3"
                className={cn(
                  'fill-border',
                  edge.state === 'complete' && 'fill-emerald-500',
                  edge.state === 'active' && 'fill-violet-500',
                )}
              />
            </g>
          ))}
        </svg>
        <div
          className={cn('relative z-10 grid gap-x-3 gap-y-4', compact && 'gap-y-3')}
          style={{
            gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
            gridAutoRows: 'minmax(3.75rem, auto)',
          }}
        >
          {positionedNodes.map(({ node, row, column }) => {
            const selected = node.id === selectedNode.id
            const style: CSSProperties = {
              gridRow: row,
              gridColumn: column === 'center' ? '1 / -1' : column,
              ...(column === 'center' ? { justifySelf: 'center', width: 'min(100%, 16rem)' } : {}),
            }
            return (
              <Button
                key={node.id}
                ref={(element) => setNodeRef(node.id, element)}
                type="button"
                variant="outline"
                aria-pressed={selected}
                aria-label={`${node.title}, ${workGraphNodeStatusLabel(node.status)}`}
                className={cn(
                  'h-auto min-h-16 w-full min-w-0 flex-col items-stretch gap-1.5 overflow-hidden bg-background px-2.5 py-2 text-left shadow-none',
                  'aria-pressed:border-ring aria-pressed:ring-1 aria-pressed:ring-ring',
                  // Status tints use an inset shadow wash so the opaque bg-background
                  // base is never replaced by a translucent bg color, which let
                  // connector lines show through the cards.
                  node.status === 'completed' && 'shadow-[inset_0_0_0_999px_color-mix(in_srgb,var(--color-emerald-500)_6%,transparent)]',
                  (node.status === 'running' || node.status === 'awaiting_review') && 'shadow-[inset_0_0_0_999px_color-mix(in_srgb,var(--color-violet-500)_7%,transparent)]',
                  node.status === 'waiting' && 'shadow-[inset_0_0_0_999px_color-mix(in_srgb,var(--color-sky-500)_7%,transparent)]',
                  node.status === 'blocked' && 'shadow-[inset_0_0_0_999px_color-mix(in_srgb,var(--color-destructive)_6%,transparent)]',
                  (node.status === 'pending' || node.status === 'cancelled') && 'opacity-70',
                )}
                style={style}
                onClick={() => {
                  userSelectedRef.current = true
                  setSelectedNodeId(node.id)
                  highlightWorker(getWorkGraphNodeWorkerId(node))
                }}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium normal-case">{node.title}</span>
                  <WorkGraphNodeStatusIcon node={node} className="size-3.5" />
                </span>
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-normal normal-case">
                  <span className="text-[10px] capitalize text-muted-foreground">{node.kind}</span>
                  <span className="text-[10px] text-muted-foreground/50">·</span>
                  <WorkGraphNodeRuntime node={node} />
                </span>
              </Button>
            )
          })}
        </div>
      </div>
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5" aria-live="polite">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{selectedNode.title}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              <span className="capitalize">{selectedNode.kind}</span>
              {' · '}{workGraphNodeStatusLabel(selectedNode.status)}
              {' · '}After: {dependencyLabel}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {workGraphNodeStatusLabel(selectedNode.status)}
          </span>
        </div>
        {!compact && selectedNode.acceptanceCriteria ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Accept when: {selectedNode.acceptanceCriteria}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function positionGraphNodes(nodes: readonly WorkGraphNode[], columnCount: number): PositionedNode[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const depthById = new Map<string, number>()
  const visiting = new Set<string>()
  const findDepth = (node: WorkGraphNode): number => {
    const cached = depthById.get(node.id)
    if (cached !== undefined) return cached
    if (visiting.has(node.id)) return 0
    visiting.add(node.id)
    const dependencies = node.dependsOn
      .map((id) => nodesById.get(id))
      .filter((dependency): dependency is WorkGraphNode => Boolean(dependency))
    const depth = dependencies.length === 0
      ? 0
      : Math.max(...dependencies.map((dependency) => findDepth(dependency))) + 1
    visiting.delete(node.id)
    depthById.set(node.id, depth)
    return depth
  }
  const layers = new Map<number, WorkGraphNode[]>()
  for (const node of nodes) {
    const depth = findDepth(node)
    const layer = layers.get(depth) ?? []
    layer.push(node)
    layers.set(depth, layer)
  }

  const positioned: PositionedNode[] = []
  let row = 1
  for (const [, layer] of [...layers.entries()].sort(([left], [right]) => left - right)) {
    const chunks = chunk(layer, columnCount)
    for (const layerChunk of chunks) {
      layerChunk.forEach((node, index) => {
        positioned.push({
          node,
          row,
          column: layerChunk.length === 1
            ? 'center'
            : columnCount === 3 && layerChunk.length === 2
              ? (index === 0 ? 1 : 3)
              : index + 1,
        })
      })
      row += 1
    }
  }
  return positioned
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function defaultSelectedNodeId(nodes: readonly WorkGraphNode[]): string {
  return nodes.find((node) => ['running', 'awaiting_review', 'waiting', 'blocked'].includes(node.status))?.id
    ?? nodes.find((node) => node.status === 'pending')?.id
    ?? nodes.at(-1)?.id
    ?? ''
}

function edgeState(source: WorkGraphNode, target: WorkGraphNode): GraphEdge['state'] {
  if (source.status === 'completed' && target.status === 'completed') return 'complete'
  if (
    ['running', 'awaiting_review'].includes(source.status)
    || ['running', 'awaiting_review'].includes(target.status)
  ) return 'active'
  return 'inactive'
}

function curvedEdgePath(sourceX: number, sourceY: number, targetX: number, targetY: number): string {
  const bend = Math.max(18, (targetY - sourceY) * 0.5)
  return `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY + bend}, ${targetX} ${targetY - bend}, ${targetX} ${targetY}`
}

function compactEdgePath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  stageWidth,
  dependencyIndex,
}: {
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  stageWidth: number
  dependencyIndex: number
}): string {
  const railInset = 7 + Math.floor(dependencyIndex / 2) * 6
  const railX = dependencyIndex % 2 === 0 ? railInset : stageWidth - railInset
  const departureY = sourceY + 10
  const arrivalY = targetY - 10
  return [
    `M ${sourceX} ${sourceY}`,
    `C ${sourceX} ${sourceY + 5}, ${railX} ${sourceY + 5}, ${railX} ${departureY}`,
    `L ${railX} ${arrivalY}`,
    `C ${railX} ${targetY - 5}, ${targetX} ${targetY - 5}, ${targetX} ${targetY}`,
  ].join(' ')
}
