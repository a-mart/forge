import { describe, expect, it, vi } from 'vitest'
import { createInitialManagerWsState } from '../../ws-state'
import { handleSystemEvent } from './system-event-handlers'

describe('handleSystemEvent Stream Deck navigation', () => {
  it('projects the latest authenticated navigation request into UI state', () => {
    const state = createInitialManagerWsState('forge')
    const updateState = vi.fn()
    const event = {
      type: 'stream_deck_navigation_requested' as const,
      requestId: 'deck-nav-1',
      surface: 'browser' as const,
      sessionAgentId: 'forge',
      requestedAt: '2026-07-26T16:00:00.000Z',
    }

    expect(handleSystemEvent(event, {
      updateState,
      pushSystemMessage: vi.fn(),
      isPendingDirectoryRequest: () => false,
      rejectPendingFromError: vi.fn(),
    })).toBe(true)
    expect(updateState).toHaveBeenCalledWith({ streamDeckNavigationRequest: event })
    expect(state.streamDeckNavigationRequest).toBeNull()
  })
})
