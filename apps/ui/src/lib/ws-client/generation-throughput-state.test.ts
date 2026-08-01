import { describe, expect, it } from 'vitest'
import type { GenerationThroughputLiveMeasurement } from '@forge/protocol'
import { createInitialManagerWsState } from '../ws-state'
import {
  MAX_GENERATION_RATE_SAMPLES,
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
    elapsedGenerationMs: 1_000,
    outputTokens: 20,
    instantaneousTokensPerSecond: 20,
    generationAverageTokensPerSecond: 20,
    valueKind: 'estimated',
    quality: {
      tokenSource: 'estimated_local',
      boundarySource: 'content_delta_to_stream_end',
      reasoningBoundaryCoverage: 'not_reported',
    },
    ...overrides,
  }
}

function state() {
  return createInitialManagerWsState('manager-1')
}

const summary = {
  sessionAgentId: 'manager-1',
  window: 'last_20_terminal_generations' as const,
  measuredGenerationCount: 1,
  weightedTokensPerSecond: 40,
  samples: [{
    completedAt: '2026-07-31T10:00:03.000Z',
    role: 'manager' as const,
    tokensPerSecond: 40,
  }],
}

describe('generation throughput WS reducer', () => {
  it('hydrates an active measurement from the reconnect snapshot without transcript changes', () => {
    const initial = state()
    const result = reduceGenerationThroughputSnapshot(initial, {
      type: 'generation_throughput_snapshot',
      sessionAgentId: 'manager-1',
      measurements: [measurement()],
      sessionSummary: summary,
    })

    expect(result.accepted).toBe(true)
    expect(result.patch.generationThroughputByAgentId?.['manager-1']?.measurementId).toBe('call-1')
    expect(result.patch.generationRateSamplesByAgentId?.['manager-1']).toEqual([
      { sampledAt: '2026-07-31T10:00:00.000Z', tokensPerSecond: 20 },
    ])
    expect(result.patch.generationThroughputSessionSummary).toEqual(summary)
    expect(initial.messages).toEqual([])
    expect(initial.activityMessages).toEqual([])
  })

  it('ignores duplicate/out-of-order sequence frames, while a newer call replaces stale agent samples', () => {
    const initial = {
      ...state(),
      generationThroughputByAgentId: { 'manager-1': measurement({ sequence: 3 }) },
      generationRateSamplesByAgentId: { 'manager-1': [{ sampledAt: '2026-07-31T10:00:00.000Z', tokensPerSecond: 20 }] },
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
      instantaneousTokensPerSecond: 30,
    })
    const result = reduceGenerationThroughputEvent(initial, {
      type: 'generation_throughput',
      measurement: replacement,
    })
    expect(result.accepted).toBe(true)
    expect(result.patch.generationThroughputByAgentId?.['manager-1']).toEqual(replacement)
    expect(result.patch.generationRateSamplesByAgentId?.['manager-1']).toEqual([
      { sampledAt: replacement.sampledAt, tokensPerSecond: 30 },
    ])
  })

  it('caps active rate samples and keeps the server-provided weighted session summary after terminal cleanup', () => {
    let current = state()
    for (let index = 1; index <= 25; index += 1) {
      const result = reduceGenerationThroughputEvent(current, {
        type: 'generation_throughput',
        measurement: measurement({
          sequence: index,
          sampledAt: new Date(Date.UTC(2026, 6, 31, 10, 0, index)).toISOString(),
          instantaneousTokensPerSecond: index,
        }),
      })
      current = { ...current, ...result.patch }
    }
    expect(current.generationRateSamplesByAgentId['manager-1']).toHaveLength(MAX_GENERATION_RATE_SAMPLES)

    const terminal = measurement({
      sequence: 26,
      phase: 'completed',
      sampledAt: '2026-07-31T10:00:30.000Z',
      instantaneousTokensPerSecond: null,
      generationAverageTokensPerSecond: 50,
      valueKind: 'provider_final',
      outputTokens: 100,
    })
    const terminalResult = reduceGenerationThroughputEvent(current, {
      type: 'generation_throughput',
      measurement: terminal,
      sessionSummary: summary,
    })
    const settled = { ...current, ...terminalResult.patch }
    expect(terminalResult.terminal).toEqual({ agentId: 'manager-1', measurementId: 'call-1', sequence: 26 })

    const cleanup = removeGenerationThroughputTombstone(settled, terminalResult.terminal!)
    expect(cleanup.generationThroughputByAgentId).toEqual({})
    expect(cleanup.generationRateSamplesByAgentId).toEqual({})
    expect(settled.generationThroughputSessionSummary).toEqual(summary)
  })
})
