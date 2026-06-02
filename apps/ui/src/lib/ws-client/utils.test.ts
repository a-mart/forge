import { describe, expect, it } from 'vitest'
import { resolveModelCacheObservationsForState, splitConversationHistory } from './utils'

describe('resolveModelCacheObservationsForState', () => {
  it('returns empty observations while visualization is disabled', () => {
    expect(
      resolveModelCacheObservationsForState(
        [
          {
            type: 'model_cache_observation',
            agentId: 'manager',
            id: 'cache-1',
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
        ],
        false,
      ),
    ).toEqual([])
  })
})

describe('splitConversationHistory', () => {
  it('routes model_cache_observation into the hidden observation bucket', () => {
    const result = splitConversationHistory([
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input',
      },
      {
        type: 'model_cache_observation',
        agentId: 'manager',
        id: 'cache-obs-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        runtimeType: 'pi',
        provider: 'openai',
        modelId: 'gpt-5',
        tokens: {
          promptInputTokens: 2000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          uncachedInputTokens: 2000,
          outputTokens: 10,
          totalTokens: 2010,
          normalization: 'raw_input_tokens_total',
        },
        classification: {
          version: 1,
          status: 'miss',
          cachedRatio: 0,
          thresholdTokens: 1024,
          hitRatioThreshold: 0.8,
        },
      },
      {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: '2026-01-01T00:00:02.000Z',
        source: 'agent_to_agent',
        toAgentId: 'manager',
        text: 'activity',
      },
    ])

    expect(result.messages.map((entry) => entry.type)).toEqual(['conversation_message'])
    expect(result.activityMessages.map((entry) => entry.type)).toEqual(['agent_message'])
    expect(result.modelCacheObservations).toHaveLength(1)
    expect(result.modelCacheObservations[0]?.id).toBe('cache-obs-1')
  })
})
