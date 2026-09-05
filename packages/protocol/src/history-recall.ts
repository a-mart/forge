/** Local Builder transcript retrieval. Historical evidence never grants new authority. */
export const HISTORY_SEARCH_SCOPES = ['session', 'project', 'all_local'] as const
export type HistorySearchScope = (typeof HISTORY_SEARCH_SCOPES)[number]
export const HISTORY_ENTRY_KINDS = ['message', 'tool_call', 'tool_result', 'checkpoint'] as const
export type HistoryEntryKind = (typeof HISTORY_ENTRY_KINDS)[number]

/** Qualified locator, not an access token or caller-supplied filesystem path. */
export interface HistoryEntryReference {
  sessionAgentId: string
  actorAgentId: string
  entryId: string
  /** Detect source replacement/reset rather than reading an unrelated row. */
  sourceVersion: string
  /** Optional canonical locator hint for checkpoint evidence not indexed yet; validated on read. */
  byteOffset?: number
}

export interface HistorySearchRequest {
  query: string
  /** Defaults to the caller's owning session. Broader search is always explicit. */
  scope?: HistorySearchScope
  sessionAgentId?: string
  profileId?: string
  /** A specific purpose for searching outside the current project; no approval workflow. */
  reason?: string
  kinds?: HistoryEntryKind[]
  toolName?: string
  role?: 'user' | 'assistant'
  since?: string
  until?: string
  window?: 'all' | 'current' | 'previous'
  limit?: number
  cursor?: string
}

export interface HistorySearchHit {
  ref: HistoryEntryReference
  profileId: string
  sessionLabel: string
  actorLabel: string
  timestamp?: string
  kind: HistoryEntryKind
  role?: 'user' | 'assistant'
  toolName?: string
  windowId: string
  archived: boolean
  snippet: string
  score: number
}

export interface HistorySearchResponse {
  scope: HistorySearchScope
  results: HistorySearchHit[]
  nextCursor?: string
  /** False means no-match is not evidence that the requested history does not exist. */
  complete: boolean
  warnings: string[]
}

export interface HistoryReadRequest {
  ref: HistoryEntryReference
  offset?: number
  maxChars?: number
  /** Optional bounded neighboring entries on the same source/branch. */
  before?: number
  after?: number
}

export interface HistoryReadEntry {
  ref: HistoryEntryReference
  kind: HistoryEntryKind
  timestamp?: string
  role?: 'user' | 'assistant'
  toolName?: string
  windowId: string
  text: string
  offset: number
  nextOffset?: number
  totalChars: number
}

export interface HistoryReadResponse {
  entry: HistoryReadEntry
  before: HistoryReadEntry[]
  after: HistoryReadEntry[]
  warnings: string[]
}
