import { describe, expect, it } from 'vitest'
import type { AgentDescriptor, GenerationThroughputLiveMeasurement } from '@forge/protocol'
import { createInitialManagerWsState } from '../ws-state'
import {
  MAX_GENERATION_THROUGHPUT_TOMBSTONES,
  clearGenerationThroughputState,
  reduceGenerationThroughputEvent,
  reduceGenerationThroughputSnapshot,
  removeGenerationThroughputTombstone,
} from './generation-throughput-state'
import { reduceAgentsSnapshot, reduceSessionWorkersSnapshot } from './snapshot-reducers'

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

function agent(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'manager-1',
    managerId: 'manager-1',
    displayName: 'Manager',
    role: 'manager',
    status: 'idle',
    createdAt: '2026-07-31T10:00:00.000Z',
    updatedAt: '2026-07-31T10:00:00.000Z',
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    sessionFile: '/tmp/manager-1.jsonl',
    ...overrides,
  }
}

function state(agents: AgentDescriptor[] = [agent()]) {
  return {
    ...createInitialManagerWsState('manager-1'),
    agents,
    workerMetadataSessionIds: new Set(
      agents.filter((candidate) => candidate.role === 'worker').map((candidate) => candidate.managerId),
    ),
  }
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

  it('rejects Cursor SDK manager telemetry and does not hydrate its retained anchors', () => {
    const initial = state([agent({ model: { provider: 'cursor-sdk', modelId: 'composer-2.5', thinkingLevel: 'high' } })])
    const event = { type: 'generation_throughput' as const, measurement: measurement() }

    expect(reduceGenerationThroughputEvent(initial, event).accepted).toBe(false)
    const snapshot = reduceGenerationThroughputSnapshot(initial, {
      type: 'generation_throughput_snapshot',
      sessionAgentId: 'manager-1',
      measurements: [measurement()],
      sessionSummary: legacySummary,
    })
    expect(snapshot.accepted).toBe(true)
    expect(snapshot.patch.generationThroughputByAgentId).toEqual({})
  })

  it('rejects Cursor SDK worker telemetry while retaining eligible Pi workers in the same manager session', () => {
    const worker = agent({
      agentId: 'worker-1',
      role: 'worker',
      managerId: 'manager-1',
      model: { provider: 'cursor-sdk', modelId: 'composer-2.5', thinkingLevel: 'high' },
      sessionFile: '/tmp/worker-1.jsonl',
    })
    const initial = state([agent(), worker])
    const cursorWorkerMeasurement = measurement({ agentId: worker.agentId, role: 'worker' })

    expect(reduceGenerationThroughputEvent(initial, {
      type: 'generation_throughput', measurement: cursorWorkerMeasurement,
    }).accepted).toBe(false)
    const snapshot = reduceGenerationThroughputSnapshot(initial, {
      type: 'generation_throughput_snapshot',
      sessionAgentId: 'manager-1',
      measurements: [measurement(), cursorWorkerMeasurement],
      sessionSummary: legacySummary,
    })
    expect(snapshot.patch.generationThroughputByAgentId).toEqual({ 'manager-1': measurement() })
  })

  it('clears and tombstones retained manager anchors on Pi-to-Cursor, then accepts a fresh Pi lifecycle', () => {
    const initial = state()
    const final = measurement({
      measurementId: 'pi-call', sequence: 2, phase: 'completed', outputTokens: 100,
      generationAverageTokensPerSecond: 50, valueKind: 'provider_final',
      quality: { ...measurement().quality, tokenSource: 'provider_final' },
    })
    const piState = { ...initial, ...reduceGenerationThroughputEvent(initial, {
      type: 'generation_throughput', measurement: final,
    }).patch }

    const cursorTransition = reduceAgentsSnapshot({
      state: piState,
      desiredAgentId: 'manager-1',
      explicitAgentSelectionAgentId: null,
      agents: [agent({ model: { provider: 'cursor-sdk', modelId: 'composer-2.5', thinkingLevel: 'high' } })],
    })
    const cursorState = { ...piState, ...cursorTransition.patch }
    expect(cursorState.generationThroughputByAgentId).toEqual({})
    expect(cursorState.generationThroughputLatestFinalByAgentId).toEqual({})
    expect(cursorState.generationThroughputTombstonesByMeasurementId['pi-call']).toBe(2)
    expect(reduceGenerationThroughputEvent(cursorState, {
      type: 'generation_throughput', measurement: final,
    }).accepted).toBe(false)

    const piTransition = reduceAgentsSnapshot({
      state: cursorState,
      desiredAgentId: 'manager-1',
      explicitAgentSelectionAgentId: null,
      agents: [agent()],
    })
    const freshPiState = { ...cursorState, ...piTransition.patch }
    const fresh = measurement({ measurementId: 'fresh-pi-call', sequence: 1 })
    const freshResult = reduceGenerationThroughputEvent(freshPiState, {
      type: 'generation_throughput', measurement: fresh,
    })
    expect(freshResult.accepted).toBe(true)
    expect(freshResult.patch.generationThroughputByAgentId?.['manager-1']).toEqual(fresh)
  })

  it('clears and tombstones retained worker anchors on Pi-to-Cursor, then accepts a fresh Pi lifecycle', () => {
    const piWorker = agent({
      agentId: 'worker-1',
      role: 'worker',
      managerId: 'manager-1',
      sessionFile: '/tmp/worker-1.jsonl',
    })
    const initial = state([agent(), piWorker])
    const final = measurement({
      measurementId: 'pi-worker-call', sequence: 2, agentId: piWorker.agentId, role: 'worker',
      phase: 'completed', outputTokens: 100, generationAverageTokensPerSecond: 50,
      valueKind: 'provider_final', quality: { ...measurement().quality, tokenSource: 'provider_final' },
    })
    const piState = { ...initial, ...reduceGenerationThroughputEvent(initial, {
      type: 'generation_throughput', measurement: final,
    }).patch }

    const cursorWorker = { ...piWorker, model: { provider: 'cursor-sdk', modelId: 'composer-2.5', thinkingLevel: 'high' } }
    const cursorTransition = reduceSessionWorkersSnapshot({
      state: piState, sessionAgentId: 'manager-1', workers: [cursorWorker],
    })
    const cursorState = { ...piState, ...cursorTransition.patch }
    expect(cursorState.generationThroughputLatestFinalByAgentId).toEqual({})
    expect(cursorState.generationThroughputTombstonesByMeasurementId['pi-worker-call']).toBe(2)
    expect(reduceGenerationThroughputEvent(cursorState, {
      type: 'generation_throughput', measurement: final,
    }).accepted).toBe(false)

    const piTransition = reduceSessionWorkersSnapshot({
      state: cursorState, sessionAgentId: 'manager-1', workers: [piWorker],
    })
    const freshPiState = { ...cursorState, ...piTransition.patch }
    expect(reduceGenerationThroughputEvent(freshPiState, {
      type: 'generation_throughput',
      measurement: measurement({ measurementId: 'fresh-pi-worker-call', agentId: piWorker.agentId, role: 'worker' }),
    }).accepted).toBe(true)
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
