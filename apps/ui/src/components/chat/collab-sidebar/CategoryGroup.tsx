import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronRight, Folder, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import type { CollaborationCategory, CollaborationChannel } from '@forge/protocol'
import { ChannelRowItem } from './ChannelRowItem'

interface CategoryGroupProps {
  category: CollaborationCategory
  channels: CollaborationChannel[]
  categoryUnreadCount: number
  selectedChannelId?: string
  unreadByChannelId: Record<string, number>
  mutedByChannelId: Record<string, boolean>
  collapsed: boolean
  canManage: boolean
  onToggleCollapsed: (categoryId: string) => void
  onSelectChannel: (channelId: string) => void
  onRenameCategory: (category: CollaborationCategory) => void
  onDeleteCategory: (category: CollaborationCategory) => void
  onCreateChannel?: (categoryId: string) => void
  onRenameChannel: (channel: CollaborationChannel) => void
  onArchiveChannel: (channel: CollaborationChannel) => void
  onToggleMute: (channel: CollaborationChannel) => void
  onMarkAsRead: (channel: CollaborationChannel) => void
  onOpenChannelSettings: (channel: CollaborationChannel) => void
}

function formatUnreadCount(unreadCount: number): string {
  if (unreadCount > 99) {
    return '99+'
  }
  return String(unreadCount)
}

export function CategoryGroup({
  category,
  channels,
  categoryUnreadCount,
  selectedChannelId,
  unreadByChannelId,
  mutedByChannelId,
  collapsed,
  canManage,
  onToggleCollapsed,
  onSelectChannel,
  onRenameCategory,
  onDeleteCategory,
  onCreateChannel,
  onRenameChannel,
  onArchiveChannel,
  onToggleMute,
  onMarkAsRead,
  onOpenChannelSettings,
}: CategoryGroupProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `category:${category.categoryId}`,
    disabled: !canManage,
    data: {
      type: 'category',
      categoryId: category.categoryId,
    },
  })
  const {
    isOver: isChannelDropOver,
    setNodeRef: setChannelDropNodeRef,
  } = useDroppable({
    id: `category-drop:${category.categoryId}`,
    data: {
      type: 'category-drop',
      categoryId: category.categoryId,
    },
    disabled: !canManage || collapsed || channels.length > 0,
  })

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={{
            transform: CSS.Transform.toString(transform),
            transition,
            opacity: isDragging ? 0.5 : undefined,
          }}
          {...attributes}
          className="space-y-1"
        >
          <div
            className="flex items-center gap-1 px-1"
            {...(canManage ? listeners : {})}
          >
            <button
              type="button"
              onClick={() => onToggleCollapsed(category.categoryId)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
              aria-expanded={!collapsed}
            >
              {collapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate">{category.name}</span>
              {categoryUnreadCount > 0 ? (
                <span className="ml-auto text-[10px] font-semibold text-sidebar-foreground">
                  {formatUnreadCount(categoryUnreadCount)}
                </span>
              ) : null}
            </button>
          </div>

          {!collapsed ? (
            <SortableContext items={channels.map((channel) => `channel:${channel.channelId}`)} strategy={verticalListSortingStrategy}>
              <div className="space-y-1 pl-2">
                {channels.length > 0 ? (
                  channels.map((channel) => (
                    <ChannelRowItem
                      key={channel.channelId}
                      channel={channel}
                      unreadCount={unreadByChannelId[channel.channelId] ?? 0}
                      muted={mutedByChannelId[channel.channelId] ?? false}
                      isActive={selectedChannelId === channel.channelId}
                      canManage={canManage}
                      onSelect={onSelectChannel}
                      onRename={onRenameChannel}
                      onArchive={onArchiveChannel}
                      onToggleMute={onToggleMute}
                      onMarkAsRead={onMarkAsRead}
                      onOpenSettings={onOpenChannelSettings}
                    />
                  ))
                ) : canManage ? (
                  <div
                    ref={setChannelDropNodeRef}
                    className={[
                      'rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground transition-colors',
                      isChannelDropOver
                        ? 'border-sidebar-ring bg-sidebar-accent/50 text-sidebar-foreground'
                        : 'border-sidebar-border/70 bg-sidebar-accent/20',
                    ].join(' ')}
                  >
                    Drop channels here
                  </div>
                ) : (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    No channels yet.
                  </p>
                )}
              </div>
            </SortableContext>
          ) : null}
        </div>
      </ContextMenuTrigger>
      {canManage ? (
        <ContextMenuContent className="min-w-[180px]">
          {onCreateChannel ? (
            <>
              <ContextMenuItem onClick={() => onCreateChannel(category.categoryId)}>
                <Plus className="size-4" />
                New Channel
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}
          <ContextMenuItem onClick={() => onRenameCategory(category)}>
            <Pencil className="size-4" />
            Category Settings
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => onDeleteCategory(category)}>
            <Trash2 className="size-4" />
            Delete Category
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  )
}
