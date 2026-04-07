import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { StatsSnapshot } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStatsRoutes } from '../ws/routes/stats-routes.js'

interface TestServer {
  baseUrl: string
  close: () => Promise<void>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
}

const activeServers: TestServer[] = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
})

describe('createStatsRoutes', () => {
  it('uses /api/stats/refresh as the canonical refresh trigger and does not run on GET /api/stats', async () => {
    const getSnapshot = vi.fn(async () => createStatsSnapshot())
    const refreshAllRangesInBackground = vi.fn(async () => createStatsSnapshot())
    const getProviderUsage = vi.fn(async () => ({}))
    const server = await createRouteServer({ getSnapshot, refreshAllRangesInBackground, getProviderUsage })

    const statsResponse = await fetch(`${server.baseUrl}/api/stats?range=7d&tz=America%2FChicago`)
    expect(statsResponse.status).toBe(200)
    expect(refreshAllRangesInBackground).not.toHaveBeenCalled()

    const refreshResponse = await fetch(`${server.baseUrl}/api/stats/refresh?range=30d&tz=America%2FNew_York`, {
      method: 'POST',
    })
    expect(refreshResponse.status).toBe(200)
    expect(getSnapshot).toHaveBeenNthCalledWith(1, '7d', { timezone: 'America/Chicago' })
    expect(getSnapshot).toHaveBeenNthCalledWith(2, '30d', {
      forceRefresh: true,
      timezone: 'America/New_York',
    })
    expect(refreshAllRangesInBackground).toHaveBeenCalledTimes(1)
  })

  it('fires background refresh without blocking /api/stats/refresh response', async () => {
    const getSnapshot = vi.fn(async () => createStatsSnapshot())
    const refreshStarted = createDeferred<void>()
    const releaseRefresh = createDeferred<void>()
    const refreshAllRangesInBackground = vi.fn(async () => {
      refreshStarted.resolve()
      await releaseRefresh.promise
      return createStatsSnapshot()
    })
    const getProviderUsage = vi.fn(async () => ({}))
    const server = await createRouteServer({ getSnapshot, refreshAllRangesInBackground, getProviderUsage })

    const refreshResponsePromise = fetch(`${server.baseUrl}/api/stats/refresh`, { method: 'POST' })
    await refreshStarted.promise
    const refreshResponse = await refreshResponsePromise

    expect(refreshResponse.status).toBe(200)
    expect(refreshAllRangesInBackground).toHaveBeenCalledTimes(1)

    releaseRefresh.resolve()
  })

  it('does not trigger background refresh when the primary refresh request fails', async () => {
    const getSnapshot = vi.fn(async () => {
      throw new Error('stats refresh failed')
    })
    const refreshAllRangesInBackground = vi.fn(async () => createStatsSnapshot())
    const getProviderUsage = vi.fn(async () => ({}))
    const server = await createRouteServer({ getSnapshot, refreshAllRangesInBackground, getProviderUsage })

    const response = await fetch(`${server.baseUrl}/api/stats/refresh`, { method: 'POST' })
    expect(response.status).toBe(500)
    expect(refreshAllRangesInBackground).not.toHaveBeenCalled()
  })

  it('wires token analytics endpoints to the dedicated service', async () => {
    const getSnapshot = vi.fn(async () => createStatsSnapshot())
    const refreshAllRangesInBackground = vi.fn(async () => createStatsSnapshot())
    const getProviderUsage = vi.fn(async () => ({}))
    const tokenGetSnapshot = vi.fn(async () => ({ computedAt: '2026-04-03T00:00:00.000Z' }))
    const tokenGetWorkerPage = vi.fn(async () => ({ computedAt: '2026-04-03T00:00:00.000Z', items: [], nextCursor: null, totalCount: 0 }))
    const tokenGetWorkerEvents = vi.fn(async () => ({ computedAt: '2026-04-03T00:00:00.000Z', worker: {}, events: [] }))
    const server = await createRouteServer(
      { getSnapshot, refreshAllRangesInBackground, getProviderUsage },
      { getSnapshot: tokenGetSnapshot, getWorkerPage: tokenGetWorkerPage, getWorkerEvents: tokenGetWorkerEvents },
    )

    const snapshotResponse = await fetch(
      `${server.baseUrl}/api/stats/tokens?rangePreset=custom&startDate=2026-04-01&endDate=2026-04-03&tz=UTC&provider=openai-codex`,
    )
    expect(snapshotResponse.status).toBe(200)
    expect(tokenGetSnapshot).toHaveBeenCalledWith({
      rangePreset: 'custom',
      startDate: '2026-04-01',
      endDate: '2026-04-03',
      timezone: 'UTC',
      profileId: undefined,
      provider: 'openai-codex',
      modelId: undefined,
      attribution: 'all',
      specialistId: undefined,
    })

    const refreshResponse = await fetch(`${server.baseUrl}/api/stats/tokens/refresh?rangePreset=all`, { method: 'POST' })
    expect(refreshResponse.status).toBe(200)
    expect(tokenGetSnapshot).toHaveBeenNthCalledWith(2, {
      rangePreset: 'all',
      startDate: undefined,
      endDate: undefined,
      timezone: null,
      profileId: undefined,
      provider: undefined,
      modelId: undefined,
      attribution: 'all',
      specialistId: undefined,
    }, { forceRefresh: true })

    const pageResponse = await fetch(
      `${server.baseUrl}/api/stats/tokens/workers?rangePreset=7d&sort=totalTokens&direction=desc&limit=10&cursor=abc123`,
    )
    expect(pageResponse.status).toBe(200)
    expect(tokenGetWorkerPage).toHaveBeenCalledWith({
      rangePreset: '7d',
      startDate: undefined,
      endDate: undefined,
      timezone: null,
      profileId: undefined,
      provider: undefined,
      modelId: undefined,
      attribution: 'all',
      specialistId: undefined,
      limit: 10,
      cursor: 'abc123',
      sort: 'totalTokens',
      direction: 'desc',
    })

    const workerEventsResponse = await fetch(
      `${server.baseUrl}/api/stats/tokens/worker-events?profileId=alpha&sessionId=s1&workerId=w1`,
    )
    expect(workerEventsResponse.status).toBe(200)
    expect(tokenGetWorkerEvents).toHaveBeenCalledWith({
      profileId: 'alpha',
      sessionId: 's1',
      workerId: 'w1',
    })
  })

  it('returns 400 for contradictory specialistId and attribution params', async () => {
    const getSnapshot = vi.fn(async () => createStatsSnapshot())
    const refreshAllRangesInBackground = vi.fn(async () => createStatsSnapshot())
    const getProviderUsage = vi.fn(async () => ({}))
    const tokenGetSnapshot = vi.fn(async () => ({ computedAt: '2026-04-03T00:00:00.000Z' }))
    const server = await createRouteServer(
      { getSnapshot, refreshAllRangesInBackground, getProviderUsage },
      { getSnapshot: tokenGetSnapshot, getWorkerPage: vi.fn(), getWorkerEvents: vi.fn() },
    )

    const response = await fetch(`${server.baseUrl}/api/stats/tokens?rangePreset=all&attribution=ad_hoc&specialistId=backend`)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'specialistId cannot be combined with attribution=ad_hoc; use attribution=all or attribution=specialist',
    })
    expect(tokenGetSnapshot).not.toHaveBeenCalled()
  })

  it('returns 400 for custom token ranges with missing dates', async () => {
    const getSnapshot = vi.fn(async () => createStatsSnapshot())
    const refreshAllRangesInBackground = vi.fn(async () => createStatsSnapshot())
    const getProviderUsage = vi.fn(async () => ({}))
    const tokenGetSnapshot = vi.fn(async () => ({ computedAt: '2026-04-03T00:00:00.000Z' }))
    const server = await createRouteServer(
      { getSnapshot, refreshAllRangesInBackground, getProviderUsage },
      { getSnapshot: tokenGetSnapshot, getWorkerPage: vi.fn(), getWorkerEvents: vi.fn() },
    )

    const response = await fetch(`${server.baseUrl}/api/stats/tokens?rangePreset=custom&startDate=2026-04-01`)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'custom rangePreset requires startDate and endDate',
    })
    expect(tokenGetSnapshot).not.toHaveBeenCalled()
  })
})

async function createRouteServer(
  statsService: {
    getSnapshot: (range: string, options?: Record<string, unknown>) => Promise<StatsSnapshot>
    refreshAllRangesInBackground: () => Promise<StatsSnapshot | null>
    getProviderUsage: () => Promise<Record<string, unknown>>
  },
  tokenAnalyticsService: {
    getSnapshot: (...args: unknown[]) => Promise<Record<string, unknown>>
    getWorkerPage: (...args: unknown[]) => Promise<Record<string, unknown>>
    getWorkerEvents: (...args: unknown[]) => Promise<Record<string, unknown>>
  } = {
    getSnapshot: async () => ({ computedAt: '2026-04-03T00:00:00.000Z' }),
    getWorkerPage: async () => ({ computedAt: '2026-04-03T00:00:00.000Z', items: [], nextCursor: null, totalCount: 0 }),
    getWorkerEvents: async () => ({ computedAt: '2026-04-03T00:00:00.000Z', worker: {}, events: [] }),
  },
): Promise<TestServer> {
  const routes = createStatsRoutes({
    statsService: statsService as never,
    tokenAnalyticsService: tokenAnalyticsService as never,
  })
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine stats route server address')
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }

  activeServers.push(testServer)
  return testServer
}

async function handleRouteRequest(
  routes: ReturnType<typeof createStatsRoutes>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const route = routes.find((entry) => entry.matches(requestUrl.pathname))

  if (!route) {
    response.statusCode = 404
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ error: 'Not Found' }))
    return
  }

  try {
    await route.handle(request, response, requestUrl)
  } catch (error) {
    response.statusCode = 500
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unexpected route error' }))
  }
}

function createStatsSnapshot(): StatsSnapshot {
  return {
    computedAt: '2026-04-03T00:00:00.000Z',
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
