import type { WsRequestTracker } from '../ws-request-tracker'
import type { AgentDescriptor, PersistedProjectAgentConfig, ProjectAgentInfo, SessionMemoryMergeResult } from '@forge/protocol'
import type { ManagerWsState } from '../ws-state'

export interface DirectoriesListedResult {
  path: string
  directories: string[]
}

export interface DirectoryValidationResult {
  path: string
  valid: boolean
  message: string | null
  resolvedPath?: string
}

export type Listener = (state: ManagerWsState) => void

export type SessionCreatedResult = { sessionAgent: AgentDescriptor; profileId: string }
export type SessionActionResult = { agentId: string }
export type SessionForkedResult = { sourceAgentId: string; newSessionAgent: AgentDescriptor }
export type SessionWorkersResult = { sessionAgentId: string; workers: AgentDescriptor[] }

export type SessionProjectAgentResult = {
  agentId: string
  profileId: string
  projectAgent: ProjectAgentInfo | null
}

export type ProjectAgentConfigResult = {
  agentId: string
  config: PersistedProjectAgentConfig
  systemPrompt: string | null
  references: string[]
}

export type ProjectAgentReferencesResult = { agentId: string; references: string[] }
export type ProjectAgentReferenceResult = { agentId: string; fileName: string; content: string }
export type ProjectAgentReferenceSavedResult = { agentId: string; fileName: string }
export type ProjectAgentReferenceDeletedResult = { agentId: string; fileName: string }

export type ProjectAgentRecommendationsResult = {
  agentId: string
  whenToUse: string
  systemPrompt: string
}

export type WsRequestResultMap = {
  create_manager: AgentDescriptor
  delete_manager: { managerId: string }
  update_profile_default_model: { profileId: string }
  update_manager_model: { managerId: string }
  update_manager_cwd: { managerId: string; cwd: string }
  stop_all_agents: { managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }
  create_session: SessionCreatedResult
  stop_session: SessionActionResult
  resume_session: SessionActionResult
  delete_session: SessionActionResult
  clear_session: SessionActionResult
  rename_session: SessionActionResult
  pin_session: { pinnedAt: string | null }
  update_session_model: { sessionAgentId: string; mode: 'inherit' | 'override' }
  rename_profile: { profileId: string }
  fork_session: SessionForkedResult
  merge_session_memory: SessionMemoryMergeResult
  set_session_project_agent: SessionProjectAgentResult
  get_project_agent_config: ProjectAgentConfigResult
  list_project_agent_references: ProjectAgentReferencesResult
  get_project_agent_reference: ProjectAgentReferenceResult
  set_project_agent_reference: ProjectAgentReferenceSavedResult
  delete_project_agent_reference: ProjectAgentReferenceDeletedResult
  request_project_agent_recommendations: ProjectAgentRecommendationsResult
  get_session_workers: SessionWorkersResult
  list_directories: DirectoriesListedResult
  validate_directory: DirectoryValidationResult
  pick_directory: string | null
}

export type WsRequestType = Extract<keyof WsRequestResultMap, string>

export interface WsRequestErrorHint {
  requestType: WsRequestType
  codeFragment: string
}

export type RequestTrackerAdapter = Pick<
  WsRequestTracker<WsRequestResultMap>,
  'resolve' | 'reject' | 'rejectByRequestId' | 'rejectOldest' | 'rejectOnlyPending'
>

export interface ManagerWsConversationEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
}

export interface ManagerWsTerminalEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
}

export interface ManagerWsAgentEventContext {
  applyAgentStatus: (event: Extract<import('@forge/protocol').ServerEvent, { type: 'agent_status' }>) => void
  applyAgentsSnapshot: (agents: AgentDescriptor[]) => void
  applySessionWorkersSnapshot: (
    sessionAgentId: string,
    workers: AgentDescriptor[],
    requestId?: string,
  ) => void
  applyManagerCreated: (manager: AgentDescriptor) => void
  applyManagerDeleted: (managerId: string) => void
  requestTracker: RequestTrackerAdapter
}

export interface ManagerWsSessionEventContext {
  applySessionDeleted: (agentId: string, profileId: string) => void
  requestTracker: RequestTrackerAdapter
}

export interface ManagerWsProjectAgentEventContext {
  requestTracker: RequestTrackerAdapter
}

export interface ManagerWsConfigEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
  requestTracker: RequestTrackerAdapter
}

export interface ManagerWsDirectoryEventContext {
  requestTracker: RequestTrackerAdapter
}

export interface ManagerWsSystemEventContext {
  updateState: (patch: Partial<ManagerWsState>) => void
  pushSystemMessage: (text: string) => void
  rejectPendingFromError: (code: string, message: string, requestId?: string) => void
}
