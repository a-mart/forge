/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  SecureSecretsError,
  checkSecureMaterialEntryAvailability,
  connectBitwardenPasswordManager,
  connectBitwardenProvider,
  createSecureSshTrustedHost,
  createLocalSecret,
  deleteSecureSshTrustedHost,
  exportSecureVaultTransfer,
  fetchSecureSessionReadiness,
  fetchBitwardenPasswordManagerSettings,
  fetchSecureSecretsCatalog,
  fetchSecureSecretSettings,
  importBitwardenSecret,
  importSecureVaultTransfer,
  installBitwardenPasswordManagerCli,
  installSecureRunner,
  lockBitwardenPasswordManager,
  replaceBitwardenPasswordManagerCollections,
  reconnectBitwardenProvider,
  secureSecretsErrorMessage,
  testSecureSecretProvider,
  unlockBitwardenPasswordManager,
  unlockSecureMaterialEntry,
  updateSecureSecret,
  updateSecureSecretAutomaticGrant,
  updateSecureSecretProjectDefault,
  updateSecureSecretSettings,
  updateSecureSshTrustedHost,
  updateBitwardenPasswordManagerCli,
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

const SSH_HOST_SUMMARY = {
  trustedHostId: 'ssh-host-1',
  profileId: 'project-alpha',
  alias: 'production-api',
  hostName: '10.0.0.25',
  port: 22,
  username: 'deploy',
  hostKeyAlgorithm: 'ssh-ed25519',
  hostKeyFingerprint: 'SHA256:trusted-key',
  createdAt: '2026-07-23T12:00:00.000Z',
  updatedAt: '2026-07-23T12:00:00.000Z',
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
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
        unlock: vi.fn(async () => ({ ok: true as const, available: true as const })),
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
  it('installs and configures the Bitwarden CLI through metadata-only endpoints', async () => {
    const cliSettings = {
      providerId: 'password-manager-1',
      accountEmail: null,
      serverUrl: null,
      cli: {
        state: 'ready' as const,
        source: 'managed' as const,
        executablePath: 'C:\\Forge\\bw.exe',
        configuredExecutablePath: null,
        version: '2026.8.0',
        managedVersion: '2026.8.0',
        canInstall: true,
      },
      collections: [],
    }
    const fetchMock = vi.fn(async () => jsonResponse(cliSettings))
    const client = makeClient(fetchMock)

    await installBitwardenPasswordManagerCli(client, 'password-manager-1')
    await updateBitwardenPasswordManagerCli(
      client,
      'password-manager-1',
      'C:\\Tools\\bw.exe',
    )
    await updateBitwardenPasswordManagerCli(client, 'password-manager-1', null)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/secure-secrets/providers/password-manager-1/cli/install',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/secure-secrets/providers/password-manager-1/cli',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ executablePath: 'C:\\Tools\\bw.exe' }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/secure-secrets/providers/password-manager-1/cli',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ executablePath: null }),
      }),
    )
  })

  it('encrypts Password Manager unlock locally and sends only collection metadata afterward', async () => {
    const encryptLocalValue = vi.fn(async () => ({
      ok: true as const,
      encryptedPayloadBase64: 'encrypted-master-password',
    }))
    installSecureVault(encryptLocalValue)
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/bitwarden-password-manager')) {
        return jsonResponse(PROVIDER_SUMMARY)
      }
      if (path.endsWith('/unlock')) {
        return jsonResponse({
          providerId: 'password-manager-1',
          accountEmail: 'forge@example.test',
          serverUrl: 'https://vault.example.test',
          cli: {
            state: 'ready',
            source: 'system',
            executablePath: '/usr/local/bin/bw',
            configuredExecutablePath: null,
            version: '2026.8.0',
            managedVersion: '2026.8.0',
            canInstall: true,
          },
          collections: [],
        })
      }
      if (path.endsWith('/lock')) return jsonResponse(PROVIDER_SUMMARY)
      if (path.endsWith('/collections') && init?.method === 'PUT') {
        return jsonResponse({
          settings: {
            providerId: 'password-manager-1',
            accountEmail: 'forge@example.test',
            serverUrl: 'https://vault.example.test',
            collections: [],
          },
          addedSecrets: 0,
          removedSecrets: 0,
        })
      }
      return jsonResponse({
        providerId: 'password-manager-1',
        accountEmail: 'forge@example.test',
        serverUrl: 'https://vault.example.test',
        collections: [],
      })
    })
    const client = makeClient(fetchMock)

    await connectBitwardenPasswordManager(client)
    await fetchBitwardenPasswordManagerSettings(client, 'password-manager-1')
    await unlockBitwardenPasswordManager(
      client,
      'password-manager-1',
      'synthetic-master-password',
    )
    await replaceBitwardenPasswordManagerCollections(
      client,
      'password-manager-1',
      ['11111111-1111-4111-8111-111111111111'],
    )
    await lockBitwardenPasswordManager(client, 'password-manager-1')

    expect(encryptLocalValue).toHaveBeenCalledWith('synthetic-master-password')
    const unlockRequest = fetchMock.mock.calls.find(([path]) =>
      path.endsWith('/unlock'))
    expect(JSON.parse(String(unlockRequest?.[1]?.body))).toEqual({
      encryptedMasterPassword: 'encrypted-master-password',
    })
    expect(String(unlockRequest?.[1]?.body)).not.toContain('synthetic-master-password')
    const collectionRequest = fetchMock.mock.calls.find(([path, init]) =>
      path.endsWith('/collections') && init?.method === 'PUT')
    expect(JSON.parse(String(collectionRequest?.[1]?.body))).toEqual({
      collectionIds: ['11111111-1111-4111-8111-111111111111'],
    })
  })

  it('reports the real desktop vault status rather than bridge presence alone', async () => {
    const unlock = vi.fn(async () => ({
      ok: true as const,
      available: true as const,
    }))
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        secureControlToken: 'test-secure-control-token-that-is-long-enough',
        secureVault: {
          status: vi.fn(async () => ({
            ok: false as const,
            errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE' as const,
          })),
          unlock,
          encryptLocalValue: vi.fn(),
        },
      },
    })

    await expect(checkSecureMaterialEntryAvailability()).resolves.toBe(false)
    expect(unlock).not.toHaveBeenCalled()
    await expect(unlockSecureMaterialEntry()).resolves.toBe(true)
    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it('loads provider and secret metadata with no-store requests', async () => {
    const fetchMock = vi.fn(async (path: string) => new Response(
      JSON.stringify(
        path.endsWith('/providers')
          ? { providers: [PROVIDER_SUMMARY] }
          : path.endsWith('/project-defaults')
            ? { projectDefaults: [] }
            : path.endsWith('/ssh-trusted-hosts')
              ? [SSH_HOST_SUMMARY]
            : path.endsWith('/api/settings/secure-secrets')
              ? {
                  settings: { maxProjectDefaults: 50, updatedAt: null },
                  defaults: { maxProjectDefaults: 50, updatedAt: null },
                  constraints: { maxProjectDefaults: { min: 1, max: 256, default: 50 } },
                }
            : { secrets: [SECRET_SUMMARY] },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = makeClient(fetchMock)

    await expect(fetchSecureSecretsCatalog(client)).resolves.toEqual({
      providers: [PROVIDER_SUMMARY],
      secrets: [SECRET_SUMMARY],
      projectDefaults: [],
      sshTrustedHosts: [SSH_HOST_SUMMARY],
      maxProjectDefaults: 50,
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
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets/ssh-trusted-hosts',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/secure-secrets',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('loads and updates the live automatic-grant limit', async () => {
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => new Response(
      JSON.stringify(
        init?.method === 'PUT'
          ? {
              ok: true,
              settings: { maxProjectDefaults: 12, updatedAt: '2026-08-31T12:00:00.000Z' },
            }
          : {
              settings: { maxProjectDefaults: 50, updatedAt: null },
              defaults: { maxProjectDefaults: 50, updatedAt: null },
              constraints: { maxProjectDefaults: { min: 1, max: 256, default: 50 } },
            },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = makeClient(fetchMock)

    await expect(fetchSecureSecretSettings(client)).resolves.toEqual({
      settings: { maxProjectDefaults: 50, updatedAt: null },
      defaults: { maxProjectDefaults: 50, updatedAt: null },
      constraints: { maxProjectDefaults: { min: 1, max: 256, default: 50 } },
    })
    await expect(updateSecureSecretSettings(client, { maxProjectDefaults: 12 })).resolves.toEqual({
      ok: true,
      settings: { maxProjectDefaults: 12, updatedAt: '2026-08-31T12:00:00.000Z' },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/secure-secrets',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ maxProjectDefaults: 12 }),
      }),
    )
  })

  it('creates, updates, and removes project SSH trust metadata with secure control', async () => {
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(SSH_HOST_SUMMARY), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }))
    const client = makeClient(fetchMock)

    await createSecureSshTrustedHost(client, {
      profileId: 'project-alpha',
      alias: 'production-api',
      hostName: '10.0.0.25',
      port: 22,
      username: 'deploy',
      hostKey: 'ssh-ed25519 AAAA',
    })
    await updateSecureSshTrustedHost(client, 'ssh-host-1', {
      username: 'release',
    })
    await deleteSecureSshTrustedHost(client, 'ssh-host-1')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/secure-secrets/ssh-trusted-hosts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    )
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
      .get('X-Forge-Secure-Control')).toBe('test-secure-control-token-that-is-long-enough')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/secure-secrets/ssh-trusted-hosts/ssh-host-1',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/secure-secrets/ssh-trusted-hosts/ssh-host-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('exports and imports only the encrypted Desktop vault transfer contract', async () => {
    const transferBundle = {
      format: 'forge-secure-vault-transfer' as const,
      version: 1 as const,
      algorithm: 'aes-256-gcm' as const,
      createdAt: '2026-08-31T12:00:00.000Z',
      itemCount: 2,
      nonce: 'bm9uY2U',
      authTag: 'YXV0aC10YWc',
      ciphertext: 'ZW5jcnlwdGVkLW9ubHk=',
    }
    const exported = {
      bundle: transferBundle,
      transferCode: 'transfer-code-not-persisted',
      localSecretCount: 1,
      providerCredentialCount: 1,
    }
    const imported = {
      importedItemCount: 2,
      localSecretCount: 1,
      providerCredentialCount: 1,
    }
    const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => new Response(
      JSON.stringify(path.endsWith('/export') ? exported : imported),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = makeClient(fetchMock)

    await expect(exportSecureVaultTransfer(client)).resolves.toEqual(exported)
    await expect(importSecureVaultTransfer(client, {
      bundle: transferBundle,
      transferCode: exported.transferCode,
    })).resolves.toEqual(imported)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/secure-secrets/transfer/export',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/secure-secrets/transfer/import',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bundle: transferBundle,
          transferCode: exported.transferCode,
        }),
      }),
    )
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get('X-Forge-Secure-Control'))
        .toBe('test-secure-control-token-that-is-long-enough')
    }
  })

  it('loads and installs through only the fixed Secure Sessions readiness contract', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      available: false,
      code: 'image_unavailable',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = makeClient(fetchMock)

    await expect(fetchSecureSessionReadiness(client)).resolves.toEqual({
      available: false,
      code: 'image_unavailable',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-sessions/readiness',
      expect.objectContaining({ cache: 'no-store' }),
    )

    await expect(installSecureRunner(client)).resolves.toEqual({
      available: false,
      code: 'image_unavailable',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-sessions/runner/install',
      expect.objectContaining({
        cache: 'no-store',
        method: 'POST',
      }),
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
      note: 'Used by release automation.',
      material: rawSecret,
      scope: {
        kind: 'profiles',
        profileIds: ['project-alpha', 'project-beta'],
      },
    })

    const requestBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-Forge-Secure-Control'))
      .toBe('test-secure-control-token-that-is-long-enough')
    expect(requestBody).toContain('"encryptedMaterial":"ciphertext-only"')
    expect(requestBody).toContain('"note":"Used by release automation."')
    expect(requestBody).toContain(
      '"scope":{"kind":"profiles","profileIds":["project-alpha","project-beta"]}',
    )
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

  it('reconnects Bitwarden by replacing only its encrypted credential', async () => {
    const rawToken = 'replacement-bws-raw-access-token'
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(PROVIDER_SUMMARY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const client = makeClient(fetchMock)

    await reconnectBitwardenProvider(client, 'bitwarden/one', rawToken)

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/secure-secrets/providers/bitwarden%2Fone/credential',
    )
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'PATCH',
    }))
    const requestBody = String(fetchMock.mock.calls[0]?.[1]?.body)
    expect(JSON.parse(requestBody)).toEqual({
      encryptedAccessToken: 'encrypted-envelope',
    })
    expect(requestBody).not.toContain(rawToken)
  })

  it('returns only fixed local recovery metadata from provider tests', async () => {
    const result = {
      provider: {
        ...PROVIDER_SUMMARY,
        providerId: 'local',
        kind: 'local_keychain' as const,
      },
      code: 'local_secret_decrypt_failed' as const,
      affectedSecrets: [{
        secretId: 'secret-1',
        displayAlias: 'github/work',
      }],
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = makeClient(fetchMock)

    await expect(testSecureSecretProvider(client, 'local/one')).resolves.toEqual(result)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets/providers/local%2Fone/test',
      expect.objectContaining({ method: 'POST' }),
    )
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

    await updateSecureSecret(client, 'secret-1', {
      displayName: 'Updated',
      note: null,
    })

    expect(encryptLocalValue).not.toHaveBeenCalled()
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body).toBe(
      JSON.stringify({ displayName: 'Updated', note: null }),
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

  it('atomically replaces the automatic grant policy without sending secret material', async () => {
    const updated = {
      ...SECRET_SUMMARY,
      automaticGrantPolicy: {
        kind: 'projects' as const,
        profileIds: ['project/alpha', 'project/beta'],
      },
    }
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(updated), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      }))
    const client = makeClient(fetchMock)

    await expect(updateSecureSecretAutomaticGrant(
      client,
      'secret/one',
      updated.automaticGrantPolicy,
    )).resolves.toEqual(updated)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/secure-secrets/secret%2Fone/automatic-grant',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          policy: {
            kind: 'projects',
            profileIds: ['project/alpha', 'project/beta'],
          },
        }),
      }),
    )
    const requestBody = String(fetchMock.mock.calls[0]?.[1]?.body)
    expect(requestBody).not.toContain('encryptedMaterial')
    expect(requestBody).not.toContain('raw-secret')
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
        'One or more selected projects already have the maximum number of automatic grants. Remove one before adding another.',
    })
  })
})
