import { describe, expect, it } from 'vitest'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import { deriveVisibleMessages } from './use-visible-messages'

/**
 * Phase 0 characterization tests for Full Session Audit / normal All replay.
 * These assert Phase 1 target semantics. Skipped until QF-1/QF-2 land.
 * Unskip the whole describe in Phase 1 when the visibility classifier changes.
 */
describe.skip('audit view replay characterization (Phase 0 → Phase 1)', () => {
  const currentManager: AgentDescriptor = {
    agentId: 'visible-messages-dropped',
    displayName: 'Visible Messages Dropped',
    role: 'manager',
    managerId: 'visible-messages-dropped',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: '/tmp/project/visible-messages-dropped.jsonl',
  }

  const ancestorManagerId = 'ancestor-manager'

  const worker: AgentDescriptor = {
    ...currentManager,
    agentId: 'worker-1',
    displayName: 'Worker 1',
    role: 'worker',
    managerId: 'visible-messages-dropped',
    sessionFile: '/tmp/project/worker-1.jsonl',
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

  function makeAgentMessage(
    agentId: string,
    fromAgentId: string,
    toAgentId: string,
    text: string,
    timestamp = '2026-01-01T00:00:02.000Z',
  ): ConversationEntry {
    return {
      type: 'agent_message',
      agentId,
      timestamp,
      source: 'agent_to_agent',
      fromAgentId,
      toAgentId,
      text,
    }
  }

  describe('A. forked All view scoping with ancestor agentIds', () => {
    const forkedTranscript: ConversationEntry = {
      type: 'conversation_message',
      agentId: ancestorManagerId,
      role: 'user',
      text: 'forked user turn',
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'user_input',
    }

    const ancestorManagerToolCall = makeToolCall(
      ancestorManagerId,
      ancestorManagerId,
      'ancestor-spawn',
      '2026-01-01T00:00:01.000Z',
    )

    const workerCallback = makeAgentMessage(
      ancestorManagerId,
      'worker-ancestor',
      ancestorManagerId,
      'worker report to ancestor manager',
      '2026-01-01T00:00:03.000Z',
    )

    const workerInternalTool = makeToolCall(
      ancestorManagerId,
      'worker-ancestor',
      'worker-internal',
      '2026-01-01T00:00:04.000Z',
    )

    it('shows forked transcript rows in Web view despite ancestor agentId', () => {
      const result = deriveVisibleMessages({
        messages: [forkedTranscript],
        activityMessages: [],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'web',
      })

      expect(result.visibleMessages).toEqual([forkedTranscript])
    })

    it('shows forked manager transcript and manager-context rows in All view', () => {
      const result = deriveVisibleMessages({
        messages: [forkedTranscript],
        activityMessages: [ancestorManagerToolCall, workerCallback, workerInternalTool],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'all',
      })

      expect(result.visibleMessages.map((entry) => entry.type)).toEqual([
        'conversation_message',
        'agent_tool_call',
        'agent_message',
      ])
      expect(result.visibleMessages).not.toContainEqual(workerInternalTool)
    })

    it('renders manager-context agent_message with only manager descriptors present', () => {
      const result = deriveVisibleMessages({
        messages: [],
        activityMessages: [workerCallback],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'all',
      })

      expect(result.visibleMessages).toEqual([workerCallback])
    })
  })

  describe('B. Detailed toggle must not reveal worker internals', () => {
    const workerTool = makeToolCall('visible-messages-dropped', 'worker-1', 'owned-call')

    it('hides owned worker tool calls in detailed manager all view', () => {
      const result = deriveVisibleMessages({
        messages: [],
        activityMessages: [workerTool],
        agents: [currentManager, worker],
        activeAgent: currentManager,
        channelView: 'all',
        detailedAllView: true,
      })

      expect(result.visibleMessages).toEqual([])
    })

    it('keeps default and detailed visibility identical for worker tool rows', () => {
      const defaultResult = deriveVisibleMessages({
        messages: [],
        activityMessages: [workerTool],
        agents: [currentManager, worker],
        activeAgent: currentManager,
        channelView: 'all',
        detailedAllView: false,
      })

      const detailedResult = deriveVisibleMessages({
        messages: [],
        activityMessages: [workerTool],
        agents: [currentManager, worker],
        activeAgent: currentManager,
        channelView: 'all',
        detailedAllView: true,
      })

      expect(detailedResult.visibleMessages).toEqual(defaultResult.visibleMessages)
    })

    it('does not reveal worker internals after worker descriptors are present', () => {
      const result = deriveVisibleMessages({
        messages: [],
        activityMessages: [workerTool],
        agents: [currentManager, worker],
        activeAgent: currentManager,
        channelView: 'all',
        detailedAllView: true,
      })

      expect(result.visibleMessages.some((entry) => entry.type === 'agent_tool_call')).toBe(false)
    })
  })

  describe('C. conversation_log hiding in manager normal views', () => {
    const managerRuntimeLog: ConversationEntry = {
      type: 'conversation_log',
      agentId: 'visible-messages-dropped',
      timestamp: '2026-01-01T00:00:01.000Z',
      source: 'runtime_log',
      kind: 'message_start',
      role: 'assistant',
      text: 'manager runtime log',
    }

    it('hides conversation_log in manager Web view', () => {
      const result = deriveVisibleMessages({
        messages: [managerRuntimeLog],
        activityMessages: [],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'web',
      })

      expect(result.visibleMessages).toEqual([])
    })

    it('hides conversation_log in manager All view', () => {
      const result = deriveVisibleMessages({
        messages: [],
        activityMessages: [managerRuntimeLog],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'all',
      })

      expect(result.visibleMessages).toEqual([])
    })

    it('hides conversation_log in manager Detailed All view', () => {
      const result = deriveVisibleMessages({
        messages: [],
        activityMessages: [managerRuntimeLog],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'all',
        detailedAllView: true,
      })

      expect(result.visibleMessages).toEqual([])
    })
  })
})
