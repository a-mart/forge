import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  makeP0HttpRouteTempConfig as makeTempConfig,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
  readP0HttpRouteSseEvents as readSseEvents,
  writeP0HttpRouteAuthKey as writeAuthKey,
} from '../../../../test-support/ws-integration-harness.js'
import { applyCorsHeaders, sendJson } from '../../../http-utils.js'
import { createSettingsRoutes } from '../../../routes/settings-routes.js'
import { SwarmWebSocketServer } from '../../../server.js'

const oauthMockState = vi.hoisted(() => ({
  anthropicLogin: vi.fn(),
  openaiLogin: vi.fn(),
}))

vi.mock('@mariozechner/pi-ai/oauth', () => ({
  anthropicOAuthProvider: {
    name: 'Anthropic',
    usesCallbackServer: false,
    login: (callbacks: unknown) => oauthMockState.anthropicLogin(callbacks),
  },
  openaiCodexOAuthProvider: {
    name: 'OpenAI Codex',
    usesCallbackServer: false,
    login: (callbacks: unknown) => oauthMockState.openaiLogin(callbacks),
  },
}))

interface TestServer {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

const activeServers: TestServer[] = []

afterEach(async () => {
  oauthMockState.anthropicLogin.mockReset()
  oauthMockState.openaiLogin.mockReset()
  vi.restoreAllMocks()
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
})

describe('settings routes', () => {
  it('lists settings env variables with the current response shape', async () => {
    const swarmManager = {
      listSettingsEnv: vi.fn(async () => [{ name: 'OPENAI_API_KEY', value: 'sk-test', source: 'settings' }]),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/env`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      variables: [{ name: 'OPENAI_API_KEY', value: 'sk-test', source: 'settings' }],
    })
    expect(swarmManager.listSettingsEnv).toHaveBeenCalledTimes(1)
  })

  it('updates settings env variables from the values wrapper payload and returns ok + variables', async () => {
    const swarmManager = {
      updateSettingsEnv: vi.fn(async () => undefined),
      listSettingsEnv: vi.fn(async () => [{ name: 'OPENAI_API_KEY', value: 'sk-updated' }]),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/env`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { OPENAI_API_KEY: '  sk-updated  ' } }),
    })

    expect(response.status).toBe(200)
    expect(swarmManager.updateSettingsEnv).toHaveBeenCalledWith({ OPENAI_API_KEY: 'sk-updated' })
    await expect(response.json()).resolves.toEqual({
      ok: true,
      variables: [{ name: 'OPENAI_API_KEY', value: 'sk-updated' }],
    })
  })

  it('surfaces env payload validation errors as 400 responses', async () => {
    const swarmManager = {
      updateSettingsEnv: vi.fn(async () => undefined),
      listSettingsEnv: vi.fn(async () => []),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/env`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { OPENAI_API_KEY: 123 } }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'settings env value for OPENAI_API_KEY must be a string',
    })
    expect(swarmManager.updateSettingsEnv).not.toHaveBeenCalled()
  })

  it('rejects unsupported methods for /api/settings/env', async () => {
    const server = await createSettingsRouteTestServer({})
    const response = await fetch(`${server.baseUrl}/api/settings/env`, { method: 'PATCH' })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, PUT, DELETE, OPTIONS')
    await expect(response.json()).resolves.toEqual({ error: 'Method Not Allowed' })
  })

  it('lists auth providers with the current response envelope', async () => {
    const swarmManager = {
      listSettingsAuth: vi.fn(async () => [
        { provider: 'anthropic', type: 'oauth', connected: true },
        { provider: 'openai-codex', type: 'pool', connected: true },
      ]),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/auth`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      providers: [
        { provider: 'anthropic', type: 'oauth', connected: true },
        { provider: 'openai-codex', type: 'pool', connected: true },
      ],
    })
  })

  it('updates auth settings, invalidates usage cache, and returns ok + providers', async () => {
    const swarmManager = {
      updateSettingsAuth: vi.fn(async () => undefined),
      listSettingsAuth: vi.fn(async () => [{ provider: 'anthropic', type: 'api_key', connected: true }]),
    }
    const statsService = {
      invalidateProviderUsage: vi.fn(async () => undefined),
    }

    const server = await createSettingsRouteTestServer(swarmManager, statsService)
    const response = await fetch(`${server.baseUrl}/api/settings/auth`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anthropic: '  sk-ant-1  ' }),
    })

    expect(response.status).toBe(200)
    expect(swarmManager.updateSettingsAuth).toHaveBeenCalledWith({ anthropic: 'sk-ant-1' })
    expect(statsService.invalidateProviderUsage).toHaveBeenCalledWith('anthropic')
    await expect(response.json()).resolves.toEqual({
      ok: true,
      providers: [{ provider: 'anthropic', type: 'api_key', connected: true }],
    })
  })

  it('rejects legacy OpenAI Codex auth deletion in favor of pool management', async () => {
    const swarmManager = {
      deleteSettingsAuth: vi.fn(async () => undefined),
      listSettingsAuth: vi.fn(async () => []),
      listCredentialPool: vi.fn(async () => createPoolState([makeCredential()])),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/auth/openai-codex`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Use pool management to remove OpenAI Codex accounts.',
    })
    expect(swarmManager.deleteSettingsAuth).not.toHaveBeenCalled()
  })

  it('lists pooled Anthropic credentials via the provider-scoped route', async () => {
    const pool = createPoolState([makeCredential({ id: 'acct-ant-1', label: 'Primary Anthropic', isPrimary: true })])
    const swarmManager = {
      listCredentialPool: vi.fn(async (provider: string) => {
        expect(provider).toBe('anthropic')
        return pool
      }),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/auth/anthropic/accounts`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ pool })
  })

  it('renames pooled OpenAI Codex credentials, invalidates usage cache, and returns the refreshed pool', async () => {
    const pool = createPoolState([makeCredential({ id: 'acct-1', label: 'Primary', isPrimary: true })])
    const swarmManager = {
      renamePooledCredential: vi.fn(async () => undefined),
      listCredentialPool: vi.fn(async () => pool),
    }
    const statsService = {
      invalidateProviderUsage: vi.fn(async () => undefined),
    }

    const server = await createSettingsRouteTestServer(swarmManager, statsService)
    const response = await fetch(`${server.baseUrl}/api/settings/auth/openai-codex/accounts/acct-1/label`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Primary' }),
    })

    expect(response.status).toBe(200)
    expect(swarmManager.renamePooledCredential).toHaveBeenCalledWith('openai-codex', 'acct-1', 'Primary')
    expect(statsService.invalidateProviderUsage).toHaveBeenCalledWith('openai')
    await expect(response.json()).resolves.toEqual({ ok: true, pool })
  })

  it('updates Anthropic pool strategy and returns the refreshed pool', async () => {
    const pool = createPoolState([makeCredential({ id: 'acct-ant-1', label: 'Anthropic Account' })], 'least_used')
    const swarmManager = {
      setCredentialPoolStrategy: vi.fn(async () => undefined),
      listCredentialPool: vi.fn(async () => pool),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/auth/anthropic/strategy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'least_used' }),
    })

    expect(response.status).toBe(200)
    expect(swarmManager.setCredentialPoolStrategy).toHaveBeenCalledWith('anthropic', 'least_used')
    await expect(response.json()).resolves.toEqual({ ok: true, pool })
  })

  it('manages pooled Anthropic credentials through rename, primary, cooldown, and remove routes', async () => {
    const pool = createPoolState([
      makeCredential({ id: 'acct-ant-1', label: 'Anthropic Primary', isPrimary: true }),
      makeCredential({ id: 'acct-ant-2', label: 'Anthropic Backup', isPrimary: false }),
    ])
    const swarmManager = {
      renamePooledCredential: vi.fn(async () => undefined),
      setPrimaryPooledCredential: vi.fn(async () => undefined),
      resetPooledCredentialCooldown: vi.fn(async () => undefined),
      removePooledCredential: vi.fn(async () => undefined),
      listCredentialPool: vi.fn(async () => pool),
    }

    const server = await createSettingsRouteTestServer(swarmManager)

    const renameResponse = await fetch(`${server.baseUrl}/api/settings/auth/anthropic/accounts/acct-ant-2/label`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Renamed Anthropic Backup' }),
    })
    expect(renameResponse.status).toBe(200)
    expect(swarmManager.renamePooledCredential).toHaveBeenCalledWith(
      'anthropic',
      'acct-ant-2',
      'Renamed Anthropic Backup',
    )
    await expect(renameResponse.json()).resolves.toEqual({ ok: true, pool })

    const primaryResponse = await fetch(`${server.baseUrl}/api/settings/auth/anthropic/accounts/acct-ant-2/primary`, {
      method: 'POST',
    })
    expect(primaryResponse.status).toBe(200)
    expect(swarmManager.setPrimaryPooledCredential).toHaveBeenCalledWith('anthropic', 'acct-ant-2')
    await expect(primaryResponse.json()).resolves.toEqual({ ok: true, pool })

    const cooldownResponse = await fetch(`${server.baseUrl}/api/settings/auth/anthropic/accounts/acct-ant-2/cooldown`, {
      method: 'DELETE',
    })
    expect(cooldownResponse.status).toBe(200)
    expect(swarmManager.resetPooledCredentialCooldown).toHaveBeenCalledWith('anthropic', 'acct-ant-2')
    await expect(cooldownResponse.json()).resolves.toEqual({ ok: true, pool })

    const removeResponse = await fetch(`${server.baseUrl}/api/settings/auth/anthropic/accounts/acct-ant-2`, {
      method: 'DELETE',
    })
    expect(removeResponse.status).toBe(200)
    expect(swarmManager.removePooledCredential).toHaveBeenCalledWith('anthropic', 'acct-ant-2')
    await expect(removeResponse.json()).resolves.toEqual({ ok: true, pool })
  })

  it('rejects generic auth deletion when pooled Anthropic accounts exist', async () => {
    const swarmManager = {
      deleteSettingsAuth: vi.fn(async () => undefined),
      listSettingsAuth: vi.fn(async () => []),
      listCredentialPool: vi.fn(async () => createPoolState([makeCredential({ id: 'acct-ant-1' })])),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/auth/anthropic`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Use pool management to remove Anthropic accounts.',
    })
    expect(swarmManager.deleteSettingsAuth).not.toHaveBeenCalled()
  })

  it('allows legacy Anthropic auth deletion when only plain API-key mode is configured', async () => {
    const swarmManager = {
      deleteSettingsAuth: vi.fn(async () => undefined),
      listSettingsAuth: vi.fn(async () => [{ provider: 'anthropic', type: 'api_key', connected: false }]),
      listCredentialPool: vi.fn(async () => createPoolState([])),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/auth/anthropic`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect(swarmManager.deleteSettingsAuth).toHaveBeenCalledWith('anthropic')
    await expect(response.json()).resolves.toEqual({
      ok: true,
      providers: [{ provider: 'anthropic', type: 'api_key', connected: false }],
    })
  })

  it('validates pool strategy payloads', async () => {
    const swarmManager = {
      setCredentialPoolStrategy: vi.fn(async () => undefined),
      listCredentialPool: vi.fn(async () => createPoolState([])),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const response = await fetch(`${server.baseUrl}/api/settings/auth/openai-codex/strategy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'round_robin' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "strategy must be 'fill_first' or 'least_used'",
    })
    expect(swarmManager.setCredentialPoolStrategy).not.toHaveBeenCalled()
  })
})

describe('SwarmWebSocketServer P0 endpoints', () => {
  it('streams OAuth login SSE events and accepts prompt responses', async () => {
    oauthMockState.anthropicLogin.mockImplementation(async (callbacks: any) => {
      callbacks.onProgress?.('Preparing OAuth login')
      callbacks.onAuth?.({
        url: 'https://auth.example.test',
        instructions: 'Open the URL in your browser.',
      })

      const code = await callbacks.onPrompt?.({
        message: 'Paste the one-time code',
        placeholder: 'code-123',
      })

      callbacks.onProgress?.(`Received code: ${code}`)

      return {
        accessToken: 'oauth-access-token',
        refreshToken: 'oauth-refresh-token',
      }
    })

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
      const streamResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth/login/anthropic`, {
        method: 'POST',
      })

      expect(streamResponse.status).toBe(200)
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream')

      let responded = false
      const events = await readSseEvents(streamResponse, async (event) => {
        if (event.event !== 'prompt' || responded) {
          return
        }

        responded = true
        const respondResponse = await fetch(
          `http://${config.host}:${config.port}/api/settings/auth/login/anthropic/respond`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: 'code-from-user' }),
          },
        )

        const payload = await parseJsonResponse(respondResponse)
        expect(payload.status).toBe(200)
        expect(payload.json.ok).toBe(true)
      })

      const eventNames = events.map((event) => event.event)
      expect(eventNames).toEqual(expect.arrayContaining(['progress', 'auth_url', 'prompt', 'complete']))
      expect(oauthMockState.anthropicLogin).toHaveBeenCalledTimes(1)

      const storedAuth = JSON.parse(await readFile(config.paths.sharedAuthFile, 'utf8')) as Record<string, unknown>
      expect(storedAuth.anthropic).toMatchObject({
        type: 'oauth',
      })
    } finally {
      await server.stop()
    }
  })

  it('copies legacy auth forward for OAuth login and preserves prior credentials in canonical shared auth', async () => {
    oauthMockState.anthropicLogin.mockImplementation(async (callbacks: any) => {
      callbacks.onProgress?.('Preparing OAuth login')
      callbacks.onAuth?.({
        url: 'https://auth.example.test',
        instructions: 'Open the URL in your browser.',
      })

      await callbacks.onPrompt?.({
        message: 'Paste the one-time code',
        placeholder: 'code-123',
      })

      return {
        accessToken: 'oauth-access-token',
        refreshToken: 'oauth-refresh-token',
      }
    })

    const config = await makeTempConfig({ managerId: 'manager' })
    await writeAuthKey(config.paths.authFile, 'sk-legacy-openai')

    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const streamResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth/login/anthropic`, {
        method: 'POST',
      })
      expect(streamResponse.status).toBe(200)

      let responded = false
      await readSseEvents(streamResponse, async (event) => {
        if (event.event !== 'prompt' || responded) {
          return
        }

        responded = true
        const respondResponse = await fetch(
          `http://${config.host}:${config.port}/api/settings/auth/login/anthropic/respond`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: 'code-from-user' }),
          },
        )

        const payload = await parseJsonResponse(respondResponse)
        expect(payload.status).toBe(200)
        expect(payload.json.ok).toBe(true)
      })

      const storedAuth = JSON.parse(await readFile(config.paths.sharedAuthFile, 'utf8')) as Record<
        string,
        { type: string; key?: string; access?: string; accessToken?: string; refresh?: string; refreshToken?: string }
      >
      expect(storedAuth['openai-codex']).toMatchObject({ type: 'api_key' })
      expect(storedAuth['openai-codex'].key ?? storedAuth['openai-codex'].access).toBe('sk-legacy-openai')
      expect(storedAuth.anthropic).toMatchObject({ type: 'oauth' })
      expect(storedAuth.anthropic.accessToken ?? storedAuth.anthropic.access).toBe('oauth-access-token')
      expect(storedAuth.anthropic.refreshToken ?? storedAuth.anthropic.refresh).toBe('oauth-refresh-token')
    } finally {
      await server.stop()
    }
  })

  it('supports pool add-account OAuth prompt responses via the existing respond endpoint', async () => {
    oauthMockState.openaiLogin.mockImplementation(async (callbacks: any) => {
      callbacks.onProgress?.('Preparing pooled OpenAI login')
      callbacks.onAuth?.({
        url: 'https://auth.example.test/openai',
        instructions: 'Open the URL in your browser.',
      })

      const code = await callbacks.onPrompt?.({
        message: 'Paste the OpenAI code',
        placeholder: 'openai-code-123',
      })

      callbacks.onProgress?.(`Received code: ${code}`)

      return {
        accessToken: 'pooled-oauth-access-token',
        refreshToken: 'pooled-oauth-refresh-token',
      }
    })

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
      const streamResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/auth/openai-codex/accounts/login`,
        {
          method: 'POST',
        },
      )

      expect(streamResponse.status).toBe(200)
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream')

      let responded = false
      const events = await readSseEvents(streamResponse, async (event) => {
        if (event.event !== 'prompt' || responded) {
          return
        }

        responded = true
        const respondResponse = await fetch(
          `http://${config.host}:${config.port}/api/settings/auth/login/openai-codex/respond`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: 'pool-code-from-user' }),
          },
        )

        const payload = await parseJsonResponse(respondResponse)
        expect(payload.status).toBe(200)
        expect(payload.json.ok).toBe(true)
      })

      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining(['progress', 'auth_url', 'prompt', 'complete']),
      )
      expect(oauthMockState.openaiLogin).toHaveBeenCalledTimes(1)
      expect(manager.pooledCredentialAdds).toHaveLength(1)
      expect(manager.pooledCredentialAdds[0]).toMatchObject({
        provider: 'openai-codex',
        credential: {
          type: 'oauth',
          accessToken: 'pooled-oauth-access-token',
          refreshToken: 'pooled-oauth-refresh-token',
        },
      })
    } finally {
      await server.stop()
    }
  })

  it('supports Anthropic pool add-account OAuth prompt responses via the existing respond endpoint', async () => {
    oauthMockState.anthropicLogin.mockImplementation(async (callbacks: any) => {
      callbacks.onProgress?.('Preparing pooled Anthropic login')
      callbacks.onAuth?.({
        url: 'https://auth.example.test/anthropic',
        instructions: 'Open the URL in your browser.',
      })

      const code = await callbacks.onPrompt?.({
        message: 'Paste the Anthropic code',
        placeholder: 'anthropic-code-123',
      })

      callbacks.onProgress?.(`Received code: ${code}`)

      return {
        accessToken: 'anthropic-pooled-oauth-access-token',
        refreshToken: 'anthropic-pooled-oauth-refresh-token',
      }
    })

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
      const streamResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/auth/anthropic/accounts/login`,
        {
          method: 'POST',
        },
      )

      expect(streamResponse.status).toBe(200)
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream')

      let responded = false
      const events = await readSseEvents(streamResponse, async (event) => {
        if (event.event !== 'prompt' || responded) {
          return
        }

        responded = true
        const respondResponse = await fetch(
          `http://${config.host}:${config.port}/api/settings/auth/login/anthropic/respond`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: 'anthropic-pool-code-from-user' }),
          },
        )

        const payload = await parseJsonResponse(respondResponse)
        expect(payload.status).toBe(200)
        expect(payload.json.ok).toBe(true)
      })

      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining(['progress', 'auth_url', 'prompt', 'complete']),
      )
      expect(oauthMockState.anthropicLogin).toHaveBeenCalledTimes(1)
      expect(manager.pooledCredentialAdds).toHaveLength(1)
      expect(manager.pooledCredentialAdds[0]).toMatchObject({
        provider: 'anthropic',
        credential: {
          type: 'oauth',
          accessToken: 'anthropic-pooled-oauth-access-token',
          refreshToken: 'anthropic-pooled-oauth-refresh-token',
        },
      })
    } finally {
      await server.stop()
    }
  })

  it('rejects legacy OpenAI Codex auth deletion so pool state is not corrupted', async () => {
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
      const response = await fetch(`http://${config.host}:${config.port}/api/settings/auth/openai-codex`, {
        method: 'DELETE',
      })
      const payload = await parseJsonResponse(response)
      expect(payload.status).toBe(400)
      expect(payload.json.error).toBe('Use pool management to remove OpenAI Codex accounts.')
      expect(manager.pooledCredentialAdds).toHaveLength(0)
    } finally {
      await server.stop()
    }
  })

  it('validates OAuth login provider and path segments', async () => {
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
      const invalidProviderResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/auth/login/not-a-provider`,
        {
          method: 'POST',
        },
      )
      const invalidProvider = await parseJsonResponse(invalidProviderResponse)
      expect(invalidProvider.status).toBe(400)
      expect(invalidProvider.json.error).toBe('Invalid OAuth provider')

      const invalidPathResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/auth/login/anthropic/extra`,
        {
          method: 'POST',
        },
      )
      const invalidPath = await parseJsonResponse(invalidPathResponse)
      expect(invalidPath.status).toBe(400)
      expect(invalidPath.json.error).toBe('Invalid OAuth login path')
    } finally {
      await server.stop()
    }
  })
})

function createPoolState(credentials: Array<ReturnType<typeof makeCredential>>, strategy = 'fill_first') {
  return {
    strategy,
    credentials,
  }
}

function makeCredential(overrides?: Partial<{
  id: string
  label: string
  isPrimary: boolean
  health: 'healthy' | 'cooldown' | 'auth_error'
  cooldownUntil: number | null
  requestCount: number
  createdAt: string
}>) {
  return {
    id: overrides?.id ?? 'acct-1',
    label: overrides?.label ?? 'Primary Account',
    isPrimary: overrides?.isPrimary ?? true,
    health: overrides?.health ?? 'healthy',
    cooldownUntil: overrides?.cooldownUntil ?? null,
    requestCount: overrides?.requestCount ?? 0,
    createdAt: overrides?.createdAt ?? '2026-01-01T00:00:00.000Z',
  }
}

async function createSettingsRouteTestServer(
  swarmManager: Record<string, unknown>,
  statsService?: { invalidateProviderUsage: (provider: 'openai' | 'anthropic') => Promise<void> },
): Promise<TestServer> {
  const bundle = createSettingsRoutes({
    swarmManager: swarmManager as never,
    statsService: statsService as never,
  })
  const server = createServer((request, response) => {
    void handleRouteRequest(bundle.routes, request, response)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve test server address')
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      bundle.cancelActiveSettingsAuthLoginFlows()
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
  routes: ReturnType<typeof createSettingsRoutes>['routes'],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
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
    const statusCode =
      message.includes('must be') ||
      message.includes('Invalid') ||
      message.includes('Missing') ||
      message.includes('too large')
        ? 400
        : 500

    applyCorsHeaders(request, response, route.methods)
    sendJson(response, statusCode, { error: message })
  }
}
