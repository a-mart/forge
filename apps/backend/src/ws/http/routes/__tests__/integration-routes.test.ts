import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHARED_INTEGRATION_MANAGER_ID } from '../../../../integrations/shared-config.js'
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteIntegrationRegistryMock as createIntegrationRegistryMock,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  makeP0HttpRouteTempConfig as makeTempConfig,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
} from '../../../../test-support/ws-integration-harness.js'
import { SwarmWebSocketServer } from '../../../server.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SwarmWebSocketServer P0 endpoints', () => {
  it('handles manager-scoped Telegram routes and validates methods/payloads', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir, 'manager')])
    const integrationRegistry = createIntegrationRegistryMock()

    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
      integrationRegistry: integrationRegistry as unknown as never,
    })

    await server.start()

    try {
      const unknownManagerResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/ghost/integrations/telegram`,
      )
      const unknownManager = await parseJsonResponse(unknownManagerResponse)
      expect(unknownManager.status).toBe(404)
      expect(unknownManager.json.error).toBe('Unknown manager: ghost')

      const sharedTelegramResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(SHARED_INTEGRATION_MANAGER_ID)}/integrations/telegram`,
      )
      const sharedTelegram = await parseJsonResponse(sharedTelegramResponse)
      expect(sharedTelegram.status).toBe(200)
      expect(integrationRegistry.getTelegramSnapshot).toHaveBeenCalledWith(SHARED_INTEGRATION_MANAGER_ID)

      const telegramTestResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/manager/integrations/telegram/test`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        },
      )
      const telegramTest = await parseJsonResponse(telegramTestResponse)
      expect(telegramTest.status).toBe(200)
      expect(integrationRegistry.testTelegramConnection).toHaveBeenCalledWith('manager', { dryRun: true })

      const telegramWrongMethodResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/manager/integrations/telegram`,
        {
          method: 'PATCH',
        },
      )
      const telegramWrongMethod = await parseJsonResponse(telegramWrongMethodResponse)
      expect(telegramWrongMethod.status).toBe(405)
      expect(telegramWrongMethod.json.error).toBe('Method Not Allowed')
    } finally {
      await server.stop()
    }
  })

  it('does not expose legacy integration routes', async () => {
    const config = await makeTempConfig({ managerId: undefined })
    const manager = new FakeSwarmManager(config, [])
    const integrationRegistry = createIntegrationRegistryMock()

    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
      integrationRegistry: integrationRegistry as unknown as never,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/integrations/telegram`)
      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  })
})
