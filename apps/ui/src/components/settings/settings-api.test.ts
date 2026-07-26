import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchServerVersion,
  fetchSkillsList,
  SETTINGS_AUTH_PROVIDER_META,
  removePooledCredential,
  resetPooledCredentialCooldown,
  SETTINGS_AUTH_CHANGED_EVENT,
  setCredentialPoolStrategy,
  setPrimaryPooledCredential,
  startPoolAddAccountOAuthStream,
  startSettingsAuthOAuthLoginStream,
  submitSettingsAuthOAuthPrompt,
} from './settings-api'
import { createBuilderSettingsApiClient, type SettingsApiClient } from './settings-api-client'

const fetchMock = vi.fn<typeof fetch>()

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function mockJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

function mockSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }))
}

function createMockClient(response: Response): SettingsApiClient {
  return {
    endpoint: (path: string) => path,
    fetch: vi.fn(async () => response),
    fetchJson: vi.fn(),
    readApiError: vi.fn(async () => 'API error'),
    target: {
      kind: 'builder',
      label: 'Builder backend',
      description: 'Local Forge Builder backend on this machine.',
      wsUrl: 'ws://127.0.0.1:47187',
      apiBaseUrl: 'http://127.0.0.1:47187/',
      fetchCredentials: 'same-origin',
      requiresAdmin: false,
      availableTabs: [],
    },
  }
}

function listenForAuthChanged(): ReturnType<typeof vi.fn> {
  const testWindow = new EventTarget()
  vi.stubGlobal('window', testWindow)
  const listener = vi.fn()
  testWindow.addEventListener(SETTINGS_AUTH_CHANGED_EVENT, listener)
  return listener
}

describe('settings-api auth changed events', () => {

  it('dispatches after successful direct OAuth completion', async () => {
    const listener = listenForAuthChanged()
    const client = createMockClient(mockSseResponse([
      'event: complete\n',
      'data: {"provider":"openai-codex","status":"connected"}\n\n',
    ]))

    await startSettingsAuthOAuthLoginStream(client, 'openai-codex', {
      onAuthUrl: vi.fn(),
      onPrompt: vi.fn(),
      onProgress: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    }, new AbortController().signal)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('describes xAI credentials as specialist/spawn-only for Grok', () => {
    expect(SETTINGS_AUTH_PROVIDER_META.xai.description).toBe(
      'Native xAI credentials enable Grok for specialist and spawn usage, but Grok is excluded from normal manager create/change selectors.',
    )
  })

  it('accepts xAI as a direct OAuth completion provider', async () => {
    const onComplete = vi.fn()
    const client = createMockClient(mockSseResponse([
      'event: complete\n',
      'data: {"provider":"xai","status":"connected"}\n\n',
    ]))

    await startSettingsAuthOAuthLoginStream(client, 'xai', {
      onAuthUrl: vi.fn(),
      onPrompt: vi.fn(),
      onProgress: vi.fn(),
      onComplete,
      onError: vi.fn(),
    }, new AbortController().signal)

    expect(onComplete).toHaveBeenCalledWith({ provider: 'xai', status: 'connected' })
  })

  it('parses direct OAuth device-code and select events', async () => {
    const onDeviceCode = vi.fn()
    const onSelect = vi.fn()
    const onAuthUrl = vi.fn()
    const onPrompt = vi.fn()
    const client = createMockClient(mockSseResponse([
      'event: device_code\n',
      'data: {"userCode":"ABCD-EFGH","verificationUri":"https://example.test/device","intervalSeconds":5,"expiresInSeconds":600}\n\n',
      'event: auth_url\n',
      'data: {"url":"https://example.test/device","instructions":"[forge-oauth-legacy-fallback:device_code] Enter device code ABCD-EFGH at https://example.test/device"}\n\n',
      'event: select\n',
      'data: {"requestId":"req-select-1","message":"Choose account","options":[{"id":"acct-1","label":"Account 1"}]}\n\n',
      'event: prompt\n',
      'data: {"requestId":"req-select-1","message":"[forge-oauth-legacy-fallback:select]\\nChoose account\\nOptions:\\n- acct-1: Account 1","placeholder":"acct-1"}\n\n',
    ]))

    await startSettingsAuthOAuthLoginStream(client, 'openai-codex', {
      onAuthUrl,
      onDeviceCode,
      onPrompt,
      onSelect,
      onProgress: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    }, new AbortController().signal)

    expect(onDeviceCode).toHaveBeenCalledWith({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://example.test/device',
      intervalSeconds: 5,
      expiresInSeconds: 600,
    })
    expect(onSelect).toHaveBeenCalledWith({
      requestId: 'req-select-1',
      message: 'Choose account',
      options: [{ id: 'acct-1', label: 'Account 1' }],
    })
    // New client ignores marked legacy fallbacks.
    expect(onAuthUrl).not.toHaveBeenCalled()
    expect(onPrompt).not.toHaveBeenCalled()
  })

  it('submits OAuth respond payloads with optional requestId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }))
    const client = createMockClient(undefined as never)
    client.fetch = fetchMock

    await submitSettingsAuthOAuthPrompt(client, 'anthropic', 'code-1', 'req-1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/auth/login/anthropic/respond',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ value: 'code-1', requestId: 'req-1' }),
      }),
    )
  })

  it('dispatches after successful pooled OAuth completion', async () => {
    const listener = listenForAuthChanged()
    const client = createMockClient(mockSseResponse([
      'event: complete\n',
      'data: {"provider":"openai-codex","status":"connected"}\n\n',
    ]))

    await startPoolAddAccountOAuthStream(client, 'openai-codex', {
      onAuthUrl: vi.fn(),
      onPrompt: vi.fn(),
      onProgress: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    }, new AbortController().signal)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('dispatches after credential-pool availability mutations', async () => {
    const listener = listenForAuthChanged()
    const client = createMockClient(mockJsonResponse({ ok: true }))

    await setCredentialPoolStrategy(client, 'openai-codex', 'least_used')
    await setPrimaryPooledCredential(client, 'openai-codex', 'cred-1')
    await resetPooledCredentialCooldown(client, 'openai-codex', 'cred-1')
    await removePooledCredential(client, 'openai-codex', 'cred-1')

    expect(listener).toHaveBeenCalledTimes(4)
  })
})

describe('settings-api skills list', () => {
  it('keeps skills whose description is omitted', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        skills: [
          {
            name: 'custom-skill',
            envCount: 0,
            hasRichConfig: false,
          },
        ],
      }),
    )

    const skills = await fetchSkillsList(createBuilderSettingsApiClient('ws://127.0.0.1:47187'))

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/skills',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(skills).toEqual([
      {
        name: 'custom-skill',
        envCount: 0,
        hasRichConfig: false,
      },
    ])
  })
})

describe('settings-api server version', () => {
  it('reads the resolved backend version from stats', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        system: {
          serverVersion: '0.13.0',
        },
      }),
    )

    await expect(fetchServerVersion(createBuilderSettingsApiClient('ws://127.0.0.1:47187'))).resolves.toBe('0.13.0')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/stats?range=7d',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })
})
