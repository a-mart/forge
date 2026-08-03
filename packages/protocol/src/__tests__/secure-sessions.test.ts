import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  SECURE_SECRET_DELIVERY_KINDS,
  SECURE_SECRET_LEASE_GRANT_SOURCES,
  SECURE_SECRET_LEASE_KINDS,
  SECURE_SECRET_MAX_TIMED_LEASE_SECONDS,
  SECURE_SECRET_PROVIDER_KINDS,
  SECURE_SESSION_PRINCIPAL_KINDS,
  SecureSessionsContractError,
  isSecureSecretBinding,
  isSecureSecretLeaseSpec,
  parseApplySecureSessionProjectDefaultsRequest,
  parseCreateSecureSshTrustedHostRequest,
  parseGrantSecureSecretLeaseRequest,
  parseGrantSecureSecretLeasesRequest,
  parseRequestSecureSecretAccessRequest,
  parseRequestSecureSshHostTrustRequest,
  parseResolveSecureSecretAccessRequest,
  parseResolveSecureSshHostTrustRequest,
  parseRevokeSecureSecretLeaseRequest,
  parseSecureSecretBinding,
  parseSecureSecretAutomaticGrantPolicy,
  parseSecureSecretLeaseSpec,
  parseSecureSecretScope,
  parseUpdateSecureSshTrustedHostRequest,
  type ApplySecureSessionProjectDefaultsRequest,
  type SecureAccessRequestSummary,
  type SecureSecretBinding,
  type SecureSecretCatalog,
  type SecureSecretCatalogChangedEvent,
  type SecureSecretProviderSummary,
  type SecureSecretProjectDefaultSummary,
  type SecureSecretSummary,
  type SecureSshTrustedHostSummary,
  type SecureSshTrustRequestSummary,
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
    expect(SECURE_SECRET_LEASE_GRANT_SOURCES).toEqual([
      'manual',
      'access_request',
      'project_default',
    ])
    expect(SECURE_SESSION_PRINCIPAL_KINDS).toEqual(['manager', 'worker'])

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
      note: 'Used for release automation.',
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
      projectDefaults: [{
        profileId: 'profile-1',
        secretId: secret.secretId,
        createdAt: now,
        updatedAt: now,
      } satisfies SecureSecretProjectDefaultSummary],
      updatedAt: now,
    } satisfies SecureSecretCatalog

    expect(catalog.secrets[0]?.displayAlias).toBe('github/work')
    expect(catalog.secrets[0]?.note).toBe('Used for release automation.')
    expect(catalog.projectDefaults).toEqual([expect.objectContaining({
      profileId: 'profile-1',
      secretId: 'secret-api',
    })])
    expect(parseSecureSecretScope(secret.scope)).toEqual(secret.scope)
    expect(parseSecureSecretScope({
      kind: 'profiles',
      profileIds: ['profile-1', 'profile-2'],
    })).toEqual({
      kind: 'profiles',
      profileIds: ['profile-1', 'profile-2'],
    })
    expect(() => parseSecureSecretScope({
      kind: 'profiles',
      profileIds: [],
    })).toThrow(SecureSessionsContractError)
    expect(() => parseSecureSecretScope({
      kind: 'profiles',
      profileIds: ['profile-1', 'profile-1'],
    })).toThrow(SecureSessionsContractError)
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
      selectedSecretId: 'secret-api',
      decision: 'approve',
    })).toEqual({
      baseRevision: 5,
      requestId: 'access-1',
      selectedSecretId: 'secret-api',
      decision: 'approve',
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
    expect(() => parseResolveSecureSecretAccessRequest({
      baseRevision: 5,
      requestId: 'access-1',
      selectedSecretId: 'secret-api',
      decision: 'deny',
    })).toThrow(SecureSessionsContractError)
  })

  it('parses strict SSH trusted-host catalog and agent proposal contracts', () => {
    const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey'

    expect(parseCreateSecureSshTrustedHostRequest({
      profileId: 'profile-1',
      alias: 'ansible-p-azure',
      hostName: '10.140.2.17',
      port: 22,
      username: 'ansibleuser',
      hostKey,
    })).toEqual({
      profileId: 'profile-1',
      alias: 'ansible-p-azure',
      hostName: '10.140.2.17',
      port: 22,
      username: 'ansibleuser',
      hostKey,
    })
    expect(parseUpdateSecureSshTrustedHostRequest({
      port: 2222,
      username: 'deploy',
    })).toEqual({
      port: 2222,
      username: 'deploy',
    })
    expect(parseRequestSecureSshHostTrustRequest({
      alias: 'ansible-p-azure',
      hostName: '10.140.2.17',
      port: 22,
      username: 'ansibleuser',
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey',
      purposeSummary: 'Connect to the project deployment host',
    })).toEqual({
      alias: 'ansible-p-azure',
      hostName: '10.140.2.17',
      port: 22,
      username: 'ansibleuser',
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey',
      purposeSummary: 'Connect to the project deployment host',
    })
    expect(parseResolveSecureSshHostTrustRequest({
      baseRevision: 7,
      requestId: 'ssh-request-1',
      decision: 'approve',
    })).toEqual({
      baseRevision: 7,
      requestId: 'ssh-request-1',
      decision: 'approve',
    })

    for (const invalid of [
      {},
      { port: 0 },
      { port: 65_536 },
      { alias: 'next', unexpected: true },
    ]) {
      expect(() => parseUpdateSecureSshTrustedHostRequest(invalid))
        .toThrow(SecureSessionsContractError)
    }
    expect(() => parseCreateSecureSshTrustedHostRequest({
      profileId: 'profile-1',
      alias: 'ansible-p-azure',
      hostName: '10.140.2.17',
      port: 22,
      username: 'ansibleuser',
      hostKey,
      plaintextPassword: 'must-not-pass',
    })).toThrow(SecureSessionsContractError)
    expect(() => parseRequestSecureSshHostTrustRequest({
      alias: 'ansible-p-azure',
      hostName: '10.140.2.17',
      port: 22,
      username: 'ansibleuser',
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey',
      purposeSummary: 'Connect to the project deployment host',
      privateKey: 'must-not-pass',
    })).toThrow(SecureSessionsContractError)
    expect(() => parseResolveSecureSshHostTrustRequest({
      baseRevision: 7,
      requestId: 'ssh-request-1',
      decision: 'approve',
      hostKeyBase64: 'must-not-pass',
    })).toThrow(SecureSessionsContractError)
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

  it('parses only a revision when applying configured project defaults', () => {
    const request = parseApplySecureSessionProjectDefaultsRequest({
      baseRevision: 7,
    })
    expect(request).toEqual({ baseRevision: 7 })
    expectTypeOf(request).toEqualTypeOf<ApplySecureSessionProjectDefaultsRequest>()

    for (const invalid of [
      {},
      { baseRevision: -1 },
      { baseRevision: 7, secretId: 'forbidden-selection' },
      { baseRevision: 7, grants: [] },
    ]) {
      expect(() =>
        parseApplySecureSessionProjectDefaultsRequest(invalid)
      ).toThrow(SecureSessionsContractError)
    }
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
      grantSource: 'project_default',
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
      workerAssignmentId: null,
      createdAt: now,
      expiresAt: null,
    } satisfies SecureAccessRequestSummary

    const snapshot = {
      type: 'secure_session_snapshot',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      principalKind: 'manager',
      ownerManagerAgentId: null,
      workerAssignmentId: null,
      revision: 8,
      executionMode: 'secure',
      environmentStatus: 'ready',
      outputState: 'quarantined',
      outputStateCode: 'SECURE_OUTPUT_QUARANTINED',
      leases: [lease],
      pendingRequests: [accessRequest],
      projectDefaults: [{
        secretId: 'secret-api',
        displayAlias: 'github/work',
        state: 'active',
        statusCode: 'ok',
      }],
      lastExecutionIncident: {
        code: 'EXECUTION_TIMEOUT',
        agentId: 'agent-worker',
        occurredAt: now,
      },
      updatedAt: now,
    } satisfies SecureSessionSnapshotEvent satisfies ServerEvent

    const invalidation = {
      type: 'secure_secret_catalog_changed',
      revision: 4,
    } satisfies SecureSecretCatalogChangedEvent satisfies ServerEvent

    expect(snapshot.leases[0]?.exposures[0]?.deliveryKind).toBe('environment')
    expect(snapshot.leases[0]?.grantSource).toBe('project_default')
    expect(snapshot.projectDefaults).toEqual([expect.objectContaining({
      state: 'active',
      statusCode: 'ok',
    })])
    expect(snapshot.outputStateCode).toBe('SECURE_OUTPUT_QUARANTINED')
    expect(snapshot.lastExecutionIncident).toEqual({
      code: 'EXECUTION_TIMEOUT',
      agentId: 'agent-worker',
      occurredAt: now,
    })
    expect(invalidation).toEqual({ type: 'secure_secret_catalog_changed', revision: 4 })
    expect(JSON.stringify(invalidation)).not.toContain('providers')
    expect(JSON.stringify(invalidation)).not.toContain('secrets')
  })

  it('parses automatic-grant policies independently of the 16-secret limit', () => {
    const profileIds = Array.from({ length: 17 }, (_, index) => `profile-${index}`)
    expect(parseSecureSecretAutomaticGrantPolicy({
      kind: 'projects',
      profileIds,
    })).toEqual({ kind: 'projects', profileIds })
    expect(parseSecureSecretAutomaticGrantPolicy({
      kind: 'projects',
      profileIds: [],
    })).toEqual({ kind: 'none' })
    expect(parseSecureSecretAutomaticGrantPolicy({
      kind: 'all_projects',
    })).toEqual({ kind: 'all_projects' })
    expect(() => parseSecureSecretAutomaticGrantPolicy({
      kind: 'projects',
      profileIds: ['profile-1', 'profile-1'],
    })).toThrow(SecureSessionsContractError)
  })

  it('has no public representation for secret material or source locators', () => {
    type ForbiddenMaterialField =
      | 'value'
      | 'secretValue'
      | 'ciphertext'
      | 'sourceLocator'
      | 'keychainRef'
      | 'hostKeyBase64'
    type ExposedMaterialField = Extract<
      | keyof SecureSecretProviderSummary
      | keyof SecureSecretSummary
      | keyof SecureSecretBinding
      | keyof SecureSessionLeaseSummary
      | keyof SecureAccessRequestSummary
      | keyof SecureSshTrustedHostSummary
      | keyof SecureSshTrustRequestSummary,
      ForbiddenMaterialField
    >

    expectTypeOf<ExposedMaterialField>().toEqualTypeOf<never>()
  })
})
