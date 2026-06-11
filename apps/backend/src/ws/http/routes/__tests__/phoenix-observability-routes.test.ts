import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PhoenixObservabilitySettings, PhoenixObservabilitySettingsPatch, PhoenixObservabilityStatus, PhoenixObservabilityTestResponse } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  makeP0HttpRouteTempConfig as makeTempConfig,
} from '../../../../test-support/ws-integration-harness.js'
import { ObservabilityService } from '../../../../observability/observability-service.js'
import type { ObservabilityFacade } from '../../../../observability/observability-types.js'
import { createDefaultPhoenixObservabilitySettings } from '../../../../observability/observability-settings.js'
import { sendJson } from '../../../http-utils.js'
import { SwarmWebSocketServer } from '../../../server.js'
import { createPhoenixObservabilityRoutes } from '../phoenix-observability-routes.js'
import type { HttpRoute } from '../../shared/http-route.js'

const activeServers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
})

describe('createPhoenixObservabilityRoutes', () => {
  it('serves settings and status for Builder runtime', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-phoenix-routes-'))
    const service = new ObservabilityService({ dataDir, runtimeTarget: 'builder' })
    await service.initialize()
    const server = await createRouteServer(createPhoenixObservabilityRoutes({ observabilityService: service, runtimeTarget: 'builder' }))

    const response = await fetch(`${server.baseUrl}/api/phoenix-observability/settings`)
    const body = await response.json() as { settings: PhoenixObservabilitySettings; status: PhoenixObservabilityStatus }

    expect(response.status).toBe(200)
    expect(body.settings.enabled).toBe(false)
    expect(body.status.runtimeTarget).toBe('builder')
  })

  it('rejects non-loopback endpoints on save', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-phoenix-routes-'))
    const service = new ObservabilityService({ dataDir, runtimeTarget: 'builder' })
    await service.initialize()
    const server = await createRouteServer(createPhoenixObservabilityRoutes({ observabilityService: service, runtimeTarget: 'builder' }))

    const response = await fetch(`${server.baseUrl}/api/phoenix-observability/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, endpoint: 'https://example.com/v1/traces' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('http:// loopback') })
  })

  it('defensively hides routes for collaboration runtime', async () => {
    const service = new FakeObservabilityService('collaboration-server')
    const server = await createRouteServer(createPhoenixObservabilityRoutes({ observabilityService: service, runtimeTarget: 'collaboration-server' }))

    const response = await fetch(`${server.baseUrl}/api/phoenix-observability/status`)

    expect(response.status).toBe(404)
  })

  it('SwarmWebSocketServer fallback uses an explicit no-op facade instead of owning a real service', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()
    try {
      const getResponse = await fetch(`http://${config.host}:${config.port}/api/phoenix-observability/settings`)
      const getBody = await getResponse.json() as { status: PhoenixObservabilityStatus }
      expect(getResponse.status).toBe(200)
      expect(getBody.status.exporter.configured).toBe(false)

      const putResponse = await fetch(`http://${config.host}:${config.port}/api/phoenix-observability/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:6006/v1/traces' }),
      })
      expect(putResponse.status).toBe(400)
      await expect(putResponse.json()).resolves.toMatchObject({ error: expect.stringContaining('not available') })
    } finally {
      await server.stop()
    }
  })

  it('invokes testConnection only for explicit POST test requests', async () => {
    const service = new FakeObservabilityService('builder')
    const server = await createRouteServer(createPhoenixObservabilityRoutes({ observabilityService: service, runtimeTarget: 'builder' }))

    const response = await fetch(`${server.baseUrl}/api/phoenix-observability/test`, { method: 'POST' })
    const body = await response.json() as PhoenixObservabilityTestResponse

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(service.testConnection).toHaveBeenCalledTimes(1)
  })
})

class FakeObservabilityService implements ObservabilityFacade {
  readonly settings = createDefaultPhoenixObservabilitySettings()
  readonly testConnection = vi.fn(async () => ({ ok: true, status: this.getStatus() }))

  constructor(private readonly runtimeTarget: PhoenixObservabilityStatus['runtimeTarget']) {}

  async initialize(): Promise<void> {}
  async getSettings(): Promise<PhoenixObservabilitySettings> { return this.settings }
  async updateSettings(patch: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilitySettings> {
    Object.assign(this.settings, patch)
    return this.settings
  }
  getStatus(): PhoenixObservabilityStatus {
    return {
      enabled: this.settings.enabled,
      runtimeTarget: this.runtimeTarget,
      contentMode: this.settings.contentMode,
      exporter: {
        configured: false,
        active: false,
        endpoint: this.settings.endpoint,
        projectName: this.settings.projectName ?? 'default',
        lastSuccessfulExportAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
      counters: {
        spansStarted: 0,
        spansEnded: 0,
        accepted: 0,
        droppedQueueFull: 0,
        exportSucceeded: 0,
        exportFailed: 0,
        contentTruncations: 0,
        redactionMatches: 0,
        correlationMisses: 0,
        correlationEvictions: 0,
      },
    }
  }
  recordPromptResolved(): void {}
  recordRuntimeCreated(): void {}
  beginRuntimeInput(): undefined { return undefined }
  completeRuntimeInput(): void {}
  cancelRuntimeInput(): void {}
  recordRuntimeInput(): undefined { return undefined }
  recordRuntimeSessionEvent(): void {}
  recordToolSideEffect(): void {}
  recordFeedback(): void {}
  async shutdown(): Promise<void> {}
}

async function createRouteServer(routes: HttpRoute[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const httpServer = createServer((request, response) => {
    void handleRoute(routes, request, response)
  })

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve test server address')
  }

  const server = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
  activeServers.push(server)
  return server
}

async function handleRoute(routes: HttpRoute[], request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname))
  if (!route) {
    response.statusCode = 404
    response.end()
    return
  }

  try {
    await route.handle(request, response, requestUrl)
  } catch (error) {
    if (response.writableEnded || response.headersSent) {
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    sendJson(response, 500, { error: message })
  }
}
