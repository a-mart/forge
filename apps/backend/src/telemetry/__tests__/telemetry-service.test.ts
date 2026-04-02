import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TelemetryPayload } from '@forge/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { getTelemetryConfigPath } from '../../swarm/data-paths.js'
import { TelemetryService } from '../telemetry-service.js'
import { createTelemetryRoutes } from '../../ws/routes/telemetry-routes.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

interface TestServer {
  baseUrl: string
  close: () => Promise<void>
}

const activeDataRoots: string[] = []
const activeServers: TestServer[] = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
  await Promise.all(activeDataRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  delete process.env.FORGE_TELEMETRY
  delete process.env.MIDDLEMAN_TELEMETRY
})

describe('TelemetryService', () => {
  it('initializes enabled telemetry on first run and persists telemetry.json', async () => {
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
    expect(config.lastSentAt).toBeNull()
  })

  it('serializes send and config updates so enabled=false is not overwritten by lastSentAt writes', async () => {
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
    const sendPromise = service.sendIfDue()
    await sendStarted.promise

    let updateResolved = false
    const updatePromise = service.updateConfig({ enabled: false }).then((result) => {
      updateResolved = true
      return result
    })

    await Promise.resolve()
    expect(updateResolved).toBe(false)

    releaseSend.resolve()
    await sendPromise
    const updated = await updatePromise
    const config = await readConfig(dataDir)

    expect(updated.enabled).toBe(false)
    expect(config.enabled).toBe(false)
    expect(config.lastSentAt).toMatch(ISO_TIMESTAMP_RE)
  })

  it('resetInstallId regenerates the ID and clears lastSentAt', async () => {
    const dataDir = await createDataDir('telemetry-reset-')
    await writeTelemetryConfig(dataDir, {
      enabled: true,
      installId: 'install-old',
      lastSentAt: '2026-04-01T00:00:00.000Z',
    })

    const service = createService({ dataDir })
    const settings = await service.resetInstallId()
    const config = await readConfig(dataDir)

    expect(settings.installId).not.toBe('install-old')
    expect(settings.installId).toMatch(UUID_RE)
    expect(settings.lastSentAt).toBeNull()
    expect(config.installId).toBe(settings.installId)
    expect(config.lastSentAt).toBeNull()
  })

  it('forceSend shares the serialized send lock with sendIfDue', async () => {
    const dataDir = await createDataDir('telemetry-force-send-')
    const firstStarted = createDeferred<void>()
    const secondStarted = createDeferred<void>()
    const releaseFirst = createDeferred<void>()
    const releaseSecond = createDeferred<void>()
    let sendCount = 0
    let activeSends = 0
    let maxActiveSends = 0

    const service = createService({
      dataDir,
      sendPayload: async () => {
        sendCount += 1
        activeSends += 1
        maxActiveSends = Math.max(maxActiveSends, activeSends)

        if (sendCount === 1) {
          firstStarted.resolve()
          await releaseFirst.promise
        } else {
          secondStarted.resolve()
          await releaseSecond.promise
        }

        activeSends -= 1
        return true
      },
    })

    await service.readSettings()
    const scheduledSend = service.sendIfDue()
    await firstStarted.promise

    const forcedSend = service.forceSend()
    await Promise.resolve()
    expect(sendCount).toBe(1)

    releaseFirst.resolve()
    await secondStarted.promise
    expect(maxActiveSends).toBe(1)

    releaseSecond.resolve()
    await Promise.all([scheduledSend, forcedSend])

    const config = await readConfig(dataDir)
    expect(sendCount).toBe(2)
    expect(config.lastSentAt).toMatch(ISO_TIMESTAMP_RE)
  })

  it('sendIfDue works without calling start()', async () => {
    const dataDir = await createDataDir('telemetry-direct-send-')
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

    await service.sendIfDue()
    const config = await readConfig(dataDir)

    expect(assemblerCalls).toBe(1)
    expect(senderCalls).toBe(1)
    expect(config.lastSentAt).toMatch(ISO_TIMESTAMP_RE)
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
    await service.sendIfDue()

    const config = await readConfig(dataDir)
    expect(assemblerCalls).toBe(0)
    expect(senderCalls).toBe(0)
    expect(config.enabled).toBe(false)
    expect(config.lastSentAt).toBeNull()
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

    await service.sendIfDue()

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

    await service.sendIfDue()

    const config = await readConfig(dataDir)
    expect(senderCalls).toBe(1)
    expect(config.enabled).toBe(false)
    expect(config.lastSentAt).toMatch(ISO_TIMESTAMP_RE)
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
  })
})

describe('telemetry routes', () => {
  it('serves GET, PUT, reset-id, and send-now responses', async () => {
    const dataDir = await createDataDir('telemetry-routes-')
    const service = createService({ dataDir, sendPayload: async () => true })
    const server = await createRouteServer(service)

    const initialResponse = await fetch(`${server.baseUrl}/api/settings/telemetry`)
    expect(initialResponse.status).toBe(200)
    const initialPayload = (await initialResponse.json()) as { settings?: { installId?: string; enabled?: boolean } }
    expect(initialPayload.settings?.enabled).toBe(true)
    const initialInstallId = initialPayload.settings?.installId
    expect(initialInstallId).toMatch(UUID_RE)

    const updateResponse = await fetch(`${server.baseUrl}/api/settings/telemetry`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(updateResponse.status).toBe(200)
    const updatePayload = (await updateResponse.json()) as { ok?: boolean; settings?: { enabled?: boolean } }
    expect(updatePayload.ok).toBe(true)
    expect(updatePayload.settings?.enabled).toBe(false)

    const resetResponse = await fetch(`${server.baseUrl}/api/telemetry/reset-id`, {
      method: 'POST',
    })
    expect(resetResponse.status).toBe(200)
    const resetPayload = (await resetResponse.json()) as {
      ok?: boolean
      settings?: { installId?: string; lastSentAt?: string | null }
    }
    expect(resetPayload.ok).toBe(true)
    expect(resetPayload.settings?.installId).toMatch(UUID_RE)
    expect(resetPayload.settings?.installId).not.toBe(initialInstallId)
    expect(resetPayload.settings?.lastSentAt).toBeNull()

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
  assemblePayload?: (installId: string) => Promise<TelemetryPayload>
  sendPayload?: (payload: TelemetryPayload) => Promise<boolean>
}): TelemetryService {
  return new TelemetryService({
    dataDir: options.dataDir,
    debug: false,
    assemblePayload: options.assemblePayload ?? (async (installId) => createPayload(installId)),
    sendPayload: options.sendPayload,
  })
}

function createPayload(installId: string): TelemetryPayload {
  return {
    install_id: installId,
    schema_version: 1,
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
    terminals_active: 0,
    pinned_messages_used: 0,
    scheduled_tasks_count: 0,
    telegram_configured: false,
    playwright_enabled: false,
    forked_sessions_count: 0,
    project_agents_count: 0,
    extensions_loaded: 0,
    skills_configured: 0,
    reference_docs_count: 0,
    slash_commands_count: 0,
    cortex_auto_review_enabled: false,
    mobile_devices_registered: 0,
    providers_used: '',
    auth_providers: '',
    top_model: '',
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function writeTelemetryConfig(
  dataDir: string,
  value: { enabled: boolean; installId: string; lastSentAt: string | null },
): Promise<void> {
  const configPath = getTelemetryConfigPath(dataDir)
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(value, null, 2), 'utf8')
}

async function readConfig(dataDir: string): Promise<{
  enabled: boolean
  installId: string
  lastSentAt: string | null
}> {
  const raw = await readFile(getTelemetryConfigPath(dataDir), 'utf8')
  return JSON.parse(raw) as { enabled: boolean; installId: string; lastSentAt: string | null }
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
