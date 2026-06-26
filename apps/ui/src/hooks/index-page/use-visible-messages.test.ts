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

const foreignManager: AgentDescriptor = {
  ...manager,
  agentId: 'foreign-manager',
  displayName: 'Foreign Manager',
  managerId: 'foreign-manager',
  sessionFile: '/tmp/project/foreign-manager.jsonl',
}

const foreignWorker: AgentDescriptor = {
  ...manager,
  agentId: 'foreign-worker',
  displayName: 'Foreign Worker',
  role: 'worker',
  managerId: 'foreign-manager',
  sessionFile: '/tmp/project/foreign-worker.jsonl',
}

const codexSidecar: AgentDescriptor = {
  ...worker,
  agentId: 'manager--codex',
  displayName: 'Codex',
  managerId: 'manager',
  sessionFile: '/tmp/project/manager--codex.jsonl',
  externalThread: {
    type: 'codex_app_server',
    persisted: true,
    createdByMention: true,
  },
}

function makeToolCall(
  agentId: string,
  actorAgentId: string,
  toolCallId: string,
  timestamp = '2026-01-01T00:00:01.000Z',
): ConversationEntry {
  return {
    type: 'agent_tool_call',
    agentId,
    actorAgentId,
    timestamp,
    kind: 'tool_execution_start',
    toolName: 'bash',
    toolCallId,
    text: '{"command":"echo hi"}',
  }
}

describe('deriveVisibleMessages', () => {
  it('keeps worker-origin session choices visible in web and manager all views', () => {
    const choice: ConversationEntry = {
      type: 'choice_request',
      agentId: 'worker-1',
      sessionAgentId: 'manager',
      choiceId: 'choice-1',
      questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
      status: 'pending',
      timestamp: '2026-01-01T00:00:01.000Z',
    }

    const webResult = deriveVisibleMessages({
      messages: [choice],
      activityMessages: [],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'web',
    })
    const allResult = deriveVisibleMessages({
      messages: [choice],
      activityMessages: [],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
    })

    expect(webResult.visibleMessages).toEqual([choice])
    expect(allResult.visibleMessages).toEqual([choice])
  })

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

  it('shows assistant output and progress rows in web and all manager views while hiding runtime logs', () => {
    const projected: ConversationEntry = {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'projected reply',
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'assistant_output',
      sourceContext: { channel: 'web' },
    }
    const progress: ConversationEntry = {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'checking now',
      timestamp: '2026-01-01T00:00:00.500Z',
      source: 'assistant_progress',
      sourceContext: { channel: 'web' },
    }
    const runtimeLog: ConversationEntry = {
      type: 'conversation_log',
      agentId: 'manager',
      timestamp: '2026-01-01T00:00:01.000Z',
      source: 'runtime_log',
      kind: 'message_end',
      role: 'assistant',
      text: 'hidden runtime text',
    }

    const webResult = deriveVisibleMessages({
      messages: [projected, progress, runtimeLog],
      activityMessages: [],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'web',
    })
    const allResult = deriveVisibleMessages({
      messages: [projected, progress, runtimeLog],
      activityMessages: [],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
    })

    expect(webResult.visibleMessages).toEqual([projected, progress])
    expect(allResult.visibleMessages).toEqual([projected, progress])
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
      makeToolCall('manager', 'worker-1', 'call-1'),
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

  it('hides worker tool calls from manager all view when detailedAllView is explicitly false', () => {
    const activityMessages: ConversationEntry[] = [
      makeToolCall('manager', 'worker-1', 'call-1'),
    ]

    const result = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: false,
    })

    expect(result.visibleMessages).toEqual([])
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
      makeToolCall('manager', 'manager', 'call-2'),
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

  it('shows manager-owned tool calls in both default and detailed all view', () => {
    const activityMessages: ConversationEntry[] = [
      makeToolCall('manager', 'manager', 'call-mgr'),
    ]

    const defaultResult = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: false,
    })

    const detailedResult = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: true,
    })

    expect(defaultResult.visibleMessages).toHaveLength(1)
    expect(detailedResult.visibleMessages).toHaveLength(1)
    expect(defaultResult.visibleMessages[0]).toEqual(detailedResult.visibleMessages[0])
  })

  it('hides owned worker tool calls in detailed manager all view', () => {
    const activityMessages: ConversationEntry[] = [
      makeToolCall('manager', 'worker-1', 'owned-call'),
    ]

    const result = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: true,
    })

    expect(result.visibleMessages).toEqual([])
  })

  it('hides Codex sidecar tool activity in manager all view regardless of detailed toggle', () => {
    const activityMessages: ConversationEntry[] = [
      makeToolCall('manager', 'manager--codex', 'codex-call'),
    ]

    const defaultResult = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, codexSidecar],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: false,
    })

    const detailedResult = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, codexSidecar],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: true,
    })

    expect(defaultResult.visibleMessages).toHaveLength(0)
    expect(detailedResult.visibleMessages).toHaveLength(0)
  })

  it('shows Codex sidecar conversation_log rows in selected sidecar view', () => {
    const activityMessages: ConversationEntry[] = [
      {
        type: 'conversation_log',
        agentId: 'manager--codex',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'runtime_log',
        kind: 'tool_execution_start',
        toolName: 'codex_command',
        toolCallId: 'cmd-1',
        text: '{"command":"echo hi"}',
      },
    ]

    const result = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, codexSidecar],
      activeAgent: codexSidecar,
      channelView: 'all',
    })

    expect(result.visibleMessages).toHaveLength(1)
    expect(result.visibleMessages[0].type).toBe('conversation_log')
  })

  it('hides foreign-entry tool rows even when actor is owned worker (detailed)', () => {
    // Malformed: entry.agentId = foreignManagerId, but actorAgentId = owned worker
    const activityMessages: ConversationEntry[] = [
      makeToolCall('foreign-manager', 'worker-1', 'sneaky-call'),
    ]

    const result = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, worker, foreignManager, foreignWorker],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: true,
    })

    expect(result.visibleMessages).toHaveLength(0)
  })

  it('hides foreign-actor tool rows even when entry is manager-scoped (detailed)', () => {
    // entry.agentId = managerId, but actorAgentId = foreign worker
    const activityMessages: ConversationEntry[] = [
      makeToolCall('manager', 'foreign-worker', 'foreign-actor-call'),
    ]

    const result = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, worker, foreignManager, foreignWorker],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: true,
    })

    expect(result.visibleMessages).toHaveLength(0)
  })

  it('does not reveal unknown worker actor ids in detailed manager all view (fail-closed)', () => {
    // actorAgentId exists but no matching descriptor in agents
    const activityMessages: ConversationEntry[] = [
      makeToolCall('manager', 'unknown-worker', 'unknown-call'),
    ]

    const result = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: true,
    })

    expect(result.visibleMessages).toHaveLength(0)
  })

  it('does not change worker all view behavior when detailedAllView is true', () => {
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
      makeToolCall('manager', 'worker-1', 'call-1'),
    ]

    const result = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: worker,
      channelView: 'all',
      detailedAllView: true,
    })

    expect(result.allMessages.map((entry) => entry.type)).toEqual([
      'agent_tool_call',
      'conversation_message',
    ])
    // Worker all view shows everything — detailedAllView has no effect
    expect(result.visibleMessages).toEqual(result.allMessages)
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
      makeToolCall('manager', 'worker-1', 'call-1'),
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

  it('does not include sibling managers in owned actor set', () => {
    const siblingManager: AgentDescriptor = {
      ...manager,
      agentId: 'sibling-manager',
      managerId: 'sibling-manager',
    }

    // Tool call from sibling manager's context but with sibling as actor
    const activityMessages: ConversationEntry[] = [
      makeToolCall('manager', 'sibling-manager', 'sibling-call'),
    ]

    const result = deriveVisibleMessages({
      messages: [],
      activityMessages,
      agents: [manager, worker, siblingManager],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: true,
    })

    // Sibling manager is NOT an owned actor (not role=worker with managerId=manager)
    expect(result.visibleMessages).toHaveLength(0)
  })

  it('scoped agent messages remain visible in both default and detailed modes', () => {
    const agentMessage: ConversationEntry = {
      type: 'agent_message',
      agentId: 'manager',
      timestamp: '2026-01-01T00:00:01.000Z',
      source: 'agent_to_agent',
      fromAgentId: 'worker-1',
      toAgentId: 'manager',
      text: 'worker report',
    }

    const defaultResult = deriveVisibleMessages({
      messages: [],
      activityMessages: [agentMessage],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: false,
    })

    const detailedResult = deriveVisibleMessages({
      messages: [],
      activityMessages: [agentMessage],
      agents: [manager, worker],
      activeAgent: manager,
      channelView: 'all',
      detailedAllView: true,
    })

    expect(defaultResult.visibleMessages).toHaveLength(1)
    expect(detailedResult.visibleMessages).toHaveLength(1)
  })
})
