/** Local Builder transcript retrieval. Historical evidence never grants new authority. */
export const HISTORY_SEARCH_SCOPES = ['session', 'project', 'all_local'] as const
export type HistorySearchScope = (typeof HISTORY_SEARCH_SCOPES)[number]
export const HISTORY_ENTRY_KINDS = ['message', 'tool_call', 'tool_result', 'checkpoint'] as const
export type HistoryEntryKind = (typeof HISTORY_ENTRY_KINDS)[number]
export const HISTORY_SEARCH_ORDERS = ['relevance', 'newest'] as const
export type HistorySearchOrder = (typeof HISTORY_SEARCH_ORDERS)[number]
export const HISTORY_COVERAGE_STATES = ['building', 'ready', 'degraded', 'unavailable'] as const
export type HistoryCoverageState = (typeof HISTORY_COVERAGE_STATES)[number]
export const HISTORY_CATALOG_HYDRATION = ['partial', 'complete'] as const
export type HistoryCatalogHydration = (typeof HISTORY_CATALOG_HYDRATION)[number]
export const HISTORY_SNAPSHOT_ERROR_CODES = ['snapshot_expired', 'snapshot_mismatch', 'snapshot_cap_exceeded'] as const
export type HistorySnapshotErrorCode = (typeof HISTORY_SNAPSHOT_ERROR_CODES)[number]

/** Qualified locator, not an access token or caller-supplied filesystem path. */
export interface HistoryEntryReference {
  sessionAgentId: string
  actorAgentId: string
  entryId: string
  /** Detect source replacement/reset rather than reading an unrelated row. */
  sourceVersion: string
  /** Optional canonical locator; present on current hits and validated on read without the index. */
  byteOffset?: number
  /** Deterministic part identity for multipart canonical entries. Absent on legacy refs. */
  partId?: string
  /** Deterministic chunk identity for long indexed text. Absent on legacy refs. */
  chunkIndex?: number
}

export interface HistorySearchRequest {
  /** Lexical token/phrase discovery within overlapping chunks by default; literal matches the exact projected text substring. */
  query: string
  mode?: 'lexical' | 'literal'
  /** Literal mode only. Defaults to true; false uses Unicode lowercase comparison. */
  caseSensitive?: boolean
  actorAgentId?: string
  /** Exact canonical window selection; mutually exclusive with window. */
  windowId?: string
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
  /** Lexical only: previous means all non-current windows. Literal uses exact windowId. */
  window?: 'all' | 'current' | 'previous'
  limit?: number
  cursor?: string
  /** Lexical only: defaults to relevance. Explicit newest is strictly chronological. Literal scans oldest first. */
  order?: HistorySearchOrder
  /** Include identifiable history-tool artifacts. Default false. */
  includeHistoryArtifacts?: boolean
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
  /** Unresolved suffix attribution; omitted when the occurrence has converged. */
  provisional?: boolean
}

export interface HistoryCoverage {
  catalogHydration: HistoryCatalogHydration
  state: HistoryCoverageState
  catalogRevision: number
  pendingSourceCount: number
  unreadableSourceCount: number
  omittedEligibleText: boolean
  /** Present only when catalog hydration is complete. Unknown totals stay unknown. */
  eligibleSourceCount?: number
}

export interface HistorySearchResponse {
  scope: HistorySearchScope
  results: HistorySearchHit[]
  nextCursor?: string
  /** False means no-match is not evidence that the requested history does not exist. */
  complete: boolean
  warnings: string[]
  /** Structured coverage; optional so older callers can ignore it. */
  coverage?: HistoryCoverage
  snapshotId?: string
  snapshotExpiresAt?: string
}

export interface HistorySessionsRequest {
  /** Case-insensitive substring of session/actor labels or IDs, not transcript contents. */
  query?: string
  scope?: HistorySearchScope
  sessionAgentId?: string
  profileId?: string
  reason?: string
  limit?: number
  cursor?: string
}

export interface HistorySessionHit {
  sessionAgentId: string
  profileId: string
  sessionLabel: string
  archived: boolean
  actorCount: number
  actorLabels: string[]
  /** Unknown last activity stays omitted; never fabricated from file mtime. */
  lastActivityAt?: string
  snippet?: string
}

export interface HistorySessionsResponse {
  scope: HistorySearchScope
  results: HistorySessionHit[]
  nextCursor?: string
  warnings: string[]
  coverage: HistoryCoverage
  snapshotId?: string
  snapshotExpiresAt?: string
}

/** Query-free canonical traversal. Sources are visited in stable ID order, rows oldest first.
 * Pages are bounded by output and scan work; an empty page with nextCursor must be continued.
 * The source inventory is captured at traversal start. Each source is frozen at its first visit;
 * later appends require a new traversal. Cursors expire after 60 seconds of inactivity.
 */
export interface HistoryWindowsRequest {
  sessionAgentId?: string
  actorAgentId?: string
  /** Required only when explicitly selecting a session outside the current project. */
  reason?: string
  limit?: number
  cursor?: string
}

export interface HistoryItemsRequest extends HistoryWindowsRequest {
  windowId?: string
  kinds?: HistoryEntryKind[]
  toolName?: string
  role?: 'user' | 'assistant'
  includeHistoryArtifacts?: boolean
}

export interface HistoryWindowHit {
  sessionAgentId: string
  actorAgentId: string
  actorLabel: string
  windowId: string
  /** First readable item in this window, directly readable without an index. */
  firstRef: HistoryEntryReference
  timestamp?: string
}

export interface HistoryCanonicalPage<T> {
  results: T[]
  nextCursor?: string
  /** True only on the final page with no unreadable/oversized/unfinished source rows. */
  complete: boolean
  warnings: string[]
}

export type HistoryWindowsResponse = HistoryCanonicalPage<HistoryWindowHit>
export type HistoryItemsResponse = HistoryCanonicalPage<HistorySearchHit>

export interface HistoryReadRequest {
  ref: HistoryEntryReference
  offset?: number
  maxChars?: number
  /** Optional bounded neighboring entries on the same source/branch. */
  before?: number
  after?: number
}

export interface HistoryEntryPart {
  partId: string
  kind: HistoryEntryKind
  role?: 'user' | 'assistant'
  toolName?: string
  /** Bounded preview only; use ref.partId with read to expand a selected part. */
  text: string
  chunkIndex?: number
}

export interface HistoryReadOmission {
  reason: 'oversized' | 'secret' | 'binary' | 'unreadable' | 'truncated_index' | 'part_unresolved' | 'response_limit'
  detail: string
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
  parts?: HistoryEntryPart[]
  omissions?: HistoryReadOmission[]
}

export interface HistoryReadResponse {
  entry: HistoryReadEntry
  before: HistoryReadEntry[]
  after: HistoryReadEntry[]
  warnings: string[]
}

/** Authoritative eligible-source inventory. Paths are local Builder locators, not agent-supplied. */
export interface HistoryCatalogSource {
  sourceId: string
  profileId: string
  sessionAgentId: string
  actorAgentId: string
  path: string
  archived: boolean
  sessionLabel: string
  actorLabel: string
  lastActivityAt?: string
}

export interface HistoryCatalogSnapshot {
  revision: number
  hydration: HistoryCatalogHydration
  sources: HistoryCatalogSource[]
}

export interface HistoryDirtySource {
  sessionAgentId: string
  actorAgentId: string
}
