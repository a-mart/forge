import { describe, expect, it } from 'vitest'
import { deriveMissingPendingChoiceIds, splitConversationHistory } from './utils'
import type { ConversationEntry } from '@forge/protocol'

describe('deriveMissingPendingChoiceIds', () => {
  it('returns legacy ids-only pending choices with no renderable row', () => {
    expect(deriveMissingPendingChoiceIds(new Set(['choice-1']), [], 'manager')).toEqual(['choice-1'])
  })

  it('treats worker-origin session choice rows as renderable for the active manager', () => {
    const choice: ConversationEntry = {
      type: 'choice_request',
      agentId: 'worker-1',
      sessionAgentId: 'manager',
      choiceId: 'choice-1',
      questions: [{ id: 'q1', question: 'Pick one' }],
      status: 'pending',
      timestamp: '2026-06-02T12:00:00.000Z',
    }

    expect(deriveMissingPendingChoiceIds(new Set(['choice-1']), [choice], 'manager')).toEqual([])
  })

  it('ignores non-pending or non-target choice rows', () => {
    const answered: ConversationEntry = {
      type: 'choice_request',
      agentId: 'worker-1',
      sessionAgentId: 'manager',
      choiceId: 'choice-1',
      questions: [{ id: 'q1', question: 'Pick one' }],
      status: 'answered',
      answers: [],
      timestamp: '2026-06-02T12:00:00.000Z',
    }
    const otherTarget: ConversationEntry = {
      ...answered,
      choiceId: 'choice-2',
      status: 'pending',
      sessionAgentId: 'other-manager',
    }

    expect(
      deriveMissingPendingChoiceIds(new Set(['choice-1', 'choice-2']), [answered, otherTarget], 'manager'),
    ).toEqual(['choice-1', 'choice-2'])
  })
})

describe('splitConversationHistory', () => {
  it('routes model_cache_observation into the hidden observation bucket', () => {
    const result = splitConversationHistory([
      {
        type: 'conversation_message',
        agentId: 'manager',
        id: 'msg-1',
        role: 'assistant',
        text: 'hello',
        timestamp: '2026-06-02T12:00:00.000Z',
        source: 'system',
      },
      {
        type: 'model_cache_observation',
        agentId: 'manager',
        id: 'cache-obs-1',
        timestamp: '2026-06-02T12:00:00.000Z',
        runtimeType: 'pi',
        provider: 'openai',
        modelId: 'gpt-5',
        tokens: {
          promptInputTokens: 2000,
          cachedInputTokens: 1600,
          cacheWriteInputTokens: 0,
          uncachedInputTokens: 400,
          outputTokens: 120,
          totalTokens: 2120,
          normalization: 'raw_input_tokens_total',
        },
        classification: {
          version: 1,
          status: 'hit',
          cachedRatio: 0.8,
          thresholdTokens: 1024,
          hitRatioThreshold: 0.8,
        },
      },
    ])

    expect(result.messages).toHaveLength(1)
    expect(result.modelCacheObservations).toHaveLength(1)
    expect(result.modelCacheObservations[0]?.id).toBe('cache-obs-1')
  })
})
