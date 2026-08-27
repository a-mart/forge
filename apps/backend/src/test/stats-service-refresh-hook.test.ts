import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatsRange, StatsSnapshot } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatsService } from '../stats/stats-service.js'
import type { StatsScanResult } from '../stats/stats-types.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
}

const activeRoots: string[] = []
const activeServices: StatsService[] = []

afterEach(async () => {
  await Promise.all(activeServices.splice(0).map(waitForStatsPersistence))
  vi.restoreAllMocks()
  await Promise.all(activeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('StatsService refresh completion hook', () => {
  it('prewarms provider usage through the provider usage service', async () => {
    const dataDir = await createDataDir('stats-provider-prewarm-')
    const service = createStatsService(dataDir)
    const getSnapshotSpy = vi
      .spyOn((service as any).providerUsageService, 'prewarmInBackground')
      .mockResolvedValue({ openai: [], anthropic: [] })

    await expect(service.prewarmProviderUsageInBackground()).resolves.toEqual({ openai: [], anthropic: [] })
    expect(getSnapshotSpy).toHaveBeenCalledTimes(1)
  })

  it('invokes the hook once per in-flight refresh-all run, even with concurrent callers', async () => {
    const dataDir = await createDataDir('stats-hook-concurrency-')
    const onRefreshAllCompleted = vi.fn<(snapshot: StatsSnapshot | null) => void>()
    const service = createStatsService(dataDir, {
      onRefreshAllCompleted,
    })

    const scanSpy = mockStatsScan(service, createScanResult())

    const [first, second] = await Promise.all([
      service.refreshAllRangesInBackground(),
      service.refreshAllRangesInBackground(),
    ])

    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(scanSpy).toHaveBeenCalledTimes(1)
    expect(onRefreshAllCompleted).toHaveBeenCalledTimes(1)
    expect(onRefreshAllCompleted).toHaveBeenCalledWith(first)
  })

  it.each(['UTC', 'America/Chicago'])(
    'derives equivalent 7d, 30d, and all snapshots from one %s history scan',
    async (timezone) => {
      const previousTimezone = process.env.TZ
      process.env.TZ = timezone
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-10T12:00:00.000Z'))
      vi.spyOn(process, 'uptime').mockReturnValue(123)

      try {
        const baselineDataDir = await createDataDir(`stats-refresh-baseline-${timezone.replace('/', '-')}-`)
        const optimizedDataDir = await createDataDir(`stats-refresh-optimized-${timezone.replace('/', '-')}-`)
        const baselineService = createStatsService(baselineDataDir)
        const optimizedService = createStatsService(optimizedDataDir)
        const scanResult = createScanResult()
        const baselineScan = mockStatsScan(baselineService, scanResult)
        const optimizedScan = mockStatsScan(optimizedService, scanResult)

        const baseline = {} as Record<StatsRange, StatsSnapshot>
        for (const range of STATS_RANGES) {
          baseline[range] = await baselineService.getSnapshot(range, { forceRefresh: true, timezone })
        }

        const refreshedAll = await optimizedService.refreshAllRangesInBackground()
        const optimized = {} as Record<StatsRange, StatsSnapshot>
        for (const range of STATS_RANGES) {
          optimized[range] = await optimizedService.getSnapshot(range, { timezone })
        }

        expect(baselineScan).toHaveBeenCalledTimes(3)
        expect(optimizedScan).toHaveBeenCalledTimes(1)
        expect(optimized).toEqual(baseline)
        expect(refreshedAll).toEqual(baseline.all)
      } finally {
        if (previousTimezone === undefined) {
          delete process.env.TZ
        } else {
          process.env.TZ = previousTimezone
        }
      }
    },
  )

  it('uses two history scans for the manual-refresh sequence instead of rescanning all four ranges', async () => {
    const dataDir = await createDataDir('stats-manual-refresh-scan-count-')
    const service = createStatsService(dataDir)
    const scanSpy = mockStatsScan(service, createScanResult())
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

    await service.getSnapshot('30d', { forceRefresh: true, timezone })
    await service.refreshAllRangesInBackground()

    expect(scanSpy).toHaveBeenCalledTimes(2)
  })

  it('claims every batch range before the shared history scan can yield', async () => {
    const dataDir = await createDataDir('stats-batch-refresh-owner-')
    const service = createStatsService(dataDir)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const scanStarted = createDeferred<void>()
    const releaseScan = createDeferred<void>()
    const scanResult = createScanResult()
    const scanSpy = vi.spyOn(getStatsScanTarget(service), 'scanProfiles')
      .mockImplementationOnce(async () => {
        scanStarted.resolve()
        await releaseScan.promise
        return scanResult
      })
      .mockResolvedValue(scanResult)
    const cacheSetSpy = vi.spyOn(getStatsCacheTarget(service), 'set')

    const batchRefresh = service.refreshAllRangesInBackground()
    await scanStarted.promise
    const forcedRangeRefresh = service.getSnapshot('30d', { forceRefresh: true, timezone })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(scanSpy).toHaveBeenCalledTimes(1)

    releaseScan.resolve()
    await Promise.all([batchRefresh, forcedRangeRefresh])

    expect(cacheSetSpy.mock.calls.filter(([key]) => key === 'stats:30d')).toHaveLength(1)
  })

  it('waits for an older range refresh, then replaces every range from one batch scan', async () => {
    const dataDir = await createDataDir('stats-range-refresh-owner-')
    const service = createStatsService(dataDir)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const rangeScanStarted = createDeferred<void>()
    const releaseRangeScan = createDeferred<void>()
    const olderScanResult = { ...createScanResult(), activeWorkerCount: 1 }
    const batchScanResult = { ...createScanResult(), activeWorkerCount: 2 }
    const scanSpy = vi.spyOn(getStatsScanTarget(service), 'scanProfiles')
      .mockImplementationOnce(async () => {
        rangeScanStarted.resolve()
        await releaseRangeScan.promise
        return olderScanResult
      })
      .mockResolvedValue(batchScanResult)

    const forcedRangeRefresh = service.getSnapshot('7d', { forceRefresh: true, timezone })
    await rangeScanStarted.promise
    const batchRefresh = service.refreshAllRangesInBackground()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(scanSpy).toHaveBeenCalledTimes(1)

    releaseRangeScan.resolve()
    const [, batchSnapshot] = await Promise.all([forcedRangeRefresh, batchRefresh])
    const cachedSnapshots = await Promise.all(
      STATS_RANGES.map((range) => service.getSnapshot(range, { timezone })),
    )

    expect(scanSpy).toHaveBeenCalledTimes(2)
    expect(batchSnapshot?.workers.currentlyActive).toBe(2)
    expect(cachedSnapshots.map((snapshot) => snapshot.workers.currentlyActive)).toEqual([2, 2, 2])
  })

  it('does not block refresh completion on async hook work (fire-and-forget)', async () => {
    const dataDir = await createDataDir('stats-hook-fire-and-forget-')
    const hookStarted = createDeferred<void>()
    const releaseHook = createDeferred<void>()
    const service = createStatsService(dataDir, {
      onRefreshAllCompleted: async () => {
        hookStarted.resolve()
        await releaseHook.promise
      },
    })

    mockStatsScan(service, createScanResult())

    const refreshPromise = service.refreshAllRangesInBackground()
    await hookStarted.promise

    await expect(refreshPromise).resolves.not.toBeNull()

    releaseHook.resolve()
  })
})

async function createDataDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const dataDir = join(root, 'data')
  activeRoots.push(root)
  return dataDir
}

function createStatsService(
  dataDir: string,
  options?: ConstructorParameters<typeof StatsService>[1],
): StatsService {
  const service = new StatsService(createSwarmManagerStub(dataDir), options)
  activeServices.push(service)
  return service
}

async function waitForStatsPersistence(service: StatsService): Promise<void> {
  await (service as unknown as { persistQueue: Promise<void> }).persistQueue
}

function createSwarmManagerStub(dataDir: string): any {
  return {
    getConfig: () => ({
      isDesktop: false,
      paths: {
        dataDir,
        rootDir: join(dataDir, 'repo'),
        sharedAuthFile: join(dataDir, 'shared', 'config', 'auth', 'auth.json'),
        sharedCacheDir: join(dataDir, 'shared', 'cache'),
      },
    }),
    getCredentialPoolService: () => undefined,
    getOpenAIAuthBrokerRuntimeService: () => ({ fetchUsageSnapshot: async () => null }),
  }
}

const STATS_RANGES: StatsRange[] = ['7d', '30d', 'all']

function createScanResult(): StatsScanResult {
  const usageDays = [
    ['2026-02-01', 100],
    ['2026-02-15', 80],
    ['2026-03-01', 60],
    ['2026-03-05', 40],
    ['2026-03-08', 20],
    ['2026-03-10', 10],
  ] as const

  return {
    usageRecords: usageDays.map(([day, total], index) => ({
      timestampMs: Date.parse(`${day}T12:00:00.000Z`),
      input: total - 3,
      output: 1,
      cacheRead: 2,
      cacheWrite: 0,
      total,
      modelId: index % 2 === 0 ? 'openai/gpt-test' : 'anthropic/claude-test',
      reasoningLevel: index % 2 === 0 ? 'high' : 'medium',
    })),
    dailyUsage: new Map<string, {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      total: number
    }>(usageDays.map(([day, total]) => [
      day,
      {
        input: total - 3,
        output: 1,
        cacheRead: 2,
        cacheWrite: 0,
        total,
      },
    ])),
    workerRuns: usageDays.map(([day, total], index) => ({
      workerId: `worker-${index}`,
      createdAtMs: Date.parse(`${day}T12:00:00.000Z`),
      terminatedAtMs: Date.parse(`${day}T12:01:00.000Z`),
      durationMs: 60_000,
      billableTokens: total - 2,
    })),
    activeWorkerCount: 2,
    totalSessionCount: 6,
    activeSessionCount: 2,
    userMessages: usageDays.map(([day]) => Date.parse(`${day}T13:00:00.000Z`)),
    earliestUsageDayKey: usageDays[0][0],
    managerRepoPaths: [],
    diagnostics: { skippedMissingTimestampUsageRecords: 0 },
  }
}

function mockStatsScan(service: StatsService, result: StatsScanResult) {
  return vi.spyOn(getStatsScanTarget(service), 'scanProfiles').mockResolvedValue(result)
}

function getStatsScanTarget(service: StatsService): {
    scanProfiles: (dataDir: string, profileIds: string[], timezone: string) => Promise<StatsScanResult>
} {
  return service as unknown as {
    scanProfiles: (dataDir: string, profileIds: string[], timezone: string) => Promise<StatsScanResult>
  }
}

function getStatsCacheTarget(service: StatsService): Map<string, unknown> {
  return (service as unknown as { cache: Map<string, unknown> }).cache
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
