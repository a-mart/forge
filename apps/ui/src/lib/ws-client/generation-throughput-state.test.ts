import { describe, expect, it } from 'vitest'
import type { GenerationThroughputLiveMeasurement } from '@forge/protocol'
import { createInitialManagerWsState } from '../ws-state'
import {
  MAX_GENERATION_THROUGHPUT_TOMBSTONES,
  clearGenerationThroughputState,
  reduceGenerationThroughputEvent,
  reduceGenerationThroughputSnapshot,
  removeGenerationThroughputTombstone,
} from './generation-throughput-state'

function measurement(
  overrides: Partial<GenerationThroughputLiveMeasurement> = {},
): GenerationThroughputLiveMeasurement {
  return {
    measurementId: 'call-1',
    sequence: 1,
    phase: 'generating',
    profileId: 'profile-1',
    sessionId: 'manager-1',
    agentId: 'manager-1',
    managerId: 'manager-1',
    role: 'manager',
    provider: 'openai-codex',
    modelId: 'gpt-5.5',
    sampledAt: '2026-07-31T10:00:00.000Z',
    firstOutputAt: '2026-07-31T09:59:59.000Z',
    timeToFirstOutputMs: 1_000,
    elapsedGenerationMs: 1_000,
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
      boundarySource: 'content_delta_to_stream_end',
      reasoningBoundaryCoverage: 'not_reported',
    },
    ...overrides,
  }
}

function state() {
  return createInitialManagerWsState('manager-1')
}

const legacySummary = {
  sessionAgentId: 'manager-1',
  window: 'last_20_terminal_generations' as const,
  measuredGenerationCount: 1,
  weightedTokensPerSecond: 40,
  samples: [{ completedAt: '2026-07-31T10:00:03.000Z', role: 'manager' as const, tokensPerSecond: 40 }],
}

describe('generation throughput WS reducer', () => {
  it('hydrates an active lifecycle from reconnect without retaining estimates or session-summary presentation state', () => {
    const initial = state()
    const result = reduceGenerationThroughputSnapshot(initial, {
      type: 'generation_throughput_snapshot',
      sessionAgentId: 'manager-1',
      measurements: [measurement()],
      // Kept on the wire for compatibility; the stable header does not consume it.
      sessionSummary: legacySummary,
    })

    expect(result.accepted).toBe(true)
    expect(result.patch.generationThroughputByAgentId?.['manager-1']?.measurementId).toBe('call-1')
    expect(result.patch).not.toHaveProperty('generationRateSamplesByAgentId')
    expect(result.patch).not.toHaveProperty('generationThroughputSessionSummary')
    expect(initial.messages).toEqual([])
    expect(initial.activityMessages).toEqual([])
  })

  it('ignores duplicate/out-of-order sequence frames and accepts a newer lifecycle call', () => {
    const initial = {
      ...state(),
      generationThroughputByAgentId: { 'manager-1': measurement({ sequence: 3 }) },
      generationThroughputSequenceByMeasurementId: { 'call-1': 3 },
    }

    expect(reduceGenerationThroughputEvent(initial, {
      type: 'generation_throughput',
      measurement: measurement({ sequence: 2 }),
    }).accepted).toBe(false)

    const replacement = measurement({
      measurementId: 'call-2',
      sequence: 1,
      sampledAt: '2026-07-31T10:00:02.000Z',
    })
    const result = reduceGenerationThroughputEvent(initial, {
      type: 'generation_throughput',
      measurement: replacement,
    })
    expect(result.accepted).toBe(true)
    expect(result.patch.generationThroughputByAgentId?.['manager-1']).toEqual(replacement)
  })

  it('retains only an exact provider-final anchor through terminal cleanup and reconnect state clearing', () => {
    const initial = state()
    const terminal = measurement({
      sequence: 2,
      phase: 'completed',
      sampledAt: '2026-07-31T10:00:03.000Z',
      outputTokens: 100,
      generationAverageTokensPerSecond: 50,
      valueKind: 'provider_final',
      quality: {
        ...measurement().quality,
        tokenSource: 'provider_final',
      },
    })
    const terminalResult = reduceGenerationThroughputEvent(initial, {
      type: 'generation_throughput',
      measurement: terminal,
      sessionSummary: legacySummary,
    })
    const settled = { ...initial, ...terminalResult.patch }
    expect(settled.generationThroughputLatestFinalByAgentId['manager-1']).toEqual(terminal)

    const cleanup = removeGenerationThroughputTombstone(settled, terminalResult.terminal!)
    const cleaned = { ...settled, ...cleanup }
    expect(cleaned.generationThroughputByAgentId).toEqual({})
    expect(cleaned.generationThroughputLatestFinalByAgentId['manager-1']).toEqual(terminal)
    expect({ ...cleaned, ...clearGenerationThroughputState() }.generationThroughputLatestFinalByAgentId['manager-1']).toEqual(terminal)

    const unmeasurable = reduceGenerationThroughputEvent(cleaned, {
      type: 'generation_throughput',
      measurement: measurement({ measurementId: 'short-call', sequence: 1, phase: 'completed' }),
    })
    expect(unmeasurable.patch.generationThroughputLatestFinalByAgentId).toEqual(terminalResult.patch.generationThroughputLatestFinalByAgentId)
  })

  it('bounds independent tombstones while replacement sequence keys cannot leak', () => {
    let current = state()
    for (let index = 1; index <= MAX_GENERATION_THROUGHPUT_TOMBSTONES + 3; index += 1) {
      const result = reduceGenerationThroughputEvent(current, {
        type: 'generation_throughput',
        measurement: measurement({
          measurementId: `call-${index}`,
          sampledAt: new Date(Date.UTC(2026, 6, 31, 10, 0, index)).toISOString(),
        }),
      })
      current = { ...current, ...result.patch }
    }

    expect(Object.keys(current.generationThroughputSequenceByMeasurementId)).toEqual([
      `call-${MAX_GENERATION_THROUGHPUT_TOMBSTONES + 3}`,
    ])
    expect(current.generationThroughputTombstoneOrder).toHaveLength(MAX_GENERATION_THROUGHPUT_TOMBSTONES)
    expect(current.generationThroughputTombstonesByMeasurementId['call-1']).toBeUndefined()
    expect(current.generationThroughputTombstonesByMeasurementId['call-2']).toBeUndefined()
    expect(current.generationThroughputTombstonesByMeasurementId['call-3']).toBe(1)
  })
})
