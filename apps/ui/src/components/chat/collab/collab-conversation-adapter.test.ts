import { describe, expect, it } from 'vitest'
import type {
  AgentMessageEvent,
  CollaborationTranscriptMessage,
} from '@forge/protocol'
import type { CollabChoiceRequest } from '@/lib/collab-ws-state'
import { adaptCollabToConversationEntries } from './collab-conversation-adapter'

const AGENT_ID = 'session-42'

function msg(
  overrides: Partial<CollaborationTranscriptMessage> = {},
): CollaborationTranscriptMessage {
  return {
    channelId: 'ch-1',
    role: 'user',
    text: 'hello',
    timestamp: '2026-04-10T12:00:00.000Z',
    source: 'user_input',
    ...overrides,
  }
}

function choice(overrides: Partial<CollabChoiceRequest> = {}): CollabChoiceRequest {
  return {
    agentId: 'agent-x',
    choiceId: 'choice-1',
    questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
    status: 'pending',
    timestamp: '2026-04-10T12:01:00.000Z',
    ...overrides,
  }
}

describe('adaptCollabToConversationEntries', () => {
  it('maps assistant transcript messages to ConversationMessageEvent', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [msg({ role: 'assistant', text: 'hey', source: 'speak_to_user' })],
      choiceRequests: [],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: 'conversation_message',
      role: 'assistant',
      text: 'hey',
      source: 'speak_to_user',
      agentId: AGENT_ID,
    })
  })

  it('passes assistant_output transcript source through to ConversationMessageEvent', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [msg({ role: 'assistant', text: 'projected', source: 'assistant_output' })],
      choiceRequests: [],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: 'conversation_message',
      role: 'assistant',
      text: 'projected',
      source: 'assistant_output',
      agentId: AGENT_ID,
    })
  })

  it('sets agentId on every mapped entry', () => {
    const agentMsg: AgentMessageEvent = {
      type: 'agent_message',
      agentId: '',
      timestamp: '2026-04-10T12:03:00.000Z',
      source: 'agent_to_agent',
      toAgentId: 'w1',
      text: 'task done',
    }

    const entries = adaptCollabToConversationEntries({
      messages: [msg()],
      choiceRequests: [choice()],
      activity: [agentMsg],
      sessionAgentId: AGENT_ID,
    })

    for (const entry of entries) {
      expect(entry.agentId).toBeTruthy()
    }
  })

  it('maps choice requests to ChoiceRequestEvent entries', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [],
      choiceRequests: [choice({ choiceId: 'c-99', status: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] })],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: 'choice_request',
      choiceId: 'c-99',
      status: 'answered',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })
  })

  it('merges choices into correct chronological order with messages', () => {
    const m1 = msg({ text: 'first', timestamp: '2026-04-10T12:00:00.000Z' })
    const c1 = choice({ choiceId: 'c-1', timestamp: '2026-04-10T12:00:30.000Z' })
    const m2 = msg({ text: 'last', timestamp: '2026-04-10T12:01:00.000Z' })

    const entries = adaptCollabToConversationEntries({
      messages: [m1, m2],
      choiceRequests: [c1],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ type: 'conversation_message', text: 'first' })
    expect(entries[1]).toMatchObject({ type: 'choice_request', choiceId: 'c-1' })
    expect(entries[2]).toMatchObject({ type: 'conversation_message', text: 'last' })
  })

  it('falls back sessionAgentId for choice requests without agentId', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [],
      choiceRequests: [choice({ agentId: '' })],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries[0]).toMatchObject({ agentId: AGENT_ID, sessionAgentId: AGENT_ID })
  })

  it('maps worker-owned choices with requester agentId and manager sessionAgentId', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [],
      choiceRequests: [
        choice({
          agentId: 'worker-1',
          sessionAgentId: AGENT_ID,
          status: 'pending',
        }),
      ],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries[0]).toMatchObject({
      type: 'choice_request',
      agentId: 'worker-1',
      sessionAgentId: AGENT_ID,
    })
  })
})
