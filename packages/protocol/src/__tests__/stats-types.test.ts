import { describe, expect, expectTypeOf, it } from 'vitest'
import type { FuckMeterStats, StatsSnapshot } from '../stats-types.js'

function createSnapshot(): StatsSnapshot {
  return {
    computedAt: '2026-05-21T00:00:00.000Z',
    uptimeMs: 1,
    tokens: {
      today: 0,
      yesterday: 0,
      todayDate: 'May 21',
      todayInputTokens: 0,
      todayOutputTokens: 0,
      last7Days: 0,
      last7DaysAvgPerDay: 0,
      last30Days: 0,
      allTime: 0,
    },
    cache: {
      hitRate: 0,
      hitRatePeriod: 'Last 7 days',
      cachedTokensSaved: 0,
    },
    workers: {
      totalWorkersRun: 0,
      totalWorkersRunPeriod: 'Last 7 days',
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
      totalMessagesPeriod: 'Last 7 days',
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
    providers: {},
    system: {
      uptimeFormatted: '0m',
      totalProfiles: 0,
      serverVersion: '0.0.0',
      nodeVersion: 'v22.0.0',
      platform: 'darwin',
      arch: 'arm64',
      isDesktop: false,
      electronVersion: null,
    },
  }
}

describe('stats snapshot protocol', () => {
  it('keeps fuckMeter optional so older fixtures and clients remain valid', () => {
    const snapshot = createSnapshot() satisfies StatsSnapshot
    expect(snapshot.fuckMeter).toBeUndefined()
    expectTypeOf<StatsSnapshot['fuckMeter']>().toEqualTypeOf<FuckMeterStats | undefined>()
  })

  it('accepts hidden daily fuckMeter buckets without extra fields', () => {
    const snapshot = {
      ...createSnapshot(),
      fuckMeter: {
        daily: [
          { date: '2026-05-20', count: 2 },
          { date: '2026-05-21', count: 0 },
        ],
      },
    } satisfies StatsSnapshot

    expect(snapshot.fuckMeter?.daily).toEqual([
      { date: '2026-05-20', count: 2 },
      { date: '2026-05-21', count: 0 },
    ])
    expectTypeOf(snapshot.fuckMeter!.daily[0]!).toMatchTypeOf<{ date: string; count: number }>()
  })
})
