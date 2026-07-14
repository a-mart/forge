import type { TokenUsageTotals } from './stats-types.js'

export const SESSION_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'completed',
  'cancelled',
] as const

export type SessionGoalStatus = (typeof SESSION_GOAL_STATUSES)[number]

export type SessionGoalPauseReason = 'user' | 'token_budget_exhausted'

export interface SessionGoal {
  id: string
  objective: string
  status: SessionGoalStatus
  createdAt: string
  updatedAt: string
  endedAt?: string
  tokenBudget?: number
  pauseReason?: SessionGoalPauseReason
  activeElapsedMs: number
  turnCount: number
  usage: TokenUsageTotals
  usageCoverage: 'complete' | 'partial'
  remainingTokens?: number
}

export interface SessionGoalSnapshot {
  revision: number
  measuredAt: string
  goal: SessionGoal | null
}

export interface SessionGoalSnapshotEvent extends SessionGoalSnapshot {
  type: 'session_goal_snapshot'
  sessionAgentId: string
  profileId: string
}

export type SessionGoalControlAction =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'cancel' }
  | { action: 'edit'; objective: string; tokenBudget?: number | null }
