import type {
  AgentDescriptor,
  ManagerModelPreset,
  ManagerReasoningLevel,
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

export interface ManagerModelUpdatedEvent {
  type: 'manager_model_updated'
  managerId: string
  model: ManagerModelPreset
  reasoningLevel?: ManagerReasoningLevel
  requestId?: string
}

export interface ManagerCwdUpdatedEvent {
  type: 'manager_cwd_updated'
  managerId: string
  cwd: string
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
