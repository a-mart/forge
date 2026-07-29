import { describe, expect, it } from 'vitest'
import type { SecureSessionSnapshot } from '@forge/protocol'
import type { SecureGrantInput } from '@/components/chat/secure-session/types'
import { SecureSessionUiError } from '@/lib/secure-sessions-api'
import {
  reconcileSecureBatchGrantFailure,
  secureBatchGrantMatchesSnapshot,
  secureGrantMatchesSnapshot,
  shouldRefreshSecureRequestAfterError,
  shouldReconcileSecureBatchGrantError,
} from './secure-batch-grant-reconciliation'

function snapshot(
  leases: SecureSessionSnapshot['leases'],
): SecureSessionSnapshot {
  return {
    sessionAgentId: 'manager-1',
    profileId: 'profile-1',
    principalKind: 'manager',
    ownerManagerAgentId: null,
    workerAssignmentId: null,
    revision: 8,
    executionMode: 'secure',
    environmentStatus: 'ready',
    leases,
    pendingRequests: [],
    updatedAt: '2026-07-24T12:00:00.000Z',
  }
}

const reviewedGrants: SecureGrantInput[] = [
  {
    secretId: 'secret-env',
    bindings: [{ kind: 'env', variable: 'FORGE_SECRET_ENV' }],
    policy: { kind: 'task' },
  },
  {
    secretId: 'secret-file',
    bindings: [{ kind: 'file', targetPath: '/run/forge-secure/bindings/key' }],
    policy: { kind: 'timed', durationSeconds: 900 },
  },
]

const matchingSnapshot = snapshot([
  {
    leaseId: 'lease-env',
    secretId: 'secret-env',
    displayAlias: 'environment secret',
    leaseKind: 'task',
    exposures: [{ deliveryKind: 'environment', targetName: 'FORGE_SECRET_ENV' }],
    status: 'active',
    expiresAt: null,
    lastUsedAt: null,
    remainingUses: null,
  },
  {
    leaseId: 'lease-file',
    secretId: 'secret-file',
    displayAlias: 'file secret',
    leaseKind: 'timed',
    exposures: [{
      deliveryKind: 'file',
      targetPath: '/run/forge-secure/bindings/key',
      fileMode: 0o400,
    }],
    status: 'active',
    expiresAt: '2026-07-24T12:15:00.000Z',
    lastUsedAt: null,
    remainingUses: null,
  },
])

describe('BuilderSurface secure batch-grant reconciliation', () => {
  it('accepts only a one-to-one exact active lease match for every reviewed grant', () => {
    expect(secureBatchGrantMatchesSnapshot(reviewedGrants, matchingSnapshot)).toBe(true)

    expect(secureBatchGrantMatchesSnapshot([
      reviewedGrants[0]!,
      reviewedGrants[0]!,
    ], matchingSnapshot)).toBe(false)

    expect(secureBatchGrantMatchesSnapshot([
      {
        ...reviewedGrants[0]!,
        bindings: [{ kind: 'env', variable: 'A_DIFFERENT_TARGET' }],
      },
    ], matchingSnapshot)).toBe(false)

    expect(secureBatchGrantMatchesSnapshot([
      {
        ...reviewedGrants[1]!,
        policy: { kind: 'timed', durationSeconds: 3_600 },
      },
    ], matchingSnapshot)).toBe(false)

    expect(secureBatchGrantMatchesSnapshot(
      [reviewedGrants[0]!],
      {
        ...matchingSnapshot,
        leases: matchingSnapshot.leases.map((lease) => (
          lease.secretId === 'secret-env'
            ? { ...lease, status: 'revoked' as const }
            : lease
        )),
      },
    )).toBe(false)

    expect(secureGrantMatchesSnapshot(reviewedGrants[0]!, matchingSnapshot)).toBe(true)
    expect(secureGrantMatchesSnapshot(
      { ...reviewedGrants[0]!, secretId: 'not-active' },
      matchingSnapshot,
    )).toBe(false)
  })

  it('reconciles stale and ambiguous results but not definite validation failures', () => {
    expect(shouldReconcileSecureBatchGrantError(
      new SecureSessionUiError('SECURE_STALE_REVISION'),
    )).toBe(true)
    expect(shouldReconcileSecureBatchGrantError(
      new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE'),
    )).toBe(true)
    expect(shouldReconcileSecureBatchGrantError(
      new SecureSessionUiError('SECURE_OPERATION_FAILED'),
    )).toBe(true)
    expect(shouldReconcileSecureBatchGrantError(new TypeError('connection reset'))).toBe(true)
    expect(shouldReconcileSecureBatchGrantError(
      new SecureSessionUiError('SECURE_REQUEST_INVALID'),
    )).toBe(false)
    expect(shouldRefreshSecureRequestAfterError(
      new SecureSessionUiError('SECURE_REQUEST_INVALID'),
    )).toBe(true)
    expect(shouldRefreshSecureRequestAfterError(
      new SecureSessionUiError('SECURE_SECRET_ALIAS_CONFLICT'),
    )).toBe(false)
  })

  it('confirms an ambiguous success only after fetching an exact matching snapshot', async () => {
    const confirmed = await reconcileSecureBatchGrantFailure(
      new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE'),
      reviewedGrants,
      async () => matchingSnapshot,
    )
    expect(confirmed).toEqual({
      snapshot: matchingSnapshot,
      confirmed: true,
    })

    const mismatched = await reconcileSecureBatchGrantFailure(
      new SecureSessionUiError('SECURE_STALE_REVISION'),
      reviewedGrants,
      async () => snapshot([]),
    )
    expect(mismatched).toEqual({
      snapshot: snapshot([]),
      confirmed: false,
    })

    let fetchCount = 0
    const validationFailure = await reconcileSecureBatchGrantFailure(
      new SecureSessionUiError('SECURE_REQUEST_INVALID'),
      reviewedGrants,
      async () => {
        fetchCount += 1
        return matchingSnapshot
      },
    )
    expect(validationFailure).toBeNull()
    expect(fetchCount).toBe(0)

    const unavailable = await reconcileSecureBatchGrantFailure(
      new TypeError('connection reset'),
      reviewedGrants,
      async () => {
        throw new Error('still offline')
      },
    )
    expect(unavailable).toBeNull()
  })
})
