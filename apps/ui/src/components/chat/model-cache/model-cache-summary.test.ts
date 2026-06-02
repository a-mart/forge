import { describe, expect, it } from 'vitest'
import type { ModelCacheObservationEntry } from '@/lib/ws-state'
import {
  buildModelCacheHeaderSummary,
  deriveModelCacheRecentDrops,
  formatModelCacheChipLabel,
} from './model-cache-summary'

function observation(
  id: string,
  status: 'hit' | 'partial' | 'miss',
  cachedRatio: number,
  promptInputTokens = 3000,
  cachedInputTokens = Math.round(promptInputTokens * cachedRatio),
): ModelCacheObservationEntry {
  return {
    type: 'model_cache_observation',
    agentId: 'manager-1',
    id,
    timestamp: `2026-06-02T12:00:00.${id}.000Z`,
    runtimeType: 'pi',
    provider: 'openai-codex',
    modelId: 'gpt-5.5',
    tokens: {
      promptInputTokens,
      cachedInputTokens,
      cacheWriteInputTokens: 0,
      uncachedInputTokens: promptInputTokens - cachedInputTokens,
      outputTokens: 120,
      totalTokens: promptInputTokens + 120,
      normalization: 'raw_input_tokens_total',
    },
    classification: {
      version: 1,
      status,
      cachedRatio,
      thresholdTokens: 1024,
      hitRatioThreshold: 0.8,
    },
  }
}

describe('model-cache-summary', () => {
  it('returns null when disabled or no observations are loaded', () => {
    expect(buildModelCacheHeaderSummary({ enabled: false, observations: [observation('a', 'hit', 0.9)] })).toBeNull()
    expect(buildModelCacheHeaderSummary({ enabled: true, observations: [] })).toBeNull()
  })

  it('formats chip labels for hit, partial, and miss', () => {
    expect(formatModelCacheChipLabel(observation('hit', 'hit', 0.91))).toBe('Prompt cache 91%')
    expect(formatModelCacheChipLabel(observation('partial', 'partial', 0.42))).toBe('Prompt cache partial 42%')
    expect(formatModelCacheChipLabel(observation('miss', 'miss', 0))).toBe('Prompt cache miss')
  })

  it('aggregates counts, averages, and token totals from loaded observations', () => {
    const summary = buildModelCacheHeaderSummary({
      enabled: true,
      observations: [
        observation('1', 'hit', 0.9, 3000, 2700),
        observation('2', 'partial', 0.5, 2000, 1000),
        observation('3', 'miss', 0, 1500, 0),
      ],
    })

    expect(summary).toMatchObject({
      observationCount: 3,
      counts: { hit: 1, partial: 1, miss: 1 },
      totalPromptInputTokens: 6500,
      totalCachedInputTokens: 3700,
      latestStatus: 'miss',
      chipLabel: 'Prompt cache miss',
    })
    expect(summary?.averageCachedRatio).toBeCloseTo((0.9 + 0.5 + 0) / 3, 5)
  })

  it('derives recent drops from consecutive loaded observations only', () => {
    const observations = [
      observation('1', 'hit', 0.9),
      observation('2', 'partial', 0.55),
      observation('3', 'miss', 0),
    ]

    const drops = deriveModelCacheRecentDrops(observations)
    expect(drops).toHaveLength(2)
    expect(drops[0]?.observationId).toBe('3')
    expect(drops[1]?.observationId).toBe('2')
    expect(buildModelCacheHeaderSummary({ enabled: true, observations })?.recentDrops).toHaveLength(2)
  })
})
