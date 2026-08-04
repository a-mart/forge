import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  SESSION_ATTENTION_MAX_DISMISS_IDS,
  SESSION_ATTENTION_MAX_ID_LENGTH,
  SESSION_ATTENTION_REASONS,
} from '../session-attention.js'
import { getWsRequestContract } from '../ws-request-contract.js'
import type { ClientCommand } from '../client-commands.js'
import type { ServerEvent } from '../server-events.js'
import type {
  DismissSessionAttentionCommand,
  SessionAttention,
  SessionAttentionReason,
  SessionAttentionSnapshotEvent,
  SessionAttentionUpdateEvent,
} from '../session-attention.js'

const attention = {
  attentionId: 'attention-epoch-17',
  sessionAgentId: 'session-1',
  profileId: 'profile-1',
  reason: 'work_graph_completed',
  raisedAt: '2026-08-04T12:00:00.000Z',
} satisfies SessionAttention

describe('session attention protocol contract', () => {
  it('keeps the reason vocabulary closed and server-copy-free', () => {
    expect(SESSION_ATTENTION_REASONS).toEqual([
      'work_settled',
      'plan_completed',
      'work_graph_completed',
      'awaiting_review',
      'decision_waiting',
      'work_failed',
    ])
    expectTypeOf<SessionAttentionReason>().toEqualTypeOf<
      'work_settled'
      | 'plan_completed'
      | 'work_graph_completed'
      | 'awaiting_review'
      | 'decision_waiting'
      | 'work_failed'
    >()
    expect(attention).not.toHaveProperty('message')
  })

  it('defines revisioned snapshots, batched updates, and exact-instance dismissal', () => {
    const snapshot = {
      type: 'session_attention_snapshot',
      revision: 4,
      attentions: [attention],
    } satisfies SessionAttentionSnapshotEvent
    const update = {
      type: 'session_attention_update',
      revision: 5,
      changes: [
        { sessionAgentId: attention.sessionAgentId, attention: null },
        { sessionAgentId: 'session-2', attention: { ...attention, attentionId: 'attention-epoch-18', sessionAgentId: 'session-2' } },
      ],
      requestId: 'dismiss-request-1',
    } satisfies SessionAttentionUpdateEvent
    const dismiss = {
      type: 'dismiss_session_attention',
      attentionIds: [attention.attentionId],
      requestId: 'dismiss-request-1',
    } satisfies DismissSessionAttentionCommand

    expect(snapshot.attentions[0]?.attentionId).toBe('attention-epoch-17')
    expect(update.changes).toHaveLength(2)
    expect(dismiss.attentionIds).toEqual(['attention-epoch-17'])
    expect(SESSION_ATTENTION_MAX_DISMISS_IDS).toBe(100)
    expect(SESSION_ATTENTION_MAX_ID_LENGTH).toBe(256)
    expectTypeOf<typeof dismiss>().toMatchTypeOf<Extract<ClientCommand, { type: 'dismiss_session_attention' }>>()
    expectTypeOf<typeof snapshot>().toMatchTypeOf<Extract<ServerEvent, { type: 'session_attention_snapshot' }>>()
    expectTypeOf<typeof update>().toMatchTypeOf<Extract<ServerEvent, { type: 'session_attention_update' }>>()
  })

  it('registers dismissal-to-update request correlation', () => {
    expect(getWsRequestContract('dismiss_session_attention')).toEqual({
      commandType: 'dismiss_session_attention',
      resultFamily: 'session_attention_update',
      requestId: { ui: 'required', wire: 'required' },
      successEvents: ['session_attention_update'],
      errorCodeFragments: ['dismiss_session_attention'],
    })
  })
})
