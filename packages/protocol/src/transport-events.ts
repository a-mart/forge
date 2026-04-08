import type { ConversationEntry } from './conversation-events.js'

export interface ReadyEvent {
  type: 'ready'
  serverTime: string
  subscribedAgentId: string
}

export interface ConversationResetEvent {
  type: 'conversation_reset'
  agentId: string
  timestamp: string
  reason: 'user_new_command' | 'api_reset'
}

export interface ConversationHistoryEvent {
  type: 'conversation_history'
  agentId: string
  messages: ConversationEntry[]
}

export interface PendingChoicesSnapshotEvent {
  type: 'pending_choices_snapshot'
  agentId: string
  choiceIds: string[]
}

export interface ApiProxyResponseEvent {
  type: 'api_proxy_response'
  requestId: string
  status: number
  body: string
  headers?: Record<string, string>
}

export interface ErrorEvent {
  type: 'error'
  code: string
  message: string
  requestId?: string
}
