import type { ManagerProfile } from './agents.js'

export function isSystemProfile(profile: Pick<ManagerProfile, 'profileType'>): boolean {
  return profile.profileType === 'system'
}
