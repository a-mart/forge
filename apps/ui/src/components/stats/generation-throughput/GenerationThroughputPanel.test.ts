/** @vitest-environment jsdom */

import { getByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { GenerationThroughputSnapshot } from '@forge/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenerationThroughputPanel } from './GenerationThroughputPanel'

const useGenerationThroughputMock = vi.fn()
const fetchCallsMock = vi.fn()

vi.mock('./use-generation-throughput', () => ({ useGenerationThroughput: (...args: unknown[]) => useGenerationThroughputMock(...args) }))
vi.mock('./generation-throughput-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./generation-throughput-api')>()), fetchGenerationCalls: (...args: unknown[]) => fetchCallsMock(...args) }))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  useGenerationThroughputMock.mockReset()
  fetchCallsMock.mockResolvedValue({ computedAt: '2026-04-02T00:00:00.000Z', items: [], totalCount: 0, nextCursor: null })
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

    expect(getByText(container, 'Provider output tok/s')).toBeTruthy()
    expect(getByText(container, 'Manager vs worker')).toBeTruthy()
    expect(getByText(container, 'Model performance trends')).toBeTruthy()
    expect(getByText(container, 'Model performance')).toBeTruthy()
    expect(getByText(container, 'Recent generations')).toBeTruthy()
    expect(container.textContent).toContain('Coverage note.')
    await waitFor(() => expect(fetchCallsMock).toHaveBeenCalled())
  })

  it('uses the post-update empty state instead of showing zero speed', () => {
    const snapshot = fixture()
    snapshot.totals.terminalCallCount = 0
    snapshot.totals.measuredCallCount = 0
    useGenerationThroughputMock.mockReturnValue({ snapshot, isLoading: false, isRefreshing: false, isSwitchingQuery: false, error: null, refresh: vi.fn() })
    root = createRoot(container)
    flushSync(() => root?.render(createElement(GenerationThroughputPanel, { wsUrl: 'ws://127.0.0.1:47187', onBack: vi.fn() })))
    expect(getByText(container, 'Throughput is available for generations recorded after this Forge update.')).toBeTruthy()
  })
})

function fixture(): GenerationThroughputSnapshot {
  const metrics = {
    allCallCount: 3, terminalCallCount: 2, measuredCallCount: 1, incompleteCallCount: 1,
    outputTokens: 100, generationDurationMs: 2000, weightedTokensPerSecond: 50,
    p50TokensPerSecond: 50, p90TokensPerSecond: 50, p50TimeToFirstOutputMs: 100,
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
    diagnostics: { malformedRecordCount: 0, duplicateRecordCount: 0, conflictRecordCount: 0, startOnlyCallCount: 1 },
  }
}
