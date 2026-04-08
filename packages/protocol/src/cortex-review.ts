export interface CortexAutoReviewSettings {
  enabled: boolean
  intervalMinutes: number
  updatedAt: string | null
}

export interface GetCortexAutoReviewSettingsResponse {
  settings: CortexAutoReviewSettings
}

export interface UpdateCortexAutoReviewSettingsRequest {
  enabled?: boolean
  intervalMinutes?: number
}

export interface UpdateCortexAutoReviewSettingsResponse {
  ok: true
  settings: CortexAutoReviewSettings
}

export type CortexReviewRunTrigger = 'manual' | 'scheduled'
export type CortexReviewRunStatus = 'queued' | 'running' | 'completed' | 'blocked' | 'stopped' | 'interrupted'
export type CortexReviewRunAxis = 'transcript' | 'memory' | 'feedback'
export type CortexReviewControlAction = 'exclude' | 'resume'

export type CortexReviewRunScope =
  | { mode: 'all' }
  | {
      mode: 'session'
      profileId: string
      sessionId: string
      axes?: CortexReviewRunAxis[]
    }

export interface CortexReviewRunRecord {
  runId: string
  trigger: CortexReviewRunTrigger
  scope: CortexReviewRunScope
  scopeLabel: string
  requestText: string
  requestedAt: string
  status: CortexReviewRunStatus
  sessionAgentId: string | null
  activeWorkerCount: number
  latestCloseout: string | null
  queuePosition?: number | null
  blockedReason?: string | null
  interruptedAt?: string | null
  interruptionReason?: string | null
  scheduleName?: string | null
}
