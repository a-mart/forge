import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  makeP0HttpRouteTempConfig as makeTempConfig,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
} from '../../../../test-support/ws-integration-harness.js'
import { resetOpenAICodexWebSocketConstructorDiagnosticsForTest } from '../../../../swarm/runtime-utils.js'
import { SwarmWebSocketServer } from '../../../server.js'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.FORGE_CODEX_TRANSPORT_DEBUG
  delete process.env.FORGE_OPENAI_CODEX_TRANSPORT
  resetOpenAICodexWebSocketConstructorDiagnosticsForTest()
})

describe('SwarmWebSocketServer P0 endpoints', () => {
  it('returns 404 for disabled GET /api/debug/codex-transport', async () => {
    process.env.FORGE_CODEX_TRANSPORT_DEBUG = '0'
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
      const response = await fetch(`http://${config.host}:${config.port}/api/debug/codex-transport`)
      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('exposes sanitized codex transport diagnostics when enabled', async () => {
    process.env.FORGE_CODEX_TRANSPORT_DEBUG = '1'
    process.env.FORGE_OPENAI_CODEX_TRANSPORT = 'definitely-not-a-transport'

    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir, 'manager')]) as FakeSwarmManager & {
      getCodexTransportDebugDiagnostics: () => unknown[]
    }
    manager.getCodexTransportDebugDiagnostics = () => [
      {
        agentId: 'manager',
        agentIdHash: '5c788b3055066dd1',
        role: 'manager',
        status: 'idle',
        modelId: 'gpt-5.5',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
        selectedConfigTransport: 'sse',
        runtimeAvailable: true,
        runtimeTransport: 'websocket-cached',
        runtimeModelProvider: 'openai-codex',
        runtimeModelApi: 'openai-codex-responses',
        piSessionIdPresent: true,
        websocketStatsStatus: 'available',
        directPiSessionStatsStatus: 'available',
        websocketStats: {
          requests: 2,
          connectionsCreated: 1,
          connectionsReused: 1,
          cachedContextRequests: 1,
          storeTrueRequests: 1,
          fullContextRequests: 1,
          deltaRequests: 1,
          lastInputItems: 4,
          lastDeltaInputItems: 1,
        },
      },
    ]
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/debug/codex-transport`)
      const payload = await parseJsonResponse(response)

      expect(payload.status).toBe(200)
      expect(payload.json.env).toEqual({ FORGE_OPENAI_CODEX_TRANSPORT: 'invalid' })
      expect(payload.json.websocketConstructorDiagnostics).toMatchObject({
        enabled: true,
        constructorCalls: expect.any(Number),
        sendCalls: expect.any(Number),
        closeCalls: expect.any(Number),
      })
      expect(JSON.stringify(payload.json.websocketConstructorDiagnostics)).not.toContain('codexConstructorCalls')
      expect(JSON.stringify(payload.json.websocketConstructorDiagnostics)).not.toContain('codexSendCalls')
      expect(payload.json.agents).toHaveLength(1)
      expect(payload.json.agents[0]).toMatchObject({
        agentId: 'manager',
        agentIdHash: '5c788b3055066dd1',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
        runtimeTransport: 'websocket-cached',
        runtimeModelProvider: 'openai-codex',
        runtimeModelApi: 'openai-codex-responses',
        piSessionIdPresent: true,
        websocketStatsStatus: 'available',
        directPiSessionStatsStatus: 'available',
      })
      expect(JSON.stringify(payload.json)).not.toContain('lastPreviousResponseId')
    } finally {
      await server.stop()
    }
  })
})
