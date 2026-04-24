import { Settings, ShieldAlert, LogIn } from 'lucide-react'
import type { ActiveSurface, ActiveView } from '@/hooks/index-page/use-route-state'
import { CollabSidebar } from '@/components/chat/collab-sidebar/CollabSidebar'
import { useCollabWsConnection, CollabWsProvider } from '@/hooks/index-page/use-collab-ws-connection'
import { createCollabSettingsTarget } from '@/components/settings/settings-target'
import { useSettingsBackendState } from '@/components/settings/use-settings-backend-state'
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

  const isSettingsView = activeView === 'settings'

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
  const target = createCollabSettingsTarget(wsUrl)
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

  // Admin: render safe placeholder until target-aware panel migration (Package 3).
  // The secondary WS foundation from useSettingsBackendState is preserved above,
  // but no target-unaware settings panels are mounted to avoid wrong-backend
  // requests (terminal, playwright, cortex, onboarding, etc.).
  return <CollabSettingsPlaceholder onBack={onBack} />
}

/**
 * Safe placeholder for admin Collab Settings before target-aware panel migration.
 *
 * Renders an informational shell instead of mounting any settings panels,
 * preventing wrong-backend HTTP requests (terminal, playwright, cortex, etc.)
 * that the target-unaware SettingsGeneral and other tabs would fire.
 */
function CollabSettingsPlaceholder({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <Settings className="size-10 text-muted-foreground/60" />
      <div>
        <h2 className="text-base font-semibold text-foreground">Collab backend settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Remote settings panels are being enabled and will be available soon.
        </p>
      </div>
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
