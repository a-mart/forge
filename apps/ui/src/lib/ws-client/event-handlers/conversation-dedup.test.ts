import { describe, expect, it } from 'vitest'
import type { ConversationMessageEvent, ServerEvent } from '@forge/protocol'
import { createInitialManagerWsState, type ManagerWsState } from '@/lib/ws-state'
import { handleConversationEvent } from './conversation-event-handlers'

/**
 * Multi-writer echo/dedup reducer behavior (SPEC §4.6): replace-on-echo for
 * the sender's optimistic entry, id-upsert for redelivered server entries,
 * plain append for other members, and bootstrap reconciliation of pending
 * optimistic entries.
 */

function makeContext(initial?: Partial<ManagerWsState>) {
  let state: ManagerWsState = { ...createInitialManagerWsState('agent-1'), targetAgentId: 'agent-1', ...initial }
  return {
    get state() {
      return state
    },
    updateState(patch: Partial<ManagerWsState>) {
      state = { ...state, ...patch }
    },
  }
}

function userMessage(overrides: Partial<ConversationMessageEvent>): ConversationMessageEvent {
  return {
    type: 'conversation_message',
    agentId: 'agent-1',
    role: 'user',
    text: 'hello',
    timestamp: '2026-07-07T12:00:00.000Z',
    source: 'user_input',
    ...overrides,
  }
}

describe('conversation echo/dedup reducer', () => {
  it('replaces the optimistic entry in place when its echo arrives', () => {
    const optimistic = userMessage({ clientRequestId: 'req-1' })
    const earlier = userMessage({ id: 'srv-0', text: 'earlier' })
    const context = makeContext({ messages: [earlier, optimistic] })

    const echo = userMessage({ id: 'srv-1', clientRequestId: 'req-1', collaborationAuthor: { userId: 'u1', displayName: 'Ada', role: 'member' } })
    handleConversationEvent(echo, context)

    expect(context.state.messages).toHaveLength(2)
    expect(context.state.messages[1]).toBe(echo)
  })

  it('upserts redelivered server entries by id instead of duplicating', () => {
    const original = userMessage({ id: 'srv-1', text: 'v1' })
    const context = makeContext({ messages: [original] })

    handleConversationEvent(userMessage({ id: 'srv-1', text: 'v2' }), context)

    expect(context.state.messages).toHaveLength(1)
    expect((context.state.messages[0] as ConversationMessageEvent).text).toBe('v2')
  })

  it('appends broadcasts from other members normally', () => {
    const context = makeContext({ messages: [] })
    handleConversationEvent(userMessage({ id: 'srv-9', clientRequestId: 'other-req' }), context)
    handleConversationEvent(userMessage({ id: 'srv-10', text: 'second' }), context)
    expect(context.state.messages).toHaveLength(2)
  })

  it('reconciles confirmed optimistic entries during bootstrap merge and keeps pending ones', () => {
    const confirmedOptimistic = userMessage({ clientRequestId: 'req-confirmed' })
    const pendingOptimistic = userMessage({ clientRequestId: 'req-pending', text: 'still pending' })
    const context = makeContext({ messages: [confirmedOptimistic, pendingOptimistic] })

    const history: ServerEvent = {
      type: 'conversation_history',
      agentId: 'agent-1',
      messages: [
        userMessage({ id: 'srv-1', clientRequestId: 'req-confirmed' }),
        userMessage({ id: 'srv-2', text: 'someone else' }),
      ],
    }
    handleConversationEvent(history, context)

    const texts = context.state.messages.map((message) => (message as ConversationMessageEvent).text)
    expect(texts).toEqual(['hello', 'someone else', 'still pending'])
    const confirmedCopies = context.state.messages.filter(
      (message) => message.type === 'conversation_message' && message.clientRequestId === 'req-confirmed',
    )
    expect(confirmedCopies).toHaveLength(1)
    expect((confirmedCopies[0] as ConversationMessageEvent).id).toBe('srv-1')
  })
})

describe('project_presence reducer', () => {
  it('stores per-session viewer snapshots and clears empty ones', () => {
    const context = makeContext()
    handleConversationEvent(
      {
        type: 'project_presence',
        sessionAgentId: 'agent-1',
        viewers: [{ userId: 'u1', displayName: 'Ada', role: 'member' }],
      },
      context,
    )
    expect(context.state.projectPresence['agent-1']).toHaveLength(1)

    handleConversationEvent(
      { type: 'project_presence', sessionAgentId: 'agent-1', viewers: [] },
      context,
    )
    expect(context.state.projectPresence['agent-1']).toBeUndefined()
  })
})
