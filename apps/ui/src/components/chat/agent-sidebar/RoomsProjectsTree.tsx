import { Globe } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import type { BuilderSidebarOrderRef } from '@forge/protocol'
import type { ProfileTreeRow } from '@/lib/agent-hierarchy'
import { builderSidebarOrderKey, resolveBuilderSidebarDragMove } from '@/lib/builder-sidebar-order'
import type { RemoteSidebarOrigin } from './types'
import { SortableProfileGroup } from './SortableProfileGroup'

export type RoomsProjectTreeRow =
  | {
      kind: 'local'
      ref: BuilderSidebarOrderRef
      treeRow: ProfileTreeRow
    }
  | {
      kind: 'remote'
      ref: BuilderSidebarOrderRef
      treeRow: ProfileTreeRow
      origin: RemoteSidebarOrigin
    }

export function RoomsProjectsTree({
  rows,
  activeView,
  isSearchActive,
  dndEnabled: allowDnd = true,
  onMoveBuilderProject,
  renderRow,
  getMemoDependencies,
  emptyState,
  remoteOriginSections,
}: {
  rows: readonly RoomsProjectTreeRow[]
  activeView: boolean
  isSearchActive: boolean
  /** Inbox embeds the same tree but deliberately has no competing sortable context. */
  dndEnabled?: boolean
  onMoveBuilderProject?: (active: BuilderSidebarOrderRef, over: BuilderSidebarOrderRef) => void
  renderRow: (
    row: RoomsProjectTreeRow,
    dragHandleRef?: (element: HTMLElement | null) => void,
    dragHandleListeners?: DraggableSyntheticListeners,
    dragHandleAttributes?: DraggableAttributes,
  ) => ReactNode
  getMemoDependencies?: (row: RoomsProjectTreeRow) => readonly unknown[] | undefined
  emptyState?: ReactNode
  remoteOriginSections?: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const dndEnabled = allowDnd && !activeView && !isSearchActive && Boolean(onMoveBuilderProject) && rows.length > 1
  const sortableIds = rows.map((row) => builderSidebarOrderKey(row.ref))
  const activeDragRow = activeDragId
    ? rows.find((row) => builderSidebarOrderKey(row.ref) === activeDragId)
    : null

  const projectList = rows.length === 0
    ? emptyState ?? null
    : dndEnabled ? (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(event) => setActiveDragId(String(event.active.id))}
        onDragCancel={() => setActiveDragId(null)}
        onDragEnd={(event) => {
          setActiveDragId(null)
          const { active, over } = event
          if (!over || active.id === over.id || !onMoveBuilderProject) return
          const move = resolveBuilderSidebarDragMove(
            String(active.id),
            String(over.id),
            rows.map((row) => row.ref),
          )
          if (move) onMoveBuilderProject(move.active, move.over)
        }}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <ul className="mt-2 space-y-2" data-testid="unified-project-list">
            {rows.map((row) => {
              const sortableId = builderSidebarOrderKey(row.ref)
              return (
                <SortableProfileGroup
                  key={sortableId}
                  sortableId={sortableId}
                  memoDependencies={getMemoDependencies?.(row)}
                  roomsV2
                >
                  {(dragHandleRef, dragHandleListeners, dragHandleAttributes) => (
                    renderRow(row, dragHandleRef, dragHandleListeners, dragHandleAttributes)
                  )}
                </SortableProfileGroup>
              )
            })}
          </ul>
        </SortableContext>
        <DragOverlay>
          {activeDragRow ? (
            <div className="rounded-md border border-sidebar-border bg-sidebar shadow-lg">
              <div className="flex items-center gap-1.5 px-3 py-2">
                {activeDragRow.kind === 'remote' ? (
                  <Globe aria-hidden="true" className="sidebar-room-remote-marker sidebar-room-remote-marker--large" />
                ) : null}
                <span className="text-sm font-semibold">{activeDragRow.treeRow.profile.displayName}</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    ) : (
      <ul className="mt-2 space-y-2" data-testid="unified-project-list">
        {rows.map((row) => (
          <li key={builderSidebarOrderKey(row.ref)}>{renderRow(row)}</li>
        ))}
      </ul>
    )

  return (
    <>
      {projectList}
      {remoteOriginSections}
    </>
  )
}
