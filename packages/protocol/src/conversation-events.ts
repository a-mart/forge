// Builder event changes are additive-only for remote version skew; removals require a protocolVersion bump.
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
import type { PlanSummaryEvent } from './plans.js'

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
  'worker_report',
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

/**
 * Discriminates system notices that deserve their own presentation. A
 * `worker_outcome_backstop` notice is the deterministic delivery of a worker's
 * final outcome when the manager did not summarize it — informational, not an
 * error, and must not masquerade as manager prose.
 */
export type SystemNoticeKind = 'worker_outcome_backstop'

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
  /**
   * Echo of the sender-provided `user_message.clientRequestId`, when one was
   * supplied. Lets the originating client reconcile its optimistic entry.
   */
  clientRequestId?: string
  projectAgentContext?: ProjectAgentMessageContext
  externalThreadContext?: ExternalThreadMessageContext
  terminal?: boolean
  sourceWorkerId?: string
  excludeFromModelContext?: true
  pinned?: boolean
  replyTo?: ConversationReplyTarget
  systemNoticeKind?: SystemNoticeKind
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
  /** Marks peer-manager activity that belongs in the normal project-agent conversation. */
  projectAgentExchange?: true
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

export const ACTIVITY_SUMMARY_SCHEMA_VERSION = 1 as const

export type ActivitySummaryStatus = 'completed' | 'failed' | 'interrupted'

/**
 * Compact, provider-neutral activity that is safe to keep in canonical session
 * history. Streaming updates and raw tool output deliberately stay out of this
 * record; the stable itemId lets live and replayed rows converge.
 */
export interface ActivitySummaryEvent {
  type: 'activity_summary'
  schemaVersion: typeof ACTIVITY_SUMMARY_SCHEMA_VERSION
  itemId: string
  /** Timeline/session that owns the activity. */
  agentId: string
  /** Agent that performed the activity (normally the same as agentId). */
  actorAgentId: string
  turnId?: string
  timestamp: string
  kind: 'tool_activity'
  status: ActivitySummaryStatus
  toolName?: string
  correlationId?: string
  /** Bounded collapsed-row copy; never contains raw tool output. */
  displaySummary: string
  isError?: boolean
}

/**
 * Canonical identity and ordering coordinates shared by live and replayed
 * Builder entries. New writes persist these fields; readers backfill them from
 * the outer JSONL record and byte position for legacy rows.
 */
export interface ConversationTimelineEntryMetadata {
  timelineEntryId?: string
  timelineSequence?: number
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

export type ConversationEntry = (
  | ConversationMessageEvent
  | ConversationLogEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | ActivitySummaryEvent
  | ChoiceRequestEvent
  | PlanSummaryEvent
  | ModelCacheObservationEvent
) & ConversationTimelineEntryMetadata

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
