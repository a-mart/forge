import type { ChoiceRequestEvent, ConversationEntry } from './conversation-events.js'

export interface ReadyEvent {
  type: 'ready'
  serverTime: string
  subscribedAgentId: string
  /** Echoes acceptance of request-correlated session goal controls. */
  goalControlRequestId?: true
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
  /** @deprecated Older servers used this event for page responses. */
  requestId?: string
  /** @deprecated Older servers used `prepend` for page responses. */
  mode?: 'replace' | 'prepend'
  /** @deprecated Older servers attached page metadata to this bootstrap event. */
  page?: ConversationHistoryPageMetadata
}

/** Request-correlated older-history page. Bootstrap history remains a separate snapshot event. */
export interface ConversationPageEvent {
  type: 'conversation_page'
  agentId: string
  messages: ConversationEntry[]
  requestId: string
  page: ConversationHistoryPageMetadata
}

export type ConversationHistoryPageCompleteness = 'complete' | 'partial_scan' | 'source_changed'
export type ConversationHistoryPageSource = 'canonical' | 'legacy_cache' | 'memory'

export interface ConversationHistoryPageMetadata {
  nextCursor?: string
  hasOlder: boolean
  completeness: ConversationHistoryPageCompleteness
  source: ConversationHistoryPageSource
}

export interface PendingChoicesSnapshotEvent {
  type: 'pending_choices_snapshot'
  agentId: string
  choiceIds: string[]
  choices?: ChoiceRequestEvent[]
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
