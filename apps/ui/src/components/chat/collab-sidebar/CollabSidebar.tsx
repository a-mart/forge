import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderPlus, MoreHorizontal, Plus, Settings } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCollabConnectionsContext } from '@/hooks/index-page/use-collab-connections'
import type { ActiveSurface } from '@/hooks/index-page/use-route-state'
import { subscribeToMuteChanges, toggleMute } from '@/lib/collab-local-channel-state'
import { isChannelMuted } from '@/lib/collab-selectors'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CollaborationCategory, CollaborationChannel } from '@forge/protocol'
import type { ConnectionHealth } from '@/lib/connection-health-store'
import type { CollabWsState } from '@/lib/collab-ws-state'
import { ModeSwitch } from './ModeSwitch'
import { ConnectionSection } from './ConnectionSection'
import { ConnectionSectionHeader } from './ConnectionSectionHeader'
import { useCollabSidebarPrefs } from './hooks/use-collab-sidebar-prefs'
import { ChannelSettingsSheet } from '@/components/chat/collab/ChannelSettingsSheet'
import { ArchiveChannelDialog } from './dialogs/ArchiveChannelDialog'
import { CreateCategoryDialog } from './dialogs/CreateCategoryDialog'
import { CreateChannelDialog } from './dialogs/CreateChannelDialog'
import { DeleteCategoryDialog } from './dialogs/DeleteCategoryDialog'
import { RenameCategoryDialog } from './dialogs/RenameCategoryDialog'
import { RenameChannelDialog } from './dialogs/RenameChannelDialog'

// ---------------------------------------------------------------------------
// Dialog action context — carries the owning connection's target so dialogs
// and mutations hit the correct backend even when the clicked item belongs
// to an inactive connection.
// ---------------------------------------------------------------------------

interface DialogActionCtx {
  apiBaseUrl?: string
  /** WebSocket URL for the owning backend (used by dialogs that read model presets / specialists). */
  wsUrl?: string
  connectionId: string
  sortedCategories: CollaborationCategory[]
}

interface DialogTarget<T> {
  entity: T
  ctx: DialogActionCtx
}

interface CollabSidebarProps {
  selectedChannelId?: string
  activeSurface: ActiveSurface
  isSettingsActive?: boolean
  onSelectChannel: (channelId?: string, connectionId?: string) => void
  onSelectSurface: (surface: ActiveSurface) => void
  onOpenSettings?: () => void
}

export function CollabSidebar({
  selectedChannelId,
  activeSurface,
  isSettingsActive = false,
  onSelectChannel,
  onSelectSurface,
  onOpenSettings,
}: CollabSidebarProps) {
  const connections = useCollabConnectionsContext()
  const {
    connectionIds,
    connectionStates,
    targets,
    activeConnectionId,
  } = connections

  const isMultiBackend = connectionIds.length > 1

  // Collect all workspaceIds so collapse prefs load/persist from every
  // backend's localStorage key — not just the first.
  const allWorkspaceIds = useMemo(() => {
    const ids: string[] = []
    for (const connId of connectionIds) {
      const wsId = connectionStates[connId]?.workspace?.workspaceId
      if (wsId) ids.push(wsId)
    }
    return ids
  }, [connectionIds, connectionStates])

  const { collapsedCategoryIds, toggleCategoryCollapsed } = useCollabSidebarPrefs(allWorkspaceIds)

  // Determine admin capability: admin on any connection enables workspace-level actions
  const canManageAny = useMemo(() => {
    return connectionIds.some((connId) => connectionStates[connId]?.currentUser?.role === 'admin')
  }, [connectionIds, connectionStates])

  // ---------------------------------------------------------------------------
  // Dialog state — every dialog target stores the owning connection's context
  // so mutations always hit the backend that owns the entity, even when the
  // user right-clicks an item on an inactive connection.
  // ---------------------------------------------------------------------------

  const [createChannelOpen, setCreateChannelOpen] = useState(false)
  const [createChannelCategoryId, setCreateChannelCategoryId] = useState<string | undefined>()
  const [createChannelCtx, setCreateChannelCtx] = useState<DialogActionCtx | null>(null)
  const [createCategoryCtx, setCreateCategoryCtx] = useState<DialogActionCtx | null>(null)
  const [renameChannelTarget, setRenameChannelTarget] = useState<DialogTarget<CollaborationChannel> | null>(null)
  const [renameCategoryTarget, setRenameCategoryTarget] = useState<DialogTarget<CollaborationCategory> | null>(null)
  const [archiveChannelTarget, setArchiveChannelTarget] = useState<DialogTarget<CollaborationChannel> | null>(null)
  const [settingsChannelTarget, setSettingsChannelTarget] = useState<DialogTarget<CollaborationChannel> | null>(null)
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState<DialogTarget<CollaborationCategory> | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [muteRevision, setMuteRevision] = useState(0)

  // Subscribe to mute changes for all workspaces
  useEffect(() => {
    const workspaceIds = new Set<string>()
    for (const connId of connectionIds) {
      const ws = connectionStates[connId]?.workspace?.workspaceId
      if (ws) workspaceIds.add(ws)
    }

    if (workspaceIds.size === 0) return

    return subscribeToMuteChanges((change) => {
      if (workspaceIds.has(change.workspaceId)) {
        setMuteRevision((revision) => revision + 1)
      }
    })
  }, [connectionIds, connectionStates])

  // Force re-evaluation of muted state
  void muteRevision

  const handleToggleMute = (channel: CollaborationChannel) => {
    // Find the workspace this channel belongs to
    for (const connId of connectionIds) {
      const state = connectionStates[connId]
      if (!state?.workspace) continue
      if (state.channels.some((ch) => ch.channelId === channel.channelId)) {
        toggleMute(state.workspace.workspaceId, channel.channelId)
        return
      }
    }
  }

  const handleMarkAsRead = (channel: CollaborationChannel) => {
    // Find the connection this channel belongs to and mark via its client
    for (const connId of connectionIds) {
      const state = connectionStates[connId]
      if (!state) continue
      if (state.channels.some((ch) => ch.channelId === channel.channelId)) {
        const client = connections.getClient(connId)
        client?.markChannelRead(channel.channelId)
        return
      }
    }
  }

  // Build a DialogActionCtx for a given connectionId
  const buildCtx = useCallback((connId: string): DialogActionCtx => {
    const target = targets.find((t) => t.connectionId === connId)
    const state = connectionStates[connId]
    const sorted = [...(state?.categories ?? [])].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    )
    return { apiBaseUrl: target?.apiBaseUrl, wsUrl: target?.wsUrl, connectionId: connId, sortedCategories: sorted }
  }, [targets, connectionStates])

  // Derive per-connection health from state
  const getConnectionHealth = (state: CollabWsState): ConnectionHealth => {
    if (state.connected) return 'connected'
    if (state.hasBootstrapped) return 'reconnecting'
    return 'disconnected'
  }

  // Derive total unread for a connection
  const getConnectionTotalUnread = (state: CollabWsState): number => {
    return Object.values(state.channelUnreadCounts).reduce((sum, count) => sum + count, 0)
  }

  // Build muted-by-channelId for a specific connection's channels
  const buildMutedMap = (state: CollabWsState): Record<string, boolean> => {
    return Object.fromEntries(
      state.channels.map((channel) => [channel.channelId, isChannelMuted(state, channel.channelId)]),
    )
  }

  // True when at least one connection has a workspace (used to gate dialog rendering)
  const hasAnyWorkspace = useMemo(() => {
    return connectionIds.some((connId) => connectionStates[connId]?.workspace != null)
  }, [connectionIds, connectionStates])

  return (
    <>
      <aside className="flex h-full w-[320px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        {/* Header: mode switch + actions menu */}
        <TooltipProvider delayDuration={200}>
          <div className="flex items-center gap-1.5 px-2 pt-2 pb-3">
            <ModeSwitch
              activeSurface={activeSurface}
              onSelectSurface={onSelectSurface}
              className="flex-1"
            />
            {canManageAny ? (
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
                  <DropdownMenuItem onClick={() => {
                    if (activeConnectionId) setCreateCategoryCtx(buildCtx(activeConnectionId))
                  }}>
                    <FolderPlus className="size-4" />
                    New Category
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    setCreateChannelCategoryId(undefined)
                    setCreateChannelOpen(true)
                    if (activeConnectionId) setCreateChannelCtx(buildCtx(activeConnectionId))
                  }}>
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

        <div className="flex-1 overflow-y-auto px-2 pb-2 [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border [&::-webkit-scrollbar-thumb:hover]:bg-sidebar-border/80">
          {connectionIds.length === 0 ? (
            <p className="rounded-md bg-sidebar-accent/40 px-3 py-4 text-center text-xs text-muted-foreground">
              No collaboration backends configured.
            </p>
          ) : null}

          {connectionIds.map((connId, index) => {
            const state = connectionStates[connId]
            if (!state) return null

            const target = targets.find((t) => t.connectionId === connId)
            const isActive = activeConnectionId === connId
            const connCanManage = state.currentUser?.role === 'admin'
            const mutedMap = buildMutedMap(state)

            return (
              <div key={connId} className={cn(index > 0 && 'mt-4')}>
                {/* Section header: only for multi-backend */}
                {isMultiBackend ? (
                  <ConnectionSectionHeader
                    label={target?.label ?? connId}
                    health={getConnectionHealth(state)}
                    totalUnread={getConnectionTotalUnread(state)}
                    isActive={isActive}
                  />
                ) : null}

                <ConnectionSection
                  connectionId={connId}
                  state={state}
                  selectedChannelId={selectedChannelId}
                  isActiveConnection={isActive}
                  canManage={connCanManage}
                  collapsedCategoryIds={collapsedCategoryIds}
                  mutedByChannelId={mutedMap}
                  apiBaseUrl={target?.apiBaseUrl}
                  onSelectChannel={(channelId, connectionId) => onSelectChannel(channelId, connectionId)}
                  onToggleCategoryCollapsed={toggleCategoryCollapsed}
                  onRenameCategory={(cat) => setRenameCategoryTarget({ entity: cat, ctx: buildCtx(connId) })}
                  onDeleteCategory={(cat) => setDeleteCategoryTarget({ entity: cat, ctx: buildCtx(connId) })}
                  onCreateChannelInCategory={(catId) => {
                    setCreateChannelCategoryId(catId)
                    setCreateChannelOpen(true)
                    setCreateChannelCtx(buildCtx(connId))
                  }}
                  onRenameChannel={(ch) => setRenameChannelTarget({ entity: ch, ctx: buildCtx(connId) })}
                  onArchiveChannel={(ch) => setArchiveChannelTarget({ entity: ch, ctx: buildCtx(connId) })}
                  onToggleMute={handleToggleMute}
                  onMarkAsRead={handleMarkAsRead}
                  onOpenChannelSettings={(ch) => setSettingsChannelTarget({ entity: ch, ctx: buildCtx(connId) })}
                  onOpenCreateCategory={() => {
                    setCreateCategoryCtx(buildCtx(connId))
                  }}
                  onMutationError={setMutationError}
                />
              </div>
            )
          })}
        </div>

        {/* Footer: settings icon (admin only, mirrors Builder sidebar footer) */}
        {onOpenSettings ? (
          <div className="shrink-0 border-t border-sidebar-border">
            <TooltipProvider delayDuration={200}>
              <div className="flex items-center justify-center gap-1 px-2 py-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className={cn(
                        'inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                        isSettingsActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                      )}
                      aria-label="Settings"
                      aria-pressed={isSettingsActive}
                    >
                      <Settings aria-hidden="true" className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>Settings</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
          </div>
        ) : null}
      </aside>

      {hasAnyWorkspace ? (
        <>
          <CreateChannelDialog
            open={createChannelOpen}
            categories={createChannelCtx?.sortedCategories ?? []}
            defaultCategoryId={createChannelCategoryId}
            apiBaseUrl={createChannelCtx?.apiBaseUrl}
            onClose={() => { setCreateChannelOpen(false); setCreateChannelCategoryId(undefined); setCreateChannelCtx(null) }}
            onCreated={(channel) => {
              setMutationError(null)
              onSelectChannel(channel.channelId, createChannelCtx?.connectionId)
            }}
          />
          <CreateCategoryDialog
            open={createCategoryCtx != null}
            apiBaseUrl={createCategoryCtx?.apiBaseUrl}
            onClose={() => setCreateCategoryCtx(null)}
            wsUrl={createCategoryCtx?.wsUrl}
          />
        </>
      ) : null}

      {renameChannelTarget ? (
        <RenameChannelDialog
          open
          channel={renameChannelTarget.entity}
          apiBaseUrl={renameChannelTarget.ctx.apiBaseUrl}
          onClose={() => setRenameChannelTarget(null)}
        />
      ) : null}

      {renameCategoryTarget ? (
        <RenameCategoryDialog
          open
          category={renameCategoryTarget.entity}
          apiBaseUrl={renameCategoryTarget.ctx.apiBaseUrl}
          onClose={() => setRenameCategoryTarget(null)}
          wsUrl={renameCategoryTarget.ctx.wsUrl}
        />
      ) : null}

      {archiveChannelTarget ? (
        <ArchiveChannelDialog
          open
          channel={archiveChannelTarget.entity}
          apiBaseUrl={archiveChannelTarget.ctx.apiBaseUrl}
          onClose={() => setArchiveChannelTarget(null)}
        />
      ) : null}

      {deleteCategoryTarget ? (
        <DeleteCategoryDialog
          open
          category={deleteCategoryTarget.entity}
          apiBaseUrl={deleteCategoryTarget.ctx.apiBaseUrl}
          onClose={() => setDeleteCategoryTarget(null)}
        />
      ) : null}

      {settingsChannelTarget ? (
        <ChannelSettingsSheet
          open
          onOpenChange={(open) => { if (!open) setSettingsChannelTarget(null) }}
          channel={settingsChannelTarget.entity}
          categories={settingsChannelTarget.ctx.sortedCategories}
          isAdmin={canManageAny}
          wsUrl={settingsChannelTarget.ctx.wsUrl}
          apiBaseUrl={settingsChannelTarget.ctx.apiBaseUrl}
        />
      ) : null}
    </>
  )
}
