import { ShieldAlert, LogIn } from 'lucide-react'
import type { ActiveSurface, ActiveView } from '@/hooks/index-page/use-route-state'
import { CollabSidebar } from '@/components/chat/collab-sidebar/CollabSidebar'
import { useCollabWsConnection, CollabWsProvider } from '@/hooks/index-page/use-collab-ws-connection'
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

  // Determine blocked reason for non-admin collab settings access
  const isSettingsView = activeView === 'settings'
  const blockedReason: 'admin_required' | 'auth_required' | null =
    isSettingsView && hasLoaded && !isAdmin
      ? isMember
        ? 'admin_required'
        : 'auth_required'
      : null

  return (
    <CollabWsProvider value={collab}>
      <CollabSidebar
        wsUrl={wsUrl}
        selectedChannelId={channel}
        activeSurface={activeSurface}
        onSelectChannel={onSelectChannel}
        onSelectSurface={onSelectSurface}
        onOpenSettings={isAdmin ? onOpenSettings : undefined}
      />

      {isSettingsView ? (
        blockedReason ? (
          <CollabSettingsBlockedState reason={blockedReason} onBack={onBackToChat} />
        ) : (
          // Admin collab settings shell placeholder — Package 2 renders the full SettingsPanel here
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Collab Settings loading…
          </div>
        )
      ) : (
        <CollabWorkspace
          wsUrl={wsUrl}
          channelId={channel}
          onSelectChannel={onSelectChannel}
        />
      )}
    </CollabWsProvider>
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
      <button
        type="button"
        className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        onClick={onBack}
      >
        Back to chat
      </button>
    </div>
  )
}
