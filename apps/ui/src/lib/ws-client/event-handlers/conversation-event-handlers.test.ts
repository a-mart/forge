import { describe, expect, it } from 'vitest'
import type { ModelCacheObservationEntry } from '@/lib/ws-state'
import { createInitialManagerWsState } from '@/lib/ws-state'
import { handleConversationEvent } from './conversation-event-handlers'
import type { ManagerWsState } from '@/lib/ws-state'

function makeCacheObservation(id: string): ModelCacheObservationEntry {
  return {
    type: 'model_cache_observation',
    agentId: 'manager',
    id,
    timestamp: '2026-06-02T12:00:00.000Z',
    runtimeType: 'pi',
    provider: 'openai-codex',
    modelId: 'gpt-5.5',
    tokens: {
      promptInputTokens: 3000,
      cachedInputTokens: 2500,
      cacheWriteInputTokens: 0,
      uncachedInputTokens: 500,
      outputTokens: 120,
      totalTokens: 3120,
      normalization: 'raw_input_tokens_total',
    },
    classification: {
      version: 1,
      status: 'hit',
      cachedRatio: 0.8333333333333334,
      thresholdTokens: 1024,
      hitRatioThreshold: 0.8,
    },
  }
}

function runHandler(
  state: ManagerWsState,
  event: Parameters<typeof handleConversationEvent>[0],
): ManagerWsState {
  let next = state
  handleConversationEvent(event, {
    state,
    updateState: (patch) => {
      next = { ...next, ...patch }
    },
  })
  return next
}

describe('handleConversationEvent model cache observations', () => {
  it('ignores live observations while visualization is disabled', () => {
    const state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: false,
    }

    const next = runHandler(state, makeCacheObservation('cache-live'))

    expect(next.modelCacheObservations).toEqual([])
  })

  it('does not populate observations from bootstrap history while disabled', () => {
    const state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: false,
    }

    const next = runHandler(state, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [
        {
          type: 'conversation_message',
          agentId: 'manager',
          id: 'msg-1',
          role: 'assistant',
          text: 'hello',
          timestamp: '2026-06-02T12:00:00.000Z',
          source: 'system',
        },
        makeCacheObservation('cache-bootstrap'),
      ],
    })

    expect(next.modelCacheObservations).toEqual([])
  })

  it('collects live and bootstrap observations only while enabled', () => {
    let state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: true,
    }

    state = runHandler(state, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [makeCacheObservation('cache-bootstrap')],
    })
    expect(state.modelCacheObservations).toHaveLength(1)

    state = runHandler(state, makeCacheObservation('cache-live'))
    expect(state.modelCacheObservations.map((observation) => observation.id)).toEqual([
      'cache-bootstrap',
      'cache-live',
    ])
  })

  it('does not reveal observations that arrived while disabled after re-enable', () => {
    let state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: false,
    }

    state = runHandler(state, makeCacheObservation('stale-while-disabled'))
    expect(state.modelCacheObservations).toEqual([])

    state = {
      ...state,
      modelCacheVisualizationEnabled: true,
    }

    expect(state.modelCacheObservations).toEqual([])

    state = runHandler(state, makeCacheObservation('fresh-after-enable'))
    expect(state.modelCacheObservations.map((observation) => observation.id)).toEqual([
      'fresh-after-enable',
    ])
  })
})
