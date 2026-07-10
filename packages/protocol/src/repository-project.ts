import type { AgentDescriptor, ManagerExactModelSelection, ManagerReasoningLevel } from './shared-types.js'

export interface CreateRepositoryProjectCommandFields {
  name: string
  repositoryUrl: string
  repositoryBasePath: string
  repositoryFolder: string
  modelSelection: ManagerExactModelSelection
  reasoningLevel?: ManagerReasoningLevel
  /** Required on the wire for create_repository_project. */
  requestId: string
}

export interface CancelRepositoryProjectCreationCommandFields {
  operationRequestId: string
  requestId?: string
}

export type RepositoryProjectCreationStage =
  | 'validating'
  | 'cloning'
  | 'publishing'
  | 'creating_manager'

export interface RepositoryProjectCreationProgressEvent {
  type: 'repository_project_creation_progress'
  requestId: string
  stage: RepositoryProjectCreationStage
  percent?: number
}

export interface RepositoryProjectCreatedEvent {
  type: 'repository_project_created'
  requestId: string
  manager: AgentDescriptor
  repositoryPath: string
}

export interface RepositoryProjectCreationCancelledEvent {
  type: 'repository_project_creation_cancelled'
  requestId: string
}

export interface RepositoryProjectCreationCancelResultEvent {
  type: 'repository_project_creation_cancel_result'
  requestId?: string
  operationRequestId: string
  accepted: boolean
  tooLate: boolean
}

export type RepositoryProjectCreationErrorCode =
  | 'invalid_repository_url'
  | 'invalid_repository_folder'
  | 'invalid_repository_base_path'
  | 'destination_exists'
  | 'git_unavailable'
  | 'repository_not_found'
  | 'repository_auth_failed'
  | 'repository_network_failed'
  | 'clone_timed_out'
  | 'clone_cancelled'
  | 'destination_permission_denied'
  | 'disk_full'
  | 'manager_creation_failed_after_clone'
  | 'clone_failed'
  | 'duplicate_operation'
