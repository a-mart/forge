import { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CollaborationCategory, CollaborationChannel } from '@forge/protocol'
import type { CollabWsState } from '@/lib/collab-ws-state'
import {
  reorderCategories,
  reorderChannels,
  updateChannel,
} from '@/lib/collaboration-api'
import {
  getCategoryUnreadCount,
  getChannelUnreadCount,
} from '@/lib/collab-selectors'
import { CategoryGroup } from './CategoryGroup'
import { ChannelRowItem } from './ChannelRowItem'

const UNCATEGORIZED_KEY = '__uncategorized__'
const CATEGORY_DROP_ID_PREFIX = 'category-drop:'

interface ConnectionSectionProps {
  connectionId: string
  state: CollabWsState
  selectedChannelId?: string
  /** Whether this connection owns the currently active channel */
  isActiveConnection: boolean
  canManage: boolean
  collapsedCategoryIds: Set<string>
  mutedByChannelId: Record<string, boolean>
  /** API base URL for this connection's backend (target-aware). */
  apiBaseUrl?: string
  onSelectChannel: (channelId: string, connectionId: string) => void
  onToggleCategoryCollapsed: (categoryId: string) => void
  onRenameCategory: (category: CollaborationCategory) => void
  onDeleteCategory: (category: CollaborationCategory) => void
  onCreateChannelInCategory: (categoryId: string) => void
  onRenameChannel: (channel: CollaborationChannel) => void
  onArchiveChannel: (channel: CollaborationChannel) => void
  onToggleMute: (channel: CollaborationChannel) => void
  onMarkAsRead: (channel: CollaborationChannel) => void
  onOpenChannelSettings: (channel: CollaborationChannel) => void
  onOpenCreateCategory: () => void
  onMutationError: (error: string | null) => void
}

export function ConnectionSection({
  connectionId,
  state,
  selectedChannelId,
  isActiveConnection,
  canManage,
  collapsedCategoryIds,
  mutedByChannelId,
  apiBaseUrl,
  onSelectChannel,
  onToggleCategoryCollapsed,
  onRenameCategory,
  onDeleteCategory,
  onCreateChannelInCategory,
  onRenameChannel,
  onArchiveChannel,
  onToggleMute,
  onMarkAsRead,
  onOpenChannelSettings,
  onOpenCreateCategory,
  onMutationError,
}: ConnectionSectionProps) {
  const workspace = state.workspace

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const [activeDragId, setActiveDragId] = useState<string | null>(null)

  const sortedCategories = useMemo(
    () => [...state.categories].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name)),
    [state.categories],
  )

  const channelGroups = useMemo(() => {
    const groups = new Map<string, CollaborationChannel[]>()
    for (const category of sortedCategories) {
      groups.set(category.categoryId, [])
    }
    groups.set(UNCATEGORIZED_KEY, [])

    const sortedChannels = [...state.channels].sort(compareChannels)
    for (const channel of sortedChannels) {
      const key = channel.categoryId ?? UNCATEGORIZED_KEY
      groups.set(key, [...(groups.get(key) ?? []), channel])
    }

    return groups
  }, [sortedCategories, state.channels])

  const uncategorizedChannels = channelGroups.get(UNCATEGORIZED_KEY) ?? []

  const activeDragLabel = useMemo(() => {
    if (!activeDragId) return null

    if (activeDragId.startsWith('category:')) {
      const categoryId = activeDragId.slice('category:'.length)
      const category = sortedCategories.find((entry) => entry.categoryId === categoryId)
      return category ? category.name : null
    }

    if (activeDragId.startsWith('channel:')) {
      const channelId = activeDragId.slice('channel:'.length)
      const channel = state.channels.find((entry) => entry.channelId === channelId)
      return channel ? `#${channel.name}` : null
    }

    return null
  }, [activeDragId, sortedCategories, state.channels])

  // Effective selected channel: only highlight if this connection is the active one
  const effectiveSelectedChannelId = isActiveConnection ? selectedChannelId : undefined

  const handleSelectChannel = (channelId: string) => {
    onSelectChannel(channelId, connectionId)
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null)

    if (!workspace || !canManage || !event.over) return

    const activeId = String(event.active.id)
    const overId = String(event.over.id)
    if (activeId === overId) return

    try {
      onMutationError(null)

      if (activeId.startsWith('category:') && overId.startsWith('category:')) {
        const currentIds = sortedCategories.map((category) => category.categoryId)
        const oldIndex = currentIds.indexOf(activeId.slice('category:'.length))
        const newIndex = currentIds.indexOf(overId.slice('category:'.length))
        if (oldIndex < 0 || newIndex < 0) return

        await reorderCategories(arrayMove(currentIds, oldIndex, newIndex), apiBaseUrl)
        return
      }

      if (activeId.startsWith('channel:')) {
        const activeChannelId = activeId.slice('channel:'.length)
        const activeChannel = state.channels.find((channel) => channel.channelId === activeChannelId)
        if (!activeChannel) return

        const overChannel = overId.startsWith('channel:')
          ? state.channels.find((channel) => channel.channelId === overId.slice('channel:'.length))
          : null
        const targetCategoryId = overChannel
          ? (overChannel.categoryId ?? UNCATEGORIZED_KEY)
          : parseCategoryDropTargetId(overId)

        if (!targetCategoryId) return

        const sourceKey = activeChannel.categoryId ?? UNCATEGORIZED_KEY
        const targetKey = targetCategoryId
        const groupEntries = new Map(
          [...channelGroups.entries()].map(([key, channels]) => [key, channels.map((channel) => channel.channelId)]),
        )

        const sourceIds = [...(groupEntries.get(sourceKey) ?? [])]
        const sourceIndex = sourceIds.indexOf(activeChannelId)
        if (sourceIndex < 0) return

        if (overChannel) {
          const targetIds = sourceKey === targetKey ? sourceIds : [...(groupEntries.get(targetKey) ?? [])]
          const targetIndex = targetIds.indexOf(overChannel.channelId)
          if (targetIndex < 0) return

          if (sourceKey === targetKey) {
            groupEntries.set(sourceKey, arrayMove(sourceIds, sourceIndex, targetIndex))
          } else {
            sourceIds.splice(sourceIndex, 1)
            targetIds.splice(targetIndex, 0, activeChannelId)
            groupEntries.set(sourceKey, sourceIds)
            groupEntries.set(targetKey, targetIds)
            await updateChannel(activeChannelId, {
              categoryId: targetKey === UNCATEGORIZED_KEY ? null : targetKey,
            }, apiBaseUrl)
          }
        } else {
          if (sourceKey === targetKey) return

          sourceIds.splice(sourceIndex, 1)
          const targetIds = [...(groupEntries.get(targetKey) ?? [])]
          targetIds.push(activeChannelId)
          groupEntries.set(sourceKey, sourceIds)
          groupEntries.set(targetKey, targetIds)
          await updateChannel(activeChannelId, {
            categoryId: targetKey === UNCATEGORIZED_KEY ? null : targetKey,
          }, apiBaseUrl)
        }

        await reorderChannels(flattenChannelOrder(sortedCategories, groupEntries), apiBaseUrl)
      }
    } catch (error) {
      onMutationError(error instanceof Error ? error.message : 'Could not reorder collaboration sidebar')
    }
  }

  if (!state.hasBootstrapped) {
    return (
      <p className="rounded-md bg-sidebar-accent/40 px-3 py-4 text-center text-xs text-muted-foreground">
        Loading workspace…
      </p>
    )
  }

  if (!workspace) {
    return (
      <p className="rounded-md bg-sidebar-accent/40 px-3 py-4 text-center text-xs text-muted-foreground">
        Please sign in to access the collaboration workspace.
      </p>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={(event) => {
        void handleDragEnd(event)
      }}
    >
      <div className="space-y-4">
        {sortedCategories.length > 0 ? (
          <SortableContext
            items={sortedCategories.map((category) => `category:${category.categoryId}`)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-4">
              {sortedCategories.map((category) => (
                <CategoryGroup
                  key={category.categoryId}
                  category={category}
                  channels={channelGroups.get(category.categoryId) ?? []}
                  categoryUnreadCount={getCategoryUnreadCount(state, category.categoryId)}
                  selectedChannelId={effectiveSelectedChannelId}
                  unreadByChannelId={state.channelUnreadCounts}
                  mutedByChannelId={mutedByChannelId}
                  collapsed={collapsedCategoryIds.has(category.categoryId)}
                  canManage={canManage}
                  onToggleCollapsed={onToggleCategoryCollapsed}
                  onSelectChannel={handleSelectChannel}
                  onRenameCategory={onRenameCategory}
                  onDeleteCategory={onDeleteCategory}
                  onCreateChannel={onCreateChannelInCategory}
                  onRenameChannel={onRenameChannel}
                  onArchiveChannel={onArchiveChannel}
                  onToggleMute={onToggleMute}
                  onMarkAsRead={onMarkAsRead}
                  onOpenChannelSettings={onOpenChannelSettings}
                />
              ))}
            </div>
          </SortableContext>
        ) : null}

        {/* Uncategorized channels */}
        {uncategorizedChannels.length > 0 ? (
          <SortableContext
            items={uncategorizedChannels.map((channel) => `channel:${channel.channelId}`)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-1">
              {uncategorizedChannels.map((channel) => (
                <ChannelRowItem
                  key={channel.channelId}
                  channel={channel}
                  unreadCount={getChannelUnreadCount(state, channel.channelId)}
                  muted={mutedByChannelId[channel.channelId] ?? false}
                  isActive={effectiveSelectedChannelId === channel.channelId}
                  canManage={canManage}
                  onSelect={handleSelectChannel}
                  onRename={onRenameChannel}
                  onArchive={onArchiveChannel}
                  onToggleMute={onToggleMute}
                  onMarkAsRead={onMarkAsRead}
                  onOpenSettings={onOpenChannelSettings}
                />
              ))}
            </div>
          </SortableContext>
        ) : null}

        {/* Empty state */}
        {sortedCategories.length === 0 && uncategorizedChannels.length === 0 && canManage ? (
          <div className="px-2 py-6 text-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 border-sidebar-border bg-transparent text-xs"
              onClick={onOpenCreateCategory}
            >
              <FolderPlus className="size-3.5" />
              Create a category
            </Button>
          </div>
        ) : null}
      </div>

      <DragOverlay>
        {activeDragLabel ? (
          <div className="rounded-md border border-sidebar-border bg-sidebar px-3 py-2 text-sm font-medium text-sidebar-foreground shadow-lg">
            {activeDragLabel}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

// ---------------------------------------------------------------------------
// Helpers (moved from CollabSidebar.tsx)
// ---------------------------------------------------------------------------

function compareChannels(left: CollaborationChannel, right: CollaborationChannel): number {
  if (left.position !== right.position) {
    return left.position - right.position
  }

  const byName = left.name.localeCompare(right.name)
  if (byName !== 0) {
    return byName
  }

  return left.channelId.localeCompare(right.channelId)
}

function parseCategoryDropTargetId(overId: string): string | null {
  if (!overId.startsWith(CATEGORY_DROP_ID_PREFIX)) return null
  const categoryId = overId.slice(CATEGORY_DROP_ID_PREFIX.length)
  return categoryId.length > 0 ? categoryId : null
}

function flattenChannelOrder(
  categories: CollaborationCategory[],
  groupEntries: Map<string, string[]>,
): string[] {
  const orderedChannelIds: string[] = []

  for (const category of categories) {
    orderedChannelIds.push(...(groupEntries.get(category.categoryId) ?? []))
  }

  orderedChannelIds.push(...(groupEntries.get(UNCATEGORIZED_KEY) ?? []))
  return orderedChannelIds
}
