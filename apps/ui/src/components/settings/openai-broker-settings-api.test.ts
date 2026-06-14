import { describe, expect, it } from 'vitest'
import {
  clearOpenAIBrokerSettings,
  fetchOpenAIBrokerSettings,
  testOpenAIBrokerSettings,
  updateOpenAIBrokerSettings,
} from './settings-api'
import { createBuilderSettingsApiClient } from './settings-api-client'

describe('OpenAI broker settings API helpers', () => {
  it('fetchOpenAIBrokerSettings parses the settings envelope', async () => {
    const client = createBuilderSettingsApiClient('http://127.0.0.1:47187')
    client.fetch = async () => new Response(JSON.stringify({
      settings: {
        mode: 'local',
        effectiveMode: 'local',
        source: 'default',
        envOverride: false,
        broker: { configured: false, hasToken: false, clientId: 'forge', timeoutMs: 10000 },
      },
    }))

    await expect(fetchOpenAIBrokerSettings(client)).resolves.toMatchObject({
      mode: 'local',
      broker: { configured: false },
    })
  })

  it('updateOpenAIBrokerSettings posts broker patches without requiring token echo', async () => {
    const client = createBuilderSettingsApiClient('http://127.0.0.1:47187')
    client.fetch = async (_input, init) => {
      expect(init?.method).toBe('PUT')
      expect(JSON.parse(String(init?.body))).toEqual({
        mode: 'central_broker',
        broker: { url: 'https://broker.example.test', token: 'broker-token' },
        testBeforeEnable: true,
      })
      return new Response(JSON.stringify({
        settings: {
          mode: 'central_broker',
          effectiveMode: 'central_broker',
          source: 'settings',
          envOverride: false,
          broker: {
            configured: true,
            url: 'https://broker.example.test/',
            hasToken: true,
            tokenMasked: '********oken',
            clientId: 'forge',
            timeoutMs: 10000,
          },
        },
      }))
    }

    await expect(updateOpenAIBrokerSettings(client, {
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
      testBeforeEnable: true,
    })).resolves.toMatchObject({
      effectiveMode: 'central_broker',
      broker: { configured: true, tokenMasked: '********oken' },
    })
  })

  it('clearOpenAIBrokerSettings deletes stored broker settings', async () => {
    const client = createBuilderSettingsApiClient('http://127.0.0.1:47187')
    client.fetch = async (_input, init) => {
      expect(init?.method).toBe('DELETE')
      return new Response(JSON.stringify({
        settings: {
          mode: 'local',
          effectiveMode: 'local',
          source: 'default',
          envOverride: false,
          broker: { configured: false, hasToken: false, clientId: 'forge', timeoutMs: 10000 },
        },
      }))
    }

    await expect(clearOpenAIBrokerSettings(client)).resolves.toMatchObject({
      effectiveMode: 'local',
      broker: { configured: false, hasToken: false },
    })
  })

  it('testOpenAIBrokerSettings returns structured test failures', async () => {
    const client = createBuilderSettingsApiClient('http://127.0.0.1:47187')
    client.fetch = async () => new Response(JSON.stringify({
      ok: false,
      error: 'Broker rejected credentials.',
    }))

    await expect(testOpenAIBrokerSettings(client, {
      broker: { url: 'https://broker.example.test', token: 'bad-token' },
    })).resolves.toEqual({
      ok: false,
      error: 'Broker rejected credentials.',
    })
  })
})
