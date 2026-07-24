/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SecureAccessRequestSummary, SecureSessionSnapshot } from '@forge/protocol'
import {
  fetchSecureSessionSnapshot,
  fulfillSecureAccessRequestPrivately,
  grantSecureSessionLease,
  grantSecureSessionLeases,
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
  it('uses no-store for snapshot reads', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot()), { status: 200 }))
    await fetchSecureSessionSnapshot(makeClient(fetch), 'manager/one')

    expect(fetch).toHaveBeenCalledWith(
      '/api/secure-sessions/manager%2Fone',
      expect.objectContaining({ cache: 'no-store' }),
    )
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
      createdAt: '2026-07-23T12:00:00.000Z',
      expiresAt: null,
    }

    await fulfillSecureAccessRequestPrivately(
      makeClient(fetch),
      'manager-1',
      request,
      4,
      'raw-super-secret',
    )

    expect(encryptLocalValue).toHaveBeenCalledWith('raw-super-secret')
    const serializedBody = String(fetch.mock.calls[0]?.[1]?.body)
    expect(serializedBody).not.toContain('raw-super-secret')
    expect(JSON.parse(serializedBody)).toEqual({
      baseRevision: 4,
      displayAlias: 'deploy-token',
      encryptedMaterial: 'ciphertext-only',
      leaseKind: 'one_use',
      exposures: [{ deliveryKind: 'environment', targetName: 'DEPLOY_TOKEN' }],
    })
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
