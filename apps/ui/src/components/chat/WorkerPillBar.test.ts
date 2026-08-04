/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ConversationEntry, GenerationThroughputLiveMeasurement } from '@forge/protocol'
import type { AgentActivityEntry } from '@/lib/ws-state'
import { createInitialManagerWsState } from '@/lib/ws-state'
import {
  clearGenerationThroughputState,
  reduceGenerationThroughputEvent,
} from '@/lib/ws-client/generation-throughput-state'
import { reduceSessionWorkersSnapshot } from '@/lib/ws-client/snapshot-reducers'
import { WorkerPillBar } from './WorkerPillBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const onNavigateToWorker = vi.fn()

const worker: AgentDescriptor = {
  agentId: 'worker-1',
  managerId: 'manager-1',
  displayName: 'Streaming worker',
  role: 'worker',
  status: 'streaming',
  createdAt: '2026-07-21T10:00:00.000Z',
  updatedAt: '2026-07-21T10:00:00.000Z',
  cwd: '/tmp',
  model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
  sessionFile: '/tmp/worker-1.jsonl',
}

const manager: AgentDescriptor = {
  ...worker,
  agentId: 'manager-1',
  managerId: 'manager-1',
  displayName: 'Manager',
  role: 'manager',
}

const retainedFinal: GenerationThroughputLiveMeasurement = {
  measurementId: 'worker-call',
  sequence: 2,
  phase: 'completed',
  profileId: 'profile-1',
  sessionId: 'manager-1',
  agentId: worker.agentId,
  managerId: worker.managerId,
  role: 'worker',
  provider: 'openai-codex',
  modelId: 'gpt-5.5',
  sampledAt: '2026-07-21T10:00:02.000Z',
  firstOutputAt: '2026-07-21T10:00:01.000Z',
  timeToFirstOutputMs: 1_000,
  responseDurationMs: 2_000,
  responseThroughputDurationBasis: 'request_wall_monotonic',
  responseThroughputTokensPerSecond: 50,
  elapsedGenerationMs: 2_000,
  outputTokens: 100,
  instantaneousTokensPerSecond: null,
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
}

function summary(index: number, prefix = 'Activity'): Extract<ConversationEntry, { type: 'activity_summary' }> {
  const correlationId = `${prefix.toLowerCase()}-${index}`
  return {
    type: 'activity_summary',
    schemaVersion: 1,
    itemId: `tool:manager-1:${correlationId}`,
    agentId: 'manager-1',
    actorAgentId: worker.agentId,
    timestamp: new Date(Date.UTC(2026, 6, 21, 10, 0, index)).toISOString(),
    kind: 'tool_activity',
    status: 'completed',
    toolName: 'read',
    correlationId,
    displaySummary: `${prefix} ${index}`,
  }
}

const replayedSummary = summary(1, 'Read file')

beforeEach(() => {
  onNavigateToWorker.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(
  activityMessages: AgentActivityEntry[],
  generationThroughputByAgentId?: Record<string, GenerationThroughputLiveMeasurement>,
  workerDescriptor: AgentDescriptor = worker,
  workerMetadataSessionIds: ReadonlySet<string> = new Set([workerDescriptor.managerId]),
  generationThroughputLatestFinalByAgentId?: Record<string, GenerationThroughputLiveMeasurement>,
  showGenerationThroughput = true,
) {
  act(() => {
    root.render(createElement(WorkerPillBar, {
      workers: [workerDescriptor],
      statuses: {
        [workerDescriptor.agentId]: {
          status: 'streaming',
          streamingStartedAt: Date.now() - 5_000,
        },
      },
      activityMessages,
      generationThroughputByAgentId,
      generationThroughputLatestFinalByAgentId,
      showGenerationThroughput,
      workerMetadataSessionIds,
      onNavigateToWorker,
    }))
  })
}

function getPill(): HTMLButtonElement {
  const pill = container.querySelector(`[data-worker-pill="${worker.agentId}"]`)
  expect(pill).toBeInstanceOf(HTMLButtonElement)
  return pill as HTMLButtonElement
}

function getEntryCount(): number {
  return document.body.querySelector('[data-worker-quick-look-entries]')?.children.length ?? 0
}

describe('WorkerPillBar quick look', () => {
  it('renders replayed worker summaries and updates immediately for live tool activity', () => {
    render([replayedSummary])

    act(() => getPill().click())

    expect(document.body.textContent).toContain('Read file 1')
    expect(document.body.textContent).not.toContain('No recent activity')

    const liveStart: Extract<ConversationEntry, { type: 'agent_tool_call' }> = {
      type: 'agent_tool_call',
      agentId: 'manager-1',
      actorAgentId: worker.agentId,
      timestamp: '2026-07-21T10:00:02.000Z',
      kind: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'bash-1',
      text: JSON.stringify({ command: 'pnpm test' }),
    }
    render([replayedSummary, liveStart])

    expect(document.body.textContent).toContain('Running host command')
    expect(document.body.textContent).toContain('pnpm test')
  })

  it('retains the initial open snapshot while rolling live updates append beyond 30 entries', () => {
    const initial = Array.from({ length: 30 }, (_, index) => summary(index, 'Initial'))
    render(initial)
    act(() => getPill().click())

    expect(getEntryCount()).toBe(30)
    expect(document.body.textContent).toContain('Initial 0')

    let rollingActivity: AgentActivityEntry[] = initial
    let previousCount = getEntryCount()
    for (let index = 0; index < 35; index += 1) {
      rollingActivity = [...rollingActivity, summary(index, 'Live')].slice(-30)
      render(rollingActivity)
      const nextCount = getEntryCount()
      expect(nextCount).toBeGreaterThanOrEqual(previousCount)
      previousCount = nextCount
    }

    expect(getEntryCount()).toBe(65)
    expect(document.body.textContent).toContain('Initial 0')
    expect(document.body.textContent).toContain('Live 34')
  })

  it('reserves final-only throughput geometry in the pill and Quick Look', () => {
    render([replayedSummary])
    const pill = getPill()
    const emptyCell = pill.querySelector('[data-worker-throughput]')
    expect(emptyCell?.textContent).toContain('— t/s')
    expect(emptyCell?.className).toContain('w-[42px]')
    expect(pill.textContent).not.toContain('≈')

    render([replayedSummary], {
      [worker.agentId]: {
        measurementId: 'worker-call',
        sequence: 2,
        phase: 'completed',
        profileId: 'profile-1',
        sessionId: 'manager-1',
        agentId: worker.agentId,
        managerId: worker.managerId,
        role: 'worker',
        provider: 'openai-codex',
        modelId: 'gpt-5.5',
        sampledAt: '2026-07-21T10:00:02.000Z',
        firstOutputAt: '2026-07-21T10:00:01.000Z',
        timeToFirstOutputMs: 1_000,
        responseDurationMs: 2_000,
        responseThroughputDurationBasis: 'request_wall_monotonic',
        responseThroughputTokensPerSecond: 50,
        elapsedGenerationMs: 2_000,
        outputTokens: 100,
        instantaneousTokensPerSecond: null,
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
      },
    })
    expect(getPill().querySelector('[data-worker-throughput]')?.textContent).toContain('50 t/s')

    act(() => getPill().click())
    const telemetryRow = document.body.querySelector('[data-worker-throughput-row]')
    expect(telemetryRow?.textContent).toContain('Latest final response throughput')
    expect(telemetryRow?.textContent).toContain('50 tok/s')
    expect(telemetryRow?.className).toContain('h-7')
  })

  it('hides conversation throughput immediately without dropping retained final telemetry', () => {
    let state: ReturnType<typeof createInitialManagerWsState> = {
      ...createInitialManagerWsState('manager-1'),
      targetAgentId: 'manager-1',
      subscribedAgentId: 'manager-1',
      agents: [manager, worker],
      workerMetadataSessionIds: new Set(['manager-1']),
    }
    state = {
      ...state,
      ...reduceGenerationThroughputEvent(state, {
        type: 'generation_throughput',
        measurement: retainedFinal,
      }).patch,
    }

    render(
      [replayedSummary],
      state.generationThroughputByAgentId,
      worker,
      state.workerMetadataSessionIds,
      state.generationThroughputLatestFinalByAgentId,
      false,
    )

    expect(getPill().querySelector('[data-worker-throughput]')).toBeNull()
    act(() => getPill().click())
    expect(document.body.querySelector('[data-worker-throughput-row]')).toBeNull()
    expect(state.generationThroughputLatestFinalByAgentId[worker.agentId]).toEqual(retainedFinal)

    render(
      [replayedSummary],
      state.generationThroughputByAgentId,
      worker,
      state.workerMetadataSessionIds,
      state.generationThroughputLatestFinalByAgentId,
      true,
    )
    expect(getPill().querySelector('[data-worker-throughput]')?.textContent).toContain('50 t/s')
  })

  it('suppresses throughput cells and the Quick Look row for Cursor SDK workers', () => {
    const cursorWorker: AgentDescriptor = {
      ...worker,
      model: { provider: 'cursor-sdk', modelId: 'composer-2.5', thinkingLevel: 'high' },
    }
    render([replayedSummary], {
      [worker.agentId]: {
        measurementId: 'stale-pi-call',
        sequence: 2,
        phase: 'completed',
        profileId: 'profile-1',
        sessionId: 'manager-1',
        agentId: worker.agentId,
        managerId: 'manager-1',
        role: 'worker',
        provider: 'openai-codex',
        modelId: 'gpt-5.5',
        sampledAt: '2026-07-21T10:00:02.000Z',
        firstOutputAt: '2026-07-21T10:00:01.000Z',
        timeToFirstOutputMs: 1_000,
        responseDurationMs: 2_000,
        responseThroughputDurationBasis: 'request_wall_monotonic',
        responseThroughputTokensPerSecond: 50,
        elapsedGenerationMs: 2_000,
        outputTokens: 100,
        instantaneousTokensPerSecond: null,
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
      },
    }, cursorWorker)

    expect(getPill().querySelector('[data-worker-throughput]')).toBeNull()
    act(() => getPill().click())
    expect(document.body.querySelector('[data-worker-throughput-row]')).toBeNull()
  })

  it('withholds retained worker throughput until reconnect metadata is authoritative', () => {
    let state: ReturnType<typeof createInitialManagerWsState> = {
      ...createInitialManagerWsState('manager-1'),
      targetAgentId: 'manager-1',
      subscribedAgentId: 'manager-1',
      agents: [manager, worker],
      workerMetadataSessionIds: new Set(['manager-1']),
    }
    state = {
      ...state,
      ...reduceGenerationThroughputEvent(state, {
        type: 'generation_throughput',
        measurement: retainedFinal,
      }).patch,
    }

    const renderState = () => render(
      [replayedSummary],
      state.generationThroughputByAgentId,
      state.agents.find((agent) => agent.agentId === worker.agentId) ?? worker,
      state.workerMetadataSessionIds,
      state.generationThroughputLatestFinalByAgentId,
    )

    // The cached Pi descriptor and retained final are visible on the original connection.
    renderState()
    expect(getPill().querySelector('[data-worker-throughput]')?.textContent).toContain('50 t/s')
    act(() => getPill().click())
    expect(document.body.querySelector('[data-worker-throughput-row]')?.textContent).toContain('50 tok/s')

    // Reconnect keeps the worker row and exact final internally, but invalidates the roster.
    state = {
      ...state,
      ...clearGenerationThroughputState(),
      workerMetadataSessionIds: new Set(),
    }
    renderState()
    expect(getPill().querySelector('[data-worker-throughput]')).toBeNull()
    expect(document.body.querySelector('[data-worker-throughput-row]')).toBeNull()
    expect(state.generationThroughputLatestFinalByAgentId[worker.agentId]).toEqual(retainedFinal)

    // A fresh Pi roster restores the retained final and fixed throughput geometry.
    state = {
      ...state,
      ...reduceSessionWorkersSnapshot({
        state,
        sessionAgentId: manager.agentId,
        workers: [worker],
      }).patch,
    }
    renderState()
    expect(getPill().querySelector('[data-worker-throughput]')?.textContent).toContain('50 t/s')
    expect(document.body.querySelector('[data-worker-throughput-row]')?.textContent).toContain('50 tok/s')

    // Cursor authority clears/tombstones the retained Pi anchor and keeps both surfaces hidden.
    const cursorWorker: AgentDescriptor = {
      ...worker,
      model: { provider: 'cursor-sdk', modelId: 'composer-2.5', thinkingLevel: 'high' },
    }
    state = {
      ...state,
      ...reduceSessionWorkersSnapshot({
        state,
        sessionAgentId: manager.agentId,
        workers: [cursorWorker],
      }).patch,
    }
    renderState()
    expect(getPill().querySelector('[data-worker-throughput]')).toBeNull()
    expect(document.body.querySelector('[data-worker-throughput-row]')).toBeNull()
    expect(state.generationThroughputLatestFinalByAgentId).toEqual({})
    expect(state.generationThroughputTombstonesByMeasurementId[retainedFinal.measurementId]).toBe(retainedFinal.sequence)

    // Pi authority can start a new eligible lifecycle after Cursor tombstoning.
    const freshFinal = { ...retainedFinal, measurementId: 'fresh-worker-call', sequence: 1 }
    state = {
      ...state,
      ...reduceSessionWorkersSnapshot({
        state,
        sessionAgentId: manager.agentId,
        workers: [worker],
      }).patch,
    }
    state = {
      ...state,
      ...reduceGenerationThroughputEvent(state, {
        type: 'generation_throughput',
        measurement: freshFinal,
      }).patch,
    }
    expect(state.generationThroughputByAgentId[worker.agentId]).toEqual(freshFinal)
    renderState()
    expect(getPill().querySelector('[data-worker-throughput]')?.textContent).toContain('50 t/s')
    expect(document.body.querySelector('[data-worker-throughput-row]')?.textContent).toContain('50 tok/s')
  })

  it('uses a fixed responsive frame with an internal flex scroll region', () => {
    render([replayedSummary])
    act(() => getPill().click())

    const popover = document.body.querySelector('[data-worker-quick-look-popover]')
    const scrollRegion = document.body.querySelector('[data-worker-quick-look-scroll]')
    expect(popover?.className).toContain('h-[min(42rem,_calc(100vh-6rem))]')
    expect(popover?.className).toContain('overflow-hidden')
    expect(scrollRegion?.className).toContain('min-h-0')
    expect(scrollRegion?.className).toContain('flex-1')
    expect(scrollRegion?.className).toContain('overflow-y-auto')
  })

  it('resets the accumulated snapshot after close and reopen', () => {
    render([summary(0, 'Initial')])
    const pill = getPill()
    act(() => pill.click())
    render([summary(0, 'Live')])

    expect(document.body.textContent).toContain('Initial 0')
    expect(document.body.textContent).toContain('Live 0')

    act(() => pill.click())
    render([summary(0, 'Live')])
    act(() => pill.click())

    expect(document.body.textContent).not.toContain('Initial 0')
    expect(document.body.textContent).toContain('Live 0')
  })
})
