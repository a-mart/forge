import { describe, expect, it } from 'vitest'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import { deriveVisibleMessages } from './use-visible-messages'

/**
 * Phase 0 characterization tests for Full Session Audit / normal All replay.
 * These assert Phase 1 target semantics. Skipped until QF-1/QF-2 land.
 * Unskip the whole describe in Phase 1 when the visibility classifier changes.
 */
describe('audit view replay characterization (Phase 0 → Phase 1)', () => {
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

    it('shows forked web/cli transcript rows in Web view despite ancestor agentId', () => {
      const result = deriveVisibleMessages({
        messages: [forkedTranscript],
        activityMessages: [],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'web',
      })

      expect(result.visibleMessages).toEqual([forkedTranscript])
    })

    it('hides non-web ancestor transcript rows in Web view', () => {
      const telegramTranscript: ConversationEntry = {
        type: 'conversation_message',
        agentId: ancestorManagerId,
        role: 'assistant',
        text: 'telegram-only ancestor turn',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'speak_to_user',
        sourceContext: { channel: 'telegram' },
      }

      const result = deriveVisibleMessages({
        messages: [forkedTranscript, telegramTranscript],
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

    it('renders manager-context agent_message when forked transcript establishes alias', () => {
      const result = deriveVisibleMessages({
        messages: [forkedTranscript],
        activityMessages: [workerCallback],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'all',
      })

      expect(result.visibleMessages).toEqual([forkedTranscript, workerCallback])
    })

    it('hides descriptorless foreign worker callbacks without alias evidence', () => {
      const foreignCallback = makeAgentMessage(
        'foreign-manager',
        'worker-foreign',
        'foreign-manager',
        'foreign worker report',
      )

      const result = deriveVisibleMessages({
        messages: [],
        activityMessages: [foreignCallback],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'all',
      })

      expect(result.visibleMessages).toEqual([])
    })
  })

  describe('D. alias evidence required for non-user-visible transcript rows', () => {
    it('hides foreign choice_request rows without alias evidence in All view', () => {
      const foreignChoice: ConversationEntry = {
        type: 'choice_request',
        agentId: 'foreign-manager',
        choiceId: 'foreign-choice',
        questions: [],
        status: 'pending',
        timestamp: '2026-01-01T00:00:01.000Z',
      }

      const result = deriveVisibleMessages({
        messages: [foreignChoice],
        activityMessages: [],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'all',
      })

      expect(result.visibleMessages).toEqual([])
    })

    it('shows choice_request rows when manager alias evidence exists', () => {
      const forkedTranscript: ConversationEntry = {
        type: 'conversation_message',
        agentId: ancestorManagerId,
        role: 'user',
        text: 'forked user turn',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input',
      }

      const ancestorChoice: ConversationEntry = {
        type: 'choice_request',
        agentId: ancestorManagerId,
        choiceId: 'ancestor-choice',
        questions: [],
        status: 'pending',
        timestamp: '2026-01-01T00:00:01.000Z',
      }

      const result = deriveVisibleMessages({
        messages: [forkedTranscript, ancestorChoice],
        activityMessages: [],
        agents: [currentManager],
        activeAgent: currentManager,
        channelView: 'all',
      })

      expect(result.visibleMessages).toEqual([forkedTranscript, ancestorChoice])
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
