/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCacheObservationEntry } from '@/lib/ws-state'
import { buildModelCacheHeaderSummary } from './model-cache-summary'
import { ModelCacheHeaderIndicator } from './ModelCacheHeaderIndicator'

let root: Root
let container: HTMLDivElement

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function observation(status: 'hit' | 'partial' | 'miss', cachedRatio: number): ModelCacheObservationEntry {
  return {
    type: 'model_cache_observation',
    agentId: 'manager-1',
    id: 'obs-1',
    timestamp: '2026-06-02T12:00:00.000Z',
    runtimeType: 'pi',
    provider: 'openai-codex',
    modelId: 'gpt-5.5',
    tokens: {
      promptInputTokens: 3000,
      cachedInputTokens: Math.round(3000 * cachedRatio),
      cacheWriteInputTokens: 0,
      uncachedInputTokens: 3000 - Math.round(3000 * cachedRatio),
      outputTokens: 120,
      totalTokens: 3120,
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

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('ModelCacheHeaderIndicator', () => {
  it('renders nothing when summary is unavailable', () => {
    expect(buildModelCacheHeaderSummary({ enabled: false, observations: [observation('hit', 0.9)] })).toBeNull()
  })

  it('renders hit, partial, and miss chip labels', () => {
    for (const [status, label] of [
      ['hit', 'Prompt cache 91%'],
      ['partial', 'Prompt cache partial 42%'],
      ['miss', 'Prompt cache miss'],
    ] as const) {
      const ratio = status === 'hit' ? 0.91 : status === 'partial' ? 0.42 : 0
      const summary = buildModelCacheHeaderSummary({
        enabled: true,
        observations: [observation(status, ratio)],
      })
      expect(summary?.chipLabel).toBe(label)

      act(() => {
        root.render(createElement(ModelCacheHeaderIndicator, { summary: summary! }))
      })

      expect(container.textContent).toContain(label)
      act(() => root.unmount())
      root = createRoot(container)
    }
  })

  it('opens popover with provider-reported disclaimer', () => {
    const summary = buildModelCacheHeaderSummary({
      enabled: true,
      observations: [observation('hit', 0.91)],
    })

    act(() => {
      root.render(createElement(ModelCacheHeaderIndicator, { summary: summary! }))
    })

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open prompt cache details"]')
    act(() => trigger?.click())

    expect(document.body.textContent).toContain('Cached token counts are reported by the provider')
    expect(document.body.textContent).toContain('OpenAI does not report specific miss or drop causes')
  })
})
