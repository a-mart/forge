import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import type { ProfileTreeRow } from '@/lib/agent-hierarchy'
import type { OriginId } from '@/lib/origin-store'

export interface RemoteProfileRowProps {
  originId: OriginId
  treeRow: ProfileTreeRow
  selectedAgentId: string | null
  isActiveOrigin: boolean
  instanceName?: string
  dragHandleRef?: (element: HTMLElement | null) => void
  dragHandleListeners?: DraggableSyntheticListeners
  dragHandleAttributes?: DraggableAttributes
  onSelectAgent: (originId: OriginId, agentId: string) => void
}

export function equalRemoteProfileRowProps(
  previous: RemoteProfileRowProps,
  next: RemoteProfileRowProps,
): boolean {
  return previous.originId === next.originId
    && previous.treeRow === next.treeRow
    && previous.selectedAgentId === next.selectedAgentId
    && previous.isActiveOrigin === next.isActiveOrigin
    && previous.instanceName === next.instanceName
    && previous.onSelectAgent === next.onSelectAgent
    // dnd-kit may regenerate callback objects when its shared context renders.
    // Presence plus semantic ARIA values are what affect this activator; the
    // existing listener/ref closures remain valid for the same keyed sortable.
    && Boolean(previous.dragHandleListeners) === Boolean(next.dragHandleListeners)
    && equalDraggableAttributes(previous.dragHandleAttributes, next.dragHandleAttributes)
}

function equalDraggableAttributes(
  previous: DraggableAttributes | undefined,
  next: DraggableAttributes | undefined,
): boolean {
  if (previous === next) return true
  if (!previous || !next) return false
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const key of keys) {
    if (!Object.is(
      previous[key as keyof DraggableAttributes],
      next[key as keyof DraggableAttributes],
    )) return false
  }
  return true
}
