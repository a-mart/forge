import type { ManagerProfile } from './shared-types.js'

export interface ProfilesSnapshotEvent {
  type: 'profiles_snapshot'
  profiles: ManagerProfile[]
}

export interface ProfileRenamedEvent {
  type: 'profile_renamed'
  profileId: string
  displayName: string
  requestId?: string
}
