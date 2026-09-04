import type {
  AgentDescriptor,
  ManagerModelPreset,
  ManagerReasoningLevel,
  WorkModeId,
} from './shared-types.js'

export interface ManagerCreatedEvent {
  type: 'manager_created'
  manager: AgentDescriptor
  requestId?: string
}

export interface ManagerDeletedEvent {
  type: 'manager_deleted'
  managerId: string
  terminatedWorkerIds: string[]
  requestId?: string
}

export interface ProfileDefaultModelUpdatedEvent {
  type: 'profile_default_model_updated'
  profileId: string
  /** Omitted when the exact selection has no catalog preset family (for example, discovered OpenRouter models). */
  model?: ManagerModelPreset
  reasoningLevel?: ManagerReasoningLevel
  requestId?: string
}

export interface ManagerModelUpdatedEvent {
  type: 'manager_model_updated'
  managerId: string
  /** Omitted when the exact selection has no catalog preset family (for example, discovered OpenRouter models). */
  model?: ManagerModelPreset
  reasoningLevel?: ManagerReasoningLevel
  requestId?: string
}

export interface ManagerCwdUpdatedEvent {
  type: 'manager_cwd_updated'
  managerId: string
  cwd: string
  requestId?: string
}

export interface ProjectDelegationDefaultsUpdatedEvent {
  type: 'project_delegation_defaults_updated'
  profileId: string
  managerPosture?: WorkModeId
  delegationRosterId?: string
  requestId?: string
}

export interface StopAllAgentsResultEvent {
  type: 'stop_all_agents_result'
  managerId: string
  stoppedWorkerIds: string[]
  managerStopped: boolean
  terminatedWorkerIds?: string[]
  managerTerminated?: boolean
  requestId?: string
}
