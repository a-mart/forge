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

export interface ProfileArchivedEvent {
  type: 'profile_archived'
  profileId: string
  archivedAt: string
  requestId?: string
}

export interface ProfileRestoredEvent {
  type: 'profile_restored'
  profileId: string
  requestId?: string
  openAgentId: string
}
