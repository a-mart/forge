import type { StreamDeckNavigationRequestedEvent } from '@forge/protocol'
import type { AppRouteState } from './use-route-state'

export function resolveStreamDeckNavigationRoute(
  request: StreamDeckNavigationRequestedEvent,
  fallbackAgentId: string | null,
): AppRouteState | null {
  if (request.surface === 'stats' || request.surface === 'tokens') {
    return {
      view: 'stats',
      statsTab: request.surface === 'tokens' ? 'tokens' : 'overview',
    }
  }

  const agentId = request.sessionAgentId ?? fallbackAgentId
  if (!agentId) return null
  return {
    view: 'chat',
    agentId,
    surface: 'builder',
    ...(request.surface === 'git' || request.surface === 'browser' || request.surface === 'terminal'
      ? { deckPanel: request.surface }
      : {}),
  }
}
