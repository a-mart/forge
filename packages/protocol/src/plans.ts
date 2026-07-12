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
