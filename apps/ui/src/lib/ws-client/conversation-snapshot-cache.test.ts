import { describe, expect, it } from 'vitest'
import { ConversationSnapshotCache } from './conversation-snapshot-cache'

function snapshot(originId: string, agentId: string, text: string, servedView: 'web' | 'all' = 'web') {
  return {
    originId,
    agentId,
    servedView,
    profileId: `profile-${originId}`,
    messages: [{
      type: 'conversation_message' as const,
      agentId,
      id: `${agentId}-${text}`,
      role: 'assistant' as const,
      text,
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'speak_to_user' as const,
    }],
    activityMessages: [],
    conversationPage: null,
  }
}

describe('ConversationSnapshotCache', () => {
  it('isolates origin, agent, and served view keys', () => {
    const cache = new ConversationSnapshotCache()
    cache.capture(snapshot('one', 'agent', 'one-web'))
    cache.capture(snapshot('two', 'agent', 'two-web'))
    cache.capture(snapshot('one', 'agent', 'one-all', 'all'))
    expect(cache.get({ originId: 'one', agentId: 'agent', servedView: 'web' })?.messages[0]).toMatchObject({ text: 'one-web' })
    expect(cache.get({ originId: 'two', agentId: 'agent', servedView: 'web' })?.messages[0]).toMatchObject({ text: 'two-web' })
    expect(cache.get({ originId: 'one', agentId: 'agent', servedView: 'all' })?.messages[0]).toMatchObject({ text: 'one-all' })
  })

  it('enforces global LRU count, bytes, TTL, and oversize replacement', () => {
    let now = 100
    const cache = new ConversationSnapshotCache({
      now: () => now,
      maxSnapshots: 2,
      maxEstimatedBytes: 2_000,
      maxEntryBytes: 900,
      maxAgeMs: 50,
    })
    cache.capture(snapshot('one', 'a', 'a'))
    cache.capture(snapshot('one', 'b', 'b'))
    cache.get({ originId: 'one', agentId: 'a', servedView: 'web' })
    cache.capture(snapshot('one', 'c', 'c'))
    expect(cache.get({ originId: 'one', agentId: 'b', servedView: 'web' })).toBeNull()
    expect(cache.size).toBe(2)

    expect(cache.capture(snapshot('one', 'a', 'x'.repeat(2_000)))).toBe(false)
    expect(cache.get({ originId: 'one', agentId: 'a', servedView: 'web' })).toBeNull()
    now += 51
    expect(cache.size).toBe(0)
    expect(cache.totalEstimatedBytes).toBe(0)
  })

  it('drops optimistic and every choice lifecycle row, then supports origin/profile invalidation', () => {
    const cache = new ConversationSnapshotCache()
    const input: Parameters<ConversationSnapshotCache['capture']>[0] = snapshot('one', 'a', 'confirmed')
    input.messages.push({
      type: 'conversation_message', agentId: 'a', role: 'user', text: 'optimistic',
      timestamp: '2026-01-01T00:00:01.000Z', source: 'user_input', clientRequestId: 'pending',
    })
    for (const status of ['pending', 'answered', 'cancelled', 'expired'] as const) {
      input.messages.push({
        type: 'choice_request', agentId: 'a', choiceId: `choice-${status}`, status,
        timestamp: '2026-01-01T00:00:02.000Z', questions: [{
          id: 'q', question: 'Unsafe stale action?', options: [{ id: 'yes', label: 'Yes' }],
        }],
      })
    }
    cache.capture(input)
    expect(cache.get({ originId: 'one', agentId: 'a', servedView: 'web' })?.messages).toEqual([
      expect.objectContaining({ id: 'a-confirmed' }),
    ])
    cache.evictProfile('one', 'profile-one')
    expect(cache.size).toBe(0)
    cache.capture(snapshot('one', 'a', 'a'))
    cache.capture(snapshot('two', 'a', 'a'))
    cache.evictOrigin('one')
    expect(cache.size).toBe(1)
  })
})
