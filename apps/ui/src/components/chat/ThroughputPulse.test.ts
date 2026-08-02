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
    sampledAt: '2026-07-31T10:00:02.000Z',
    firstOutputAt: null,
    timeToFirstOutputMs: null,
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

function finalMeasurement(overrides: Partial<GenerationThroughputLiveMeasurement> = {}) {
  return measurement({
    phase: 'completed',
    sequence: 3,
    firstOutputAt: '2026-07-31T10:00:00.800Z',
    timeToFirstOutputMs: 800,
    elapsedGenerationMs: 2_000,
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
    ...overrides,
  })
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
  it('keeps a fixed shell with an em dash and restrained reduced-motion-safe activity pulse before any exact result', () => {
    render({ measurement: measurement() })

    const trigger = container.querySelector('[data-testid="throughput-pulse"]') as HTMLButtonElement
    expect(trigger).toBeInstanceOf(HTMLButtonElement)
    expect(trigger.dataset.throughputState).toBe('generating')
    expect(trigger.textContent).toContain('—')
    expect(trigger.textContent).toContain('tok/s')
    expect(trigger.textContent).not.toContain('Measuring')
    expect(trigger.textContent).not.toContain('≈')
    expect(trigger.className).toContain('w-[104px]')
    expect(trigger.className).toContain('sm:w-[116px]')
    expect(container.querySelector('[data-throughput-pulse]')?.className).toContain('motion-reduce:animate-none')
  })

  it('shows exact provider-final details in permanently mounted popover rows', () => {
    render({ measurement: finalMeasurement() })

    const trigger = container.querySelector('[data-testid="throughput-pulse"]') as HTMLButtonElement
    expect(trigger.dataset.throughputState).toBe('final')
    expect(trigger.textContent).toContain('50')
    expect(trigger.textContent).not.toContain('≈')
    act(() => trigger.click())

    expect(document.body.textContent).toContain('Latest final TPS')
    expect(document.body.textContent).toContain('50 tok/s · final')
    expect(document.body.textContent).toContain('TTFT')
    expect(document.body.textContent).toContain('0.8 s')
    expect(document.body.textContent).toContain('Output tokens')
    expect(document.body.textContent).toContain('100')
    expect(document.body.textContent).toContain('Model / provider')
    expect(document.body.textContent).toContain('gpt-5.5 · openai-codex')
  })

  it('holds the latest exact result through tool calls, unmeasurable completions, and a reconnect prop gap', () => {
    const completed = finalMeasurement()
    render({ measurement: completed, latestFinal: completed })

    render({
      measurement: measurement({ measurementId: 'tool-follow-up', sequence: 1 }),
      latestFinal: completed,
    })
    let trigger = container.querySelector('[data-testid="throughput-pulse"]') as HTMLButtonElement
    expect(trigger.dataset.throughputState).toBe('generating')
    expect(trigger.textContent).toContain('50')
    expect(container.querySelector('[data-throughput-value]')?.className).toContain('opacity-55')

    render({
      measurement: measurement({
        measurementId: 'tool-follow-up',
        phase: 'completed',
        sequence: 2,
        valueKind: 'unavailable',
      }),
      latestFinal: completed,
    })
    render({ latestFinal: completed })
    trigger = container.querySelector('[data-testid="throughput-pulse"]') as HTMLButtonElement
    expect(trigger.textContent).toContain('50')
    expect(trigger.textContent).not.toContain('Measuring')
  })

  it('takes a short generation directly to final without rendering an approximate rate', () => {
    render({ measurement: measurement({ phase: 'generating', sequence: 2 }) })
    expect(container.textContent).not.toContain('≈')

    render({ measurement: finalMeasurement({ measurementId: 'short-call', elapsedGenerationMs: 100 }) })
    expect(container.textContent).toContain('50')
    expect(container.textContent).not.toContain('≈')
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Final generation throughput 50 tokens per second.')
  })
})
