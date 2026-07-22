import type { WsRequestTracker } from '../ws-request-tracker'
import type {
  AgentDescriptor,
  BrowserSessionSnapshot,
  PersistedProjectAgentConfig,
  ProjectAgentConfigSourceSnapshot,
  ProjectAgentExternalDirectoryEntry,
  ProjectAgentInfo,
  ProjectAgentShareEligibleTarget,
  ProjectAgentShareGrantInfo,
  SessionMemoryMergeResult,
  ConversationEntry,
  ConversationHistoryPageMetadata,
} from '@forge/protocol'
import type { ManagerWsState } from '../ws-state'

export interface DirectoriesListedResult {
  path: string
  directories: string[]
  requestedPath?: string
  resolvedPath?: string
  parentPath?: string | null
  roots?: string[]
  entries?: Array<{ name: string; path: string }>
}

export interface DirectoryValidationResult {
  path: string
  valid: boolean
  message: string | null
  resolvedPath?: string
  roots?: string[]
}

export interface DirectoryCreatedResult {
  path: string
  parentPath: string
  name: string
  roots?: string[]
}

export type Listener = (state: ManagerWsState) => void

export type SessionCreatedResult = { sessionAgent: AgentDescriptor; profileId: string }
export type SessionActionResult = { agentId: string }
export type SessionArchiveResult = { agentId: string; profileId: string; archivedAt: string }
export type SessionRestoreResult = { agentId: string; profileId: string; openAgentId?: string }
export type ProfileArchiveResult = { profileId: string; archivedAt: string }
export type ProfileRestoreResult = { profileId: string; openAgentId: string }
export type ArchiveLastUsedHydrationResult = { scannedSessionCount: number; hydratedSessionCount: number }
export type SessionForkedResult = { sourceAgentId: string; newSessionAgent: AgentDescriptor }
export type SessionWorkersResult = { sessionAgentId: string; workers: AgentDescriptor[] }
export type ConversationPageResult = {
  agentId: string
  messages: ConversationEntry[]
  page: ConversationHistoryPageMetadata
}

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
  source?: ProjectAgentConfigSourceSnapshot
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

export type ProjectAgentSharingResult = {
  agentId: string
  grants: ProjectAgentShareGrantInfo[]
  eligibleTargets: ProjectAgentShareEligibleTarget[]
}

export type ProjectAgentSharingUpdatedResult = ProjectAgentSharingResult & {
  addedTargetProfileIds: string[]
  removedTargetProfileIds: string[]
}

export type ProjectAgentExternalDirectoryResult = {
  profileId: string
  entries: ProjectAgentExternalDirectoryEntry[]
}

export type WsRequestResultMap = {
  create_manager: AgentDescriptor
  create_repository_project: { manager: AgentDescriptor; repositoryPath: string }
  cancel_repository_project_creation: {
    operationRequestId: string
    accepted: boolean
    tooLate: boolean
  }
  delete_manager: { managerId: string }
  update_profile_default_model: { profileId: string }
  update_manager_model: { managerId: string }
  update_manager_cwd: { managerId: string; cwd: string }
  stop_all_agents: { managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }
  create_session: SessionCreatedResult
  stop_session: SessionActionResult
  resume_session: SessionActionResult
  archive_session: SessionArchiveResult
  restore_session: SessionRestoreResult
  delete_session: SessionActionResult
  clear_session: SessionActionResult
  rename_session: SessionActionResult
  pin_session: { pinnedAt: string | null }
  update_session_model: { sessionAgentId: string; mode: 'inherit' | 'override' }
  rename_profile: { profileId: string }
  archive_profile: ProfileArchiveResult
  restore_profile: ProfileRestoreResult
  hydrate_archive_last_used: ArchiveLastUsedHydrationResult
  fork_session: SessionForkedResult
  merge_session_memory: SessionMemoryMergeResult
  set_session_project_agent: SessionProjectAgentResult
  get_project_agent_config: ProjectAgentConfigResult
  list_project_agent_references: ProjectAgentReferencesResult
  get_project_agent_reference: ProjectAgentReferenceResult
  set_project_agent_reference: ProjectAgentReferenceSavedResult
  delete_project_agent_reference: ProjectAgentReferenceDeletedResult
  request_project_agent_recommendations: ProjectAgentRecommendationsResult
  get_project_agent_sharing: ProjectAgentSharingResult
  set_project_agent_sharing: ProjectAgentSharingUpdatedResult
  get_project_agent_external_directory: ProjectAgentExternalDirectoryResult
  get_session_workers: SessionWorkersResult
  get_conversation_page: ConversationPageResult
  list_directories: DirectoriesListedResult
  validate_directory: DirectoryValidationResult
  create_directory: DirectoryCreatedResult
  pick_directory: string | null
  browser_tab_open: BrowserSessionSnapshot
  browser_tab_activate: BrowserSessionSnapshot
  browser_tab_close: BrowserSessionSnapshot
  browser_tab_resize: BrowserSessionSnapshot
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
  onRepositoryProjectCreationProgress?: (
    event: Extract<import('@forge/protocol').ServerEvent, { type: 'repository_project_creation_progress' }>,
  ) => void
}

export interface ManagerWsSessionEventContext {
  applySessionDeleted: (agentId: string, profileId: string) => void
  requestTracker: RequestTrackerAdapter
}

export interface ManagerWsProjectAgentEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
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
  /** Utility browser command errors reject their caller but are not chat events. */
  isPendingDirectoryRequest: (requestId?: string) => boolean
  rejectPendingFromError: (code: string, message: string, requestId?: string) => void
}
