import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempConfig, type TempConfigHandle } from '../../test-support/temp-config.js'
import { getManagedModelProviderCredentialAvailability, getManagedModelProviderCredentialSummaries } from '../secrets-env-service.js'
import {
  OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY,
  OpenAIAuthSettingsService,
} from '../openai-auth/openai-auth-settings-service.js'

const handles: TempConfigHandle[] = []
const originalEnv = { ...process.env }

afterEach(async () => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  await Promise.all(handles.splice(0).map((handle) => handle.cleanup()))
})

describe('OpenAIAuthSettingsService', () => {
  it('defaults to local mode and does not enable broker from URL/token env vars alone', async () => {
    process.env.FORGE_OPENAI_AUTH_BROKER_URL = 'https://broker.example.test'
    process.env.FORGE_OPENAI_AUTH_BROKER_TOKEN = 'broker-secret-token'
    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })

    await expect(service.getSettingsState()).resolves.toMatchObject({
      mode: 'local',
      effectiveMode: 'local',
      source: 'default',
      envOverride: false,
      broker: { configured: false, hasToken: false },
    })
  })

  it('stores non-secret broker config separately from the broker token and never echoes the token', async () => {
    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })

    const response = await service.updateSettings({
      mode: 'local',
      broker: {
        url: 'https://broker.example.test',
        token: 'broker-bearer-secret',
        clientId: 'forge-test',
        userLabel: 'Adam',
      },
    })

    expect(JSON.stringify(response)).not.toContain('broker-bearer-secret')
    expect(response.settings).toMatchObject({
      mode: 'local',
      effectiveMode: 'local',
      broker: {
        configured: true,
        url: 'https://broker.example.test/',
        hasToken: true,
        tokenMasked: '********cret',
        clientId: 'forge-test',
        userLabel: 'Adam',
      },
    })

    const configRaw = await readFile(join(handle.config.paths.sharedAuthDir, 'openai-codex-auth-source.json'), 'utf8')
    const secretsRaw = await readFile(handle.config.paths.sharedSecretsFile, 'utf8')
    expect(configRaw).toContain('https://broker.example.test/')
    expect(configRaw).not.toContain('broker-bearer-secret')
    expect(JSON.parse(secretsRaw)).toMatchObject({ [OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY]: 'broker-bearer-secret' })
  })

  it('applies explicit env mode as a read-only effective override', async () => {
    process.env.FORGE_OPENAI_CODEX_AUTH_MODE = 'central_broker'
    process.env.FORGE_OPENAI_AUTH_BROKER_URL = 'https://env-broker.example.test'
    process.env.FORGE_OPENAI_AUTH_BROKER_TOKEN = 'env-broker-token'
    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })

    const state = await service.getSettingsState()
    expect(state).toMatchObject({
      mode: 'local',
      effectiveMode: 'central_broker',
      source: 'env',
      envOverride: true,
      broker: {
        configured: true,
        url: 'https://env-broker.example.test/',
        hasToken: true,
        tokenMasked: '********oken',
      },
    })

    await expect(service.updateSettings({ mode: 'local' })).rejects.toThrow('environment variables')
  })

  it('reports central broker as configured provider source while keeping all-cooldown separate from availability', async () => {
    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })
    const configPath = join(handle.config.paths.sharedAuthDir, 'openai-codex-auth-source.json')
    const stored = JSON.parse(await readFile(configPath, 'utf8'))
    stored.broker.lastStatus = {
      ok: false,
      degraded: 'all_cooldown',
      accounts: { healthy: 0, cooldown: 2, auth_error: 0, disabled: 0, unknown: 0 },
      checkedAt: '2026-01-01T00:00:00.000Z',
    }
    await writeFile(configPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')

    const summaries = await getManagedModelProviderCredentialSummaries(handle.config)
    const openai = summaries.get('openai-codex')
    expect(openai).toEqual({
      configured: true,
      authTypes: ['oauth'],
      sources: ['central_broker'],
      centralBroker: {
        configured: true,
        reachable: true,
        degraded: 'all_cooldown',
        availableAccounts: 0,
        totalAccounts: 2,
      },
    })

    const availability = await getManagedModelProviderCredentialAvailability(handle.config)
    expect(availability.get('openai-codex')).toBe(true)
  })
})

async function makeHandle(): Promise<TempConfigHandle> {
  const handle = await createTempConfig({ prefix: 'forge-openai-broker-settings-' })
  handles.push(handle)
  return handle
}
