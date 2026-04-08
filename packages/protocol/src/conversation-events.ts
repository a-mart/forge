import type { ConversationMessageAttachment } from './attachments.js'
import type {
  AcceptedDeliveryMode,
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceRequestStatus,
  DeliveryMode,
  MessageSourceContext,
} from './shared-types.js'

export interface ProjectAgentMessageContext {
  fromAgentId: string
  fromDisplayName: string
}

export interface ConversationMessageEvent {
  type: 'conversation_message'
  agentId: string
  id?: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: ConversationMessageAttachment[]
  timestamp: string
  source: 'user_input' | 'speak_to_user' | 'system' | 'project_agent_input'
  sourceContext?: MessageSourceContext
  projectAgentContext?: ProjectAgentMessageContext
  pinned?: boolean
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
  choiceId: string
  questions: ChoiceQuestion[]
  status: ChoiceRequestStatus
  answers?: ChoiceAnswer[]
  timestamp: string
}

export type ConversationEntry =
  | ConversationMessageEvent
  | ConversationLogEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | ChoiceRequestEvent

export type ConversationEntryEvent = ConversationEntry
