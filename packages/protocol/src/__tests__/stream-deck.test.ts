import { describe, expect, it } from 'vitest'
import {
  STREAM_DECK_ACTION_TYPES,
  STREAM_DECK_PROTOCOL_VERSION,
  STREAM_DECK_SURFACES,
  type StreamDeckActionRequest,
  type StreamDeckSnapshot,
} from '../index.js'

describe('Stream Deck protocol', () => {
  it('exports the versioned snapshot and guarded action contract from the root barrel', () => {
    const action: StreamDeckActionRequest = {
      requestId: 'deck-1',
      type: 'send_prompt',
      sessionAgentId: 'forge--s2',
      text: 'Run the focused checks',
    }
    const snapshot = {
      protocolVersion: STREAM_DECK_PROTOCOL_VERSION,
      serverTime: '2026-07-25T00:00:00.000Z',
      serverVersion: '1.0.0',
      summary: {
        profileCount: 1,
        sessionCount: 1,
        runningSessionCount: 1,
        activeWorkerCount: 2,
        pendingChoiceCount: 0,
        unreadCount: 1,
      },
      focusSessionAgentId: 'forge--s2',
      profiles: [],
      sessions: [],
      stats: null,
    } satisfies StreamDeckSnapshot

    expect(STREAM_DECK_PROTOCOL_VERSION).toBe(2)
    expect(STREAM_DECK_ACTION_TYPES).toContain(action.type)
    expect(STREAM_DECK_ACTION_TYPES).toContain('navigate')
    expect(STREAM_DECK_SURFACES).toEqual(['chat', 'git', 'browser', 'terminal', 'stats', 'tokens'])
    expect(snapshot.focusSessionAgentId).toBe('forge--s2')
  })
})
