import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatsRange, StatsSnapshot } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatsService } from '../stats/stats-service.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
}

const activeRoots: string[] = []

afterEach(async () => {
  await Promise.all(activeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('StatsService refresh completion hook', () => {
  it('invokes the hook once per in-flight refresh-all run, even with concurrent callers', async () => {
    const dataDir = await createDataDir('stats-hook-concurrency-')
    const onRefreshAllCompleted = vi.fn<(snapshot: StatsSnapshot | null) => void>()
    const service = new StatsService(createSwarmManagerStub(dataDir), {
      onRefreshAllCompleted,
    })

    const snapshots = createSnapshots()
    const getSnapshotSpy = vi
      .spyOn(service, 'getSnapshot')
      .mockImplementation(async (range: StatsRange) => snapshots[range])

    const [first, second] = await Promise.all([
      service.refreshAllRangesInBackground(),
      service.refreshAllRangesInBackground(),
    ])

    expect(first).toBe(snapshots.all)
    expect(second).toBe(snapshots.all)
    expect(getSnapshotSpy).toHaveBeenCalledTimes(3)
    expect(onRefreshAllCompleted).toHaveBeenCalledTimes(1)
    expect(onRefreshAllCompleted).toHaveBeenCalledWith(snapshots.all)
  })

  it('does not block refresh completion on async hook work (fire-and-forget)', async () => {
    const dataDir = await createDataDir('stats-hook-fire-and-forget-')
    const hookStarted = createDeferred<void>()
    const releaseHook = createDeferred<void>()
    const service = new StatsService(createSwarmManagerStub(dataDir), {
      onRefreshAllCompleted: async () => {
        hookStarted.resolve()
        await releaseHook.promise
      },
    })

    const snapshots = createSnapshots()
    vi.spyOn(service, 'getSnapshot').mockImplementation(async (range: StatsRange) => snapshots[range])

    const refreshPromise = service.refreshAllRangesInBackground()
    await hookStarted.promise

    await expect(refreshPromise).resolves.toBe(snapshots.all)

    releaseHook.resolve()
  })
})

async function createDataDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const dataDir = join(root, 'data')
  activeRoots.push(root)
  return dataDir
}

function createSwarmManagerStub(dataDir: string): any {
  return {
    getConfig: () => ({
      paths: {
        dataDir,
        sharedAuthFile: join(dataDir, 'shared', 'config', 'auth', 'auth.json'),
        sharedCacheDir: join(dataDir, 'shared', 'cache'),
      },
    }),
  }
}

function createSnapshots(): Record<StatsRange, StatsSnapshot> {
  return {
    '7d': createStatsSnapshot('2026-04-03T00:00:00.000Z'),
    '30d': createStatsSnapshot('2026-04-03T00:00:01.000Z'),
    all: createStatsSnapshot('2026-04-03T00:00:02.000Z'),
  }
}

function createStatsSnapshot(computedAt: string): StatsSnapshot {
  return {
    computedAt,
    uptimeMs: 1,
    tokens: {
      today: 0,
      yesterday: 0,
      todayDate: '2026-04-03',
      todayInputTokens: 0,
      todayOutputTokens: 0,
      last7Days: 0,
      last7DaysAvgPerDay: 0,
      last30Days: 0,
      allTime: 0,
    },
    cache: {
      hitRate: 0,
      hitRatePeriod: 'all time',
      cachedTokensSaved: 0,
    },
    workers: {
      totalWorkersRun: 0,
      totalWorkersRunPeriod: 'all time',
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
      totalMessagesPeriod: 'all time',
    },
    activity: {
      longestStreak: 0,
      streakLabel: '0 days',
      activeDays: 0,
      activeDaysInRange: 0,
      totalDaysInRange: 0,
      peakDay: '',
      peakDayTokens: 0,
    },
    models: [],
    allProviders: [],
    dailyUsage: [],
    providers: {},
    system: {
      uptimeFormatted: '0s',
      totalProfiles: 0,
      serverVersion: '0.0.0',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      isDesktop: false,
      electronVersion: null,
    },
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
