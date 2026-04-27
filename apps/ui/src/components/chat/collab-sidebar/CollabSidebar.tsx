import { useEffect, useMemo, useState } from 'react'
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
import { FolderPlus, MoreHorizontal, Plus } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useCollabWsContext } from '@/hooks/index-page/use-collab-ws-connection'
import type { ActiveSurface } from '@/hooks/index-page/use-route-state'
import { reorderCategories, reorderChannels, updateChannel } from '@/lib/collaboration-api'
import { subscribeToMuteChanges, toggleMute } from '@/lib/collab-local-channel-state'
import {
  getCategoryUnreadCount,
  getChannelUnreadCount,
  isChannelMuted,
} from '@/lib/collab-selectors'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CollaborationCategory, CollaborationChannel } from '@forge/protocol'
import { ModeSwitch } from './ModeSwitch'
import { CategoryGroup } from './CategoryGroup'
import { ChannelRowItem } from './ChannelRowItem'
import { useCollabSidebarPrefs } from './hooks/use-collab-sidebar-prefs'
import { ChannelSettingsSheet } from '@/components/chat/collab/ChannelSettingsSheet'
import { ArchiveChannelDialog } from './dialogs/ArchiveChannelDialog'
import { CreateCategoryDialog } from './dialogs/CreateCategoryDialog'
import { CreateChannelDialog } from './dialogs/CreateChannelDialog'
import { DeleteCategoryDialog } from './dialogs/DeleteCategoryDialog'
import { RenameCategoryDialog } from './dialogs/RenameCategoryDialog'
import { RenameChannelDialog } from './dialogs/RenameChannelDialog'

const UNCATEGORIZED_KEY = '__uncategorized__'
const CATEGORY_DROP_ID_PREFIX = 'category-drop:'

interface CollabSidebarProps {
  wsUrl: string
  selectedChannelId?: string
  activeSurface: ActiveSurface
  onSelectChannel: (channelId?: string) => void
  onSelectSurface: (surface: ActiveSurface) => void
}

export function CollabSidebar({
  wsUrl,
  selectedChannelId,
  activeSurface,
  onSelectChannel,
  onSelectSurface,
}: CollabSidebarProps) {
  const { clientRef, state } = useCollabWsContext()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const workspace = state.workspace
  const canManage = state.currentUser?.role === 'admin'
  const { collapsedCategoryIds, toggleCategoryCollapsed } = useCollabSidebarPrefs(workspace?.workspaceId)

  const [createChannelOpen, setCreateChannelOpen] = useState(false)
  const [createChannelCategoryId, setCreateChannelCategoryId] = useState<string | undefined>()
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false)
  const [renameChannelTarget, setRenameChannelTarget] = useState<CollaborationChannel | null>(null)
  const [renameCategoryTarget, setRenameCategoryTarget] = useState<CollaborationCategory | null>(null)
  const [archiveChannelTarget, setArchiveChannelTarget] = useState<CollaborationChannel | null>(null)
  const [settingsChannelTarget, setSettingsChannelTarget] = useState<CollaborationChannel | null>(null)
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState<CollaborationCategory | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [muteRevision, setMuteRevision] = useState(0)

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

  void muteRevision

  const mutedByChannelId = Object.fromEntries(
    state.channels.map((channel) => [channel.channelId, isChannelMuted(state, channel.channelId)]),
  )

  const activeDragLabel = useMemo(() => {
    if (!activeDragId) {
      return null
    }

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

  const uncategorizedChannels = channelGroups.get(UNCATEGORIZED_KEY) ?? []

  useEffect(() => {
    const workspaceId = workspace?.workspaceId
    if (!workspaceId) {
      return
    }

    return subscribeToMuteChanges((change) => {
      if (change.workspaceId !== workspaceId) {
        return
      }

      setMuteRevision((revision) => revision + 1)
    })
  }, [workspace?.workspaceId])

  const handleToggleMute = (channel: CollaborationChannel) => {
    if (!workspace) {
      return
    }

    toggleMute(workspace.workspaceId, channel.channelId)
  }

  const handleMarkAsRead = (channel: CollaborationChannel) => {
    clientRef.current?.markChannelRead(channel.channelId)
  }

  const handleCreateChannelInCategory = (categoryId: string) => {
    setCreateChannelCategoryId(categoryId)
    setCreateChannelOpen(true)
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null)

    if (!workspace || !canManage || !event.over) {
      return
    }

    const activeId = String(event.active.id)
    const overId = String(event.over.id)
    if (activeId === overId) {
      return
    }

    try {
      setMutationError(null)

      if (activeId.startsWith('category:') && overId.startsWith('category:')) {
        const currentIds = sortedCategories.map((category) => category.categoryId)
        const oldIndex = currentIds.indexOf(activeId.slice('category:'.length))
        const newIndex = currentIds.indexOf(overId.slice('category:'.length))
        if (oldIndex < 0 || newIndex < 0) {
          return
        }

        await reorderCategories(arrayMove(currentIds, oldIndex, newIndex))
        return
      }

      if (activeId.startsWith('channel:')) {
        const activeChannelId = activeId.slice('channel:'.length)
        const activeChannel = state.channels.find((channel) => channel.channelId === activeChannelId)
        if (!activeChannel) {
          return
        }

        const overChannel = overId.startsWith('channel:')
          ? state.channels.find((channel) => channel.channelId === overId.slice('channel:'.length))
          : null
        const targetCategoryId = overChannel
          ? (overChannel.categoryId ?? UNCATEGORIZED_KEY)
          : parseCategoryDropTargetId(overId)

        if (!targetCategoryId) {
          return
        }

        const sourceKey = activeChannel.categoryId ?? UNCATEGORIZED_KEY
        const targetKey = targetCategoryId
        const groupEntries = new Map(
          [...channelGroups.entries()].map(([key, channels]) => [key, channels.map((channel) => channel.channelId)]),
        )

        const sourceIds = [...(groupEntries.get(sourceKey) ?? [])]
        const sourceIndex = sourceIds.indexOf(activeChannelId)
        if (sourceIndex < 0) {
          return
        }

        if (overChannel) {
          const targetIds = sourceKey === targetKey ? sourceIds : [...(groupEntries.get(targetKey) ?? [])]
          const targetIndex = targetIds.indexOf(overChannel.channelId)
          if (targetIndex < 0) {
            return
          }

          if (sourceKey === targetKey) {
            groupEntries.set(sourceKey, arrayMove(sourceIds, sourceIndex, targetIndex))
          } else {
            sourceIds.splice(sourceIndex, 1)
            targetIds.splice(targetIndex, 0, activeChannelId)
            groupEntries.set(sourceKey, sourceIds)
            groupEntries.set(targetKey, targetIds)
            await updateChannel(activeChannelId, {
              categoryId: targetKey === UNCATEGORIZED_KEY ? null : targetKey,
            })
          }
        } else {
          if (sourceKey === targetKey) {
            return
          }

          sourceIds.splice(sourceIndex, 1)
          const targetIds = [...(groupEntries.get(targetKey) ?? [])]
          targetIds.push(activeChannelId)
          groupEntries.set(sourceKey, sourceIds)
          groupEntries.set(targetKey, targetIds)
          await updateChannel(activeChannelId, {
            categoryId: targetKey === UNCATEGORIZED_KEY ? null : targetKey,
          })
        }

        await reorderChannels(flattenChannelOrder(sortedCategories, groupEntries))
      }
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Could not reorder collaboration sidebar')
    }
  }

  return (
    <>
      <aside className="flex h-full w-[320px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        {/* Header: mode switch + actions menu (avatar moved to top-right header area) */}
        <TooltipProvider delayDuration={200}>
          <div className="flex items-center gap-1.5 px-2 pt-2 pb-3">
            <ModeSwitch
              activeSurface={activeSurface}
              onSelectSurface={onSelectSurface}
              className="flex-1"
            />
            {canManage ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8 shrink-0 text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                    aria-label="Workspace actions"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <DropdownMenuItem onClick={() => setCreateCategoryOpen(true)}>
                    <FolderPlus className="size-4" />
                    New Category
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setCreateChannelCategoryId(undefined); setCreateChannelOpen(true) }}>
                    <Plus className="size-4" />
                    New Channel
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </TooltipProvider>

        {mutationError ? (
          <div className="px-3 pb-2">
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {mutationError}
            </div>
          </div>
        ) : null}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={(event) => {
            void handleDragEnd(event)
          }}
        >
          <div className="flex-1 overflow-y-auto px-2 pb-2 [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border [&::-webkit-scrollbar-thumb:hover]:bg-sidebar-border/80">
            {!state.hasBootstrapped ? (
              <p className="rounded-md bg-sidebar-accent/40 px-3 py-4 text-center text-xs text-muted-foreground">
                Loading workspace…
              </p>
            ) : null}

            {state.hasBootstrapped && !workspace ? (
              <p className="rounded-md bg-sidebar-accent/40 px-3 py-4 text-center text-xs text-muted-foreground">
                Please sign in to access the collaboration workspace.
              </p>
            ) : null}

            {workspace ? (
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
                          selectedChannelId={selectedChannelId}
                          unreadByChannelId={state.channelUnreadCounts}
                          mutedByChannelId={mutedByChannelId}
                          collapsed={collapsedCategoryIds.has(category.categoryId)}
                          canManage={canManage}
                          onToggleCollapsed={toggleCategoryCollapsed}
                          onSelectChannel={onSelectChannel}
                          onRenameCategory={setRenameCategoryTarget}
                          onDeleteCategory={setDeleteCategoryTarget}
                          onCreateChannel={handleCreateChannelInCategory}
                          onRenameChannel={setRenameChannelTarget}
                          onArchiveChannel={setArchiveChannelTarget}
                          onToggleMute={handleToggleMute}
                          onMarkAsRead={handleMarkAsRead}
                          onOpenChannelSettings={setSettingsChannelTarget}
                        />
                      ))}
                    </div>
                  </SortableContext>
                ) : null}

                {/* Uncategorized channels (no header, no empty state) */}
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
                          isActive={selectedChannelId === channel.channelId}
                          canManage={canManage}
                          onSelect={(channelId) => onSelectChannel(channelId)}
                          onRename={setRenameChannelTarget}
                          onArchive={setArchiveChannelTarget}
                          onToggleMute={handleToggleMute}
                          onMarkAsRead={handleMarkAsRead}
                          onOpenSettings={setSettingsChannelTarget}
                        />
                      ))}
                    </div>
                  </SortableContext>
                ) : null}

                {/* Empty state: no categories and no uncategorized channels */}
                {sortedCategories.length === 0 && uncategorizedChannels.length === 0 && canManage ? (
                  <div className="px-2 py-6 text-center">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-sidebar-border bg-transparent text-xs"
                      onClick={() => setCreateCategoryOpen(true)}
                    >
                      <FolderPlus className="size-3.5" />
                      Create a category
                    </Button>
                  </div>
                ) : null}
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

      </aside>

      {workspace ? (
        <>
          <CreateChannelDialog
            open={createChannelOpen}
            categories={sortedCategories}
            defaultCategoryId={createChannelCategoryId}
            onClose={() => { setCreateChannelOpen(false); setCreateChannelCategoryId(undefined) }}
            onCreated={(channel) => {
              setMutationError(null)
              onSelectChannel(channel.channelId)
            }}
          />
          <CreateCategoryDialog
            open={createCategoryOpen}
            onClose={() => setCreateCategoryOpen(false)}
            wsUrl={wsUrl}
          />
        </>
      ) : null}

      {renameChannelTarget ? (
        <RenameChannelDialog
          open
          channel={renameChannelTarget}
          onClose={() => setRenameChannelTarget(null)}
        />
      ) : null}

      {renameCategoryTarget ? (
        <RenameCategoryDialog
          open
          category={renameCategoryTarget}
          onClose={() => setRenameCategoryTarget(null)}
          wsUrl={wsUrl}
        />
      ) : null}

      {archiveChannelTarget ? (
        <ArchiveChannelDialog
          open
          channel={archiveChannelTarget}
          onClose={() => setArchiveChannelTarget(null)}
        />
      ) : null}

      {deleteCategoryTarget ? (
        <DeleteCategoryDialog
          open
          category={deleteCategoryTarget}
          onClose={() => setDeleteCategoryTarget(null)}
        />
      ) : null}

      {settingsChannelTarget ? (
        <ChannelSettingsSheet
          open
          onOpenChange={(open) => { if (!open) setSettingsChannelTarget(null) }}
          channel={settingsChannelTarget}
          categories={sortedCategories}
          isAdmin={canManage}
          wsUrl={wsUrl}
        />
      ) : null}
    </>
  )
}

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
  if (!overId.startsWith(CATEGORY_DROP_ID_PREFIX)) {
    return null
  }

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
