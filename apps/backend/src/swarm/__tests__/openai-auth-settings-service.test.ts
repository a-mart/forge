import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempConfig, type TempConfigHandle } from '../../test-support/temp-config.js'
import {
  getManagedModelProviderCredentialAvailability,
  getManagedModelProviderCredentialSummaries,
  SecretsEnvService,
} from '../secrets-env-service.js'
import {
  LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY,
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
    const storedSecrets = JSON.parse(secretsRaw)
    expect(storedSecrets).toMatchObject({ [OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY]: 'broker-bearer-secret' })
    expect(storedSecrets).not.toHaveProperty(LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY)
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

  it('does not fall back to saved broker URL or token when env central mode omits them', async () => {
    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'local',
      broker: { url: 'https://saved-broker.example.test', token: 'saved-broker-token' },
    })

    process.env.FORGE_OPENAI_CODEX_AUTH_MODE = 'central_broker'
    delete process.env.FORGE_OPENAI_AUTH_BROKER_URL
    delete process.env.FORGE_OPENAI_AUTH_BROKER_TOKEN

    const state = await service.getSettingsState()
    expect(state).toMatchObject({
      mode: 'local',
      effectiveMode: 'central_broker',
      source: 'env',
      envOverride: true,
      broker: {
        configured: false,
        hasToken: false,
        clientId: 'forge',
        timeoutMs: 10000,
      },
    })
    expect(state.broker.url).toBeUndefined()
    expect(state.broker.tokenMasked).toBeUndefined()
    await expect(service.testSettings()).resolves.toMatchObject({
      ok: false,
      error: 'Forge Auth broker URL and token are required before testing OpenAI/Codex auth.',
    })
  })

  it('does not treat saved broker tokens loaded through SecretsEnvService as env broker tokens', async () => {
    delete process.env.FORGE_OPENAI_CODEX_AUTH_MODE
    delete process.env.FORGE_OPENAI_AUTH_BROKER_URL
    delete process.env.FORGE_OPENAI_AUTH_BROKER_TOKEN

    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'local',
      broker: { url: 'https://saved-broker.example.test', token: 'saved-broker-token' },
    })

    const storedSecrets = JSON.parse(await readFile(handle.config.paths.sharedSecretsFile, 'utf8'))
    await writeFile(
      handle.config.paths.sharedSecretsFile,
      `${JSON.stringify({ [LEGACY_OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY]: storedSecrets[OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY] }, null, 2)}\n`,
      'utf8',
    )

    const secretsEnvService = new SecretsEnvService({
      config: handle.config,
      ensureSkillMetadataLoaded: async () => undefined,
      getSkillMetadata: () => [],
    })
    await secretsEnvService.loadSecretsStore()
    expect(process.env.FORGE_OPENAI_AUTH_BROKER_TOKEN).toBeUndefined()

    process.env.FORGE_OPENAI_CODEX_AUTH_MODE = 'central_broker'

    await expect(service.getSettingsState()).resolves.toMatchObject({
      effectiveMode: 'central_broker',
      source: 'env',
      envOverride: true,
      broker: { configured: false, hasToken: false },
    })
    await expect(service.testSettings()).resolves.toMatchObject({
      ok: false,
      error: 'Forge Auth broker URL and token are required before testing OpenAI/Codex auth.',
    })
  })

  it('reports central broker as configured provider source while keeping all-cooldown separate from availability', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true })))
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
      accounts: { healthy: 0, cooldown: 2, auth_error: 0, disabled: 0, draining: 0, unknown: 0 },
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

  it('rejects invalid non-empty broker URL patches instead of falling back to the existing URL', async () => {
    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'local',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    await expect(service.updateSettings({
      mode: 'local',
      broker: { url: 'not a valid URL' },
    })).rejects.toThrow('valid http(s) URL')

    await expect(service.updateSettings({
      mode: 'local',
      broker: { url: '   ', userLabel: 'Blank URL keeps existing URL' },
    })).resolves.toMatchObject({
      settings: {
        mode: 'local',
        broker: {
          url: 'https://broker.example.test/',
          userLabel: 'Blank URL keeps existing URL',
        },
      },
    })
  })

  it('requires a successful broker test before changing active central broker connection settings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ok: false,
        degraded: 'invalid_bearer',
        message: 'Broker rejected updated credentials.',
      })))

    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://old-broker.example.test', token: 'old-broker-token' },
    })

    await expect(service.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://new-broker.example.test', token: 'new-broker-token' },
    })).rejects.toThrow('Broker rejected updated credentials.')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(service.getSettingsState()).resolves.toMatchObject({
      mode: 'central_broker',
      broker: {
        configured: true,
        url: 'https://old-broker.example.test/',
        status: { ok: true },
      },
    })
  })

  it('caches successful broker tests when a UI patch matches the current saved settings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ok: true,
        accounts: { healthy: 2, cooldown: 0, auth_error: 0, disabled: 0, draining: 0, unknown: 0 },
        message: 'Broker ready',
      })))

    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    const testResult = await service.testSettings({
      broker: { url: 'https://broker.example.test/', timeoutMs: 10000 },
    })
    expect(testResult).toMatchObject({ ok: true, status: { message: 'Broker ready' } })

    await expect(service.getSettingsState()).resolves.toMatchObject({
      broker: {
        status: {
          ok: true,
          message: 'Broker ready',
          accounts: { healthy: 2 },
        },
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caches failed broker tests when a UI patch matches the current saved settings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true, message: 'Broker ready' })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ok: false,
        degraded: 'unreachable',
        message: 'Broker unreachable',
      })))

    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    await expect(service.getSettingsState()).resolves.toMatchObject({
      broker: { status: { ok: true, message: 'Broker ready' } },
    })

    const testResult = await service.testSettings({
      broker: { url: 'https://broker.example.test/', timeoutMs: 10000 },
    })
    expect(testResult).toMatchObject({ ok: false, status: { ok: false, degraded: 'unreachable', message: 'Broker unreachable' } })

    await expect(service.getSettingsState()).resolves.toMatchObject({
      broker: {
        status: {
          ok: false,
          degraded: 'unreachable',
          message: 'Broker unreachable',
        },
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache broker tests for unsaved broker patches', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true, message: 'Unsaved broker ready' })))

    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    await expect(service.testSettings({
      broker: { url: 'https://other-broker.example.test', token: 'other-token' },
    })).resolves.toMatchObject({ ok: true, status: { message: 'Unsaved broker ready' } })

    await expect(service.getSettingsState()).resolves.toMatchObject({
      broker: { status: { ok: true } },
    })
    const state = await service.getSettingsState()
    expect(state.broker.status?.message).not.toBe('Unsaved broker ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('redeems broker invites without echoing invite secrets or returned broker tokens', async () => {
    const inviteSecret = 'invite-secret-sentinel'
    const brokerToken = 'fop_returned-broker-token-sentinel'
    const invitePayload = Buffer.from(JSON.stringify({
      v: 1,
      brokerUrl: 'https://broker.example.test',
      brokerId: 'broker-test',
      inviteId: 'inv_test',
      secret: inviteSecret,
    }), 'utf8').toString('base64url')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({
          inviteId: 'inv_test',
          secret: inviteSecret,
          install: { clientId: 'forge' },
        })
        expect(body.install.instanceId).toBeTruthy()
        return new Response(JSON.stringify({
          ok: true,
          token: brokerToken,
          tokenType: 'bearer',
          scopes: ['lease', 'read'],
          grants: [{ provider: 'openai-codex', scopes: ['lease', 'read'] }],
          user: { id: 'usr_test', name: 'Ada Lovelace', email: 'ada@example.com' },
          install: { installId: body.install.installId, clientId: body.install.clientId, instanceId: body.install.instanceId },
        }))
      })
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true, message: `ready ${brokerToken} ${inviteSecret}` })))

    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    const response = await service.redeemInvite({
      invite: `https://broker.example.test/-/forge-auth/invite#forge_auth_broker=${invitePayload}`,
    })

    expect(response.settings).toMatchObject({
      mode: 'central_broker',
      effectiveMode: 'central_broker',
      broker: {
        configured: true,
        url: 'https://broker.example.test/',
        hasToken: true,
        tokenMasked: '********inel',
        userLabel: 'ada@example.com',
        status: { ok: true, message: 'ready [redacted] [redacted]' },
      },
    })
    expect(JSON.stringify(response)).not.toContain(inviteSecret)
    expect(JSON.stringify(response)).not.toContain(brokerToken)

    const persistedStatusState = await service.getSettingsState()
    expect(persistedStatusState.broker.status?.message).toBe('ready [redacted] [redacted]')
    expect(JSON.stringify(persistedStatusState)).not.toContain(inviteSecret)
    expect(JSON.stringify(persistedStatusState)).not.toContain(brokerToken)

    const configRaw = await readFile(join(handle.config.paths.sharedAuthDir, 'openai-codex-auth-source.json'), 'utf8')
    const secretsRaw = await readFile(handle.config.paths.sharedSecretsFile, 'utf8')
    expect(configRaw).not.toContain(inviteSecret)
    expect(configRaw).not.toContain(brokerToken)
    expect(JSON.parse(secretsRaw)).toMatchObject({ [OPENAI_AUTH_BROKER_TOKEN_SECRET_KEY]: brokerToken })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects invite redemption while broker auth is controlled by environment variables', async () => {
    process.env.FORGE_OPENAI_CODEX_AUTH_MODE = 'central_broker'
    process.env.FORGE_OPENAI_AUTH_BROKER_URL = 'https://env-broker.example.test'
    process.env.FORGE_OPENAI_AUTH_BROKER_TOKEN = 'env-broker-token'
    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })

    await expect(service.redeemInvite({ invite: '{}' })).rejects.toThrow('environment variables')
  })

  it('redacts exact broker bearer tokens and OpenAI-looking tokens from status responses, cached status, and enable errors', async () => {
    const brokerBearer = 'broker-secret-sentinel'
    const openAILookingToken = 'sk-proj-abcdefghijklmnopqrstuvwxyz'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: false,
      degraded: 'invalid_bearer',
      message: `broker echoed ${brokerBearer} and ${openAILookingToken}`,
    })))

    const handle = await makeHandle()
    const service = new OpenAIAuthSettingsService({ config: handle.config })
    await service.updateSettings({
      mode: 'local',
      broker: { url: 'https://broker.example.test', token: brokerBearer },
    })

    const testResult = await service.testSettings()
    expect(testResult.ok).toBe(false)
    expect(JSON.stringify(testResult)).not.toContain(brokerBearer)
    expect(JSON.stringify(testResult)).not.toContain(openAILookingToken)

    const cachedState = await service.getSettingsState()
    expect(JSON.stringify(cachedState)).not.toContain(brokerBearer)
    expect(JSON.stringify(cachedState)).not.toContain(openAILookingToken)
    const configRaw = await readFile(join(handle.config.paths.sharedAuthDir, 'openai-codex-auth-source.json'), 'utf8')
    expect(configRaw).not.toContain(brokerBearer)
    expect(configRaw).not.toContain(openAILookingToken)

    let enableError: unknown
    try {
      await service.updateSettings({ mode: 'central_broker' })
    } catch (error) {
      enableError = error
    }
    expect(enableError).toBeInstanceOf(Error)
    const enableErrorMessage = enableError instanceof Error ? enableError.message : String(enableError)
    expect(enableErrorMessage).toContain('[redacted]')
    expect(enableErrorMessage).not.toContain(brokerBearer)
    expect(enableErrorMessage).not.toContain(openAILookingToken)
    await expect(service.getSettingsState()).resolves.toMatchObject({ mode: 'local', effectiveMode: 'local' })
  })
})

async function makeHandle(): Promise<TempConfigHandle> {
  const handle = await createTempConfig({ prefix: 'forge-openai-broker-settings-' })
  handles.push(handle)
  return handle
}
