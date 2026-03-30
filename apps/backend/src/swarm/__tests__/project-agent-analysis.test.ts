import { describe, expect, it, vi } from 'vitest'
import {
  analyzeSessionForPromotion,
  extractTranscriptSummary,
  parseRecommendations,
} from '../project-agent-analysis.js'
import type { ConversationEntryEvent } from '../types.js'

function makeAssistantMessage(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    api: 'responses',
    provider: 'openai-codex',
    model: 'gpt-5.4',
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'stop',
  } as any
}

describe('project-agent-analysis', () => {
  it('extractTranscriptSummary keeps only transcript messages, favors the tail, and reports omissions', () => {
    const history: ConversationEntryEvent[] = [
      {
        type: 'conversation_log',
        agentId: 'session-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'runtime_log',
        kind: 'message_start',
        text: 'ignored log',
      },
      {
        type: 'conversation_message',
        agentId: 'session-1',
        role: 'user',
        text: 'First user message',
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'user_input',
      },
      {
        type: 'conversation_message',
        agentId: 'session-1',
        role: 'assistant',
        text: 'Manager reply',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'speak_to_user',
      },
      {
        type: 'conversation_message',
        agentId: 'session-1',
        role: 'user',
        text: 'Incoming coordination',
        timestamp: '2026-01-01T00:00:03.000Z',
        source: 'project_agent_input',
        projectAgentContext: {
          fromAgentId: 'session-2',
          fromDisplayName: 'Release Notes',
        },
      },
    ]

    const summary = extractTranscriptSummary(history, 85)

    expect(summary).toContain('(1 earlier transcript messages omitted)')
    expect(summary).not.toContain('ignored log')
    expect(summary).toContain('Assistant: Manager reply')
    expect(summary).toContain('Project agent (Release Notes): Incoming coordination')
    expect(summary).not.toContain('User: First user message')
  })

  it('parseRecommendations accepts fenced JSON and normalizes whenToUse', () => {
    const parsed = parseRecommendations(
      makeAssistantMessage('```json\n{"whenToUse":"  Use for   release notes  ","systemPrompt":"You are the release notes manager."}\n```'),
    )

    expect(parsed).toEqual({
      whenToUse: 'Use for release notes',
      systemPrompt: 'You are the release notes manager.',
    })
  })

  it('parseRecommendations rejects malformed responses', () => {
    expect(() => parseRecommendations(makeAssistantMessage('not json'))).toThrow(
      'Failed to parse project agent recommendations: no valid JSON object found in response',
    )
  })

  it('analyzeSessionForPromotion builds a one-shot complete call and parses the result', async () => {
    const completeFn = vi.fn(async () =>
      makeAssistantMessage('{"whenToUse":"Use for backend API work","systemPrompt":"You are the backend API manager."}'),
    )

    const result = await analyzeSessionForPromotion({ provider: 'openai-codex', id: 'gpt-5.4' } as any, {
      conversationHistory: [
        {
          type: 'conversation_message',
          agentId: 'session-1',
          role: 'user',
          text: 'Please own the backend API routes.',
          timestamp: '2026-01-01T00:00:00.000Z',
          source: 'user_input',
        },
      ],
      currentSystemPrompt: 'Base manager prompt',
      sessionAgentId: 'session-1',
      sessionLabel: 'Backend API',
      sessionCwd: '/repo',
      apiKey: 'test-key',
      now: () => 123,
      completeFn,
    })

    expect(result).toEqual({
      whenToUse: 'Use for backend API work',
      systemPrompt: 'You are the backend API manager.',
    })
    expect(completeFn).toHaveBeenCalledTimes(1)
    const firstCall = completeFn.mock.calls[0] as any[] | undefined
    expect(firstCall?.[1]).toMatchObject({
      systemPrompt: expect.stringContaining('The generated systemPrompt becomes the BASE TEMPLATE inside buildResolvedManagerPrompt().'),
      messages: [
        expect.objectContaining({
          role: 'user',
          timestamp: 123,
          content: [
            expect.objectContaining({
              text: expect.stringContaining('Session label: Backend API'),
            }),
          ],
        }),
      ],
    })
    expect(firstCall?.[2]).toEqual({ apiKey: 'test-key' })
  })
})
