import type { KnowledgeV2Settings } from './knowledge-v2.js'

export type KnowledgeEntryType = 'preference' | 'convention' | 'gotcha' | 'pointer'
export type KnowledgeEntryScope = 'global' | `profile:${string}`
export type KnowledgeEntryStatus = 'active' | 'archived' | 'superseded'
export type KnowledgeEntryImportance = 'normal' | 'high' | 'pinned'
export type KnowledgeEvidenceTier =
  | 'explicit_user'
  | 'trusted_artifact'
  | 'feedback_signal'
  | 'repeated_pattern'
  | 'agent_inference'

export interface KnowledgeEntrySource {
  kind: 'user-stated' | 'observed' | 'legacy'
  session?: string
  at: string
}

export interface CortexKnowledgeEntry {
  id: string
  version: number
  type: KnowledgeEntryType
  scope: KnowledgeEntryScope
  status: KnowledgeEntryStatus
  title: string
  body: string
  first_seen: string
  last_confirmed: string
  support_count: number
  sources: KnowledgeEntrySource[]
  evidence_tier: KnowledgeEvidenceTier
  supersedes: string[]
  source_entry_ids: string[]
  importance: KnowledgeEntryImportance
  decay_after_days: number | null
  indexed?: boolean
  tokenEstimate: number
}

export interface CortexKnowledgeIndex {
  scope: KnowledgeEntryScope
  content: string
  tokenCap: number
  tokenEstimate: number
  indexedEntryIds: string[]
}

export type CortexChangelogAction = 'added' | 'merged' | 'archived' | 'superseded' | 'reindexed'

export interface CortexChangelogEntry {
  runId: string
  action: CortexChangelogAction
  entryId?: string
  sourceEntryIds?: string[]
  why: string
  recordedAt: string
}

export type CortexConsolidationTrigger = 'manual' | 'threshold' | 'daily'
export type CortexConsolidationStatus = 'completed' | 'skipped' | 'failed'

export interface CortexConsolidationRunRecord {
  runId: string
  trigger: CortexConsolidationTrigger
  status: CortexConsolidationStatus
  requestedAt: string
  completedAt: string | null
  merged: number
  archived: number
  superseded: number
  reindexedScopes: KnowledgeEntryScope[]
  changelog: CortexChangelogEntry[]
  skippedReason?: string | null
  error?: string | null
}

export interface CortexConsolidationSnapshot {
  lastRun: CortexConsolidationRunRecord | null
  nextTrigger: {
    thresholdNewOrUpdatedEntries: number
    dailyCadenceHours: number
  }
  promotionQueue: Array<{
    id: string
    title: string
    profileScopes: string[]
    supportCount: number
  }>
}

export interface CortexIndexResponse {
  indexes: CortexKnowledgeIndex[]
  settings: KnowledgeV2Settings
}

export interface CortexEntriesResponse {
  entries: CortexKnowledgeEntry[]
}

export interface CortexEntryResponse {
  entry: CortexKnowledgeEntry
}

export interface CortexChangelogResponse {
  changelog: CortexChangelogEntry[]
}

export interface CortexConsolidationResponse {
  consolidation: CortexConsolidationSnapshot
  runs: CortexConsolidationRunRecord[]
}
