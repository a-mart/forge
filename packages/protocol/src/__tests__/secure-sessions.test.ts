import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  SECURE_SECRET_DELIVERY_KINDS,
  SECURE_SECRET_LEASE_KINDS,
  SECURE_SECRET_MAX_TIMED_LEASE_SECONDS,
  SECURE_SECRET_PROVIDER_KINDS,
  SecureSessionsContractError,
  isSecureSecretBinding,
  isSecureSecretLeaseSpec,
  parseGrantSecureSecretLeaseRequest,
  parseGrantSecureSecretLeasesRequest,
  parseRequestSecureSecretAccessRequest,
  parseResolveSecureSecretAccessRequest,
  parseRevokeSecureSecretLeaseRequest,
  parseSecureSecretBinding,
  parseSecureSecretLeaseSpec,
  parseSecureSecretScope,
  type SecureAccessRequestSummary,
  type SecureSecretBinding,
  type SecureSecretCatalog,
  type SecureSecretCatalogChangedEvent,
  type SecureSecretProviderSummary,
  type SecureSecretSummary,
  type SecureSessionLeaseSummary,
  type SecureSessionSnapshotEvent,
  type ServerEvent,
} from '../index.js'

const now = '2026-07-23T12:00:00.000Z'

describe('Secure Sessions protocol', () => {
  it('exports the metadata-only provider and catalog vocabulary', () => {
    expect(SECURE_SECRET_PROVIDER_KINDS).toEqual([
      'local_keychain',
      'bitwarden_secrets_manager',
    ])
    expect(SECURE_SECRET_DELIVERY_KINDS).toEqual([
      'environment',
      'stdin',
      'file',
      'askpass',
      'ssh_agent',
    ])
    expect(SECURE_SECRET_LEASE_KINDS).toEqual(['task', 'timed', 'one_use'])

    const provider = {
      providerId: 'provider-local',
      kind: 'local_keychain',
      displayName: 'Local keychain',
      enabled: true,
      status: 'available',
      lastVerifiedAt: now,
      lastStatusCode: 'ok',
    } satisfies SecureSecretProviderSummary

    const secret = {
      secretId: 'secret-api',
      providerId: provider.providerId,
      displayAlias: 'github/work',
      displayName: 'Work GitHub credential',
      scope: { kind: 'profile', profileId: 'profile-1' },
      retention: 'saved',
      bindings: [{ deliveryKind: 'environment', targetName: 'GITHUB_TOKEN' }],
      available: true,
      updatedAt: now,
    } satisfies SecureSecretSummary

    const catalog = {
      revision: 3,
      providers: [provider],
      secrets: [secret],
      updatedAt: now,
    } satisfies SecureSecretCatalog

    expect(catalog.secrets[0]?.displayAlias).toBe('github/work')
    expect(parseSecureSecretScope(secret.scope)).toEqual(secret.scope)
  })

  it('parses every guest-side binding without provider-side source fields', () => {
    const bindings: SecureSecretBinding[] = [
      { deliveryKind: 'environment', targetName: 'SERVICE_TOKEN' },
      { deliveryKind: 'stdin' },
      {
        deliveryKind: 'file',
        targetPath: '/run/forge/service-token',
        fileMode: 0o600,
      },
      { deliveryKind: 'askpass', targetName: 'GIT_ASKPASS' },
      { deliveryKind: 'ssh_agent' },
    ]

    for (const binding of bindings) {
      expect(parseSecureSecretBinding(binding)).toEqual(binding)
      expect(isSecureSecretBinding(binding)).toBe(true)
    }
  })

  it('parses task, timed, and one-use lease specs', () => {
    expect(parseSecureSecretLeaseSpec({ leaseKind: 'task' })).toEqual({
      leaseKind: 'task',
    })
    expect(parseSecureSecretLeaseSpec({
      leaseKind: 'timed',
      durationSeconds: SECURE_SECRET_MAX_TIMED_LEASE_SECONDS,
    })).toEqual({
      leaseKind: 'timed',
      durationSeconds: SECURE_SECRET_MAX_TIMED_LEASE_SECONDS,
    })
    expect(parseSecureSecretLeaseSpec({ leaseKind: 'one_use' })).toEqual({
      leaseKind: 'one_use',
    })
    expect(isSecureSecretLeaseSpec({ leaseKind: 'timed', durationSeconds: 60 })).toBe(true)
    expect(isSecureSecretLeaseSpec({ leaseKind: 'timed', durationSeconds: 0 })).toBe(false)
  })

  it('parses revision-checked lease mutations and safe access decisions', () => {
    const exposure = { deliveryKind: 'environment', targetName: 'SERVICE_TOKEN' } as const

    expect(parseGrantSecureSecretLeaseRequest({
      baseRevision: 4,
      secretId: 'secret-api',
      exposures: [exposure],
      leaseKind: 'task',
    })).toEqual({
      baseRevision: 4,
      secretId: 'secret-api',
      exposures: [exposure],
      leaseKind: 'task',
    })
    expect(parseRevokeSecureSecretLeaseRequest({
      baseRevision: 5,
      leaseId: 'lease-1',
    })).toEqual({
      baseRevision: 5,
      leaseId: 'lease-1',
    })
    expect(parseRequestSecureSecretAccessRequest({
      secretId: 'secret-api',
      exposures: [exposure],
      leaseKind: 'timed',
      durationSeconds: 300,
      purposeSummary: 'Deploy the requested release',
    })).toEqual({
      secretId: 'secret-api',
      exposures: [exposure],
      leaseKind: 'timed',
      durationSeconds: 300,
      purposeSummary: 'Deploy the requested release',
    })
    expect(parseResolveSecureSecretAccessRequest({
      baseRevision: 5,
      requestId: 'access-1',
      decision: 'deny',
    })).toEqual({
      baseRevision: 5,
      requestId: 'access-1',
      decision: 'deny',
    })
  })

  it('parses a strict batch of unique proactive grants', () => {
    expect(parseGrantSecureSecretLeasesRequest({
      baseRevision: 4,
      grants: [
        {
          secretId: 'secret-api',
          exposures: [{ deliveryKind: 'environment', targetName: 'SERVICE_TOKEN' }],
          leaseKind: 'task',
        },
        {
          secretId: 'secret-ssh',
          exposures: [{ deliveryKind: 'ssh_agent' }],
          leaseKind: 'timed',
          durationSeconds: 300,
        },
      ],
    })).toEqual({
      baseRevision: 4,
      grants: [
        {
          secretId: 'secret-api',
          exposures: [{ deliveryKind: 'environment', targetName: 'SERVICE_TOKEN' }],
          leaseKind: 'task',
        },
        {
          secretId: 'secret-ssh',
          exposures: [{ deliveryKind: 'ssh_agent' }],
          leaseKind: 'timed',
          durationSeconds: 300,
        },
      ],
    })

    for (const grants of [
      [],
      Array.from({ length: 17 }, (_, index) => ({
        secretId: `secret-${index}`,
        exposures: [{ deliveryKind: 'stdin' }],
        leaseKind: 'task',
      })),
      [
        {
          secretId: 'duplicate',
          exposures: [{ deliveryKind: 'stdin' }],
          leaseKind: 'task',
        },
        {
          secretId: 'duplicate',
          exposures: [{ deliveryKind: 'ssh_agent' }],
          leaseKind: 'one_use',
        },
      ],
    ]) {
      expect(() => parseGrantSecureSecretLeasesRequest({
        baseRevision: 4,
        grants,
      })).toThrow(SecureSessionsContractError)
    }

    expect(() => parseGrantSecureSecretLeasesRequest({
      baseRevision: 4,
      grants: [{
        secretId: 'secret-api',
        exposures: [{ deliveryKind: 'stdin' }],
        leaseKind: 'task',
        sourceLocator: 'forbidden',
      }],
    })).toThrow(SecureSessionsContractError)
  })

  it('rejects unknown fields at every secret-bearing input boundary', () => {
    const safeExposure = { deliveryKind: 'stdin' }
    const rawMaterialFields = [
      'value',
      'ciphertext',
      'sourceLocator',
      'keychainRef',
    ] as const

    for (const field of rawMaterialFields) {
      expect(() => parseSecureSecretBinding({
        ...safeExposure,
        [field]: true,
      })).toThrow(SecureSessionsContractError)

      expect(() => parseGrantSecureSecretLeaseRequest({
        baseRevision: 0,
        secretId: 'secret-api',
        exposures: [safeExposure],
        leaseKind: 'one_use',
        [field]: true,
      })).toThrow(SecureSessionsContractError)
    }

    expect(() => parseSecureSecretLeaseSpec({
      leaseKind: 'task',
      durationSeconds: 60,
    })).toThrow(SecureSessionsContractError)
  })

  it('exports revisioned state and revision-only invalidation as ServerEvents', () => {
    const lease = {
      leaseId: 'lease-1',
      secretId: 'secret-api',
      displayAlias: 'github/work',
      leaseKind: 'timed',
      exposures: [{ deliveryKind: 'environment', targetName: 'GITHUB_TOKEN' }],
      status: 'active',
      expiresAt: '2026-07-23T12:05:00.000Z',
      lastUsedAt: null,
      remainingUses: null,
    } satisfies SecureSessionLeaseSummary

    const accessRequest = {
      requestId: 'access-1',
      secretId: 'secret-ssh',
      displayAlias: 'deploy/ssh',
      requestedLeaseKind: 'task',
      requestedExposures: [{ deliveryKind: 'ssh_agent' }],
      purposeSummary: 'Fetch the deployment repository',
      requestedByAgentId: 'agent-worker',
      requestedByDisplayName: 'Deployment worker',
      createdAt: now,
      expiresAt: null,
    } satisfies SecureAccessRequestSummary

    const snapshot = {
      type: 'secure_session_snapshot',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      revision: 8,
      executionMode: 'secure',
      environmentStatus: 'ready',
      outputState: 'quarantined',
      outputStateCode: 'SECURE_OUTPUT_QUARANTINED',
      leases: [lease],
      pendingRequests: [accessRequest],
      updatedAt: now,
    } satisfies SecureSessionSnapshotEvent satisfies ServerEvent

    const invalidation = {
      type: 'secure_secret_catalog_changed',
      revision: 4,
    } satisfies SecureSecretCatalogChangedEvent satisfies ServerEvent

    expect(snapshot.leases[0]?.exposures[0]?.deliveryKind).toBe('environment')
    expect(snapshot.outputStateCode).toBe('SECURE_OUTPUT_QUARANTINED')
    expect(invalidation).toEqual({ type: 'secure_secret_catalog_changed', revision: 4 })
    expect(JSON.stringify(invalidation)).not.toContain('providers')
    expect(JSON.stringify(invalidation)).not.toContain('secrets')
  })

  it('has no public representation for secret material or source locators', () => {
    type ForbiddenMaterialField =
      | 'value'
      | 'secretValue'
      | 'ciphertext'
      | 'sourceLocator'
      | 'keychainRef'
    type ExposedMaterialField = Extract<
      | keyof SecureSecretProviderSummary
      | keyof SecureSecretSummary
      | keyof SecureSecretBinding
      | keyof SecureSessionLeaseSummary
      | keyof SecureAccessRequestSummary,
      ForbiddenMaterialField
    >

    expectTypeOf<ExposedMaterialField>().toEqualTypeOf<never>()
  })
})
