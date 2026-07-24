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
          : { secrets: [SECRET_SUMMARY] },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = makeClient(fetchMock)

    await expect(fetchSecureSecretsCatalog(client)).resolves.toEqual({
      providers: [PROVIDER_SUMMARY],
      secrets: [SECRET_SUMMARY],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets/providers',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets',
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
    })

    const requestBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    expect(requestBody).toContain('"encryptedMaterial":"ciphertext-only"')
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
})
