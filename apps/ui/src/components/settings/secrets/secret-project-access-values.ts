import type { ManagerProfile, SecureSecretScope } from '@forge/protocol'

export type SecretScopeKind = SecureSecretScope['kind']

export function scopeFor(
  scopeKind: SecretScopeKind,
  profileId: string,
): SecureSecretScope | null {
  if (scopeKind === 'instance') return { kind: 'instance' }
  return profileId ? { kind: 'profile', profileId } : null
}

export function scopeLabel(
  scope: SecureSecretScope,
  profileById: Map<string, ManagerProfile>,
): string {
  return scope.kind === 'instance'
    ? 'All projects'
    : `Only this project · ${projectName(scope.profileId, profileById)}`
}

export function projectName(
  profileId: string,
  profileById: Map<string, ManagerProfile>,
): string {
  return profileById.get(profileId)?.displayName || profileId
}
