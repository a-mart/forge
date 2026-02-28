import type { ConversationEntry } from '@middleman/protocol'

export type ConversationMessageEntry = Extract<
  ConversationEntry,
  { type: 'conversation_message' }
>
export type ConversationLogEntry = Extract<
  ConversationEntry,
  { type: 'conversation_log' }
>
export type AgentMessageEntry = Extract<ConversationEntry, { type: 'agent_message' }>
export type AgentToolCallEntry = Extract<
  ConversationEntry,
  { type: 'agent_tool_call' }
>

export type ToolExecutionLogEntry = ConversationLogEntry & {
  kind: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'
}

export type ToolExecutionEvent = ToolExecutionLogEntry | AgentToolCallEntry

export type ToolDisplayStatus =
  | 'pending'
  | 'completed'
  | 'cancelled'
  | 'error'

export interface ToolExecutionDisplayEntry {
  id: string
  actorAgentId?: string
  toolName?: string
  toolCallId?: string
  inputPayload?: string
  latestPayload?: string
  outputPayload?: string
  timestamp: string
  latestKind: ToolExecutionEvent['kind']
  isError?: boolean
}
