import { describe, expect, it, vi } from 'vitest'
import type { SessionAttention } from '@forge/protocol'
import { createInitialManagerWsState, type ManagerWsState } from '../../ws-state'
import {
  handleSessionAttentionEvent,
  reduceSessionAttentionSnapshot,
  reduceSessionAttentionUpdate,
} from './session-attention-event-handlers'

function attention(sessionAgentId: string, attentionId = `attention-${sessionAgentId}`): SessionAttention {
  return {
    attentionId,
    sessionAgentId,
    profileId: 'profile-1',
    reason: 'work_settled',
    raisedAt: '2026-08-03T12:00:00.000Z',
  }
}

describe('session attention event handling', () => {
  it('replaces the full map from an authoritative snapshot', () => {
    expect(reduceSessionAttentionSnapshot({
      type: 'session_attention_snapshot',
      revision: 3,
      attentions: [attention('session-b')],
    })).toEqual({
      sessionAttentionRevision: 3,
      sessionAttentions: { 'session-b': attention('session-b') },
    })
  })

  it('applies a whole revision batch atomically and ignores stale or equal revisions', () => {
    const state = {
      sessionAttentionRevision: 4,
      sessionAttentions: {
        'session-a': attention('session-a'),
        'session-b': attention('session-b'),
      },
    }
    const next = reduceSessionAttentionUpdate(state, {
      type: 'session_attention_update',
      revision: 5,
      changes: [
        { sessionAgentId: 'session-a', attention: null },
        { sessionAgentId: 'session-c', attention: attention('session-c') },
      ],
    })

    expect(next).toEqual({
      sessionAttentionRevision: 5,
      sessionAttentions: {
        'session-b': attention('session-b'),
        'session-c': attention('session-c'),
      },
    })
    expect(reduceSessionAttentionUpdate(next!, {
      type: 'session_attention_update',
      revision: 5,
      changes: [{ sessionAgentId: 'session-a', attention: attention('session-a', 'late') }],
    })).toBeNull()
    expect(reduceSessionAttentionUpdate(next!, {
      type: 'session_attention_update',
      revision: 2,
      changes: [{ sessionAgentId: 'session-a', attention: attention('session-a', 'stale') }],
    })).toBeNull()
  })

  it('resolves a correlated dismissal even when its equal revision is already applied', () => {
    let state: ManagerWsState = {
      ...createInitialManagerWsState('session-a'),
      sessionAttentionRevision: 7,
      sessionAttentions: {},
    }
    const resolve = vi.fn()
    const handled = handleSessionAttentionEvent({
      type: 'session_attention_update',
      revision: 7,
      changes: [],
      requestId: 'dismiss-1',
    }, {
      state,
      updateState: (patch) => { state = { ...state, ...patch } },
      requestTracker: { resolve } as any,
    })

    expect(handled).toBe(true)
    expect(resolve).toHaveBeenCalledWith(
      'dismiss_session_attention',
      'dismiss-1',
      expect.objectContaining({ revision: 7 }),
    )
    expect(state.sessionAttentionRevision).toBe(7)
  })
})
