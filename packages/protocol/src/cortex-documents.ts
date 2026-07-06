export type CortexDocumentGroup =
  | 'commonKnowledge'
  | 'profileMemory'
  | 'referenceDocs'
  | 'promptOverrides'
  | 'notes'

export interface CortexDocumentEntry {
  id: string
  label: string
  description: string
  group: CortexDocumentGroup
  surface: 'knowledge' | 'memory' | 'reference' | 'prompt' | 'entry' | 'index'
  absolutePath: string
  gitPath: string
  profileId?: string
  exists: boolean
  sizeBytes: number
  editable: boolean
}

export interface CortexFileReviewHistoryEntry {
  reviewId?: string
  runId?: string
  recordedAt: string
  action?: 'added' | 'merged' | 'archived' | 'superseded' | 'reindexed'
  entryId?: string
  why?: string
  status?: 'success' | 'partial' | 'failed'
  trigger?: 'manual' | 'scheduled' | 'boot_recovery'
  scopeLabel?: string
  sessionAgentId?: string | null
  scheduleName?: string
  changedFiles: string[]
  notes: string[]
  blockers: string[]
  watermarksAdvanced: boolean
  manifestPath?: string
  manifestExists: boolean
}

export interface CortexFileReviewHistoryResult {
  file: string
  runs: CortexFileReviewHistoryEntry[]
  latestRun: CortexFileReviewHistoryEntry | null
}
