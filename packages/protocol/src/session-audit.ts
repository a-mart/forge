import type { AgentStatus } from './agents.js'

export const SESSION_AUDIT_SCOPES = ['session', 'worker'] as const
export type SessionAuditScope = (typeof SESSION_AUDIT_SCOPES)[number]

export const SESSION_AUDIT_SOURCE_KINDS = [
  'canonical_session_jsonl',
  'canonical_worker_jsonl',
  // Reserved for a future projected-cache audit source; not currently accepted by the API.
  'conversation_cache_projection',
] as const
export type SessionAuditSourceKind = (typeof SESSION_AUDIT_SOURCE_KINDS)[number]

export const SESSION_AUDIT_ORDERS = ['asc', 'desc'] as const
export type SessionAuditOrder = (typeof SESSION_AUDIT_ORDERS)[number]

export const SESSION_AUDIT_ENTRY_CATEGORIES = [
  'session_header',
  'conversation_message',
  'agent_message',
  'manager_tool_call',
  'worker_tool_call',
  'runtime_log',
  'choice_request',
  'work_plan_created',
  'model_cache_observation',
  'custom',
  'unknown',
  'malformed',
] as const
export type SessionAuditEntryCategory = (typeof SESSION_AUDIT_ENTRY_CATEGORIES)[number]

export interface SessionAuditWorkerSummary {
  workerId: string
  displayName?: string
  status?: AgentStatus
  descriptorPresent: boolean
  relativePath: string
  bytes?: number
  updatedAt?: string
}

export interface SessionAuditManifest {
  sessionAgentId: string
  sessionRelativePath: string
  sessionBytes?: number
  workers: SessionAuditWorkerSummary[]
}

export interface SessionAuditCursor {
  v: 1
  sessionAgentId: string
  scope: SessionAuditScope
  sourceId: string
  offset: number
  lineNumber?: number
  order: SessionAuditOrder
}

export type SessionAuditHiddenReason =
  | 'normal_view_hidden'
  | 'raw_only'
  | 'malformed'
  | 'unsupported_source'
  | 'payload_truncated'

export interface SessionAuditEntry {
  id: string
  scope: SessionAuditScope
  sourceId: string
  sourceLabel: string
  sourceKind: SessionAuditSourceKind
  relativePath: string
  ordinal?: number
  lineNumber?: number
  byteOffset: number
  nextByteOffset: number
  wrapperId?: string
  parentId?: string | null
  wrapperTimestamp?: string
  entryTimestamp?: string
  wrapperType?: string
  customType?: string
  conversationType?: string
  category: SessionAuditEntryCategory
  agentId?: string
  actorAgentId?: string
  fromAgentId?: string
  toAgentId?: string
  toolName?: string
  toolCallId?: string
  toolKind?: string
  role?: string
  conversationSource?: string
  renderable: boolean
  hiddenReason?: SessionAuditHiddenReason
  title: string
  summary: string
  preview: string
  previewTruncated?: boolean
  rawPreview: string
  rawPreviewTruncated?: boolean
  rawBytes: number
  parseError?: string
}

export interface SessionAuditPageInfo {
  startOffset: number
  endOffset: number
  sourceBytes: number
  scannedLines: number
  scannedBytes: number
  returnedItems: number
  scanLimited: boolean
}

export interface SessionAuditPageRequest {
  scope?: SessionAuditScope
  workerId?: string
  sourceKind?: SessionAuditSourceKind
  cursor?: string
  offset?: number
  order?: SessionAuditOrder
  limit?: number
  categories?: SessionAuditEntryCategory[]
  types?: string[]
}

export interface SessionAuditPageResponse {
  sessionAgentId: string
  manifest: SessionAuditManifest
  scope: SessionAuditScope
  sourceId: string
  sourceKind: SessionAuditSourceKind
  order: SessionAuditOrder
  limit: number
  categories?: SessionAuditEntryCategory[]
  types?: string[]
  items: SessionAuditEntry[]
  page: SessionAuditPageInfo
  nextCursor?: string
  hasMore: boolean
}

export interface SessionAuditEntryDetailRequest {
  scope?: SessionAuditScope
  workerId?: string
  sourceKind?: SessionAuditSourceKind
  byteOffset: number
  nextByteOffset?: number
}

export interface SessionAuditEntryDetailResponse {
  sessionAgentId: string
  scope: SessionAuditScope
  sourceId: string
  sourceKind: SessionAuditSourceKind
  relativePath: string
  byteOffset: number
  nextByteOffset: number
  rawBytes: number
  rawText: string
  truncated: boolean
  maxBytes: number
  parseError?: string
  formattedJson?: string
}
