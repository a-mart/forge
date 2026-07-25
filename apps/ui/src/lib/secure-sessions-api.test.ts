/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SecureAccessRequestSummary, SecureSessionSnapshot } from '@forge/protocol'
import {
  applySecureSessionProjectDefaults,
  fetchSecureSessionSnapshot,
  fulfillSecureAccessRequestPrivately,
  grantSecureSessionLease,
  grantSecureSessionLeases,
  resolveSecureSecretsForProfile,
  secureSessionUiErrorMessage,
  SecureSessionUiError,
  shouldRefreshAfterProjectDefaultsApplyError,
  toProtocolBindings,
  toSecureSessionSnapshotView,
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

  it('uses no-store for snapshot reads', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot()), { status: 200 }))
    await fetchSecureSessionSnapshot(makeClient(fetch), 'manager/one')

    expect(fetch).toHaveBeenCalledWith(
      '/api/secure-sessions/manager%2Fone',
      expect.objectContaining({ cache: 'no-store' }),
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
    ]

    expect(
      resolveSecureSecretsForProfile(secrets, 'profile-1').map((secret) => secret.secretId),
    ).toEqual(['current-override'])
    expect(
      resolveSecureSecretsForProfile(secrets, 'profile-2').map((secret) => secret.secretId),
    ).toEqual(['global-shared', 'other-project'])
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
