import type { ConversationAttachment, ConversationMessageAttachment } from './attachments.js'
import type { AgentContextUsage, AgentDescriptor, AgentModelDescriptor, AgentStatus, CollaborationAiRole } from './agents.js'
import type { AgentMessageEvent, AgentToolCallEvent, ProjectAgentMessageContext } from './conversation-events.js'
import type { MessageSourceContext } from './messaging.js'
import type { ChoiceAnswer, ChoiceQuestion, ChoiceRequestStatus } from './shared-types.js'

export type CollaborationRole = 'admin' | 'member'
export type CollaborationInviteRole = 'member'
export type CollaborationAuthMethod = 'password'
export type CollaborationInviteStatus = 'pending' | 'revoked' | 'expired' | 'consumed'
export type CollaborationInviteLookupError = 'not_found' | 'expired' | 'revoked' | 'consumed' | 'unsupported'

export interface CollaborationStatus {
  enabled: boolean
  adminExists: boolean
  baseUrl?: string
}

export interface CollaborationUser {
  userId: string
  email: string
  name: string
  role: CollaborationRole
  disabled: boolean
  authMethods: CollaborationAuthMethod[]
  createdAt: string
  updatedAt: string
}

export interface CollaborationInvite {
  inviteId: string
  email?: string
  role: CollaborationInviteRole
  status: CollaborationInviteStatus
  createdAt: string
  expiresAt: string
  revokedAt?: string
  consumedAt?: string
}

export interface CollaborationInviteLookupInfo {
  inviteId: string
  email?: string
  role: CollaborationInviteRole
  expiresAt: string
}

export interface CollaborationInviteLookupResult {
  valid: boolean
  invite?: CollaborationInviteLookupInfo
  error?: CollaborationInviteLookupError
}

export interface CollaborationCreatedInvite {
  inviteId: string
  email?: string
  role: CollaborationInviteRole
  createdAt: string
  expiresAt: string
  inviteUrl: string
}

export interface CollaborationInviteRedeemedUser {
  userId: string
  email: string
  name: string
  role: CollaborationInviteRole
}

export interface CollaborationSessionInfo {
  authenticated: boolean
  user?: CollaborationUser
  passwordChangeRequired?: boolean
}

export interface CollaborationWorkspaceBaseAi {
  model: AgentModelDescriptor
  archetypeId?: string
  cwd: string
  sessionSystemPrompt?: string
  contextMode: 'prompt_and_memory'
}

export interface CollaborationWorkspace {
  workspaceId: string
  displayName: string
  description?: string
  aiDisplayName?: string
  createdByUserId?: string
  createdAt: string
  updatedAt: string
  memberCount?: number
}

export interface CollaborationCategory {
  categoryId: string
  workspaceId: string
  name: string
  defaultModelId?: string
  defaultAiRole: CollaborationAiRole
  position: number
  createdAt: string
  updatedAt: string
}

export interface CollaborationChannel {
  channelId: string
  workspaceId: string
  categoryId?: string
  sessionAgentId: string
  name: string
  slug: string
  description?: string
  aiEnabled: boolean
  modelId?: string
  aiRole: CollaborationAiRole
  promptOverlay?: string
  position: number
  archived: boolean
  archivedAt?: string
  archivedByUserId?: string
  createdByUserId?: string
  lastMessageSeq: number
  lastMessageId?: string
  lastMessageAt?: string
  createdAt: string
  updatedAt: string
}

export interface CollaborationAuthor {
  userId: string
  displayName: string
  role: CollaborationRole
  workspaceId: string
  channelId: string
}

export interface CollaborationBootstrapCurrentUser {
  userId: string
  email: string
  name: string
  role: CollaborationRole
  disabled: boolean
}

export interface CollaborationReadState {
  channelId: string
  lastReadMessageId?: string
  lastReadMessageSeq: number
  lastReadAt?: string
  unreadCount: number
}

export interface CollaborationBootstrapChannel extends CollaborationChannel {
  readState: CollaborationReadState
}

export interface CollaborationTranscriptMessage {
  channelId: string
  id?: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: ConversationMessageAttachment[]
  timestamp: string
  source: 'user_input' | 'speak_to_user' | 'system' | 'project_agent_input'
  sourceContext?: MessageSourceContext
  projectAgentContext?: ProjectAgentMessageContext
  pinned?: boolean
  collaborationAuthor?: CollaborationAuthor
}

export interface CollaborationBootstrapCommand {
  type: 'collab_bootstrap'
}

export interface CollaborationSubscribeChannelCommand {
  type: 'collab_subscribe_channel'
  channelId: string
}

export interface CollaborationUnsubscribeChannelCommand {
  type: 'collab_unsubscribe_channel'
  channelId: string
}

export interface CollaborationUserMessageCommand {
  type: 'collab_user_message'
  channelId: string
  content: string
  attachments?: ConversationAttachment[]
}

export interface CollaborationMarkChannelReadCommand {
  type: 'collab_mark_channel_read'
  channelId: string
}

export interface CollaborationChoiceResponseCommand {
  type: 'collab_choice_response'
  channelId: string
  choiceId: string
  answers: ChoiceAnswer[]
}

export interface CollaborationChoiceCancelCommand {
  type: 'collab_choice_cancel'
  channelId: string
  choiceId: string
}

export interface CollaborationPinMessageCommand {
  type: 'collab_pin_message'
  channelId: string
  messageId: string
  pinned: boolean
}

export type CollaborationClientCommand =
  | CollaborationBootstrapCommand
  | CollaborationSubscribeChannelCommand
  | CollaborationUnsubscribeChannelCommand
  | CollaborationUserMessageCommand
  | CollaborationMarkChannelReadCommand
  | CollaborationChoiceResponseCommand
  | CollaborationChoiceCancelCommand
  | CollaborationPinMessageCommand

export interface CollaborationBootstrapEvent {
  type: 'collab_bootstrap'
  currentUser: CollaborationBootstrapCurrentUser
  workspace: CollaborationWorkspace | null
  categories: CollaborationCategory[]
  channels: CollaborationBootstrapChannel[]
}

export interface CollaborationChannelReadyEvent {
  type: 'collab_channel_ready'
  channel: CollaborationChannel
}

export interface CollaborationChannelHistoryEvent {
  type: 'collab_channel_history'
  channelId: string
  messages: CollaborationTranscriptMessage[]
}

export interface CollaborationChannelMessageEvent {
  type: 'collab_channel_message'
  channelId: string
  message: CollaborationTranscriptMessage
}

export interface CollaborationChannelStatusEvent {
  type: 'collab_channel_status'
  channelId: string
  status: 'thinking' | 'responding' | 'idle'
  agentStatus?: AgentStatus
  pendingCount?: number
  contextRecoveryInProgress?: boolean
  streamingStartedAt?: number
}

export type CollaborationSessionActivityEntry = AgentMessageEvent | AgentToolCallEvent

export interface CollaborationSessionWorkersSnapshotEvent {
  type: 'collab_session_workers_snapshot'
  channelId: string
  sessionAgentId: string
  workers: AgentDescriptor[]
}

export interface CollaborationSessionActivitySnapshotEvent {
  type: 'collab_session_activity_snapshot'
  channelId: string
  sessionAgentId: string
  activity: CollaborationSessionActivityEntry[]
}

export interface CollaborationSessionActivityEvent {
  type: 'collab_session_activity'
  channelId: string
  sessionAgentId: string
  activity: CollaborationSessionActivityEntry
}

export interface CollaborationSessionAgentStatusEvent {
  type: 'collab_session_agent_status'
  channelId: string
  sessionAgentId: string
  agentId: string
  managerId?: string
  status: AgentStatus
  pendingCount: number
  contextUsage?: AgentContextUsage
  contextRecoveryInProgress?: boolean
  streamingStartedAt?: number
}

export interface CollaborationChannelActivityUpdatedEvent {
  type: 'collab_channel_activity_updated'
  channelId: string
  lastMessageSeq: number
  lastMessageId?: string
  lastMessageAt?: string
  unreadCount: number
}

export interface CollaborationReadStateUpdatedEvent {
  type: 'collab_read_state_updated'
  channelId: string
  readState: CollaborationReadState
}

export interface CollaborationChoiceRequestEvent {
  type: 'collab_choice_request'
  channelId: string
  request: {
    agentId: string
    choiceId: string
    questions: ChoiceQuestion[]
    status: ChoiceRequestStatus
    answers?: ChoiceAnswer[]
    timestamp: string
  }
}

export interface CollaborationMessagePinnedEvent {
  type: 'collab_message_pinned'
  channelId: string
  messageId: string
  pinned: boolean
}

export interface CollaborationChannelCreatedEvent {
  type: 'collab_channel_created'
  channel: CollaborationChannel
}

export interface CollaborationChannelUpdatedEvent {
  type: 'collab_channel_updated'
  channel: CollaborationChannel
}

export interface CollaborationChannelArchivedEvent {
  type: 'collab_channel_archived'
  workspaceId: string
  channelId: string
}

export interface CollaborationCategoryCreatedEvent {
  type: 'collab_category_created'
  category: CollaborationCategory
}

export interface CollaborationCategoryUpdatedEvent {
  type: 'collab_category_updated'
  category: CollaborationCategory
}

export interface CollaborationCategoryDeletedEvent {
  type: 'collab_category_deleted'
  workspaceId: string
  categoryId: string
}

export interface CollaborationCategoryReorderedEvent {
  type: 'collab_category_reordered'
  workspaceId: string
  categories: CollaborationCategory[]
}

export interface CollaborationChannelReorderedEvent {
  type: 'collab_channel_reordered'
  workspaceId: string
  channels: CollaborationChannel[]
}

export type CollaborationServerEvent =
  | CollaborationBootstrapEvent
  | CollaborationChannelReadyEvent
  | CollaborationChannelHistoryEvent
  | CollaborationChannelMessageEvent
  | CollaborationChannelStatusEvent
  | CollaborationSessionWorkersSnapshotEvent
  | CollaborationSessionActivitySnapshotEvent
  | CollaborationSessionActivityEvent
  | CollaborationSessionAgentStatusEvent
  | CollaborationChannelActivityUpdatedEvent
  | CollaborationReadStateUpdatedEvent
  | CollaborationChoiceRequestEvent
  | CollaborationMessagePinnedEvent
  | CollaborationChannelCreatedEvent
  | CollaborationChannelUpdatedEvent
  | CollaborationChannelArchivedEvent
  | CollaborationChannelReorderedEvent
  | CollaborationCategoryCreatedEvent
  | CollaborationCategoryUpdatedEvent
  | CollaborationCategoryDeletedEvent
  | CollaborationCategoryReorderedEvent
