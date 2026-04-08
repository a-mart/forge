import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ProfileTreeRow } from '@/lib/agent-hierarchy'
import type React from 'react'

export function SortableProfileGroup({
  treeRow,
  children,
}: {
  treeRow: ProfileTreeRow
  children: (dragHandleRef: (element: HTMLElement | null) => void, dragHandleListeners: Record<string, unknown> | undefined) => React.ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: treeRow.profile.profileId })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <li ref={setNodeRef} style={style} {...attributes}>
      {children(setActivatorNodeRef, listeners)}
    </li>
  )
}
