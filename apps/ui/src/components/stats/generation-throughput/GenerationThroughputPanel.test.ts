/** @vitest-environment jsdom */

import { fireEvent, getByText, waitFor } from '@testing-library/dom'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { GenerationThroughputSnapshot } from '@forge/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenerationThroughputPanel } from './GenerationThroughputPanel'

const useGenerationThroughputMock = vi.fn()
const fetchCallsMock = vi.fn()

vi.mock('./use-generation-throughput', () => ({ useGenerationThroughput: (...args: unknown[]) => useGenerationThroughputMock(...args) }))
vi.mock('./generation-throughput-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./generation-throughput-api')>()), fetchGenerationCalls: (...args: unknown[]) => fetchCallsMock(...args) }))
vi.mock('recharts', async (importOriginal) => {
  const recharts = await importOriginal<typeof import('recharts')>()
  const { cloneElement, isValidElement } = await import('react')
  return {
    ...recharts,
    ResponsiveContainer: ({ children }: { children?: unknown }) => isValidElement(children)
      ? cloneElement(
          children as ReactElement<{ width?: number; height?: number }>,
          { width: 800, height: 224 },
        )
      : null,
  }
})

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  useGenerationThroughputMock.mockReset()
  fetchCallsMock.mockReset().mockResolvedValue({ computedAt: '2026-04-02T00:00:00.000Z', items: [], totalCount: 0, nextCursor: null })
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container.remove()
})

describe('GenerationThroughputPanel', () => {
  it('renders provider-rate cards, quality disclosure, trends, model table, and calls', async () => {
    useGenerationThroughputMock.mockReturnValue({ snapshot: fixture(), isLoading: false, isRefreshing: false, isSwitchingQuery: false, error: null, refresh: vi.fn() })
    root = createRoot(container)
    flushSync(() => root?.render(createElement(GenerationThroughputPanel, { wsUrl: 'ws://127.0.0.1:47187', onBack: vi.fn(), activeTab: 'throughput', onTabChange: vi.fn() })))

    expect(container.textContent).toContain('Response throughput')
    expect(getByText(container, 'Manager vs worker')).toBeTruthy()
    expect(getByText(container, 'Model performance trends')).toBeTruthy()
    expect(getByText(container, 'Model performance')).toBeTruthy()
    expect(getByText(container, 'Recent responses')).toBeTruthy()
    expect(container.textContent).toContain('Coverage note.')
    expect(container.textContent).toContain('provider-internal retries and Codex WebSocket replays are not timed as separate rates')
    await waitFor(() => expect(fetchCallsMock).toHaveBeenCalled())
  })

  it('appends unique calls from later pages', async () => {
    const first = recentCall('first-call', 'First session')
    const second = recentCall('second-call', 'Second session')
    fetchCallsMock
      .mockResolvedValueOnce(callsPage([first], 'page-two'))
      .mockResolvedValueOnce(callsPage([first, second], null))
    useGenerationThroughputMock.mockReturnValue({ snapshot: fixture(), isLoading: false, isRefreshing: false, isSwitchingQuery: false, error: null, refresh: vi.fn() })
    root = createRoot(container)
    flushSync(() => root?.render(createElement(GenerationThroughputPanel, { wsUrl: 'ws://127.0.0.1:47187', onBack: vi.fn() })))

    await waitFor(() => expect(getByText(container, 'First session')).toBeTruthy())
    fireEvent.click(getByText(container, 'Load more'))
    await waitFor(() => expect(getByText(container, 'Second session')).toBeTruthy())

    expect(Array.from(container.querySelectorAll('tbody tr')).filter((row) => row.textContent?.includes('First session'))).toHaveLength(1)
    expect(fetchCallsMock.mock.calls[1]?.[1]).toMatchObject({ cursor: 'page-two', limit: 25 })
  })

  it('replaces paginated calls when a filter query changes', async () => {
    const first = recentCall('first-call', 'First session')
    const second = recentCall('second-call', 'Second session')
    const replacement = recentCall('replacement-call', 'Filtered session')
    fetchCallsMock
      .mockResolvedValueOnce(callsPage([first], 'page-two'))
      .mockResolvedValueOnce(callsPage([second], 'page-three'))
      .mockResolvedValueOnce(callsPage([replacement], null))
    useGenerationThroughputMock.mockReturnValue({ snapshot: fixture(), isLoading: false, isRefreshing: false, isSwitchingQuery: false, error: null, refresh: vi.fn() })
    root = createRoot(container)
    flushSync(() => root?.render(createElement(GenerationThroughputPanel, { wsUrl: 'ws://127.0.0.1:47187', onBack: vi.fn() })))

    await waitFor(() => expect(getByText(container, 'First session')).toBeTruthy())
    fireEvent.click(getByText(container, 'Load more'))
    await waitFor(() => expect(getByText(container, 'Second session')).toBeTruthy())
    fireEvent.click(getByText(container, 'All time'))
    await waitFor(() => expect(getByText(container, 'Filtered session')).toBeTruthy())

    expect(container.textContent).not.toContain('First session')
    expect(container.textContent).not.toContain('Second session')
    expect(fetchCallsMock.mock.calls[2]?.[1]).toMatchObject({ rangePreset: 'all', limit: 25 })
    expect(fetchCallsMock.mock.calls[2]?.[1]?.cursor).toBeUndefined()
  })

  it('uses the post-update empty state instead of showing zero speed', () => {
    const snapshot = fixture()
    snapshot.totals.terminalCallCount = 0
    snapshot.totals.measuredCallCount = 0
    useGenerationThroughputMock.mockReturnValue({ snapshot, isLoading: false, isRefreshing: false, isSwitchingQuery: false, error: null, refresh: vi.fn() })
    root = createRoot(container)
    flushSync(() => root?.render(createElement(GenerationThroughputPanel, { wsUrl: 'ws://127.0.0.1:47187', onBack: vi.fn() })))
    expect(getByText(container, 'Response throughput is available for generations with a complete request duration.')).toBeTruthy()
  })
})

function callsPage(items: unknown[], nextCursor: string | null) {
  return { computedAt: '2026-04-02T00:00:00.000Z', items, totalCount: items.length, nextCursor }
}

function recentCall(measurementId: string, sessionLabel: string) {
  return {
    measurementId,
    completedAt: '2026-04-02T00:00:00.000Z',
    sessionLabel,
    role: 'manager',
    specialistDisplayName: null,
    modelId: 'gpt-test',
    provider: 'openai-codex',
    outputTokens: 100,
    responseDurationMs: 3000,
    responseThroughputDurationBasis: 'request_wall_monotonic',
    responseTokensPerSecond: 100 / 3,
    generationDurationMs: 2000,
    tokensPerSecond: 100 / 3,
    quality: { boundarySource: 'content_delta_to_stream_end' },
  }
}

function fixture(): GenerationThroughputSnapshot {
  const metrics = {
    allCallCount: 3, terminalCallCount: 2, measuredCallCount: 1, incompleteCallCount: 1,
    outputTokens: 100, responseDurationMs: 3000, generationDurationMs: 2000,
    weightedResponseTokensPerSecond: 100 / 3, p50ResponseTokensPerSecond: 100 / 3, p90ResponseTokensPerSecond: 100 / 3,
    weightedTokensPerSecond: 100 / 3, p50TokensPerSecond: 100 / 3, p90TokensPerSecond: 100 / 3, p50TimeToFirstOutputMs: 100,
    coverage: 0.5, timeToFirstOutputCoverage: 1, hiddenReasoningBoundaryCallCount: 1,
  }
  return {
    computedAt: '2026-04-02T00:00:00.000Z',
    query: { rangePreset: '7d', startDate: '2026-03-27', endDate: '2026-04-02', timezone: 'UTC', profileId: null, role: 'all', provider: null, modelId: null, quality: 'all_measured', attribution: 'all', specialistId: null },
    availableFilters: { profiles: [], providers: [], models: [], specialists: [] },
    totals: metrics,
    byRole: [{ role: 'manager', ...metrics }, { role: 'worker', ...metrics }],
    models: [{ provider: 'openai-codex', modelId: 'gpt-test', displayName: 'GPT Test', ...metrics }],
    modelTableTruncated: false,
    trends: [{ provider: 'openai-codex', modelId: 'gpt-test', displayName: 'GPT Test', points: [{ date: '2026-04-02', dateLabel: 'Apr 2', ...metrics }] }],
    diagnostics: { malformedRecordCount: 0, duplicateRecordCount: 0, conflictRecordCount: 0, startOnlyCallCount: 1, incompleteCallCount: 1 },
  }
}
