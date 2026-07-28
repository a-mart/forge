import { describe, expect, it } from 'vitest'
import type { CollaborationChoiceRequestEvent } from '../collaboration.js'

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('CollaborationChoiceRequestEvent contract', () => {
  it('accepts optional request.sessionAgentId', () => {
    const withSessionAgentId: CollaborationChoiceRequestEvent = {
      type: 'collab_choice_request',
      channelId: 'channel-1',
      request: {
        agentId: 'worker-1',
        sessionAgentId: 'session-1',
        choiceId: 'choice-1',
        questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
        status: 'pending',
        timestamp: '2026-04-14T12:00:00.000Z',
      },
    }

    const withoutSessionAgentId: CollaborationChoiceRequestEvent = {
      type: 'collab_choice_request',
      channelId: 'channel-1',
      request: {
        agentId: 'session-1',
        choiceId: 'choice-2',
        questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
        status: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
        timestamp: '2026-04-14T12:01:00.000Z',
      },
    }
    const withWireSessionAgentId = roundTrip(withSessionAgentId)
    const withoutWireSessionAgentId = roundTrip(withoutSessionAgentId)

    expect(withWireSessionAgentId).toEqual(withSessionAgentId)
    expect(withoutWireSessionAgentId).toEqual(withoutSessionAgentId)
    expect(withWireSessionAgentId.request.sessionAgentId).toBe('session-1')
    expect(withoutWireSessionAgentId.request.sessionAgentId).toBeUndefined()
  })
})
