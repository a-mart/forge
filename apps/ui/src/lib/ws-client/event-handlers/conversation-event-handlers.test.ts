import { describe, expect, it } from 'vitest'
import type { ModelCacheObservationEntry } from '@/lib/ws-state'
import { createInitialManagerWsState } from '@/lib/ws-state'
import { applyLoadedModelCacheVisualizationSetting } from '../model-cache-visualization-state'
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
  it('buffers bootstrap observations until setting loads, then promotes them when enabled', () => {
    let state = createInitialManagerWsState('manager')

    state = runHandler(state, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [makeCacheObservation('cache-bootstrap')],
    })

    expect(state.modelCacheVisualizationSettingLoaded).toBe(false)
    expect(state.modelCacheObservations).toEqual([])
    expect(state.pendingModelCacheObservations.map((entry) => entry.id)).toEqual(['cache-bootstrap'])

    state = {
      ...state,
      ...applyLoadedModelCacheVisualizationSetting({
        enabled: true,
        currentObservations: state.modelCacheObservations,
        pendingObservations: state.pendingModelCacheObservations,
      }),
    }

    expect(state.modelCacheObservations.map((entry) => entry.id)).toEqual(['cache-bootstrap'])
    expect(state.pendingModelCacheObservations).toEqual([])
  })

  it('ignores live observations while visualization is disabled after setting loads', () => {
    const state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: false,
      modelCacheVisualizationSettingLoaded: true,
    }

    const next = runHandler(state, makeCacheObservation('cache-live'))

    expect(next.modelCacheObservations).toEqual([])
    expect(next.pendingModelCacheObservations).toEqual([])
  })

  it('does not reveal observations that arrived while disabled after re-enable', () => {
    let state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: false,
      modelCacheVisualizationSettingLoaded: true,
    }

    state = runHandler(state, makeCacheObservation('stale-while-disabled'))
    expect(state.modelCacheObservations).toEqual([])

    state = {
      ...state,
      ...applyLoadedModelCacheVisualizationSetting({
        enabled: true,
        currentObservations: state.modelCacheObservations,
        pendingObservations: state.pendingModelCacheObservations,
      }),
    }

    expect(state.modelCacheObservations).toEqual([])

    state = runHandler(state, makeCacheObservation('fresh-after-enable'))
    expect(state.modelCacheObservations.map((entry) => entry.id)).toEqual(['fresh-after-enable'])
  })

  it('clears stale observations when fetched setting resolves to false', () => {
    let state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: true,
      modelCacheVisualizationSettingLoaded: true,
      modelCacheObservations: [makeCacheObservation('stale-active')],
      pendingModelCacheObservations: [makeCacheObservation('stale-pending')],
    }

    state = {
      ...state,
      ...applyLoadedModelCacheVisualizationSetting({
        enabled: false,
        currentObservations: state.modelCacheObservations,
        pendingObservations: state.pendingModelCacheObservations,
      }),
    }

    expect(state.modelCacheObservations).toEqual([])
    expect(state.pendingModelCacheObservations).toEqual([])
  })
})
