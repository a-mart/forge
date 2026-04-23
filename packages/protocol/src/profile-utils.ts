import type { ManagerProfile } from './agents.js'

export function isSystemProfile(profile: ManagerProfile): boolean {
  return profile.profileType === 'system'
}
