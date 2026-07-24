/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  SecureSecretsError,
  checkSecureMaterialEntryAvailability,
  connectBitwardenProvider,
  createLocalSecret,
  fetchSecureSecretsCatalog,
  importBitwardenSecret,
  secureSecretsErrorMessage,
  updateSecureSecret,
  updateSecureSecretProjectDefault,
} from './secure-secrets-api'

const SECRET_SUMMARY = {
  secretId: 'secret-1',
  displayAlias: 'github/work',
  displayName: 'GitHub work token',
  providerId: 'local',
  scope: { kind: 'instance' as const },
  retention: 'saved' as const,
  bindings: [],
  available: true,
  updatedAt: '2026-07-23T12:00:00.000Z',
}

const PROVIDER_SUMMARY = {
  providerId: 'bitwarden-1',
  kind: 'bitwarden_secrets_manager' as const,
  displayName: 'Bitwarden work',
  enabled: true,
  status: 'available' as const,
  lastVerifiedAt: '2026-07-23T12:00:00.000Z',
  lastStatusCode: 'ok',
}

function makeClient(
  fetchImpl: SettingsApiClient['fetch'],
  kind: 'builder' | 'collab' = 'builder',
): SettingsApiClient {
  return {
    target: {
      kind,
      label: kind,
      description: kind,
      wsUrl: 'ws://127.0.0.1:47187',
      apiBaseUrl: 'http://127.0.0.1:47187/',
      fetchCredentials: 'same-origin',
      requiresAdmin: false,
      availableTabs: [],
    },
    endpoint: (path) => path,
    fetch: fetchImpl,
    fetchJson: vi.fn(),
    readApiError: vi.fn(),
  }
}

function installSecureVault(
  encryptLocalValue = vi.fn(async () => ({
    ok: true as const,
    encryptedPayloadBase64: 'encrypted-envelope',
  })),
): void {
  Object.defineProperty(window, 'electronBridge', {
    configurable: true,
    value: {
      secureControlToken: 'test-secure-control-token-that-is-long-enough',
      secureVault: {
        status: vi.fn(async () => ({ ok: true as const, available: true as const })),
        encryptLocalValue,
      },
    },
  })
}

beforeEach(() => {
  installSecureVault()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'electronBridge')
  vi.restoreAllMocks()
})

describe('secure secrets API', () => {
  it('reports the real desktop vault status rather than bridge presence alone', async () => {
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        secureControlToken: 'test-secure-control-token-that-is-long-enough',
        secureVault: {
          status: vi.fn(async () => ({
            ok: false as const,
            errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE' as const,
          })),
          encryptLocalValue: vi.fn(),
        },
      },
    })

    await expect(checkSecureMaterialEntryAvailability()).resolves.toBe(false)
  })

  it('loads provider and secret metadata with no-store requests', async () => {
    const fetchMock = vi.fn(async (path: string) => new Response(
      JSON.stringify(
        path.endsWith('/providers')
          ? { providers: [PROVIDER_SUMMARY] }
          : path.endsWith('/project-defaults')
            ? { projectDefaults: [] }
            : { secrets: [SECRET_SUMMARY] },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = makeClient(fetchMock)

    await expect(fetchSecureSecretsCatalog(client)).resolves.toEqual({
      providers: [PROVIDER_SUMMARY],
      secrets: [SECRET_SUMMARY],
      projectDefaults: [],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets/providers',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets/project-defaults',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('rejects remote targets before making a request', async () => {
    const fetchMock = vi.fn()
    const client = makeClient(fetchMock, 'collab')

    await expect(fetchSecureSecretsCatalog(client)).rejects.toMatchObject({
      code: 'SECURE_BUILDER_ONLY',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends only encrypted local material to the backend', async () => {
    const rawSecret = 'raw-secret-never-in-http'
    const encryptLocalValue = vi.fn(async (value: string) => {
      expect(value).toBe(rawSecret)
      return { ok: true as const, encryptedPayloadBase64: 'ciphertext-only' }
    })
    installSecureVault(encryptLocalValue)
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(SECRET_SUMMARY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = makeClient(fetchMock)

    await createLocalSecret(client, {
      displayAlias: 'github/work',
      displayName: 'GitHub work token',
      material: rawSecret,
      scope: { kind: 'profile', profileId: 'project-alpha' },
    })

    const requestBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-Forge-Secure-Control'))
      .toBe('test-secure-control-token-that-is-long-enough')
    expect(requestBody).toContain('"encryptedMaterial":"ciphertext-only"')
    expect(requestBody).toContain('"scope":{"kind":"profile","profileId":"project-alpha"}')
    expect(requestBody).not.toContain(rawSecret)
  })

  it('encrypts a Bitwarden token without putting the raw token in the request', async () => {
    const rawToken = 'bws-raw-access-token'
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(PROVIDER_SUMMARY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = makeClient(fetchMock)

    await connectBitwardenProvider(client, {
      displayName: 'Bitwarden work',
      serverOrigin: 'https://api.bitwarden.com',
      accessToken: rawToken,
    })

    const requestBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    expect(requestBody).toContain('"encryptedAccessToken":"encrypted-envelope"')
    expect(requestBody).not.toContain(rawToken)
  })

  it('imports a Bitwarden reference through its provider without material entry', async () => {
    const encryptLocalValue = vi.fn()
    installSecureVault(encryptLocalValue)
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({
      ...SECRET_SUMMARY,
      providerId: 'bitwarden-1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = makeClient(fetchMock)

    await importBitwardenSecret(client, {
      providerId: 'bitwarden/one',
      sourceLocator: 'source-secret-uuid',
      displayAlias: 'database/production',
      displayName: 'Production database',
      scope: { kind: 'instance' },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets/providers/bitwarden%2Fone/secrets',
      expect.objectContaining({ method: 'POST' }),
    )
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body).toBe(
      JSON.stringify({
        sourceLocator: 'source-secret-uuid',
        displayAlias: 'database/production',
        displayName: 'Production database',
        scope: { kind: 'instance' },
      }),
    )
    expect(encryptLocalValue).not.toHaveBeenCalled()
  })

  it('updates metadata without calling the private material API', async () => {
    const encryptLocalValue = vi.fn()
    installSecureVault(encryptLocalValue)
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({
      ...SECRET_SUMMARY,
      displayName: 'Updated',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = makeClient(fetchMock)

    await updateSecureSecret(client, 'secret-1', { displayName: 'Updated' })

    expect(encryptLocalValue).not.toHaveBeenCalled()
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body).toBe(
      JSON.stringify({ displayName: 'Updated' }),
    )
  })

  it('updates one project default without sending secret material', async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response(
      JSON.stringify({
        profileId: 'project/alpha',
        secretId: 'secret/one',
        createdAt: '2026-07-24T12:00:00.000Z',
        updatedAt: '2026-07-24T12:00:00.000Z',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = makeClient(fetchMock)

    await updateSecureSecretProjectDefault(
      client,
      'project/alpha',
      'secret/one',
      true,
    )

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets/project-defaults/project%2Falpha/secret%2Fone',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
      }),
    )
  })

  it('maps untrusted server errors to fixed safe copy', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'failed while using raw-secret-server-detail' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = makeClient(fetchMock)

    let caught: unknown
    try {
      await fetchSecureSecretsCatalog(client)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(SecureSecretsError)
    expect(secureSecretsErrorMessage(caught)).toBe(
      'The secret source is currently unavailable.',
    )
    expect(secureSecretsErrorMessage(caught)).not.toContain('raw-secret-server-detail')
  })

  it('surfaces alias collisions with fixed scope-aware copy', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 'SECURE_SECRET_ALIAS_CONFLICT' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = makeClient(fetchMock)

    await expect(updateSecureSecret(client, 'secret-1', {
      displayAlias: 'duplicate',
    })).rejects.toMatchObject({
      code: 'SECURE_SECRET_ALIAS_CONFLICT',
      message: 'A secret with this alias already exists in that scope.',
    })
  })

  it('surfaces the project-default limit with fixed actionable copy', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 'SECURE_PROJECT_DEFAULT_LIMIT_REACHED' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = makeClient(fetchMock)

    await expect(updateSecureSecretProjectDefault(
      client,
      'project-alpha',
      'secret-17',
      true,
    )).rejects.toMatchObject({
      code: 'SECURE_PROJECT_DEFAULT_LIMIT_REACHED',
      message:
        'This project already has the maximum number of automatic secrets. Disable one before enabling another.',
    })
  })
})
