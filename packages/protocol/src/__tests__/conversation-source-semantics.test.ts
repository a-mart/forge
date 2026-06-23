import { describe, expect, it } from 'vitest'

import {
  CONVERSATION_MESSAGE_SOURCES,
  isConversationMessageSource,
  isExplicitRoutedAssistantConversationMessage,
  isUserVisibleAssistantConversationMessage,
  isUserVisibleConversationMessage,
  type ConversationEntry,
} from '../conversation-events.js'

const base = {
  type: 'conversation_message',
  agentId: 'manager-1',
  text: 'hello',
  timestamp: '2026-01-01T00:00:00.000Z',
} as const

describe('conversation source semantics', () => {
  it('recognizes assistant_output as a first-class conversation message source', () => {
    expect(CONVERSATION_MESSAGE_SOURCES).toContain('assistant_output')
    expect(isConversationMessageSource('assistant_output')).toBe(true)
    expect(isConversationMessageSource('not_real')).toBe(false)
  })

  it('classifies speak_to_user and assistant_output as user-visible assistant messages', () => {
    const oldPath = { ...base, role: 'assistant', source: 'speak_to_user' } satisfies ConversationEntry
    const projected = { ...base, role: 'assistant', source: 'assistant_output' } satisfies ConversationEntry

    expect(isUserVisibleAssistantConversationMessage(oldPath)).toBe(true)
    expect(isUserVisibleAssistantConversationMessage(projected)).toBe(true)
    expect(isUserVisibleConversationMessage(oldPath)).toBe(true)
    expect(isUserVisibleConversationMessage(projected)).toBe(true)
    expect(isExplicitRoutedAssistantConversationMessage(oldPath)).toBe(true)
    expect(isExplicitRoutedAssistantConversationMessage(projected)).toBe(false)
  })

  it('does not classify inbound, system, or runtime-log rows as assistant output', () => {
    const inbound = { ...base, role: 'user', source: 'user_input' } satisfies ConversationEntry
    const projectAgent = { ...base, role: 'user', source: 'project_agent_input' } satisfies ConversationEntry
    const system = { ...base, role: 'system', source: 'system' } satisfies ConversationEntry
    const runtimeLog = {
      type: 'conversation_log',
      agentId: 'manager-1',
      timestamp: base.timestamp,
      source: 'runtime_log',
      kind: 'message_end',
      role: 'assistant',
      text: 'hidden',
    } satisfies ConversationEntry

    expect(isUserVisibleAssistantConversationMessage(inbound)).toBe(false)
    expect(isUserVisibleAssistantConversationMessage(projectAgent)).toBe(false)
    expect(isUserVisibleAssistantConversationMessage(system)).toBe(false)
    expect(isUserVisibleAssistantConversationMessage(runtimeLog)).toBe(false)
  })
})
