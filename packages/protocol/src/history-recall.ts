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
  /** Optional canonical locator hint for checkpoint evidence not indexed yet; validated on read. */
  byteOffset?: number
  /** Deterministic part identity for multipart canonical entries. Absent on legacy refs. */
  partId?: string
  /** Deterministic chunk identity for long indexed text. Absent on legacy refs. */
  chunkIndex?: number
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
  /** Defaults to relevance for compatibility. Explicit newest is strictly chronological. */
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
  text: string
  chunkIndex?: number
}

export interface HistoryReadOmission {
  reason: 'oversized' | 'secret' | 'binary' | 'unreadable' | 'truncated_index' | 'part_unresolved'
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
