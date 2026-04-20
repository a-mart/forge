import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSharedMobileDevicesPath, getSharedMobileNotificationPreferencesPath } from '../../../../swarm/data-paths.js'
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  makeP0HttpRouteTempConfig as makeTempConfig,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
} from '../../../../test-support/ws-integration-harness.js'
import { SwarmWebSocketServer } from '../../../server.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SwarmWebSocketServer P0 endpoints', () => {
  it('supports mobile push registration, preferences, test push, and unregister endpoints', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir, 'manager')])
    const localOrigin = `http://${config.host}:${config.port}`
    const originalFetch = globalThis.fetch

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      if (url.startsWith(localOrigin)) {
        return originalFetch(input as any, init as any)
      }

      if (url.includes('/api/v2/push/send')) {
        return new Response(JSON.stringify({ data: { status: 'ok', id: 'test-ticket-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url.includes('/api/v2/push/getReceipts')) {
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response('{}', { status: 404 })
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const registerResponse = await fetch(`${localOrigin}/api/mobile/push/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'ExpoPushToken[test-mobile]',
          platform: 'ios',
          deviceName: 'iPhone',
          enabled: true,
        }),
      })
      const registerPayload = await parseJsonResponse(registerResponse)
      expect(registerPayload.status).toBe(200)
      expect(registerPayload.json.ok).toBe(true)
      expect(registerPayload.json.device).toMatchObject({
        token: 'ExpoPushToken[test-mobile]',
        platform: 'ios',
        deviceName: 'iPhone',
        enabled: true,
      })

      const devicesPath = getSharedMobileDevicesPath(config.paths.dataDir)
      const storedDevices = JSON.parse(await readFile(devicesPath, 'utf8')) as {
        devices: Array<{ token: string }>
      }
      expect(storedDevices.devices.some((device) => device.token === 'ExpoPushToken[test-mobile]')).toBe(true)

      const getPrefsResponse = await fetch(`${localOrigin}/api/mobile/notification-preferences`)
      const getPrefsPayload = await parseJsonResponse(getPrefsResponse)
      expect(getPrefsPayload.status).toBe(200)
      expect(getPrefsPayload.json.preferences).toMatchObject({
        enabled: true,
        unreadMessages: true,
        agentStatusChanges: true,
        errors: true,
        suppressWhenActive: true,
      })

      const putPrefsResponse = await fetch(`${localOrigin}/api/mobile/notification-preferences`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          unreadMessages: false,
          agentStatusChanges: false,
        }),
      })
      const putPrefsPayload = await parseJsonResponse(putPrefsResponse)
      expect(putPrefsPayload.status).toBe(200)
      expect(putPrefsPayload.json.ok).toBe(true)
      expect(putPrefsPayload.json.preferences).toMatchObject({
        unreadMessages: false,
        agentStatusChanges: false,
      })

      const legacyPrefsResponse = await fetch(`${localOrigin}/api/mobile/notification-preferences`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: false,
          byChannel: {
            mobilePush: true,
          },
        }),
      })
      const legacyPrefsPayload = await parseJsonResponse(legacyPrefsResponse)
      expect(legacyPrefsPayload.status).toBe(200)
      expect(legacyPrefsPayload.json.ok).toBe(true)
      expect(legacyPrefsPayload.json.preferences).toMatchObject({
        enabled: false,
        unreadMessages: false,
        agentStatusChanges: false,
      })

      const prefsPath = getSharedMobileNotificationPreferencesPath(config.paths.dataDir)
      const storedPrefs = JSON.parse(await readFile(prefsPath, 'utf8')) as {
        preferences: { enabled: boolean; unreadMessages: boolean; agentStatusChanges: boolean }
      }
      expect(storedPrefs.preferences).toMatchObject({
        enabled: false,
        unreadMessages: false,
        agentStatusChanges: false,
      })

      const testPushResponse = await fetch(`${localOrigin}/api/mobile/push/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'ExpoPushToken[test-mobile]',
          title: 'Test',
          body: 'hello',
        }),
      })
      const testPushPayload = await parseJsonResponse(testPushResponse)
      expect(testPushPayload.status).toBe(200)
      expect(testPushPayload.json.ok).toBe(true)
      expect(testPushPayload.json.ticketId).toBe('test-ticket-1')

      const outboundPushCall = fetchSpy.mock.calls.find((call) => {
        const input = call[0]
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        return url.includes('/api/v2/push/send')
      })
      expect(outboundPushCall).toBeDefined()

      const unregisterResponse = await fetch(`${localOrigin}/api/mobile/push/unregister`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'ExpoPushToken[test-mobile]' }),
      })
      const unregisterPayload = await parseJsonResponse(unregisterResponse)
      expect(unregisterPayload.status).toBe(200)
      expect(unregisterPayload.json).toEqual({ ok: true, removed: true })
    } finally {
      await server.stop()
    }
  })
})
