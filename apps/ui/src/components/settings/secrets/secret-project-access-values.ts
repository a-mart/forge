import type { ManagerProfile, SecureSecretScope } from '@forge/protocol'

export type SecretScopeKind = 'instance' | 'projects'

export function scopeFor(
  scopeKind: SecretScopeKind,
  selectedProfileIds: Set<string>,
): SecureSecretScope | null {
  if (scopeKind === 'instance') return { kind: 'instance' }
  const profileIds = [...selectedProfileIds].sort()
  if (profileIds.length === 0) return null
  return profileIds.length === 1
    ? { kind: 'profile', profileId: profileIds[0]! }
    : { kind: 'profiles', profileIds }
}

export function scopeKindFor(scope: SecureSecretScope): SecretScopeKind {
  return scope.kind === 'instance' ? 'instance' : 'projects'
}

export function scopeProfileIds(scope: SecureSecretScope): string[] {
  if (scope.kind === 'instance') return []
  return scope.kind === 'profile' ? [scope.profileId] : scope.profileIds
}

export function scopeLabel(
  scope: SecureSecretScope,
  profileById: Map<string, ManagerProfile>,
): string {
  return scope.kind === 'instance'
    ? 'All projects'
    : scopeProfileIds(scope).length === 1
      ? `1 project · ${projectName(scopeProfileIds(scope)[0]!, profileById)}`
      : `${scopeProfileIds(scope).length} projects`
}

export function projectName(
  profileId: string,
  profileById: Map<string, ManagerProfile>,
): string {
  return profileById.get(profileId)?.displayName || profileId
}
