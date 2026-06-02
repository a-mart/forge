import { describe, expect, it } from 'vitest'
import { splitConversationHistory } from './utils'

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
