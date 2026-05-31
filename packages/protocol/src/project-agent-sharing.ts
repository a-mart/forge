export interface ProjectAgentShareGrantInfo {
  grantId: string
  sourceProfileId: string
  sourceAgentId: string
  sourceHandle: string
  sourceProjectName: string
  targetProfileId: string
  targetProjectName: string
  targetNamespace: string
  externalHandle: string
  blockedReason?: 'source_archived' | 'target_archived'
  createdAt: string
  updatedAt: string
}

export interface ProjectAgentShareEligibleTarget {
  profileId: string
  displayName: string
  alreadyShared: boolean
  namespacePreview: string
}

export interface ProjectAgentExternalDirectoryEntry {
  agentId: string
  handle: string
  displayName: string
  whenToUse: string
  sourceProjectName: string
  origin: 'external'
}

export interface ProjectAgentSharingSnapshot {
  agentId: string
  grants: ProjectAgentShareGrantInfo[]
  eligibleTargets: ProjectAgentShareEligibleTarget[]
}

export interface ProjectAgentSharingUpdatedEvent {
  type: 'project_agent_sharing_updated'
  agentId: string
  grants: ProjectAgentShareGrantInfo[]
  eligibleTargets: ProjectAgentShareEligibleTarget[]
  addedTargetProfileIds: string[]
  removedTargetProfileIds: string[]
  requestId?: string
}

export interface ProjectAgentSharingEvent {
  type: 'project_agent_sharing'
  agentId: string
  grants: ProjectAgentShareGrantInfo[]
  eligibleTargets: ProjectAgentShareEligibleTarget[]
  requestId?: string
}

export interface ProjectAgentExternalDirectoryEvent {
  type: 'project_agent_external_directory'
  profileId: string
  entries: ProjectAgentExternalDirectoryEntry[]
  requestId?: string
}
