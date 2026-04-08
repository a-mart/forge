import type { CortexReviewRunScope, CortexReviewRunTrigger } from './cortex-review.js'

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
  surface: 'knowledge' | 'memory' | 'reference' | 'prompt'
  absolutePath: string
  gitPath: string
  profileId?: string
  exists: boolean
  sizeBytes: number
  editable: boolean
}

export interface CortexFileReviewHistoryEntry {
  reviewId?: string
  recordedAt: string
  status: 'success' | 'no-op' | 'blocked' | 'failed'
  changedFiles: string[]
  notes: string[]
  blockers: string[]
  watermarksAdvanced: boolean
  trigger?: CortexReviewRunTrigger
  scope?: CortexReviewRunScope
  scopeLabel?: string
  sessionAgentId?: string | null
  scheduleName?: string | null
  manifestPath?: string
  manifestExists: boolean
}

export interface CortexFileReviewHistoryResult {
  file: string
  runs: CortexFileReviewHistoryEntry[]
  latestRun: CortexFileReviewHistoryEntry | null
}
