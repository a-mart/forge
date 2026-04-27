import { useEffect, useMemo } from 'react'
import { ShieldAlert, LogIn } from 'lucide-react'
import type { ActiveSurface, ActiveView } from '@/hooks/index-page/use-route-state'
import { CollabSidebar } from '@/components/chat/collab-sidebar/CollabSidebar'
import { useCollabWsConnection, CollabWsProvider } from '@/hooks/index-page/use-collab-ws-connection'
import { reportCollabConnected } from '@/lib/connection-health-store'
import { createCollabSettingsTarget } from '@/components/settings/settings-target'
import { useSettingsBackendState } from '@/components/settings/use-settings-backend-state'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { Button } from '@/components/ui/button'
import { CollabWorkspace } from './CollabWorkspace'

interface CollabSurfaceProps {
  wsUrl: string
  channel?: string
  activeView: ActiveView
  activeSurface: ActiveSurface
  isAdmin: boolean
  isMember: boolean
  hasLoaded: boolean
  onSelectChannel: (channelId?: string) => void
  onSelectSurface: (surface: ActiveSurface) => void
  onOpenSettings: () => void
  onBackToChat: () => void
}

export function CollabSurface({
  wsUrl,
  channel,
  activeView,
  activeSurface,
  isAdmin,
  isMember,
  hasLoaded,
  onSelectChannel,
  onSelectSurface,
  onOpenSettings,
  onBackToChat,
}: CollabSurfaceProps) {
  const collab = useCollabWsConnection(wsUrl)

  // Sync collab WS health to the module-level store so ModeSwitch can
  // display the collab connection dot even from the builder surface.
  // The route-level health poll keeps the dot accurate when this surface
  // unmounts, so no cleanup callback is needed here.
  useEffect(() => {
    reportCollabConnected(collab.state.connected)
  }, [collab.state.connected])

  const isSettingsView = activeView === 'settings'

  return (
    <CollabWsProvider value={collab}>
      <CollabSidebar
        wsUrl={wsUrl}
        selectedChannelId={channel}
        activeSurface={activeSurface}
        onSelectChannel={onSelectChannel}
        onSelectSurface={onSelectSurface}
      />

      {isSettingsView ? (
        <CollabSettingsContent
          wsUrl={wsUrl}
          isAdmin={isAdmin}
          isMember={isMember}
          hasLoaded={hasLoaded}
          onBack={onBackToChat}
        />
      ) : (
        <CollabWorkspace
          wsUrl={wsUrl}
          channelId={channel}
          onSelectChannel={onSelectChannel}
          onOpenSettings={isAdmin ? onOpenSettings : undefined}
        />
      )}
    </CollabWsProvider>
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
  isAdmin,
  isMember,
  hasLoaded,
  onBack,
}: {
  wsUrl: string
  isAdmin: boolean
  isMember: boolean
  hasLoaded: boolean
  onBack: () => void
}) {
  const target = useMemo(() => createCollabSettingsTarget(wsUrl), [wsUrl])
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
