import { describe, expect, it } from 'vitest'
import type { StreamDeckNavigationRequestedEvent, StreamDeckSurface } from '@forge/protocol'
import { resolveStreamDeckNavigationRoute } from './stream-deck-navigation'

describe('resolveStreamDeckNavigationRoute', () => {
  it.each([
    ['git', { view: 'chat', agentId: 'forge', surface: 'builder', deckPanel: 'git' }],
    ['browser', { view: 'chat', agentId: 'forge', surface: 'builder', deckPanel: 'browser' }],
    ['terminal', { view: 'chat', agentId: 'forge', surface: 'builder', deckPanel: 'terminal' }],
    ['chat', { view: 'chat', agentId: 'forge', surface: 'builder' }],
    ['stats', { view: 'stats', statsTab: 'overview' }],
    ['tokens', { view: 'stats', statsTab: 'tokens' }],
  ] satisfies Array<[StreamDeckSurface, object]>)('routes %s into its real Forge surface', (surface, expected) => {
    expect(resolveStreamDeckNavigationRoute(request(surface), null)).toEqual(expected)
  })

  it('uses the active session only when a session-scoped request omits its target', () => {
    expect(resolveStreamDeckNavigationRoute(request('chat', null), 'fallback')).toMatchObject({
      view: 'chat',
      agentId: 'fallback',
    })
    expect(resolveStreamDeckNavigationRoute(request('chat', null), null)).toBeNull()
  })
})

function request(
  surface: StreamDeckSurface,
  sessionAgentId: string | null = 'forge',
): StreamDeckNavigationRequestedEvent {
  return {
    type: 'stream_deck_navigation_requested',
    requestId: `deck-${surface}`,
    surface,
    ...(sessionAgentId ? { sessionAgentId } : {}),
    requestedAt: '2026-07-26T16:00:00.000Z',
  }
}
