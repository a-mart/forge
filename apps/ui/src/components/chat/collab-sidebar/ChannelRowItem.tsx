import type { KeyboardEvent } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import type { CollaborationChannel } from '@forge/protocol'
import { Archive, BellOff, BellRing, CheckCheck, Pencil, Settings2 } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface ChannelRowItemProps {
  channel: CollaborationChannel
  unreadCount: number
  muted: boolean
  isActive: boolean
  canManage: boolean
  onSelect: (channelId: string) => void
  onRename: (channel: CollaborationChannel) => void
  onArchive: (channel: CollaborationChannel) => void
  onToggleMute: (channel: CollaborationChannel) => void
  onMarkAsRead: (channel: CollaborationChannel) => void
  onOpenSettings: (channel: CollaborationChannel) => void
}

function formatUnreadCount(unreadCount: number): string {
  if (unreadCount > 99) {
    return '99+'
  }
  return String(unreadCount)
}

export function ChannelRowItem({
  channel,
  unreadCount,
  muted,
  isActive,
  canManage,
  onSelect,
  onRename,
  onArchive,
  onToggleMute,
  onMarkAsRead,
  onOpenSettings,
}: ChannelRowItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `channel:${channel.channelId}`,
    disabled: !canManage,
    data: {
      type: 'channel',
      channelId: channel.channelId,
      categoryId: channel.categoryId ?? null,
    },
  })

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(channel.channelId)
    }
  }

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
          {...(canManage ? listeners : {})}
          role="button"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onClick={() => onSelect(channel.channelId)}
          className={cn(
            'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors',
            isActive
              ? 'bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-ring/25'
              : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn('truncate', unreadCount > 0 && 'font-semibold')}>
                #{channel.name}
              </span>
              {muted ? <BellOff className="size-3.5 shrink-0 text-muted-foreground" /> : null}
            </div>
          </div>

          {unreadCount > 0 ? (
            <div className="flex shrink-0 items-center gap-1">
              <span className="size-2 rounded-full bg-sky-400" aria-hidden="true" />
              <span className="min-w-[1.25rem] text-right text-[11px] font-semibold text-sidebar-foreground">
                {formatUnreadCount(unreadCount)}
              </span>
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        <ContextMenuItem onClick={() => onToggleMute(channel)}>
          {muted ? <BellRing className="size-4" /> : <BellOff className="size-4" />}
          {muted ? 'Unmute channel' : 'Mute channel'}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onMarkAsRead(channel)}>
          <CheckCheck className="size-4" />
          Mark as read
        </ContextMenuItem>
        {canManage ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onOpenSettings(channel)}>
              <Settings2 className="size-4" />
              Channel settings
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRename(channel)}>
              <Pencil className="size-4" />
              Rename channel
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={() => onArchive(channel)}>
              <Archive className="size-4" />
              Archive channel
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
