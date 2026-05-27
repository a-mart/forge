import { describe, expect, it } from 'vitest'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import { deriveVisibleMessages } from './use-visible-messages'

const manager: AgentDescriptor = {
  agentId: 'manager',
  displayName: 'Manager',
  role: 'manager',
  managerId: 'manager',
  status: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  cwd: '/tmp/project',
  model: {
    provider: 'openai-codex',
    modelId: 'gpt-5.5',
    thinkingLevel: 'high',
  },
  sessionFile: '/tmp/project/manager.jsonl',
}

const worker: AgentDescriptor = {
  ...manager,
  agentId: 'worker-1',
  displayName: 'Worker 1',
  role: 'worker',
  managerId: 'manager',
  sessionFile: '/tmp/project/worker-1.jsonl',
}

describe('deriveVisibleMessages', () => {
  it('preserves all-view merge behavior for manager-scoped timelines', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input',
      },
      {
        type: 'conversation_message',
        agentId: 'worker-1',
        role: 'assistant',
        text: 'done',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'speak_to_user',
      },
    ]

    const activityMessages: ConversationEntry[] = [
      {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'worker-1',
        text: 'working',
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
    })

    expect(result.allMessages.map((entry) => entry.type)).toEqual([
      'conversation_message',
      'agent_message',
      'conversation_message',
    ])
    expect(result.visibleMessages).toEqual(result.allMessages)
  })

  it('hides worker tool calls from manager all view', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'worker-1',
        role: 'assistant',
        text: 'after',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'speak_to_user',
      },
    ]

    const activityMessages: ConversationEntry[] = [
      {
        type: 'agent_tool_call',
        agentId: 'manager',
        actorAgentId: 'worker-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        kind: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'call-1',
        text: '{"command":"echo hi"}',
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
    })

    expect(result.visibleMessages.map((entry) => entry.type)).toEqual([
      'conversation_message',
    ])
  })

  it('shows manager-owned tool calls in manager all view', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input',
      },
    ]

    const activityMessages: ConversationEntry[] = [
      {
        type: 'agent_tool_call',
        agentId: 'manager',
        actorAgentId: 'manager',
        timestamp: '2026-01-01T00:00:01.000Z',
        kind: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'call-2',
        text: '{"command":"ls"}',
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
    })

    expect(result.visibleMessages.map((entry) => entry.type)).toEqual([
      'conversation_message',
      'agent_tool_call',
    ])
  })

  it('keeps manager-influencing worker auto-reports visible in manager all view', () => {
    const autoReport: ConversationEntry = {
      type: 'agent_message',
      agentId: 'manager',
      timestamp: '2026-01-01T00:00:01.000Z',
      source: 'agent_to_agent',
      fromAgentId: 'worker-1',
      toAgentId: 'manager',
      text: 'status: done',
    }

    const foreignContextMessage: ConversationEntry = {
      type: 'agent_message',
      agentId: 'foreign-manager',
      timestamp: '2026-01-01T00:00:02.000Z',
      source: 'agent_to_agent',
      fromAgentId: 'foreign-worker',
      toAgentId: 'foreign-manager',
      text: 'foreign-only',
    }

    const result = deriveVisibleMessages({
      messages: [],
      activityMessages: [autoReport, foreignContextMessage],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
    })

    expect(result.visibleMessages).toEqual([autoReport])
  })

  it('keeps worker timelines merged in all view', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'worker-1',
        role: 'assistant',
        text: 'after',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'speak_to_user',
      },
    ]

    const activityMessages: ConversationEntry[] = [
      {
        type: 'agent_tool_call',
        agentId: 'manager',
        actorAgentId: 'worker-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        kind: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'call-1',
        text: '{"command":"echo hi"}',
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: worker,
      channelView: 'all',
    })

    expect(result.allMessages.map((entry) => entry.type)).toEqual([
      'agent_tool_call',
      'conversation_message',
    ])
    expect(result.visibleMessages).toEqual(result.allMessages)
  })

  it('filters conversation messages to web channel in web view', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'assistant',
        text: 'web-visible',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'speak_to_user',
        sourceContext: { channel: 'web' },
      },
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'assistant',
        text: 'telegram-hidden',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'speak_to_user',
        sourceContext: { channel: 'telegram' },
      },
      {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'worker-1',
        text: 'internal',
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages: [],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'web',
    })

    expect(result.allMessages).toEqual(messages)
    expect(result.visibleMessages.map((entry) => entry.type === 'conversation_message' ? entry.text : entry.type)).toEqual([
      'web-visible',
      'agent_message',
    ])
  })

  it('shows CLI-sourced messages in web view alongside web messages', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'from-web',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input',
        sourceContext: { channel: 'web' },
      },
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'from-cli',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'user_input',
        sourceContext: { channel: 'cli' },
      },
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'from-telegram',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'user_input',
        sourceContext: { channel: 'telegram' },
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages: [],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'web',
    })

    // CLI messages should be visible in web view; Telegram should be hidden
    const visibleTexts = result.visibleMessages
      .filter((e): e is Extract<ConversationEntry, { type: 'conversation_message' }> => e.type === 'conversation_message')
      .map((e) => e.text)
    expect(visibleTexts).toEqual(['from-web', 'from-cli'])
  })

  it('shows all channels including CLI in all view', () => {
    const messages: ConversationEntry[] = [
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'from-cli',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input',
        sourceContext: { channel: 'cli' },
      },
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'assistant',
        text: 'reply',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'speak_to_user',
      },
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages: [],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
    })

    expect(result.visibleMessages).toEqual(result.allMessages)
  })
})
