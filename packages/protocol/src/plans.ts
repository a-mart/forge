export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'completed'] as const

export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number]

export interface PlanStep {
  step: string
  status: PlanStepStatus
}

export interface SessionPlanSnapshot {
  revision: number
  updatedAt: string | null
  explanation?: string
  plan: PlanStep[]
}

export interface SessionPlanSnapshotEvent extends SessionPlanSnapshot {
  type: 'session_plan_snapshot'
  sessionAgentId: string
  profileId: string
  requestId?: string
}

/** Durable transcript card anchored when a plan starts and updated in place when it completes. */
export interface PlanSummaryEvent extends SessionPlanSnapshot {
  type: 'plan_summary'
  id: string
  agentId: string
  timestamp: string
  updatedAt: string
  /** Missing on legacy records and therefore treated as completed. */
  state?: 'active' | 'completed'
}
