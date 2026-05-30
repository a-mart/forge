export const WORK_PLAN_STATUSES = [
  'active',
  'blocked',
  'needs_attention',
  'stopped',
  'completed',
  'completed_with_warnings',
  'failed',
  'interrupted',
] as const

export type WorkPlanStatus = (typeof WORK_PLAN_STATUSES)[number]

export const WORK_PLAN_MUTABLE_STATUSES = ['active', 'blocked', 'needs_attention'] as const
export type WorkPlanMutableStatus = (typeof WORK_PLAN_MUTABLE_STATUSES)[number]

export const WORK_PLAN_TERMINAL_STATUSES = [
  'completed',
  'completed_with_warnings',
  'failed',
  'stopped',
  'interrupted',
] as const
export type WorkPlanTerminalStatus = (typeof WORK_PLAN_TERMINAL_STATUSES)[number]

export const WORK_PLAN_ITEM_STATUSES = [
  'todo',
  'up_next',
  'active',
  'blocked',
  'needs_attention',
  'done',
  'skipped',
  'failed',
  'unknown',
] as const
export type WorkPlanItemStatus = (typeof WORK_PLAN_ITEM_STATUSES)[number]

export const WORK_PLAN_ITEM_RESULT_STATUSES = [
  'done',
  'partial',
  'failed',
  'skipped',
  'unknown',
] as const
export type WorkPlanItemResultStatus = (typeof WORK_PLAN_ITEM_RESULT_STATUSES)[number]

export const WORK_PLAN_MODES = ['quick', 'standard', 'deep'] as const
export type WorkPlanMode = (typeof WORK_PLAN_MODES)[number]

export const WORK_PLAN_LIFECYCLE_REASONS = ['manual_stop', 'archived', 'conversation_cleared'] as const
export type WorkPlanLifecycleReason = (typeof WORK_PLAN_LIFECYCLE_REASONS)[number]

export const WORK_PLAN_LINK_TYPES = ['worker'] as const
export type WorkPlanLinkType = (typeof WORK_PLAN_LINK_TYPES)[number]

export const SESSION_TASK_DIAGNOSTIC_STATES = [
  'ok',
  'defaulted',
  'corrupt_recovered',
  'unavailable',
] as const
export type SessionTaskDiagnosticState = (typeof SESSION_TASK_DIAGNOSTIC_STATES)[number]

export const MAX_RECENT_WORK_PLAN_SNAPSHOTS = 5

export interface WorkPlanBlockerSnapshot {
  reason: string
  needsUser?: boolean
}

export interface WorkPlanItemResultSnapshot {
  summary: string
  status: WorkPlanItemResultStatus
}

export interface WorkPlanWorkerLinkSnapshot {
  type: 'worker'
  linkId: string
  agentId: string
  label?: string
  specialistId?: string
  linkedAt: string
}

export interface WorkPlanItemSnapshot {
  itemId: string
  title: string
  phase?: string
  status: WorkPlanItemStatus
  note?: string
  blocker?: WorkPlanBlockerSnapshot
  result?: WorkPlanItemResultSnapshot
  workerLinks: WorkPlanWorkerLinkSnapshot[]
  workerLinkCount: number
  workerLinksTruncated: boolean
}

export interface WorkPlanRevisionNoteSnapshot {
  revision: number
  note: string
  createdAt: string
}

export interface WorkPlanLifecycleSnapshot {
  reason: WorkPlanLifecycleReason
  changedAt: string
}

export interface WorkPlanSnapshot {
  planId: string
  title: string
  goal?: string
  mode?: WorkPlanMode
  status: WorkPlanStatus
  createdAt: string
  updatedAt: string
  completedAt?: string
  revision: number
  items: WorkPlanItemSnapshot[]
  itemCount: number
  itemsTruncated: boolean
  latestRevisionNote?: WorkPlanRevisionNoteSnapshot
  warnings: string[]
  warningCount: number
  warningsTruncated: boolean
  finalSummary?: string
  lifecycle?: WorkPlanLifecycleSnapshot
}

export interface SessionTaskStateDiagnostics {
  state: SessionTaskDiagnosticState
  message?: string
}

export interface SessionTaskStateSnapshot {
  sessionAgentId: string
  profileId: string
  revision: number
  activeWorkPlan: WorkPlanSnapshot | null
  recentWorkPlans: WorkPlanSnapshot[]
  recentWorkPlanCount: number
  recentWorkPlansTruncated: boolean
  diagnostics?: SessionTaskStateDiagnostics
}

export interface SessionTaskStateSnapshotEvent extends SessionTaskStateSnapshot {
  type: 'session_task_state_snapshot'
  requestId?: string
}
