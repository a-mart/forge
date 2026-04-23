import type { ActiveSurface } from '@/hooks/index-page/use-route-state'
import { CollabSidebar } from '@/components/chat/collab-sidebar/CollabSidebar'
import { useCollabWsConnection, CollabWsProvider } from '@/hooks/index-page/use-collab-ws-connection'
import { CollabWorkspace } from './CollabWorkspace'

interface CollabSurfaceProps {
  wsUrl: string
  channel?: string
  activeSurface: ActiveSurface
  onSelectChannel: (channelId?: string) => void
  onSelectSurface: (surface: ActiveSurface) => void
}

export function CollabSurface({
  wsUrl,
  channel,
  activeSurface,
  onSelectChannel,
  onSelectSurface,
}: CollabSurfaceProps) {
  const collab = useCollabWsConnection(wsUrl)

  return (
    <CollabWsProvider value={collab}>
      <CollabSidebar
        wsUrl={wsUrl}
        selectedChannelId={channel}
        activeSurface={activeSurface}
        onSelectChannel={onSelectChannel}
        onSelectSurface={onSelectSurface}
      />

      <CollabWorkspace
        wsUrl={wsUrl}
        channelId={channel}
        onSelectChannel={onSelectChannel}
      />
    </CollabWsProvider>
  )
}
