/** @vitest-environment jsdom */

import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GenerationThroughputLiveMeasurement } from '@forge/protocol'
import { ThroughputPulse } from './ThroughputPulse'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

function measurement(overrides: Partial<GenerationThroughputLiveMeasurement> = {}): GenerationThroughputLiveMeasurement {
  return {
    measurementId: 'call-1',
    sequence: 1,
    phase: 'starting',
    profileId: 'profile-1',
    sessionId: 'manager-1',
    agentId: 'manager-1',
    managerId: 'manager-1',
    role: 'manager',
    provider: 'openai-codex',
    modelId: 'gpt-5.5',
    sampledAt: '2026-07-31T10:00:00.000Z',
    firstOutputAt: null,
    elapsedGenerationMs: null,
    outputTokens: null,
    instantaneousTokensPerSecond: null,
    generationAverageTokensPerSecond: null,
    valueKind: 'unavailable',
    quality: {
      measurementScope: 'agent_model_call',
      agentRetryAttempt: 0,
      providerAttemptScope: 'unavailable',
      observedProviderAttemptCount: null,
      tokenSource: 'unavailable',
      boundarySource: 'unavailable',
      reasoningBoundaryCoverage: 'not_reported',
    },
    ...overrides,
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
})

function render(props: Partial<ComponentProps<typeof ThroughputPulse>> = {}) {
  act(() => {
    root.render(createElement(ThroughputPulse, props))
  })
}

describe('ThroughputPulse', () => {
  it('uses Measuring instead of a zero rate until a qualified estimate arrives', () => {
    render({ measurement: measurement() })
    expect(container.textContent).toContain('Measuring…')
    expect(container.textContent).not.toContain('0 tok/s')
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Measuring generation throughput.')
    expect(container.innerHTML).toContain('motion-reduce:animate-none')
  })

  it('keeps estimated, final, and session labels distinct and exposes static reduced-motion-safe styling', () => {
    render({
      measurement: measurement({
        phase: 'generating',
        sequence: 2,
        firstOutputAt: '2026-07-31T10:00:00.000Z',
        elapsedGenerationMs: 1_000,
        outputTokens: 24,
        instantaneousTokensPerSecond: 24,
        generationAverageTokensPerSecond: 20,
        valueKind: 'estimated',
        quality: {
          measurementScope: 'agent_model_call',
          agentRetryAttempt: 0,
          providerAttemptScope: 'unavailable',
          observedProviderAttemptCount: null,
          tokenSource: 'estimated_local',
          boundarySource: 'content_delta_to_stream_end',
          reasoningBoundaryCoverage: 'not_reported',
        },
      }),
      samples: [{ sampledAt: '2026-07-31T10:00:01.000Z', tokensPerSecond: 24 }],
      sessionSummary: {
        sessionAgentId: 'manager-1',
        window: 'last_20_terminal_generations',
        measuredGenerationCount: 2,
        weightedTokensPerSecond: 31,
        samples: [],
      },
    })
    expect(container.textContent).toContain('≈24 tok/s')
    const trigger = container.querySelector('[data-testid="throughput-pulse"]') as HTMLButtonElement
    act(() => trigger.click())
    expect(document.body.textContent).toContain('Now (estimated)')
    expect(document.body.textContent).toContain('This generation (average)')
    expect(document.body.textContent).toContain('Session, last 20 generations')

    render({
      measurement: measurement({
        phase: 'completed',
        sequence: 3,
        outputTokens: 100,
        generationAverageTokensPerSecond: 50,
        valueKind: 'provider_final',
        quality: {
          measurementScope: 'agent_model_call',
          agentRetryAttempt: 0,
          providerAttemptScope: 'unavailable',
          observedProviderAttemptCount: null,
          tokenSource: 'provider_final',
          boundarySource: 'content_delta_to_stream_end',
          reasoningBoundaryCoverage: 'observed',
        },
      }),
    })
    expect(container.textContent).toContain('50 tok/s')
    expect(container.textContent).not.toContain('≈50 tok/s')
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Final generation throughput available.')
  })
})
