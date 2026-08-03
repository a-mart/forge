/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SecureAccessRequestSummary, SecureSessionSnapshot } from '@forge/protocol'
import {
  applySecureSessionProjectDefaults,
  approveSecureSshHostTrustRequest,
  denySecureAccessRequest,
  dismissSecureSshHostTrustRequest,
  fetchSecureSessionSnapshot,
  fulfillSecureAccessRequestPrivately,
  grantSecureSessionLease,
  grantSecureSessionLeases,
  isSecureControlAvailable,
  resolveSecureSecretsForProfile,
  secureSessionUiErrorMessage,
  SecureSessionUiError,
  shouldRefreshAfterProjectDefaultsApplyError,
  toProtocolBindings,
  toSecureSessionSnapshotView,
  unlockLocalProjectDefaultsIfNeeded,
} from './secure-sessions-api'

function makeClient(fetchImpl: SettingsApiClient['fetch']): SettingsApiClient {
  return {
    target: {
      kind: 'builder',
      label: 'Builder',
      description: 'Local',
      wsUrl: 'ws://localhost:47188/ws',
      apiBaseUrl: 'http://localhost:47188',
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

function snapshot(revision = 4): SecureSessionSnapshot {
  return {
    sessionAgentId: 'manager-1',
    profileId: 'profile-1',
    principalKind: 'manager',
    ownerManagerAgentId: null,
    workerAssignmentId: null,
    revision,
    executionMode: 'secure',
    environmentStatus: 'ready',
    leases: [],
    pendingRequests: [],
    updatedAt: '2026-07-23T12:00:00.000Z',
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'electronBridge')
  vi.restoreAllMocks()
})

beforeEach(() => {
  Object.defineProperty(window, 'electronBridge', {
    configurable: true,
    value: {
      secureControlToken: 'test-secure-control-token-that-is-long-enough',
    },
  })
})

describe('Secure Sessions API', () => {
  it('maps the project-default limit to a fixed safe message', () => {
    expect(secureSessionUiErrorMessage(
      new SecureSessionUiError('SECURE_PROJECT_DEFAULT_LIMIT_REACHED'),
    )).toBe('This project already has the maximum number of automatic secrets.')
  })

  it('maps additive SSH trust metadata into the UI snapshot', () => {
    const source = snapshot()
    source.trustedSshHosts = [{
      trustedHostId: 'host-1',
      profileId: 'profile-1',
      alias: 'production-api',
      hostName: '10.0.0.25',
      port: 22,
      username: 'deploy',
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyFingerprint: 'SHA256:trusted',
      createdAt: source.updatedAt,
      updatedAt: source.updatedAt,
    }]
    source.pendingSshTrustRequests = [{
      requestId: 'trust-1',
      alias: 'production-api',
      hostName: '10.0.0.25',
      port: 22,
      username: 'deploy',
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyFingerprint: 'SHA256:reported',
      purposeSummary: 'Deploy the release',
      requestedByAgentId: 'worker-1',
      requestedByDisplayName: 'Release worker',
      createdAt: source.updatedAt,
      expiresAt: null,
    }]

    expect(toSecureSessionSnapshotView(source)).toMatchObject({
      trustedSshHosts: [{ trustedHostId: 'host-1' }],
      pendingSshTrustRequests: [{ requestId: 'trust-1' }],
    })
    expect(toSecureSessionSnapshotView(snapshot())).toMatchObject({
      trustedSshHosts: [],
      pendingSshTrustRequests: [],
    })
  })

  it('maps fixed command-local execution incident metadata', () => {
    const source = snapshot()
    source.lastExecutionIncident = {
      code: 'EXECUTION_TIMEOUT',
      agentId: 'worker-a',
      occurredAt: '2026-07-23T12:01:00.000Z',
    }

    expect(toSecureSessionSnapshotView(source).lastExecutionIncident).toEqual({
      code: 'EXECUTION_TIMEOUT',
      agentId: 'worker-a',
      occurredAt: '2026-07-23T12:01:00.000Z',
    })
  })

  it('approves SSH trust with secure control and dismisses it through the web-safe route', async () => {
    const fetchMock = vi.fn<SettingsApiClient['fetch']>(async () => new Response(JSON.stringify(snapshot(5)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = makeClient(fetchMock)

    await approveSecureSshHostTrustRequest(client, 'manager-1', 'trust-1', 4)
    await dismissSecureSshHostTrustRequest(client, 'manager-1', 'trust-2', 5)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/secure-sessions/manager-1/ssh-trust-requests/trust-1/resolve',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
      .get('X-Forge-Secure-Control')).toBe('test-secure-control-token-that-is-long-enough')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/secure-sessions/manager-1/ssh-trust-requests/trust-2',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers)
      .has('X-Forge-Secure-Control')).toBe(false)
  })

  it('reports a stale SSH trust request with fixed actionable copy', async () => {
    const fetchMock = vi.fn<SettingsApiClient['fetch']>(async () =>
      new Response(JSON.stringify({
        code: 'SECURE_SSH_HOST_NOT_FOUND',
        error: 'SECURE_SSH_HOST_NOT_FOUND',
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }))

    await expect(approveSecureSshHostTrustRequest(
      makeClient(fetchMock),
      'manager-1',
      'missing-trust',
      4,
    )).rejects.toMatchObject({
      code: 'SECURE_SSH_HOST_NOT_FOUND',
      message: expect.stringContaining('no longer available'),
    })
  })

  it('refreshes exact state after stale or ambiguous project-default results', () => {
    expect(shouldRefreshAfterProjectDefaultsApplyError(
      new SecureSessionUiError('SECURE_STALE_REVISION'),
    )).toBe(true)
    expect(shouldRefreshAfterProjectDefaultsApplyError(
      new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE'),
    )).toBe(true)
    expect(shouldRefreshAfterProjectDefaultsApplyError(
      new SecureSessionUiError('SECURE_OPERATION_FAILED'),
    )).toBe(true)
    expect(shouldRefreshAfterProjectDefaultsApplyError(
      new SecureSessionUiError('SECURE_REQUEST_INVALID'),
    )).toBe(false)
    expect(shouldRefreshAfterProjectDefaultsApplyError(
      new TypeError('offline'),
    )).toBe(false)
  })

  it('unlocks only when the current project has a local automatic grant', async () => {
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
    const catalog = {
      providers: [{
        providerId: 'local',
        kind: 'local_keychain' as const,
        displayName: 'Local vault',
        enabled: true,
        status: 'unreachable' as const,
        lastVerifiedAt: null,
        lastStatusCode: 'source_unreachable' as const,
      }],
      secrets: [{
        secretId: 'local-default',
        providerId: 'local',
        displayAlias: 'deploy-token',
        displayName: null,
        scope: { kind: 'instance' as const },
        retention: 'saved' as const,
        bindings: [{
          deliveryKind: 'environment' as const,
          targetName: 'DEPLOY_TOKEN',
        }],
        automaticGrantPolicy: {
          kind: 'projects' as const,
          profileIds: ['profile-1'],
        },
        available: false,
        updatedAt: '2026-07-23T12:00:00.000Z',
      }],
      projectDefaults: [],
    }

    await expect(unlockLocalProjectDefaultsIfNeeded(catalog, 'profile-1'))
      .resolves.toBe(true)
    expect(unlock).toHaveBeenCalledTimes(1)

    await expect(unlockLocalProjectDefaultsIfNeeded(catalog, 'profile-2'))
      .resolves.toBe(true)
    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a required local project default cannot unlock', async () => {
    const unlock = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE' as const,
    }))
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        secureControlToken: 'test-secure-control-token-that-is-long-enough',
        secureVault: {
          status: vi.fn(),
          unlock,
          encryptLocalValue: vi.fn(),
        },
      },
    })

    await expect(unlockLocalProjectDefaultsIfNeeded({
      providers: [{
        providerId: 'local',
        kind: 'local_keychain',
        displayName: 'Local vault',
        enabled: true,
        status: 'locked',
        lastVerifiedAt: null,
        lastStatusCode: 'source_locked',
      }],
      secrets: [{
        secretId: 'local-default',
        providerId: 'local',
        displayAlias: 'deploy-token',
        displayName: null,
        scope: { kind: 'instance' },
        retention: 'saved',
        bindings: [],
        automaticGrantPolicy: { kind: 'all_projects' },
        available: false,
        updatedAt: '2026-07-23T12:00:00.000Z',
      }],
      projectDefaults: [],
    }, 'profile-1', true)).resolves.toBe(false)
    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it('uses authenticated paired-browser vault readiness when no Electron bridge exists', async () => {
    Reflect.deleteProperty(window, 'electronBridge')
    const catalog = {
      providers: [{
        providerId: 'local',
        kind: 'local_keychain' as const,
        displayName: 'Local vault',
        enabled: true,
        status: 'available' as const,
        lastVerifiedAt: '2026-07-29T12:00:00.000Z',
        lastStatusCode: null,
      }],
      secrets: [{
        secretId: 'local-default',
        providerId: 'local',
        displayAlias: 'deploy-token',
        displayName: null,
        scope: { kind: 'instance' as const },
        retention: 'saved' as const,
        bindings: [],
        automaticGrantPolicy: { kind: 'all_projects' as const },
        available: true,
        updatedAt: '2026-07-29T12:00:00.000Z',
      }],
      projectDefaults: [],
    }

    await expect(unlockLocalProjectDefaultsIfNeeded(
      catalog,
      'profile-1',
      true,
    )).resolves.toBe(true)
    await expect(unlockLocalProjectDefaultsIfNeeded(
      catalog,
      'profile-1',
      false,
    )).resolves.toBe(false)
  })

  it('uses no-store for snapshot reads', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot()), { status: 200 }))
    await fetchSecureSessionSnapshot(makeClient(fetch), 'manager/one')

    expect(fetch).toHaveBeenCalledWith(
      '/api/secure-sessions/manager%2Fone',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
      }),
    )
  })

  it('applies project defaults to the exact manager revision', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))

    await applySecureSessionProjectDefaults(
      makeClient(fetch),
      'manager/one',
      4,
    )

    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/secure-sessions/manager%2Fone/project-defaults/apply',
    )
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      baseRevision: 4,
    })
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get(
      'X-Forge-Secure-Control',
    )).toBe('test-secure-control-token-that-is-long-enough')
  })

  it('dismisses a request in the web UI without a Desktop capability token', async () => {
    Reflect.deleteProperty(window, 'electronBridge')
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))

    expect(isSecureControlAvailable()).toBe(false)
    await denySecureAccessRequest(
      makeClient(fetch),
      'manager/one',
      'request/one',
      4,
    )

    const init = fetch.mock.calls[0]?.[1]
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/secure-sessions/manager%2Fone/access-requests/request%2Fone',
    )
    expect(init?.method).toBe('DELETE')
    expect(JSON.parse(String(init?.body))).toEqual({ baseRevision: 4 })
    expect(new Headers(init?.headers).has('X-Forge-Secure-Control')).toBe(false)
  })

  it('maps a fixed output-quarantine state without exposing match details', () => {
    const value = snapshot()
    value.outputState = 'quarantined'
    value.outputStateCode = 'SECURE_OUTPUT_QUARANTINED'

    expect(toSecureSessionSnapshotView(value)).toMatchObject({
      outputState: 'quarantined',
      outputStateCode: 'SECURE_OUTPUT_QUARANTINED',
    })
  })

  it('maps safe project-default statuses and default lease provenance', () => {
    const value = snapshot()
    value.leases = [{
      leaseId: 'lease-default',
      secretId: 'secret-default',
      displayAlias: 'deploy-token',
      leaseKind: 'task',
      exposures: [{ deliveryKind: 'environment', targetName: 'DEPLOY_TOKEN' }],
      status: 'active',
      expiresAt: null,
      lastUsedAt: null,
      remainingUses: null,
      grantSource: 'project_default',
    }]
    value.projectDefaults = [{
      secretId: 'secret-default',
      displayAlias: 'deploy-token',
      state: 'active',
      statusCode: 'ok',
    }, {
      secretId: 'secret-unavailable',
      displayAlias: 'backup-token',
      state: 'unavailable',
      statusCode: 'source_unavailable',
    }]

    expect(toSecureSessionSnapshotView(value)).toMatchObject({
      leases: [{ grantSource: 'project_default' }],
      projectDefaults: [
        { displayAlias: 'deploy-token', state: 'active', statusCode: 'ok' },
        {
          displayAlias: 'backup-token',
          state: 'unavailable',
          statusCode: 'source_unavailable',
        },
      ],
    })
  })

  it('posts an exact pending-request approval without replacing its stored authority', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))
    await grantSecureSessionLease(makeClient(fetch), 'manager-1', 4, {
      requestId: 'request-1',
      secretId: 'secret-1',
      bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
      policy: { kind: 'one_use' },
    })

    const init = fetch.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get('X-Forge-Secure-Control'))
      .toBe('test-secure-control-token-that-is-long-enough')
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/secure-sessions/manager-1/access-requests/request-1/resolve',
    )
    expect(JSON.parse(String(init?.body))).toEqual({
      baseRevision: 4,
      decision: 'approve',
    })
  })

  it('selects a matching saved secret only for a request that began without one', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))

    await grantSecureSessionLease(makeClient(fetch), 'manager-1', 4, {
      requestId: 'request-1',
      selectForMissingRequest: true,
      secretId: 'newly-saved-secret',
      bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
      policy: { kind: 'one_use' },
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      baseRevision: 4,
      decision: 'approve',
      selectedSecretId: 'newly-saved-secret',
    })
  })

  it('hides other-project aliases and lets the current project override an instance alias', () => {
    const secrets = [
      {
        secretId: 'global-shared',
        providerId: 'local',
        displayAlias: 'shared-token',
        displayName: 'Global shared token',
        scope: { kind: 'instance' as const },
        retention: 'saved' as const,
        bindings: [{ deliveryKind: 'environment' as const, targetName: 'SHARED_TOKEN' }],
        available: true,
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
      {
        secretId: 'other-project',
        providerId: 'local',
        displayAlias: 'other-only',
        displayName: 'Other project token',
        scope: { kind: 'profile' as const, profileId: 'profile-2' },
        retention: 'saved' as const,
        bindings: [{ deliveryKind: 'environment' as const, targetName: 'OTHER_TOKEN' }],
        available: true,
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
      {
        secretId: 'current-override',
        providerId: 'local',
        displayAlias: 'shared-token',
        displayName: 'Current project shared token',
        scope: { kind: 'profile' as const, profileId: 'profile-1' },
        retention: 'saved' as const,
        bindings: [{ deliveryKind: 'environment' as const, targetName: 'SHARED_TOKEN' }],
        available: true,
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
      {
        secretId: 'selected-projects',
        providerId: 'local',
        displayAlias: 'selected-only',
        displayName: 'Selected projects token',
        scope: {
          kind: 'profiles' as const,
          profileIds: ['profile-1', 'profile-3'],
        },
        retention: 'saved' as const,
        bindings: [{
          deliveryKind: 'environment' as const,
          targetName: 'SELECTED_TOKEN',
        }],
        available: true,
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
    ]

    expect(
      resolveSecureSecretsForProfile(secrets, 'profile-1').map((secret) => secret.secretId),
    ).toEqual(['current-override', 'selected-projects'])
    expect(
      resolveSecureSecretsForProfile(secrets, 'profile-2').map((secret) => secret.secretId),
    ).toEqual(['global-shared', 'other-project'])
    expect(
      resolveSecureSecretsForProfile(secrets, 'profile-3').map((secret) => secret.secretId),
    ).toEqual(['global-shared', 'selected-projects'])
  })

  it('posts a reviewed multi-secret grant as one batch request', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))

    await grantSecureSessionLeases(makeClient(fetch), 'manager-1', 4, [
      {
        secretId: 'secret-1',
        bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
        policy: { kind: 'task' },
      },
      {
        secretId: 'secret-2',
        bindings: [{ kind: 'askpass', variable: 'SSH_ASKPASS' }],
        policy: { kind: 'timed', durationSeconds: 900 },
      },
    ])

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/secure-sessions/manager-1/leases/batch',
    )
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      baseRevision: 4,
      grants: [
        {
          secretId: 'secret-1',
          exposures: [{ deliveryKind: 'environment', targetName: 'DEPLOY_TOKEN' }],
          leaseKind: 'task',
        },
        {
          secretId: 'secret-2',
          exposures: [{ deliveryKind: 'askpass', targetName: 'SSH_ASKPASS' }],
          leaseKind: 'timed',
          durationSeconds: 900,
        },
      ],
    })
  })

  it('encrypts a private value before HTTP and never puts plaintext in the request', async () => {
    const encryptLocalValue = vi.fn(async () => ({
      ok: true as const,
      encryptedPayloadBase64: 'ciphertext-only',
    }))
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
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))
    const request: SecureAccessRequestSummary = {
      requestId: 'request-1',
      secretId: null,
      displayAlias: 'deploy-token',
      requestedLeaseKind: 'one_use',
      requestedExposures: [{ deliveryKind: 'environment', targetName: 'DEPLOY_TOKEN' }],
      purposeSummary: 'Publish release',
      requestedByAgentId: 'worker-1',
      requestedByDisplayName: 'Deploy worker',
      workerAssignmentId: 'assignment-1',
      createdAt: '2026-07-23T12:00:00.000Z',
      expiresAt: null,
    }

    await fulfillSecureAccessRequestPrivately(
      makeClient(fetch),
      'manager-1',
      request,
      4,
      {
        value: 'raw-super-secret',
        retention: 'saved',
        scope: { kind: 'profile', profileId: 'profile-1' },
        makeProjectDefault: true,
      },
    )

    expect(encryptLocalValue).toHaveBeenCalledWith('raw-super-secret')
    const serializedBody = String(fetch.mock.calls[0]?.[1]?.body)
    expect(serializedBody).not.toContain('raw-super-secret')
    expect(JSON.parse(serializedBody)).toEqual({
      baseRevision: 4,
      displayAlias: 'deploy-token',
      encryptedMaterial: 'ciphertext-only',
      retention: 'saved',
      scope: { kind: 'profile', profileId: 'profile-1' },
      makeProjectDefault: true,
      leaseKind: 'one_use',
      exposures: [{ deliveryKind: 'environment', targetName: 'DEPLOY_TOKEN' }],
    })
  })

  it('sends a session-only fulfillment with current-project scope and no default policy', async () => {
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        secureControlToken: 'test-secure-control-token-that-is-long-enough',
        secureVault: {
          status: vi.fn(async () => ({ ok: true as const, available: true as const })),
          unlock: vi.fn(async () => ({ ok: true as const, available: true as const })),
          encryptLocalValue: vi.fn(async () => ({
            ok: true as const,
            encryptedPayloadBase64: 'ephemeral-ciphertext',
          })),
        },
      },
    })
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))
    const request: SecureAccessRequestSummary = {
      requestId: 'request-ephemeral',
      secretId: null,
      displayAlias: 'deploy-token',
      requestedLeaseKind: 'timed',
      requestedDurationSeconds: 900,
      requestedExposures: [{ deliveryKind: 'askpass', targetName: 'SSH_ASKPASS' }],
      purposeSummary: 'Connect to the release host',
      requestedByAgentId: 'manager-1',
      requestedByDisplayName: 'Release manager',
      workerAssignmentId: null,
      createdAt: '2026-07-23T12:00:00.000Z',
      expiresAt: null,
    }

    await fulfillSecureAccessRequestPrivately(
      makeClient(fetch),
      'manager-1',
      request,
      4,
      {
        value: 'one-session-only',
        retention: 'session',
        scope: { kind: 'profile', profileId: 'profile-1' },
      },
    )

    const serializedBody = String(fetch.mock.calls[0]?.[1]?.body)
    expect(serializedBody).not.toContain('one-session-only')
    expect(JSON.parse(serializedBody)).toEqual({
      baseRevision: 4,
      displayAlias: 'deploy-token',
      encryptedMaterial: 'ephemeral-ciphertext',
      retention: 'session',
      scope: { kind: 'profile', profileId: 'profile-1' },
      leaseKind: 'timed',
      durationSeconds: 900,
      exposures: [{ deliveryKind: 'askpass', targetName: 'SSH_ASKPASS' }],
    })
  })

  it('surfaces a saved-alias race as a fixed actionable error', async () => {
    Object.defineProperty(window, 'electronBridge', {
      configurable: true,
      value: {
        secureControlToken: 'test-secure-control-token-that-is-long-enough',
        secureVault: {
          status: vi.fn(async () => ({ ok: true as const, available: true as const })),
          unlock: vi.fn(async () => ({ ok: true as const, available: true as const })),
          encryptLocalValue: vi.fn(async () => ({
            ok: true as const,
            encryptedPayloadBase64: 'conflicting-ciphertext',
          })),
        },
      },
    })
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify({
        code: 'SECURE_SECRET_ALIAS_CONFLICT',
        error: 'SECURE_SECRET_ALIAS_CONFLICT',
      }), { status: 409 }))
    const request: SecureAccessRequestSummary = {
      requestId: 'request-conflict',
      secretId: null,
      displayAlias: 'deploy-token',
      requestedLeaseKind: 'task',
      requestedExposures: [{ deliveryKind: 'environment', targetName: 'DEPLOY_TOKEN' }],
      purposeSummary: 'Publish release',
      requestedByAgentId: 'manager-1',
      requestedByDisplayName: 'Release manager',
      workerAssignmentId: null,
      createdAt: '2026-07-23T12:00:00.000Z',
      expiresAt: null,
    }

    await expect(fulfillSecureAccessRequestPrivately(
      makeClient(fetch),
      'manager-1',
      request,
      4,
      {
        value: 'conflicting-value',
        retention: 'saved',
        scope: { kind: 'profile', profileId: 'profile-1' },
      },
    )).rejects.toMatchObject({
      code: 'SECURE_SECRET_ALIAS_CONFLICT',
      message: expect.stringContaining('saved elsewhere'),
    })
  })

  it('zeros a byte-backed private value after desktop encryption', async () => {
    const encryptLocalValue = vi.fn(async () => ({
      ok: true as const,
      encryptedPayloadBase64: 'ciphertext-only',
    }))
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
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))
    const request: SecureAccessRequestSummary = {
      requestId: 'request-bytes',
      secretId: null,
      displayAlias: 'deploy-token',
      requestedLeaseKind: 'task',
      requestedExposures: [{ deliveryKind: 'stdin' }],
      purposeSummary: 'Authenticate once',
      requestedByAgentId: 'manager-1',
      requestedByDisplayName: 'Release manager',
      workerAssignmentId: null,
      createdAt: '2026-07-23T12:00:00.000Z',
      expiresAt: null,
    }
    const privateBytes = new TextEncoder().encode('byte-secret')

    await fulfillSecureAccessRequestPrivately(
      makeClient(fetch),
      'manager-1',
      request,
      4,
      {
        value: privateBytes,
        retention: 'session',
        scope: { kind: 'profile', profileId: 'profile-1' },
      },
    )

    expect(encryptLocalValue).toHaveBeenCalledWith('byte-secret')
    expect(Array.from(privateBytes)).toEqual(new Array(privateBytes.length).fill(0))
  })

  it('preserves multiple requested exposures and file modes in view adapters', () => {
    const value = snapshot()
    value.pendingRequests = [{
      requestId: 'request-1',
      secretId: 'secret-1',
      displayAlias: 'deploy-token',
      requestedLeaseKind: 'task',
      requestedExposures: [
        { deliveryKind: 'environment', targetName: 'DEPLOY_TOKEN' },
        { deliveryKind: 'file', targetPath: '/run/secret', fileMode: 0o400 },
      ],
      purposeSummary: 'Publish release',
      requestedByAgentId: 'worker-1',
      requestedByDisplayName: 'Deploy worker',
      workerAssignmentId: 'assignment-1',
      createdAt: '2026-07-23T12:00:00.000Z',
      expiresAt: null,
    }]

    const view = toSecureSessionSnapshotView(value)
    expect(view.pendingRequests[0]?.requestedBindings).toEqual([
      { kind: 'env', variable: 'DEPLOY_TOKEN' },
      { kind: 'file', targetPath: '/run/secret', fileMode: 0o400 },
    ])
    expect(toProtocolBindings(view.pendingRequests[0]?.requestedBindings ?? [])).toEqual(
      value.pendingRequests[0]?.requestedExposures,
    )
  })
})
