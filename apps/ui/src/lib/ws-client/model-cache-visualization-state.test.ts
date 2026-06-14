import { describe, expect, it } from 'vitest'
import type { ModelCacheObservationEntry } from '../ws-state'
import {
  applyLoadedModelCacheVisualizationSetting,
  routeModelCacheObservationsForState,
} from './model-cache-visualization-state'

function observation(id: string): ModelCacheObservationEntry {
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

describe('model-cache-visualization-state', () => {
  it('buffers bootstrap observations until setting is loaded, then promotes on enable', () => {
    const pending = routeModelCacheObservationsForState({
      incoming: [observation('bootstrap-1')],
      enabled: false,
      settingLoaded: false,
      currentObservations: [],
      pendingObservations: [],
      mode: 'replace',
    })

    expect(pending.modelCacheObservations).toEqual([])
    expect(pending.pendingModelCacheObservations).toHaveLength(1)

    const applied = applyLoadedModelCacheVisualizationSetting({
      enabled: true,
      currentObservations: [],
      pendingObservations: pending.pendingModelCacheObservations,
    })

    expect(applied.modelCacheObservations.map((entry) => entry.id)).toEqual(['bootstrap-1'])
    expect(applied.pendingModelCacheObservations).toEqual([])
  })

  it('clears active and pending observations when fetched setting is false', () => {
    const applied = applyLoadedModelCacheVisualizationSetting({
      enabled: false,
      currentObservations: [observation('stale-active')],
      pendingObservations: [observation('stale-pending')],
    })

    expect(applied.modelCacheVisualizationEnabled).toBe(false)
    expect(applied.modelCacheObservations).toEqual([])
    expect(applied.pendingModelCacheObservations).toEqual([])
  })
})
