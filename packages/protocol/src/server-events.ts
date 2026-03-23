import type { ConversationMessageAttachment } from './attachments.js'
import type {
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
} from './playwright.js'
import type {
  AcceptedDeliveryMode,
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  DeliveryMode,
  DirectoryItem,
  ManagerModelPreset,
  ManagerReasoningLevel,
  MessageSourceContext,
  ManagerProfile,
  PromptCategory,
  PromptSourceLayer,
  SessionMemoryMergeFailureStage,
  SessionMemoryMergeResult,
  SessionMemoryMergeStrategy,
} from './shared-types.js'

export interface ConversationMessageEvent {
  type: 'conversation_message'
  agentId: string
  id?: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: ConversationMessageAttachment[]
  timestamp: string
  source: 'user_input' | 'speak_to_user' | 'system'
  sourceContext?: MessageSourceContext
}

export type ConversationLogKind =
  | 'message_start'
  | 'message_end'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'

export interface ConversationLogEvent {
  type: 'conversation_log'
  agentId: string
  timestamp: string
  source: 'runtime_log'
  kind: ConversationLogKind
  role?: 'user' | 'assistant' | 'system'
  toolName?: string
  toolCallId?: string
  text: string
  isError?: boolean
}

export interface AgentMessageEvent {
  type: 'agent_message'
  agentId: string
  timestamp: string
  source: 'user_to_agent' | 'agent_to_agent'
  fromAgentId?: string
  toAgentId: string
  text: string
  sourceContext?: MessageSourceContext
  requestedDelivery?: DeliveryMode
  acceptedMode?: AcceptedDeliveryMode
  attachmentCount?: number
}

export type AgentToolCallKind = Extract<
  ConversationLogKind,
  'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'
>

export interface AgentToolCallEvent {
  type: 'agent_tool_call'
  agentId: string
  actorAgentId: string
  timestamp: string
  kind: AgentToolCallKind
  toolName?: string
  toolCallId?: string
  text: string
  isError?: boolean
}

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

export interface SessionCreatedEvent {
  type: 'session_created'
  profile: ManagerProfile
  sessionAgent: AgentDescriptor
  requestId?: string
}

export interface SessionStoppedEvent {
  type: 'session_stopped'
  agentId: string
  profileId: string
  terminatedWorkerIds: string[]
  requestId?: string
}

export interface SessionResumedEvent {
  type: 'session_resumed'
  agentId: string
  profileId: string
  requestId?: string
}

export interface SessionDeletedEvent {
  type: 'session_deleted'
  agentId: string
  profileId: string
  terminatedWorkerIds: string[]
  requestId?: string
}

export interface SessionClearedEvent {
  type: 'session_cleared'
  agentId: string
  requestId?: string
}

export interface SessionRenamedEvent {
  type: 'session_renamed'
  agentId: string
  label: string
  requestId?: string
}

export interface SessionForkedEvent {
  type: 'session_forked'
  sourceAgentId: string
  newSessionAgent: AgentDescriptor
  profile: ManagerProfile
  fromMessageId?: string
  requestId?: string
}

export interface SessionMemoryMergeStartedEvent {
  type: 'session_memory_merge_started'
  agentId: string
  requestId?: string
}

export interface SessionMemoryMergedEvent extends SessionMemoryMergeResult {
  type: 'session_memory_merged'
  requestId?: string
}

export interface SessionMemoryMergeFailedEvent {
  type: 'session_memory_merge_failed'
  agentId: string
  message: string
  status: 'failed'
  strategy?: SessionMemoryMergeStrategy
  stage?: SessionMemoryMergeFailureStage
  auditPath?: string
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

export interface DirectoriesListedEvent {
  type: 'directories_listed'
  path: string
  directories: string[]
  requestId?: string
  requestedPath?: string
  resolvedPath?: string
  roots?: string[]
  entries?: DirectoryItem[]
}

export interface DirectoryValidatedEvent {
  type: 'directory_validated'
  path: string
  valid: boolean
  message?: string
  requestId?: string
  requestedPath?: string
  roots?: string[]
  resolvedPath?: string
}

export interface DirectoryPickedEvent {
  type: 'directory_picked'
  path: string | null
  requestId?: string
}

export type SlackConnectionState = 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface SlackStatusEvent {
  type: 'slack_status'
  managerId?: string
  integrationProfileId?: string
  state: SlackConnectionState
  enabled: boolean
  updatedAt: string
  message?: string
  teamId?: string
  botUserId?: string
}

export type TelegramConnectionState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

export interface TelegramStatusEvent {
  type: 'telegram_status'
  managerId?: string
  integrationProfileId?: string
  state: TelegramConnectionState
  enabled: boolean
  updatedAt: string
  message?: string
  botId?: string
  botUsername?: string
}

export type ConversationEntry =
  | ConversationMessageEvent
  | ConversationLogEvent
  | AgentMessageEvent
  | AgentToolCallEvent

export type ConversationEntryEvent = ConversationEntry

export interface AgentStatusEvent {
  type: 'agent_status'
  agentId: string
  managerId?: string
  status: AgentStatus
  pendingCount: number
  contextUsage?: AgentContextUsage
  contextRecoveryInProgress?: boolean
  streamingStartedAt?: number
}

export interface AgentsSnapshotEvent {
  type: 'agents_snapshot'
  agents: AgentDescriptor[]
}

export interface SessionWorkersSnapshotEvent {
  type: 'session_workers_snapshot'
  sessionAgentId: string
  workers: AgentDescriptor[]
  requestId?: string
}

export interface ProfilesSnapshotEvent {
  type: 'profiles_snapshot'
  profiles: ManagerProfile[]
}

export interface UnreadNotificationEvent {
  type: 'unread_notification'
  agentId: string
}

export interface PlaywrightDiscoverySnapshotEvent {
  type: 'playwright_discovery_snapshot'
  snapshot: PlaywrightDiscoverySnapshot
}

export interface PlaywrightDiscoveryUpdatedEvent {
  type: 'playwright_discovery_updated'
  snapshot: PlaywrightDiscoverySnapshot
}

export interface PlaywrightDiscoverySettingsUpdatedEvent {
  type: 'playwright_discovery_settings_updated'
  settings: PlaywrightDiscoverySettings
}

export interface PromptChangedEvent {
  type: 'prompt_changed'
  category: PromptCategory
  promptId: string
  layer: PromptSourceLayer
  action: 'saved' | 'deleted'
}

export interface CortexPromptSurfaceChangedEvent {
  type: 'cortex_prompt_surface_changed'
  profileId: string
  surfaceId: string
  filePath: string
  updatedAt: string
}

export interface ApiProxyResponseEvent {
  type: 'api_proxy_response'
  requestId: string
  status: number
  body: string
  headers?: Record<string, string>
}

export type ServerEvent =
  | { type: 'ready'; serverTime: string; subscribedAgentId: string }
  | { type: 'conversation_reset'; agentId: string; timestamp: string; reason: 'user_new_command' | 'api_reset' }
  | {
      type: 'conversation_history'
      agentId: string
      messages: ConversationEntry[]
    }
  | ConversationEntry
  | AgentStatusEvent
  | AgentsSnapshotEvent
  | SessionWorkersSnapshotEvent
  | ProfilesSnapshotEvent
  | UnreadNotificationEvent
  | ManagerCreatedEvent
  | ManagerDeletedEvent
  | ManagerModelUpdatedEvent
  | SessionCreatedEvent
  | SessionStoppedEvent
  | SessionResumedEvent
  | SessionDeletedEvent
  | SessionClearedEvent
  | SessionRenamedEvent
  | SessionForkedEvent
  | SessionMemoryMergeStartedEvent
  | SessionMemoryMergedEvent
  | SessionMemoryMergeFailedEvent
  | StopAllAgentsResultEvent
  | DirectoriesListedEvent
  | DirectoryValidatedEvent
  | DirectoryPickedEvent
  | SlackStatusEvent
  | TelegramStatusEvent
  | PlaywrightDiscoverySnapshotEvent
  | PlaywrightDiscoveryUpdatedEvent
  | PlaywrightDiscoverySettingsUpdatedEvent
  | PromptChangedEvent
  | CortexPromptSurfaceChangedEvent
  | ApiProxyResponseEvent
  | { type: 'error'; code: string; message: string; requestId?: string }
