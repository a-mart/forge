import { describe, expect, it } from 'vitest'
import type {
  AgentMessageEvent,
  AgentToolCallEvent,
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
  it('maps user transcript messages to ConversationMessageEvent', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [msg({ role: 'user', text: 'hi' })],
      choiceRequests: [],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: 'conversation_message',
      role: 'user',
      text: 'hi',
      agentId: AGENT_ID,
    })
  })

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

  it('maps system transcript messages to ConversationMessageEvent', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [msg({ role: 'system', text: 'notice', source: 'system' })],
      choiceRequests: [],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: 'conversation_message',
      role: 'system',
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

  it('produces stable activity entry IDs via passthrough', () => {
    const tool: AgentToolCallEvent = {
      type: 'agent_tool_call',
      agentId: 'worker-1',
      actorAgentId: 'worker-1',
      timestamp: '2026-04-10T12:02:00.000Z',
      kind: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'tc-1',
      text: 'Running bash',
    }

    const entries = adaptCollabToConversationEntries({
      messages: [],
      choiceRequests: [],
      activity: [tool],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: 'agent_tool_call',
      agentId: 'worker-1',
      toolName: 'bash',
    })
  })

  it('preserves collab author metadata on mapped messages', () => {
    const author = { userId: 'u-1', displayName: 'Alice', role: 'member' as const, workspaceId: 'ws-1', channelId: 'ch-1' }
    const entries = adaptCollabToConversationEntries({
      messages: [msg({ collaborationAuthor: author })],
      choiceRequests: [],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toHaveLength(1)
    const entry = entries[0] as { type: 'conversation_message'; collaborationAuthor?: typeof author }
    expect(entry.collaborationAuthor).toEqual(author)
  })

  it('preserves message id, attachments, pinned, and sourceContext', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [
        msg({
          id: 'msg-42',
          pinned: true,
          attachments: [{ mimeType: 'text/plain', fileName: 'a.txt', fileRef: 'f1', sizeBytes: 100 }],
          sourceContext: { channel: 'web' },
        }),
      ],
      choiceRequests: [],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toHaveLength(1)
    const entry = entries[0] as { id?: string; pinned?: boolean; attachments?: unknown[]; sourceContext?: unknown }
    expect(entry.id).toBe('msg-42')
    expect(entry.pinned).toBe(true)
    expect(entry.attachments).toHaveLength(1)
    expect(entry.sourceContext).toEqual({ channel: 'web' })
  })

  it('falls back sessionAgentId for choice requests without agentId', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [],
      choiceRequests: [choice({ agentId: '' })],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries[0]).toMatchObject({ agentId: AGENT_ID })
  })

  it('handles empty inputs gracefully', () => {
    const entries = adaptCollabToConversationEntries({
      messages: [],
      choiceRequests: [],
      activity: [],
      sessionAgentId: AGENT_ID,
    })

    expect(entries).toEqual([])
  })
})
