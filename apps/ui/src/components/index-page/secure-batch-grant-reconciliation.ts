import type { SecureSessionSnapshot } from '@forge/protocol'
import type { SecureGrantInput } from '@/components/chat/secure-session/types'
import {
  SecureSessionUiError,
  toSecureSessionSnapshotView,
} from '@/lib/secure-sessions-api'

export function shouldReconcileSecureBatchGrantError(error: unknown): boolean {
  if (!(error instanceof SecureSessionUiError)) return true
  return error.code === 'SECURE_STALE_REVISION'
    || error.code === 'SECURE_SOURCE_UNAVAILABLE'
    || error.code === 'SECURE_OPERATION_FAILED'
}

export function secureBatchGrantMatchesSnapshot(
  grants: readonly SecureGrantInput[],
  snapshot: SecureSessionSnapshot,
): boolean {
  const unmatchedLeases = toSecureSessionSnapshotView(snapshot).leases
    .filter((lease) => lease.status === 'active')

  for (const grant of grants) {
    const matchingIndex = unmatchedLeases.findIndex((lease) => (
      lease.secretId === grant.secretId
      && secureBindingsMatch(lease.bindings, grant.bindings)
      && securePoliciesMatch(lease.policy, grant.policy)
    ))
    if (matchingIndex < 0) return false
    unmatchedLeases.splice(matchingIndex, 1)
  }
  return true
}

export async function reconcileSecureBatchGrantFailure(
  error: unknown,
  grants: readonly SecureGrantInput[],
  fetchCurrentSnapshot: () => Promise<SecureSessionSnapshot>,
): Promise<{
  snapshot: SecureSessionSnapshot
  confirmed: boolean
} | null> {
  if (!shouldReconcileSecureBatchGrantError(error)) return null
  try {
    const snapshot = await fetchCurrentSnapshot()
    return {
      snapshot,
      confirmed: secureBatchGrantMatchesSnapshot(grants, snapshot),
    }
  } catch {
    return null
  }
}

function secureBindingsMatch(
  left: SecureGrantInput['bindings'],
  right: SecureGrantInput['bindings'],
): boolean {
  if (left.length !== right.length) return false
  const leftKeys = left.map(secureBindingReconciliationKey).sort()
  const rightKeys = right.map(secureBindingReconciliationKey).sort()
  return leftKeys.every((key, index) => key === rightKeys[index])
}

function secureBindingReconciliationKey(
  binding: SecureGrantInput['bindings'][number],
): string {
  switch (binding.kind) {
    case 'env':
      return `env:${binding.variable}`
    case 'stdin':
      return 'stdin'
    case 'file':
      return `file:${binding.targetPath}:${binding.fileMode ?? 0o400}`
    case 'askpass':
      return `askpass:${binding.variable ?? ''}`
    case 'ssh_agent':
      return 'ssh_agent'
  }
}

function securePoliciesMatch(
  left: SecureGrantInput['policy'],
  right: SecureGrantInput['policy'],
): boolean {
  if (left.kind !== right.kind) return false
  return left.kind !== 'timed'
    || (right.kind === 'timed' && left.durationSeconds === right.durationSeconds)
}
