/** @vitest-environment jsdom */
import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { waitFor } from '@testing-library/dom'
import { afterEach, expect, it, vi } from 'vitest'
import { useStats } from './use-stats'
import { useTokenAnalytics } from './token-analytics/use-token-analytics'
import { useGenerationThroughput } from './generation-throughput/use-generation-throughput'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn() }))
vi.mock('./stats-api', () => ({ fetchStats: mocks.fetch, refreshStats: mocks.refresh }))
vi.mock('./token-analytics/token-analytics-api', () => ({ fetchTokenAnalytics: mocks.fetch, refreshTokenAnalytics: mocks.refresh }))
vi.mock('./generation-throughput/generation-throughput-api', () => ({ fetchGenerationThroughput: mocks.fetch, refreshGenerationThroughput: mocks.refresh }))
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => { if (root) flushSync(() => root!.unmount()); container?.remove(); vi.resetAllMocks() })

it.each(['overview', 'tokens', 'throughput'] as const)('%s ignores a refresh completing after the user switches origin', async (kind) => {
  let finish!: (value: unknown) => void
  mocks.fetch.mockResolvedValueOnce({ computedAt: 'initial' }).mockResolvedValueOnce({ computedAt: 'new-origin' })
  mocks.refresh.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  const query = { rangePreset: 'all' as const, timezone: 'UTC' }
  let current: { refresh: () => Promise<void>; isRefreshing: boolean; isLoading: boolean; computedAt?: string }
  function Overview({ url }: { url: string }) { const state = useStats(url); useEffect(() => { current = { ...state, computedAt: state.stats?.computedAt } }, [state]); return null }
  function Tokens({ url }: { url: string }) { const state = useTokenAnalytics(url, query); useEffect(() => { current = { ...state, computedAt: state.snapshot?.computedAt } }, [state]); return null }
  function Throughput({ url }: { url: string }) { const state = useGenerationThroughput(url, query); useEffect(() => { current = { ...state, computedAt: state.snapshot?.computedAt } }, [state]); return null }
  const Component = kind === 'overview' ? Overview : kind === 'tokens' ? Tokens : Throughput
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  flushSync(() => root!.render(createElement(Component, { url: 'ws://old-origin' })))
  await waitFor(() => expect(current.computedAt).toBe('initial'))
  let refresh!: Promise<void>
  flushSync(() => { refresh = current.refresh() })
  flushSync(() => root!.render(createElement(Component, { url: 'ws://new-origin' })))
  await waitFor(() => expect(current.computedAt).toBe('new-origin'))
  finish({ computedAt: 'stale-refresh' }); await refresh
  await waitFor(() => {
    expect(current.computedAt).toBe('new-origin')
    expect(current.isRefreshing).toBe(false)
    expect(current.isLoading).toBe(false)
  })
})
