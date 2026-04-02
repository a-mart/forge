/** @vitest-environment jsdom */

import { getByText, queryByText } from '@testing-library/dom'
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

function renderStatsPanel(stats: StatsSnapshot): void {
  useStatsMock.mockReturnValue({
    stats,
    isLoading: false,
    error: null,
    isRefreshing: false,
    isSwitchingRange: false,
    refresh: vi.fn(),
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
      openai: {
        provider: 'openai',
        available: true,
        plan: 'Plus',
        sessionUsage: {
          percent: 42,
          resetInfo: 'Resets in 1h 0m',
        },
      },
      anthropic: {
        provider: 'anthropic',
        available: false,
      },
    },
    system: {
      uptimeFormatted: '1s',
      totalProfiles: 1,
      serverVersion: 'test',
      nodeVersion: process.version,
    },
    ...overrides,
  }
}

describe('StatsPanel', () => {
  it('renders the empty state without provider usage cards', () => {
    renderStatsPanel(buildStatsSnapshot())

    expect(queryByText(container, 'Account Limits')).toBeNull()
    expect(queryByText(container, 'Session Usage')).toBeNull()
    expect(queryByText(container, '42%')).toBeNull()
    expect(getByText(container, 'No usage data yet')).toBeTruthy()
    expect(queryByText(container, 'Longest Streak')).toBeNull()
  })
})
