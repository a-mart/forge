import type { ConversationAttachment } from './attachments.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  ManagerProfile,
  ProjectAgentCapability,
} from './agents.js'
import type { ChoiceAnswer, ChoiceQuestion, ChoiceRequestStatus } from './choices.js'
import type { DeliveryMode } from './messaging.js'

export const CLI_PROTOCOL_VERSION = 1 as const

export const CLI_EXIT_CODES = {
  success: 0,
  blocked: 10,
  timeout: 11,
  agentFailure: 12,
  canceled: 13,
  usage: 20,
  auth: 21,
  connection: 22,
  unsupported: 23,
} as const

export type CliProtocolVersion = typeof CLI_PROTOCOL_VERSION
export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES]

export interface CliFeatureFlags {
  bearerAuth: boolean
  headlessWs: boolean
  cliSourceContext: boolean
  cliSessionMetadata: boolean
  choiceOwnerLookup: boolean
  activeToolSnapshot: boolean
  projectAgentRunTarget: boolean
  sessionTranscript: boolean
  builderRuntimeOnly: boolean
}

export interface CliCapabilities {
  protocolVersion: CliProtocolVersion
  minCliVersion: string
  available: boolean
  runtimeTarget?: string
  features: CliFeatureFlags
}

export interface CliCapabilitiesResponse {
  serverTime: string
  serverVersion: string
  capabilities: CliCapabilities
}

export type CliStatusState = 'ok' | 'degraded' | 'unavailable'

export interface CliStatusSummary {
  profileCount?: number
  sessionCount?: number
  agentCount?: number
}

export interface CliStatusResponse {
  status: CliStatusState
  serverTime: string
  serverVersion: string
  runtimeTarget?: string
  capabilities: CliCapabilities
  summary?: CliStatusSummary
}

export type CliAccessKeyLastUsedSource = 'http' | 'ws' | 'settings' | 'unknown'

export interface CliAccessKeyDescriptor {
  id: string
  name?: string
  createdAt: string
  lastUsedAt?: string
  lastUsedSource?: CliAccessKeyLastUsedSource
  revokedAt?: string
}

export interface CliAccessKeyListResponse {
  keys: CliAccessKeyDescriptor[]
}

export interface CliAccessKeyGenerateRequest {
  name?: string
}

export interface CliAccessKeyRotateRequest {
  keyId: string
  name?: string
}

export interface CliAccessKeyRevokeRequest {
  keyId: string
}

export interface CliAccessKeyCreatedResponse {
  key: CliAccessKeyDescriptor
  plaintextKey: string
}

export type CliSessionCommand = 'run' | 'launch' | 'sessions create'

export interface CliSessionMetadata {
  createdBy: 'forge-cli'
  runId: string
  command: CliSessionCommand
  startedAt: string
  invocationCwd?: string
  label?: string
}

export interface CliProfilesListResponse {
  profiles: ManagerProfile[]
}

export interface CliProfileShowResponse {
  profile: ManagerProfile
}

export interface CliAgentsListResponse {
  agents: AgentDescriptor[]
}

export interface CliAgentShowResponse {
  agent: AgentDescriptor
}

export interface CliSessionsListResponse {
  sessions: AgentDescriptor[]
}

export interface CliSessionShowResponse {
  session: AgentDescriptor
}

export type CliSessionTranscriptMessageKind = 'user' | 'assistant' | 'worker_update'

export interface CliSessionTranscriptAttachment {
  type?: 'image' | 'text' | 'binary'
  mimeType: string
  fileName?: string
  fileRef?: string
  sizeBytes?: number
}

export interface CliSessionTranscriptMessage {
  ordinal: number
  id?: string
  timestamp: string
  kind: CliSessionTranscriptMessageKind
  role: 'user' | 'assistant' | 'worker'
  source: 'user_input' | 'speak_to_user' | 'worker_update'
  text: string
  agentId: string
  fromAgentId?: string
  fromDisplayName?: string
  toAgentId?: string
  attachments?: CliSessionTranscriptAttachment[]
}

export interface CliSessionTranscriptResponse {
  session: {
    agentId: string
    profileId?: string
    displayName?: string
  }
  options: {
    includeWorkerUpdates: boolean
    limit: number
    offset: number
  }
  page: {
    total: number
    returned: number
    offset: number
    limit: number
    hasMore: boolean
    nextOffset?: number
  }
  messages: CliSessionTranscriptMessage[]
}

export interface CliProjectAgentDescriptor {
  profileId: string
  agentId: string
  handle: string
  whenToUse: string
  displayName?: string
  creatorSessionId?: string
  capabilities?: ProjectAgentCapability[]
  promotedAt?: string
  updatedAt?: string
}

export interface CliProjectAgentsListResponse {
  projectAgents: CliProjectAgentDescriptor[]
}

export interface CliProjectAgentShowResponse {
  projectAgent: CliProjectAgentDescriptor
}

export interface CliChoiceOwner {
  choiceId: string
  agentId: string
  sessionAgentId: string
  profileId?: string
  status: ChoiceRequestStatus
  questionSummary?: string
  questions?: ChoiceQuestion[]
  createdAt?: string
  updatedAt?: string
}

export interface CliChoicesListResponse {
  choices: CliChoiceOwner[]
}

export interface CliChoiceShowResponse {
  choice: CliChoiceOwner
}

export interface CliHttpErrorResponse {
  error: {
    code: string
    message: string
    status?: number
  }
}

export interface CliActiveToolSnapshotEntry {
  sessionAgentId: string
  actorAgentId: string
  agentId?: string
  toolCallId?: string
  toolName?: string
  text?: string
  startedAt?: string
  updatedAt?: string
  isError?: boolean
}

export interface SessionActiveToolsSnapshotEvent {
  type: 'session_active_tools_snapshot'
  sessionAgentId: string
  activeTools: CliActiveToolSnapshotEntry[]
  requestId?: string
}

export interface CliAgentStatusSnapshot {
  agentId: string
  status: AgentStatus
  pendingCount: number
  contextUsage?: AgentContextUsage
  contextRecoveryInProgress?: boolean
  streamingStartedAt?: number
}

export interface CliHeadlessSubscriptionTarget {
  agentId?: string
  profileId?: string
}

export interface CliHeadlessReadyEvent {
  type: 'headless_ready'
  requestId?: string
  serverTime: string
  capabilities: CliCapabilities
  subscribed: CliHeadlessSubscriptionTarget
  targetAgent?: AgentDescriptor
  profile?: ManagerProfile
  pendingChoices?: CliChoiceOwner[]
  workers?: AgentDescriptor[]
  activeTools?: CliActiveToolSnapshotEntry[]
  status?: CliAgentStatusSnapshot
}

export interface CliPendingChoicesSnapshotEvent {
  type: 'cli_pending_choices_snapshot'
  sessionAgentId: string
  choices: CliChoiceOwner[]
  requestId?: string
}

export interface CliRequestSuccessEvent<TResult = unknown> {
  type: 'cli_request_success'
  requestId: string
  commandType: CliWsCommand['type']
  result?: TResult
}

export interface CliFieldError {
  field: string
  message: string
}

export interface CliRequestErrorEvent {
  type: 'cli_request_error'
  requestId?: string
  commandType?: CliWsCommand['type']
  code: string
  message: string
  status?: number
  retryable?: boolean
  fieldErrors?: CliFieldError[]
}

export type CliServerEvent =
  | CliHeadlessReadyEvent
  | SessionActiveToolsSnapshotEvent
  | CliPendingChoicesSnapshotEvent
  | CliRequestSuccessEvent
  | CliRequestErrorEvent

export interface CliSubscribeHeadlessCommand {
  type: 'subscribe_headless'
  requestId?: string
  agentId?: string
  profileId?: string
}

export interface CliCreateSessionCommand {
  type: 'cli_create_session'
  requestId: string
  profileId: string
  label?: string
  name?: string
  cli?: CliSessionMetadata
}

export type CliMessageTarget =
  | { kind: 'session'; agentId: string }
  | { kind: 'project_agent'; profileId: string; handle: string }

export interface CliSendMessageCommand {
  type: 'cli_send_message'
  requestId: string
  target: CliMessageTarget
  text: string
  attachments?: ConversationAttachment[]
  delivery?: DeliveryMode
}

export type CliRunTarget =
  | { kind: 'new_session'; profileId: string; label?: string; name?: string }
  | { kind: 'session'; agentId: string }
  | { kind: 'project_agent'; profileId: string; handle: string }

export interface CliRunCommand {
  type: 'cli_run'
  requestId: string
  target: CliRunTarget
  text: string
  attachments?: ConversationAttachment[]
  delivery?: DeliveryMode
  cli?: CliSessionMetadata
}

export type CliSessionMutationCommand =
  | { type: 'stop_session'; requestId: string; agentId: string }
  | { type: 'resume_session'; requestId: string; agentId: string }
  | { type: 'delete_session'; requestId: string; agentId: string }
  | { type: 'clear_session'; requestId: string; agentId: string }
  | { type: 'rename_session'; requestId: string; agentId: string; label: string }
  | { type: 'pin_session'; requestId: string; agentId: string; pinned: boolean }
  | { type: 'fork_session'; requestId: string; sourceAgentId: string; label?: string; fromMessageId?: string }

export interface CliChoiceResponseCommand {
  type: 'cli_choice_response'
  requestId: string
  choiceId: string
  sessionAgentId?: string
  answers: ChoiceAnswer[]
}

export interface CliChoiceCancelCommand {
  type: 'cli_choice_cancel'
  requestId: string
  choiceId: string
  sessionAgentId?: string
}

export type CliWsCommand =
  | CliSubscribeHeadlessCommand
  | CliCreateSessionCommand
  | CliSendMessageCommand
  | CliRunCommand
  | CliSessionMutationCommand
  | CliChoiceResponseCommand
  | CliChoiceCancelCommand

export interface CliMessageDispatchResult {
  sessionAgentId: string
  profileId?: string
  messageId?: string
  acceptedAt: string
}

export interface CliSessionCreatedResult {
  session: AgentDescriptor
  profile: ManagerProfile
  cli?: CliSessionMetadata
}

export interface CliChoiceRouteResult {
  choiceId: string
  sessionAgentId: string
  status: 'answered' | 'cancelled'
}

export type CliRunStatus = 'success' | 'blocked' | 'timeout' | 'agent_failure' | 'canceled'

export interface CliBlockedChoiceResult {
  reason: 'pending_choice'
  choices: CliChoiceOwner[]
}

export interface CliRunResult {
  status: CliRunStatus
  sessionAgentId: string
  profileId?: string
  projectAgentHandle?: string | null
  finalMessage?: string | null
  blocked?: CliBlockedChoiceResult | null
  timedOut: boolean
  durationMs: number
}
