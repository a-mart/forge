import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { StatsSnapshot, TelemetryPayload } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTelemetryConfigPath } from '../../swarm/data-paths.js'
import { TelemetryService } from '../telemetry-service.js'
import { createTelemetryRoutes } from '../../ws/routes/telemetry-routes.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
}

interface TestServer {
  baseUrl: string
  close: () => Promise<void>
}

interface TelemetryConfigFile {
  enabled: boolean
  installId: string
  lastSuccessfulSendAt: string | null
  lastFailedAttemptAt: string | null
}

const activeDataRoots: string[] = []
const activeServers: TestServer[] = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
  await Promise.all(activeDataRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.useRealTimers()
  delete process.env.FORGE_TELEMETRY
  delete process.env.MIDDLEMAN_TELEMETRY
})

describe('TelemetryService', () => {
  it('initializes enabled telemetry on first run with split success/failure timestamps', async () => {
    const dataDir = await createDataDir('telemetry-first-run-')
    const service = createService({ dataDir })

    const settings = await service.readSettings()
    const config = await readConfig(dataDir)

    expect(settings.enabled).toBe(true)
    expect(settings.effectiveEnabled).toBe(true)
    expect(settings.source).toBe('settings')
    expect(settings.envOverride).toBeNull()
    expect(settings.lastSentAt).toBeNull()
    expect(settings.installId).toMatch(UUID_RE)

    expect(config.enabled).toBe(true)
    expect(config.installId).toBe(settings.installId)
    expect(config.lastSuccessfulSendAt).toBeNull()
    expect(config.lastFailedAttemptAt).toBeNull()
  })

  it('serializes stats-refresh send and config updates so enabled=false is not lost', async () => {
    const dataDir = await createDataDir('telemetry-serialize-')
    const sendStarted = createDeferred<void>()
    const releaseSend = createDeferred<void>()

    const service = createService({
      dataDir,
      sendPayload: async () => {
        sendStarted.resolve()
        await releaseSend.promise
        return true
      },
    })

    await service.readSettings()
    const sendPromise = service.sendOnStatsRefresh(createStatsSnapshot())
    await sendStarted.promise

    let updateResolved = false
    const updatePromise = service.updateConfig({ enabled: false }).then((result) => {
      updateResolved = true
      return result
    })

    await Promise.resolve()
    expect(updateResolved).toBe(false)

    releaseSend.resolve()
    expect(await sendPromise).toBe(true)
    const updated = await updatePromise
    const config = await readConfig(dataDir)

    expect(updated.enabled).toBe(false)
    expect(config.enabled).toBe(false)
    expect(config.lastSuccessfulSendAt).toMatch(ISO_TIMESTAMP_RE)
    expect(config.lastFailedAttemptAt).toBeNull()
  })

  it('coalesces concurrent stats refresh sends with queueing + persisted 2-hour success cap', async () => {
    const dataDir = await createDataDir('telemetry-concurrent-refresh-')
    let senderCalls = 0
    const service = createService({
      dataDir,
      sendPayload: async () => {
        senderCalls += 1
        return true
      },
    })

    const stats = createStatsSnapshot()
    const [first, second] = await Promise.all([
      service.sendOnStatsRefresh(stats),
      service.sendOnStatsRefresh(stats),
    ])

    const config = await readConfig(dataDir)
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(senderCalls).toBe(1)
    expect(config.lastSuccessfulSendAt).toMatch(ISO_TIMESTAMP_RE)
    expect(config.lastFailedAttemptAt).toBeNull()
  })

  it('enforces the 2-hour success cap across service restarts', async () => {
    const dataDir = await createDataDir('telemetry-restart-success-cap-')
    let senderCalls = 0
    const firstService = createService({
      dataDir,
      sendPayload: async () => {
        senderCalls += 1
        return true
      },
    })

    expect(await firstService.sendOnStatsRefresh(createStatsSnapshot())).toBe(true)

    const restartedService = createService({
      dataDir,
      sendPayload: async () => {
        senderCalls += 1
        return true
      },
    })

    expect(await restartedService.sendOnStatsRefresh(createStatsSnapshot())).toBe(false)

    const config = await readConfig(dataDir)
    expect(senderCalls).toBe(1)
    expect(config.lastSuccessfulSendAt).toMatch(ISO_TIMESTAMP_RE)
    expect(config.lastFailedAttemptAt).toBeNull()
  })

  it('uses failure backoff separately from success cap and clears failure state after a later success', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T00:00:00.000Z'))

    const dataDir = await createDataDir('telemetry-failure-backoff-')
    let senderCalls = 0
    const service = createService({
      dataDir,
      sendPayload: async () => {
        senderCalls += 1
        return senderCalls > 1
      },
    })

    expect(await service.sendOnStatsRefresh(createStatsSnapshot())).toBe(false)
    expect(senderCalls).toBe(1)

    expect(await service.sendOnStatsRefresh(createStatsSnapshot())).toBe(false)
    expect(senderCalls).toBe(1)

    vi.setSystemTime(new Date('2026-04-03T00:09:59.000Z'))
    expect(await service.sendOnStatsRefresh(createStatsSnapshot())).toBe(false)
    expect(senderCalls).toBe(1)

    vi.setSystemTime(new Date('2026-04-03T00:10:01.000Z'))
    expect(await service.sendOnStatsRefresh(createStatsSnapshot())).toBe(true)
    expect(senderCalls).toBe(2)

    const config = await readConfig(dataDir)
    expect(config.lastSuccessfulSendAt).toBe('2026-04-03T00:10:01.000Z')
    expect(config.lastFailedAttemptAt).toBeNull()
  })

  it('skips stats-refresh telemetry when no all-range stats snapshot is available', async () => {
    const dataDir = await createDataDir('telemetry-missing-stats-')
    let assemblerCalls = 0
    let senderCalls = 0
    const service = createService({
      dataDir,
      assemblePayload: async (installId) => {
        assemblerCalls += 1
        return createPayload(installId)
      },
      sendPayload: async () => {
        senderCalls += 1
        return true
      },
    })

    expect(await service.sendOnStatsRefresh(null)).toBe(false)
    expect(assemblerCalls).toBe(0)
    expect(senderCalls).toBe(0)
  })

  it('skips all telemetry work when disabled by persisted config', async () => {
    const dataDir = await createDataDir('telemetry-disabled-config-')
    let assemblerCalls = 0
    let senderCalls = 0
    const service = createService({
      dataDir,
      assemblePayload: async (installId) => {
        assemblerCalls += 1
        return createPayload(installId)
      },
      sendPayload: async () => {
        senderCalls += 1
        return true
      },
    })

    await service.updateConfig({ enabled: false })
    await service.sendOnStatsRefresh(createStatsSnapshot())

    const config = await readConfig(dataDir)
    expect(assemblerCalls).toBe(0)
    expect(senderCalls).toBe(0)
    expect(config.enabled).toBe(false)
    expect(config.lastSuccessfulSendAt).toBeNull()
    expect(config.lastFailedAttemptAt).toBeNull()
  })

  it('skips file reads and sends when disabled by env override', async () => {
    const dataDir = await createDataDir('telemetry-disabled-env-')
    process.env.FORGE_TELEMETRY = 'false'

    let assemblerCalls = 0
    let senderCalls = 0
    const service = createService({
      dataDir,
      assemblePayload: async (installId) => {
        assemblerCalls += 1
        return createPayload(installId)
      },
      sendPayload: async () => {
        senderCalls += 1
        return true
      },
    })

    await service.sendOnStatsRefresh(createStatsSnapshot())

    expect(assemblerCalls).toBe(0)
    expect(senderCalls).toBe(0)
    await expect(readFile(getTelemetryConfigPath(dataDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows env override to force telemetry on even when persisted config is disabled', async () => {
    const dataDir = await createDataDir('telemetry-enabled-env-')
    let senderCalls = 0
    const service = createService({
      dataDir,
      sendPayload: async () => {
        senderCalls += 1
        return true
      },
    })

    await service.updateConfig({ enabled: false })
    process.env.FORGE_TELEMETRY = 'true'

    await service.sendOnStatsRefresh(createStatsSnapshot())

    const config = await readConfig(dataDir)
    expect(senderCalls).toBe(1)
    expect(config.enabled).toBe(false)
    expect(config.lastSuccessfulSendAt).toMatch(ISO_TIMESTAMP_RE)
    expect(config.lastFailedAttemptAt).toBeNull()
  })

  it('migrates legacy telemetry timestamps into split success/failure fields', async () => {
    const dataDir = await createDataDir('telemetry-legacy-migration-')
    const configPath = getTelemetryConfigPath(dataDir)
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify(
        {
          enabled: true,
          installId: 'install-legacy',
          lastSentAt: '2026-04-03T00:00:00.000Z',
          lastAttemptedAt: '2026-04-03T00:15:00.000Z',
        },
        null,
        2,
      ),
      'utf8',
    )

    const service = createService({ dataDir })
    const settings = await service.readSettings()
    const config = await readConfig(dataDir)

    expect(settings.installId).toBe('install-legacy')
    expect(config.lastSuccessfulSendAt).toBe('2026-04-03T00:00:00.000Z')
    expect(config.lastFailedAttemptAt).toBe('2026-04-03T00:15:00.000Z')
  })

  it('recovers from corrupt telemetry.json by rewriting defaults', async () => {
    const dataDir = await createDataDir('telemetry-corrupt-')
    const configPath = getTelemetryConfigPath(dataDir)
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '{invalid json', 'utf8')

    const service = createService({ dataDir })
    const settings = await service.readSettings()
    const config = await readConfig(dataDir)

    expect(settings.enabled).toBe(true)
    expect(settings.installId).toMatch(UUID_RE)
    expect(settings.lastSentAt).toBeNull()
    expect(config.enabled).toBe(true)
    expect(config.installId).toBe(settings.installId)
    expect(config.lastSuccessfulSendAt).toBeNull()
    expect(config.lastFailedAttemptAt).toBeNull()
  })
})

describe('telemetry routes', () => {
  it('serves GET, PUT, and send-now responses', async () => {
    const dataDir = await createDataDir('telemetry-routes-')
    const service = createService({ dataDir, sendPayload: async () => true })
    const server = await createRouteServer(service)

    const initialResponse = await fetch(`${server.baseUrl}/api/settings/telemetry`)
    expect(initialResponse.status).toBe(200)
    const initialPayload = (await initialResponse.json()) as { settings?: { installId?: string; enabled?: boolean } }
    expect(initialPayload.settings?.enabled).toBe(true)
    expect(initialPayload.settings?.installId).toMatch(UUID_RE)

    const updateResponse = await fetch(`${server.baseUrl}/api/settings/telemetry`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(updateResponse.status).toBe(200)
    const updatePayload = (await updateResponse.json()) as { ok?: boolean; settings?: { enabled?: boolean } }
    expect(updatePayload.ok).toBe(true)
    expect(updatePayload.settings?.enabled).toBe(false)

    process.env.FORGE_TELEMETRY = 'true'
    const sendNowResponse = await fetch(`${server.baseUrl}/api/telemetry/send-now`, {
      method: 'POST',
    })
    expect(sendNowResponse.status).toBe(200)
    const sendNowPayload = (await sendNowResponse.json()) as { ok?: boolean; sent?: boolean }
    expect(sendNowPayload).toEqual({ ok: true, sent: true })
  })
})

async function createDataDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const dataDir = join(root, 'data')
  activeDataRoots.push(root)
  return dataDir
}

function createService(options: {
  dataDir: string
  assemblePayload?: (
    installId: string,
    context: { reportId: string; stats?: StatsSnapshot | null },
  ) => Promise<TelemetryPayload>
  sendPayload?: (payload: TelemetryPayload) => Promise<boolean>
}): TelemetryService {
  return new TelemetryService({
    dataDir: options.dataDir,
    debug: false,
    assemblePayload: options.assemblePayload ?? (async (installId, context) => createPayload(installId, context.reportId)),
    sendPayload: options.sendPayload,
  })
}

function createPayload(installId: string, reportId = 'report-1'): TelemetryPayload {
  return {
    install_id: installId,
    report_id: reportId,
    schema_version: 1,
    snapshot_computed_at: '2026-04-03T00:00:00.000Z',
    app_version: '0.0.0',
    platform: 'darwin',
    arch: 'arm64',
    node_version: 'v22.0.0',
    electron_version: null,
    is_desktop: false,
    locale: 'en',
    total_profiles: 0,
    total_sessions: 0,
    total_messages_sent: 0,
    total_workers_run: 0,
    tokens_all_time: 0,
    tokens_last_30_days: 0,
    cache_hit_rate: 0,
    active_days: 0,
    longest_streak: 0,
    commits: 0,
    lines_added: 0,
    average_tokens_per_run: 0,
    specialists_configured: 0,
    specialists_persisted_count: 0,
    specialists_custom_count: 0,
    specialists_enabled_count: 0,
    terminals_active: 0,
    pinned_messages_used: 0,
    scheduled_tasks_count: 0,
    telegram_configured: false,
    playwright_enabled: false,
    forked_sessions_count: 0,
    project_agents_count: 0,
    project_agents_persisted_count: 0,
    extensions_loaded: 0,
    extensions_discovered_count: 0,
    skills_configured: 0,
    skills_discovered_count: 0,
    reference_docs_count: 0,
    slash_commands_count: 0,
    cortex_auto_review_enabled: false,
    mobile_devices_registered: 0,
    mobile_devices_enabled_count: 0,
    providers_used: '',
    auth_providers: '',
    top_model: '',
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

async function readConfig(dataDir: string): Promise<TelemetryConfigFile> {
  const raw = await readFile(getTelemetryConfigPath(dataDir), 'utf8')
  return JSON.parse(raw) as TelemetryConfigFile
}

async function createRouteServer(service: TelemetryService): Promise<TestServer> {
  const routes = createTelemetryRoutes({ telemetryService: service })
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine telemetry route server address')
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
  routes: ReturnType<typeof createTelemetryRoutes>,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
