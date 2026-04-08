export type SessionMemoryMergeStatus = 'applied' | 'skipped'
export type SessionMemoryMergeAttemptStatus = SessionMemoryMergeStatus | 'failed'
export type SessionMemoryMergeStrategy =
  | 'llm'
  | 'seed'
  | 'template_noop'
  | 'idempotent_noop'
  | 'no_change'
export type SessionMemoryMergeFailureStage =
  | 'prepare'
  | 'read_inputs'
  | 'llm'
  | 'write_profile_memory'
  | 'refresh_session_meta_stats'
  | 'record_attempt'
  | 'write_audit'
  | 'save_store'

export interface SessionMemoryMergeResult {
  agentId: string
  status: SessionMemoryMergeStatus
  strategy: SessionMemoryMergeStrategy
  mergedAt?: string
  auditPath: string
}

export interface SessionWorkerMeta {
  id: string
  model: string | null
  specialistId?: string | null
  specialistAttributionKnown?: boolean
  status: 'idle' | 'streaming' | 'terminated'
  createdAt: string
  terminatedAt: string | null
  tokens: {
    input: number | null
    output: number | null
  }
  systemPrompt?: string | null
}

export interface SessionMeta {
  sessionId: string
  profileId: string
  label: string | null
  compactionCount?: number
  model: {
    provider: string | null
    modelId: string | null
  }
  createdAt: string
  updatedAt: string
  cwd: string | null
  resolvedSystemPrompt?: string | null

  promptFingerprint: string | null
  promptComponents:
    | {
        archetype: string | null
        agentsFile: string | null
        skills: string[]
        memoryFile: string | null
        profileMemoryFile: string | null
      }
    | null

  workers: SessionWorkerMeta[]

  cortexReviewedAt?: string
  cortexReviewedBytes?: number
  cortexReviewExcludedAt?: string | null
  cortexReviewedMemoryBytes?: number
  cortexReviewedMemoryAt?: string | null
  feedbackFileSize?: string | null
  lastFeedbackAt?: string | null
  cortexReviewedFeedbackBytes?: number
  cortexReviewedFeedbackAt?: string | null
  memoryMergeAttemptCount?: number
  lastMemoryMergeAttemptId?: string | null
  lastMemoryMergeAttemptAt?: string | null
  lastMemoryMergeAppliedAt?: string | null
  lastMemoryMergeStatus?: SessionMemoryMergeAttemptStatus | null
  lastMemoryMergeStrategy?: SessionMemoryMergeStrategy | null
  lastMemoryMergeFailureStage?: SessionMemoryMergeFailureStage | null
  lastMemoryMergeSourceHash?: string | null
  lastMemoryMergeProfileHashBefore?: string | null
  lastMemoryMergeProfileHashAfter?: string | null
  lastMemoryMergeAppliedSourceHash?: string | null
  lastMemoryMergeError?: string | null

  stats: {
    totalWorkers: number
    activeWorkers: number
    totalTokens: {
      input: number | null
      output: number | null
    }
    sessionFileSize: string | null
    memoryFileSize: string | null
  }
}
