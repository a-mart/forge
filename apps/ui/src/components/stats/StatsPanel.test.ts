/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StatsPanel } from './StatsPanel'
import type { StatsSnapshot } from '@forge/protocol'

const useStatsMock = vi.fn()

vi.mock('./use-stats', () => ({
  useStats: (...args: unknown[]) => useStatsMock(...args),
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  useStatsMock.mockReset()
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
})

function renderStatsPanel(stats: StatsSnapshot | null, state: Partial<{
  isLoading: boolean
  error: string | null
  isRefreshing: boolean
  isSwitchingRange: boolean
}> = {}) {
  const refresh = vi.fn()
  useStatsMock.mockReturnValue({
    stats,
    isLoading: false,
    error: null,
    isRefreshing: false,
    isSwitchingRange: false,
    refresh,
    ...state,
  })

  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(StatsPanel, {
        wsUrl: 'ws://127.0.0.1:47187',
        onBack: vi.fn(),
      }),
    )
  })
}

function buildStatsSnapshot(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return {
    computedAt: '2026-04-01T00:00:00.000Z',
    uptimeMs: 1_000,
    tokens: {
      today: 0,
      yesterday: 0,
      todayDate: '2026-04-01',
      todayInputTokens: 0,
      todayOutputTokens: 0,
      last7Days: 0,
      last7DaysAvgPerDay: 0,
      last30Days: 0,
      allTime: 0,
    },
    cache: {
      hitRate: 0,
      hitRatePeriod: '7d',
      cachedTokensSaved: 0,
    },
    workers: {
      totalWorkersRun: 0,
      totalWorkersRunPeriod: '7d',
      averageTokensPerRun: 0,
      averageRuntimeMs: 0,
      currentlyActive: 0,
    },
    code: {
      linesAdded: 0,
      linesDeleted: 0,
      commits: 0,
      repos: 0,
    },
    sessions: {
      totalSessions: 0,
      activeSessions: 0,
      totalMessagesSent: 0,
      totalMessagesPeriod: '7d',
    },
    activity: {
      longestStreak: 0,
      streakLabel: 'Across current usage range',
      activeDays: 0,
      activeDaysInRange: 0,
      totalDaysInRange: 7,
      peakDay: '—',
      peakDayTokens: 0,
    },
    models: [],
    dailyUsage: [],
    providers: {
      openai: [
        {
          provider: 'openai',
          available: true,
          plan: 'Plus',
          sessionUsage: {
            percent: 42,
            resetInfo: 'Resets in 1h 0m',
          },
        },
      ],
      anthropic: [
        {
          provider: 'anthropic',
          available: false,
        },
      ],
    },
    system: {
      uptimeFormatted: '1s',
      totalProfiles: 1,
      serverVersion: 'test',
      nodeVersion: process.version,
      platform: 'darwin',
      arch: 'arm64',
      isDesktop: false,
      electronVersion: null,
    },
    ...overrides,
  }
}

describe('StatsPanel', () => {
  it('renders populated cards, activity, chart, and model distribution', () => {
    const stats = buildStatsSnapshot({
      tokens: { ...buildStatsSnapshot().tokens, today: 12000, last7Days: 45000, allTime: 100000, todayInputTokens: 7000, todayOutputTokens: 5000 },
      code: { linesAdded: 80, linesDeleted: 12, commits: 4, repos: 2 },
      activity: { ...buildStatsSnapshot().activity, longestStreak: 4, activeDays: 3, activeDaysInRange: 3 },
      sessions: { ...buildStatsSnapshot().sessions, totalSessions: 6, totalMessagesSent: 24 },
      models: [{ modelId: 'claude-opus', displayName: 'Claude Opus', percentage: 75, tokenCount: 75000 }],
      dailyUsage: [{ date: '2026-04-01', dateLabel: 'Apr 1', tokens: 12000, inputTokens: 7000, outputTokens: 5000, cachedTokens: 0 }],
    })
    renderStatsPanel(stats)

    expect(getByText(container, 'Today')).toBeTruthy()
    expect(getByText(container, 'Longest Streak')).toBeTruthy()
    expect(getByText(container, 'Claude Opus')).toBeTruthy()
    expect(container.textContent).toContain('Apr 1')
    expect(container.textContent).toContain('80')
  })

  it('renders loading and initial error states with retry', () => {
    renderStatsPanel(null, { isLoading: true })
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)

    const refresh = vi.fn()
    useStatsMock.mockReturnValue({ stats: null, isLoading: false, error: 'network down', isRefreshing: false, isSwitchingRange: false, refresh })
    flushSync(() => root?.render(createElement(StatsPanel, { wsUrl: 'ws://127.0.0.1:47187', onBack: vi.fn() })))
    expect(getByText(container, 'Failed to load stats')).toBeTruthy()
    fireEvent.click(getByRole(container, 'button', { name: 'Try again' }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps stale data visible while refreshing and routes range/refresh controls', async () => {
    const refresh = vi.fn()
    const stats = buildStatsSnapshot({ tokens: { ...buildStatsSnapshot().tokens, today: 10 } })
    useStatsMock.mockReturnValue({ stats, isLoading: false, error: null, isRefreshing: false, isSwitchingRange: true, refresh })
    root = createRoot(container)
    flushSync(() => root?.render(createElement(StatsPanel, { wsUrl: 'ws://127.0.0.1:47187', onBack: vi.fn() })))
    expect(container.querySelector('.opacity-60')).toBeTruthy()
    useStatsMock.mockReturnValue({ stats, isLoading: false, error: null, isRefreshing: false, isSwitchingRange: false, refresh })
    flushSync(() => root?.render(createElement(StatsPanel, { wsUrl: 'ws://127.0.0.1:47187', onBack: vi.fn() })))
    fireEvent.click(getByRole(container, 'button', { name: 'Refresh stats' }))
    expect(refresh).toHaveBeenCalledTimes(1)
    fireEvent.click(getByRole(container, 'button', { name: '30 days' }))
    await waitFor(() => expect(useStatsMock).toHaveBeenLastCalledWith('ws://127.0.0.1:47187', '30d'))
  })

  it('renders the empty state without provider usage cards', () => {
    renderStatsPanel(buildStatsSnapshot())

    expect(queryByText(container, 'Account Limits')).toBeNull()
    expect(queryByText(container, 'Session Usage')).toBeNull()
    expect(queryByText(container, '42%')).toBeNull()
    expect(getByText(container, 'No usage data yet')).toBeTruthy()
    expect(queryByText(container, 'Longest Streak')).toBeNull()
  })
})
