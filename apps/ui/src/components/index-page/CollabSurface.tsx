import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ShieldAlert, LogIn } from 'lucide-react'
import type { ActiveSurface, ActiveView } from '@/hooks/index-page/use-route-state'
import { CollabSidebar } from '@/components/chat/collab-sidebar/CollabSidebar'
import { CollabWsProvider } from '@/hooks/index-page/use-collab-ws-connection'
import type { CollabWsConnectionValue } from '@/hooks/index-page/use-collab-ws-connection'
import {
  useCollabConnections,
  CollabConnectionsProvider,
} from '@/hooks/index-page/use-collab-connections'
import { reportCollabConnected } from '@/lib/connection-health-store'
import { createCollabSettingsTarget } from '@/components/settings/settings-target'
import { useSettingsBackendState } from '@/components/settings/use-settings-backend-state'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { Button } from '@/components/ui/button'
import { getDefaultConnectionIdFromTargets, type CollaborationEndpointTarget } from '@/lib/collaboration-connections'
import type { CollabWsClient } from '@/lib/collaboration/ws-client'
import { CollabWorkspace } from './CollabWorkspace'

interface CollabSurfaceProps {
  /**
   * All visible/enabled collaboration backend targets.
   * Each gets a metadata-only WS client; exactly one may have an active
   * channel detail subscription at a time.
   */
  targets: readonly CollaborationEndpointTarget[]
  /**
   * @deprecated Kept for backward-compat settings target derivation.
   * Prefer `targets[0].wsUrl` when available.
   */
  wsUrl: string
  channel?: string
  /**
   * Route-driven active connection ID (`collab` search param).
   * When set, selects the specific backend connection for the active channel.
   * When absent, falls back to the manager's activeConnectionId or the first
   * available connection (single-backend backward compatibility).
   */
  collab?: string
  activeView: ActiveView
  activeSurface: ActiveSurface
  isAdmin: boolean
  isMember: boolean
  hasLoaded: boolean
  onSelectChannel: (channelId?: string, connectionId?: string) => void
  onSelectSurface: (surface: ActiveSurface) => void
  onOpenSettings: () => void
  onBackToChat: () => void
  /**
   * Callback invoked when the user requests to sign in after an auth/connection
   * error.  Navigates to the settings view (builder surface) in-SPA rather
   * than triggering a full page reload.
   *
   * Receives the API base URL of the failing backend so the settings UI can
   * preselect it in the Collaboration tab.
   */
  onSignIn?: (apiBaseUrl?: string) => void
}

export function CollabSurface({
  targets,
  wsUrl,
  channel,
  collab,
  activeView,
  activeSurface,
  isAdmin,
  isMember,
  hasLoaded,
  onSelectChannel,
  onSelectSurface,
  onOpenSettings,
  onBackToChat,
  onSignIn,
}: CollabSurfaceProps) {
  const connections = useCollabConnections(targets)
  const activeClientRef = useRef<CollabWsClient | null>(null)

  // Determine the default connection ID from the registry's canonical default
  // (`lastActiveConnectionId` → first target fallback).  Never assume
  // `targets[0]` is the default — insertion order may differ from the user's
  // last-active selection.
  const defaultConnectionId = useMemo(() => getDefaultConnectionIdFromTargets(targets), [targets])

  // Determine the active connectionId for the current channel.
  // Resolution order:
  //   1. Route-driven `collab` param (if the connection exists)
  //   2. Manager's current activeConnectionId (in-memory selection)
  //   3. Canonical default from targets (registry-ordered, not insertion-order)
  const resolvedConnectionId = useMemo(() => {
    // Route-driven: if `collab` is set and the connection exists, use it
    if (collab && connections.connectionIds.includes(collab)) {
      return collab
    }
    // Stale/missing collab param: fall through to manager state, then canonical default
    return connections.activeConnectionId ?? defaultConnectionId
  }, [collab, connections.activeConnectionId, connections.connectionIds, defaultConnectionId])
  const activeConnectionId = resolvedConnectionId

  // Blocker 3: Normalize stale/deleted `collab` route param.
  // When the route `collab` value doesn't match any live connection, replace
  // the URL so stale params don't persist.
  // Only normalize in chat view — `onSelectChannel` navigates to chat, and
  // firing during settings would kick the user out.  The stale param is
  // harmless while in settings; normalization runs when the user returns.
  useEffect(() => {
    if (activeView !== 'chat') return // defer normalization until chat view
    if (!collab) return // no param to normalize
    if (connections.connectionIds.includes(collab)) return // valid — nothing to do

    // Stale param: replace route with the resolved connection or clear
    const normalized = activeConnectionId === defaultConnectionId ? undefined : activeConnectionId ?? undefined
    onSelectChannel(channel, normalized)
  }, [activeView, collab, connections.connectionIds, activeConnectionId, defaultConnectionId, channel, onSelectChannel])

  // Sync route-driven channel selection to the manager.
  // Uses stable `setActiveChannel` callback — NOT the whole `connections` object
  // — to avoid render loops.
  const { setActiveChannel: managerSetActiveChannel, getClient: managerGetClient } = connections
  useEffect(() => {
    const connId = activeConnectionId
    if (!connId) return

    managerSetActiveChannel(connId, channel ?? null)
  }, [activeConnectionId, channel, managerSetActiveChannel])

  // Keep activeClientRef in sync for backward-compat CollabWsProvider
  useEffect(() => {
    activeClientRef.current = activeConnectionId
      ? managerGetClient(activeConnectionId)
      : null
  }, [activeConnectionId, managerGetClient])

  // Resolve the active target for wsUrl/settings derivation.
  // This ensures the settings target, wsUrl passed to children, and compat state
  // all derive from the same resolved connection — not the deprecated `wsUrl` prop.
  const activeTarget = useMemo(() => {
    if (activeConnectionId) {
      const found = targets.find((t) => t.connectionId === activeConnectionId)
      if (found) return found
    }
    // Fall back to canonical default, not insertion-order targets[0]
    const defaultId = defaultConnectionId
    if (defaultId) {
      return targets.find((t) => t.connectionId === defaultId) ?? targets[0] ?? null
    }
    return targets[0] ?? null
  }, [activeConnectionId, defaultConnectionId, targets])

  const resolvedWsUrl = activeTarget?.wsUrl ?? wsUrl

  // Sync collab WS health to the module-level store so ModeSwitch can
  // display the collab connection dot even from the builder surface.
  const activeState = activeConnectionId
    ? connections.connectionStates[activeConnectionId]
    : undefined
  const isConnected = activeState?.connected ?? false

  useEffect(() => {
    reportCollabConnected(isConnected)
  }, [isConnected])

  // Derive backward-compatible CollabWsConnectionValue for existing consumers
  // (CollabSidebar, CollabWorkspace, etc.) that use useCollabWsContext()
  const compatValue: CollabWsConnectionValue = useMemo(
    () => ({
      clientRef: activeClientRef,
      state: connections.connectionStates[activeConnectionId ?? '']
        ?? connections.connectionStates[connections.connectionIds[0] ?? '']
        ?? {
          connected: false,
          workspace: null,
          categories: [],
          channels: [],
          currentUser: null,
          activeChannelId: null,
          channelHistory: [],
          channelHistoryLoaded: false,
          channelStatus: 'idle' as const,
          channelStreamingStartedAt: undefined,
          sessionWorkers: [],
          sessionActivity: [],
          sessionAgentStatuses: {},
          pendingChoiceRequests: [],
          channelReadStates: {},
          channelUnreadCounts: {},
          lastError: null,
          lastErrorCode: null,
          hasBootstrapped: false,
        },
    }),
    [activeConnectionId, connections.connectionIds, connections.connectionStates],
  )

  const isSettingsView = activeView === 'settings'

  // Wrap onSignIn to include the active backend's apiBaseUrl so the
  // Settings → Collaboration tab can preselect the failing backend.
  const wrappedOnSignIn = useCallback(() => {
    onSignIn?.(activeTarget?.apiBaseUrl)
  }, [onSignIn, activeTarget?.apiBaseUrl])

  return (
    <CollabConnectionsProvider value={connections}>
      <CollabWsProvider value={compatValue}>
        <CollabSidebar
          selectedChannelId={channel}
          activeSurface={activeSurface}
          isSettingsActive={isSettingsView}
          onSelectChannel={onSelectChannel}
          onSelectSurface={onSelectSurface}
          onOpenSettings={isAdmin ? onOpenSettings : undefined}
        />

        {isSettingsView ? (
          <CollabSettingsContent
            wsUrl={resolvedWsUrl}
            apiBaseUrl={activeTarget?.apiBaseUrl}
            isAdmin={isAdmin}
            isMember={isMember}
            hasLoaded={hasLoaded}
            onBack={onBackToChat}
          />
        ) : (
          <CollabWorkspace
            wsUrl={resolvedWsUrl}
            channelId={channel}
            onSelectChannel={onSelectChannel}
            onSignIn={wrappedOnSignIn}
          />
        )}
      </CollabWsProvider>
    </CollabConnectionsProvider>
  )
}

/**
 * Hooks-safe child component for collab settings content.
 *
 * Rendered only when `activeView === 'settings'`.
 * Calls useSettingsBackendState unconditionally, so hooks are always
 * invoked in the same order regardless of admin/member state.
 */
function CollabSettingsContent({
  wsUrl,
  apiBaseUrl,
  isAdmin,
  isMember,
  hasLoaded,
  onBack,
}: {
  wsUrl: string
  /** Explicit API base URL from the active connection target. */
  apiBaseUrl?: string
  isAdmin: boolean
  isMember: boolean
  hasLoaded: boolean
  onBack: () => void
}) {
  const target = useMemo(() => createCollabSettingsTarget(wsUrl, apiBaseUrl), [wsUrl, apiBaseUrl])
  const backendState = useSettingsBackendState({
    target,
    enabled: true,
    isAdmin,
    isMember,
    hasLoaded,
  })

  // Blocked: member or unauthenticated — no panels, no WS
  if (backendState.blockedReason) {
    return <CollabSettingsBlockedState reason={backendState.blockedReason} onBack={onBack} />
  }

  // Admin: render target-aware SettingsPanel with collab target
  const managers = backendState.wsState?.agents ?? []
  const profiles = backendState.wsState?.profiles ?? []

  return (
    <SettingsPanel
      wsUrl={wsUrl}
      managers={managers}
      profiles={profiles}
      telegramStatus={null}
      promptChangeKey={0}
      specialistChangeKey={0}
      modelConfigChangeKey={0}
      onBack={onBack}
      target={target}
    />
  )
}

function CollabSettingsBlockedState({
  reason,
  onBack,
}: {
  reason: 'admin_required' | 'auth_required'
  onBack: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      {reason === 'admin_required' ? (
        <>
          <ShieldAlert className="size-10 text-muted-foreground/60" />
          <div>
            <h2 className="text-base font-semibold text-foreground">Admin access required</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Collaboration backend settings are only available to administrators.
            </p>
          </div>
        </>
      ) : (
        <>
          <LogIn className="size-10 text-muted-foreground/60" />
          <div>
            <h2 className="text-base font-semibold text-foreground">Sign in required</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Sign in to the collaboration server to access backend settings.
            </p>
          </div>
        </>
      )}
      <Button
        variant="default"
        size="sm"
        className="mt-2"
        onClick={onBack}
      >
        Back to chat
      </Button>
    </div>
  )
}
