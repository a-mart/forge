import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ApiProxyCommand, FeedbackSubmitEvent } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObservabilityFacade } from '../observability-types.js'
import { createDefaultPhoenixObservabilitySettings } from '../observability-settings.js'
import { FeedbackService } from '../../swarm/feedback-service.js'
import { sendJson } from '../../ws/http-utils.js'
import { createFeedbackRoutes } from '../../ws/http/routes/feedback-routes.js'
import type { HttpRoute } from '../../ws/http/shared/http-route.js'
import { WsApiProxy } from '../../ws/ws-api-proxy.js'

const activeServers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
})

describe('FeedbackService observability injection', () => {
  it('records submitted feedback exactly once after persistence', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-feedback-observability-'))
    const observability = createFakeObservability()
    const feedbackService = new FeedbackService(dataDir, { observability })

    const submitted = await feedbackService.submitFeedback({
      profileId: 'profile-1',
      sessionId: 'session-1',
      scope: 'message',
      targetId: 'message-1',
      value: 'up',
      reasonCodes: [],
      comment: '',
      channel: 'web',
      actor: 'user',
    })

    expect(submitted.id).toBeTruthy()
    expect(observability.recordFeedback).toHaveBeenCalledTimes(1)
    expect(observability.recordFeedback).toHaveBeenCalledWith(expect.objectContaining({ id: submitted.id }))
  })

  it('HTTP feedback routes use the injected shared feedback service path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-feedback-observability-'))
    const observability = createFakeObservability()
    const feedbackService = new FeedbackService(dataDir, { observability })
    const swarmManager = createFeedbackSwarmManager(dataDir)
    const server = await createRouteServer(createFeedbackRoutes({ swarmManager: swarmManager as never, feedbackService }))

    const response = await fetch(`${server.baseUrl}/api/v1/profiles/profile-1/sessions/session-1/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'message', targetId: 'message-1', value: 'up', reasonCodes: [], channel: 'web' }),
    })

    expect(response.status).toBe(201)
    expect(observability.recordFeedback).toHaveBeenCalledTimes(1)
  })

  it('api proxy feedback uses the injected shared feedback service path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-feedback-observability-'))
    const observability = createFakeObservability()
    const feedbackService = new FeedbackService(dataDir, { observability })
    const swarmManager = createFeedbackSwarmManager(dataDir)
    const proxy = new WsApiProxy({
      swarmManager: swarmManager as never,
      mobilePushService: {} as never,
      feedbackService,
      terminalService: null,
      unreadTracker: null,
    })

    const command: ApiProxyCommand = {
      type: 'api_proxy',
      requestId: 'req-1',
      method: 'POST',
      path: '/api/feedback',
      body: JSON.stringify({ scope: 'message', targetId: 'message-1', value: 'down', reasonCodes: [], channel: 'web' }),
    }

    const response = await proxy.routeApiProxyCommand(command, 'session-1')

    expect(response.status).toBe(201)
    expect(observability.recordFeedback).toHaveBeenCalledTimes(1)
  })

  it('api proxy does not expose Phoenix observability settings routes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-feedback-observability-'))
    const proxy = new WsApiProxy({
      swarmManager: { getConfig: () => ({ paths: { dataDir } }) } as never,
      mobilePushService: {} as never,
      feedbackService: new FeedbackService(dataDir),
      terminalService: null,
      unreadTracker: null,
    })

    const response = await proxy.routeApiProxyCommand({
      type: 'api_proxy',
      requestId: 'req-2',
      method: 'GET',
      path: '/api/phoenix-observability/settings',
    }, 'session-1')

    expect(response.status).toBe(404)
    expect(response.body).toContain('Unsupported api proxy path')
  })
})

function createFeedbackSwarmManager(dataDir: string): { getAgent: (agentId: string) => unknown; getConfig: () => { paths: { dataDir: string } } } {
  return {
    getAgent: (agentId: string) => agentId === 'session-1' ? { agentId: 'session-1', role: 'manager', profileId: 'profile-1' } : undefined,
    getConfig: () => ({ paths: { dataDir } }),
  }
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

function createFakeObservability(): ObservabilityFacade & { recordFeedback: ReturnType<typeof vi.fn<[FeedbackSubmitEvent], void>> } {
  const settings = createDefaultPhoenixObservabilitySettings()
  return {
    initialize: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => settings),
    getStatus: vi.fn(() => ({
      enabled: false,
      runtimeTarget: 'builder',
      contentMode: 'rich',
      exporter: {
        configured: false,
        active: false,
        endpoint: settings.endpoint,
        projectName: 'default',
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
    })),
    testConnection: vi.fn(async () => ({ ok: true, status: {} as never })),
    recordFeedback: vi.fn<[FeedbackSubmitEvent], void>(),
    shutdown: vi.fn(async () => undefined),
  }
}
