import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import { memo, type CSSProperties, type ReactNode } from 'react'

interface SortableProfileGroupProps {
  /** Explicit composite `(originId, profileId)` identity. */
  sortableId: string
  /**
   * Optional semantic dependencies used to isolate a remote sortable row from
   * unrelated local sidebar renders. Omit for local rows, whose rich callbacks
   * and status props must always be refreshed from their render closure.
   */
  memoDependencies?: readonly unknown[]
  /** Keeps the sortable wrapper visually neutral in Classic mode. */
  roomsV2?: boolean
  children: (
    dragHandleRef: (element: HTMLElement | null) => void,
    dragHandleListeners: DraggableSyntheticListeners,
    dragHandleAttributes: DraggableAttributes,
  ) => ReactNode
}

export const SortableProfileGroup = memo(function SortableProfileGroup({
  sortableId,
  roomsV2 = false,
  children,
}: SortableProfileGroupProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <li ref={setNodeRef} style={style} className={roomsV2 ? 'sidebar-room-sortable' : undefined}>
      {children(setActivatorNodeRef, listeners, attributes)}
    </li>
  )
}, (previous, next) => {
  const previousDependencies = previous.memoDependencies
  const nextDependencies = next.memoDependencies
  if (!previousDependencies || !nextDependencies) return false
  return previous.sortableId === next.sortableId
    && previous.roomsV2 === next.roomsV2
    && previousDependencies.length === nextDependencies.length
    && previousDependencies.every((value, index) => Object.is(value, nextDependencies[index]))
})
