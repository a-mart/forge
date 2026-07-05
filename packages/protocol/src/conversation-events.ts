import type { ConversationMessageAttachment } from './attachments.js'
import type { CollaborationAuthor } from './collaboration.js'
import type {
  AcceptedDeliveryMode,
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceRequestStatus,
  DeliveryMode,
  MessageSourceContext,
} from './shared-types.js'
import type { ModelCacheObservationEvent } from './model-cache.js'
import type { WorkPlanSnapshot } from './tasks.js'

export type {
  ModelCacheClassification,
  ModelCacheObservationEvent,
  ModelCacheProvider,
  ModelCacheRuntimeType,
  ModelCacheStatus,
  ModelCacheTokenFacts,
  ModelCacheTokenNormalization,
} from './model-cache.js'
export {
  MODEL_CACHE_CLASSIFICATION_VERSION,
  MODEL_CACHE_ELIGIBILITY_THRESHOLD_TOKENS,
  MODEL_CACHE_HIT_RATIO_THRESHOLD,
  MODEL_CACHE_PROVIDERS,
  MODEL_CACHE_STATUSES,
  MODEL_CACHE_TOKEN_NORMALIZATIONS,
} from './model-cache.js'

export interface ProjectAgentMessageContext {
  fromAgentId: string
  fromDisplayName: string
  external?: boolean
  fromProfileId?: string
  fromProjectName?: string
}

export const EXTERNAL_THREAD_MESSAGE_STATUSES = [
  'sent',
  'running',
  'completed',
  'stopped',
  'error',
] as const
export type ExternalThreadMessageStatus = (typeof EXTERNAL_THREAD_MESSAGE_STATUSES)[number]

export interface ExternalThreadMessageContext {
  type: 'codex_app_server'
  sidecarAgentId: string
  requestId: string
  turnCorrelationId: string
  threadId?: string
  promptPreview?: string
  resultPreview?: string
  status: ExternalThreadMessageStatus
  detailMessageId?: string
  excludeFromModelContext: true
}

export const CONVERSATION_MESSAGE_SOURCES = [
  'user_input',
  'speak_to_user',
  'assistant_output',
  'assistant_progress',
  'system',
  'project_agent_input',
] as const

export type ConversationMessageSource = (typeof CONVERSATION_MESSAGE_SOURCES)[number]

export const TERMINAL_ASSISTANT_MESSAGE_SOURCES = [
  'speak_to_user',
  'assistant_output',
] as const satisfies readonly ConversationMessageSource[]

export type TerminalAssistantMessageSource = (typeof TERMINAL_ASSISTANT_MESSAGE_SOURCES)[number]

export const ASSISTANT_PROGRESS_MESSAGE_SOURCES = [
  'assistant_progress',
] as const satisfies readonly ConversationMessageSource[]

export type AssistantProgressMessageSource = (typeof ASSISTANT_PROGRESS_MESSAGE_SOURCES)[number]

export const USER_VISIBLE_ASSISTANT_MESSAGE_SOURCES = [
  ...TERMINAL_ASSISTANT_MESSAGE_SOURCES,
  ...ASSISTANT_PROGRESS_MESSAGE_SOURCES,
] as const satisfies readonly ConversationMessageSource[]

export type UserVisibleAssistantMessageSource = (typeof USER_VISIBLE_ASSISTANT_MESSAGE_SOURCES)[number]

export function isConversationMessageSource(value: unknown): value is ConversationMessageSource {
  return typeof value === 'string' && (CONVERSATION_MESSAGE_SOURCES as readonly string[]).includes(value)
}

export function isUserVisibleAssistantConversationSource(
  source: unknown,
): source is UserVisibleAssistantMessageSource {
  return typeof source === 'string' && (USER_VISIBLE_ASSISTANT_MESSAGE_SOURCES as readonly string[]).includes(source)
}

export function isTerminalAssistantConversationSource(
  source: unknown,
): source is TerminalAssistantMessageSource {
  return typeof source === 'string' && (TERMINAL_ASSISTANT_MESSAGE_SOURCES as readonly string[]).includes(source)
}

export function isAssistantProgressConversationSource(
  source: unknown,
): source is AssistantProgressMessageSource {
  return typeof source === 'string' && (ASSISTANT_PROGRESS_MESSAGE_SOURCES as readonly string[]).includes(source)
}

export interface ConversationReplyTarget {
  messageId: string
  role: 'user' | 'assistant' | 'system'
  timestamp: string
  text: string
  source?: ConversationMessageSource
  attachmentCount?: number
  truncated?: boolean
}

export interface ConversationReplyTargetInput {
  messageId: string
  role?: 'user' | 'assistant' | 'system'
  timestamp?: string
  text?: string
  source?: ConversationMessageSource
  attachmentCount?: number
}

export interface ConversationMessageEvent {
  type: 'conversation_message'
  agentId: string
  turnId?: string
  id?: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: ConversationMessageAttachment[]
  timestamp: string
  source: ConversationMessageSource
  sourceContext?: MessageSourceContext
  collaborationAuthor?: CollaborationAuthor
  projectAgentContext?: ProjectAgentMessageContext
  externalThreadContext?: ExternalThreadMessageContext
  pinned?: boolean
  replyTo?: ConversationReplyTarget
}

export interface MessagePinnedEvent {
  type: 'message_pinned'
  agentId: string
  messageId: string
  pinned: boolean
  timestamp: string
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
  turnId?: string
  timestamp: string
  kind: AgentToolCallKind
  toolName?: string
  toolCallId?: string
  text: string
  isError?: boolean
}

export interface ChoiceRequestEvent {
  type: 'choice_request'
  agentId: string
  sessionAgentId?: string
  choiceId: string
  questions: ChoiceQuestion[]
  status: ChoiceRequestStatus
  answers?: ChoiceAnswer[]
  timestamp: string
}

export interface WorkPlanCreatedEvent {
  type: 'work_plan_created'
  agentId: string
  id: string
  timestamp: string
  planId: string
  stateRevision: number
  planRevision: number
  plan: WorkPlanSnapshot
}

export type ConversationEntry =
  | ConversationMessageEvent
  | ConversationLogEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | ChoiceRequestEvent
  | WorkPlanCreatedEvent
  | ModelCacheObservationEvent

export function isUserVisibleAssistantConversationMessage(
  entry: ConversationEntry,
): entry is ConversationMessageEvent & { role: 'assistant'; source: UserVisibleAssistantMessageSource } {
  return (
    entry.type === 'conversation_message' &&
    entry.role === 'assistant' &&
    isUserVisibleAssistantConversationSource(entry.source)
  )
}

export function isTerminalAssistantConversationMessage(
  entry: ConversationEntry,
): entry is ConversationMessageEvent & { role: 'assistant'; source: TerminalAssistantMessageSource } {
  return (
    entry.type === 'conversation_message' &&
    entry.role === 'assistant' &&
    isTerminalAssistantConversationSource(entry.source)
  )
}

export function isAssistantProgressConversationMessage(
  entry: ConversationEntry,
): entry is ConversationMessageEvent & { role: 'assistant'; source: AssistantProgressMessageSource } {
  return (
    entry.type === 'conversation_message' &&
    entry.role === 'assistant' &&
    isAssistantProgressConversationSource(entry.source)
  )
}

export function isUserVisibleConversationMessage(
  entry: ConversationEntry,
): entry is ConversationMessageEvent {
  if (entry.type !== 'conversation_message') {
    return false
  }

  if (entry.source === 'system') {
    return entry.role === 'system'
  }

  if (entry.source === 'project_agent_input' || entry.source === 'user_input') {
    return entry.role === 'user'
  }

  return isUserVisibleAssistantConversationMessage(entry)
}

export function isExplicitRoutedAssistantConversationMessage(
  entry: ConversationEntry,
): entry is ConversationMessageEvent & { role: 'assistant'; source: 'speak_to_user' } {
  return entry.type === 'conversation_message' && entry.role === 'assistant' && entry.source === 'speak_to_user'
}

export type ConversationEntryEvent = ConversationEntry
