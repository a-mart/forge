import { describe, expect, it, vi } from 'vitest'
import { createInitialManagerWsState } from '../../ws-state'
import { handleSystemEvent } from './system-event-handlers'

describe('handleSystemEvent Stream Deck navigation', () => {
  it('correlates an inventory baseline without projecting it into selected web or transcript state', () => {
    const resolve = vi.fn(), updateState = vi.fn(), pushSystemMessage = vi.fn()
    const event = { type: 'inventory_snapshot' as const, requestId: 'inventory-1', agents: [], profiles: [], counts: {}, revision: 1, attentions: [] }
    expect(handleSystemEvent(event, { requestTracker: { resolve }, updateState, pushSystemMessage, isPendingDirectoryRequest: () => false, rejectPendingFromError: vi.fn() })).toBe(true)
    expect(resolve).toHaveBeenCalledWith('subscribe_inventory', 'inventory-1', event)
    expect(updateState).not.toHaveBeenCalled()
    expect(pushSystemMessage).not.toHaveBeenCalled()
  })

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
      requestTracker: { resolve: vi.fn() },
      updateState,
      pushSystemMessage: vi.fn(),
      isPendingDirectoryRequest: () => false,
      rejectPendingFromError: vi.fn(),
    })).toBe(true)
    expect(updateState).toHaveBeenCalledWith({ streamDeckNavigationRequest: event })
    expect(state.streamDeckNavigationRequest).toBeNull()
  })
})
