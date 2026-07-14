import type { SessionGoalPauseReason, SessionGoalStatus, TokenUsageTotals } from '@forge/protocol'

export const MAX_GOAL_OBJECTIVE_LENGTH = 1_000
export const MAX_GOAL_TOKEN_BUDGET = 100_000_000
export const MIN_BLOCKED_GOAL_TURNS = 3

export interface StoredSessionGoal {
  id: string
  objective: string
  status: SessionGoalStatus
  createdAt: string
  updatedAt: string
  endedAt?: string
  tokenBudget?: number
  pauseReason?: SessionGoalPauseReason
  activeElapsedMs: number
  activeSince?: string
  turnCount: number
  blockedAuditStartTurn?: number
  finalUsage?: TokenUsageTotals
  finalUsageCoverage?: 'complete' | 'partial'
}

export interface SessionGoalState {
  schemaVersion: 1
  revision: number
  updatedAt: string | null
  goal: StoredSessionGoal | null
}

export class SessionGoalValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionGoalValidationError'
  }
}

export function createEmptySessionGoalState(): SessionGoalState {
  return { schemaVersion: 1, revision: 0, updatedAt: null, goal: null }
}

export function normalizeGoalObjective(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SessionGoalValidationError('Goal objective must be a string.')
  }
  const objective = value.trim()
  if (!objective) {
    throw new SessionGoalValidationError('Goal objective must not be empty.')
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    throw new SessionGoalValidationError(
      `Goal objective must be ${MAX_GOAL_OBJECTIVE_LENGTH} characters or fewer.`,
    )
  }
  return objective
}

export function normalizeGoalTokenBudget(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > MAX_GOAL_TOKEN_BUDGET) {
    throw new SessionGoalValidationError(
      `Goal token budget must be a positive integer no greater than ${MAX_GOAL_TOKEN_BUDGET}.`,
    )
  }
  return value as number
}

export function normalizeSessionGoalState(value: unknown): SessionGoalState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new SessionGoalValidationError('Goal state has an unsupported schema version.')
  }
  if (!isNonNegativeInteger(value.revision)) {
    throw new SessionGoalValidationError('Goal revision must be a non-negative integer.')
  }
  if (value.updatedAt !== null && typeof value.updatedAt !== 'string') {
    throw new SessionGoalValidationError('Goal updatedAt must be a timestamp or null.')
  }
  if (value.goal === null) {
    return {
      schemaVersion: 1,
      revision: value.revision,
      updatedAt: value.updatedAt,
      goal: null,
    }
  }
  if (!isRecord(value.goal)) {
    throw new SessionGoalValidationError('Goal state must contain a goal object or null.')
  }

  const goal = value.goal
  if (typeof goal.id !== 'string' || !goal.id.trim()) {
    throw new SessionGoalValidationError('Goal id must be a non-empty string.')
  }
  const status = normalizeStatus(goal.status)
  const createdAt = requireTimestamp(goal.createdAt, 'createdAt')
  const updatedAt = requireTimestamp(goal.updatedAt, 'updatedAt')
  const activeElapsedMs = normalizeNonNegativeInteger(goal.activeElapsedMs, 'activeElapsedMs')
  const turnCount = normalizeNonNegativeInteger(goal.turnCount, 'turnCount')
  const blockedAuditStartTurn = goal.blockedAuditStartTurn === undefined
    ? undefined
    : normalizeNonNegativeInteger(goal.blockedAuditStartTurn, 'blockedAuditStartTurn')
  const activeSince = goal.activeSince === undefined
    ? undefined
    : requireTimestamp(goal.activeSince, 'activeSince')
  const endedAt = goal.endedAt === undefined
    ? undefined
    : requireTimestamp(goal.endedAt, 'endedAt')
  const pauseReason = goal.pauseReason === undefined
    ? undefined
    : normalizePauseReason(goal.pauseReason)
  const tokenBudget = goal.tokenBudget === undefined
    ? undefined
    : normalizeGoalTokenBudget(goal.tokenBudget)
  const finalUsage = goal.finalUsage === undefined
    ? undefined
    : normalizeUsage(goal.finalUsage)
  const finalUsageCoverage = goal.finalUsageCoverage === undefined
    ? undefined
    : normalizeCoverage(goal.finalUsageCoverage)
  if (status === 'active' && !activeSince) {
    throw new SessionGoalValidationError('An active goal must have activeSince.')
  }
  if (status !== 'active' && activeSince) {
    throw new SessionGoalValidationError('Only an active goal may have activeSince.')
  }
  const terminal = status === 'completed' || status === 'cancelled'
  if (terminal !== Boolean(endedAt)) {
    throw new SessionGoalValidationError('Only completed or cancelled goals must have endedAt.')
  }
  if ((status === 'paused') !== Boolean(pauseReason)) {
    throw new SessionGoalValidationError('Only a paused goal must have a pause reason.')
  }
  if (goal.tokenBudget !== undefined && tokenBudget === undefined) {
    throw new SessionGoalValidationError('Stored goal token budget must not be null.')
  }
  if (Boolean(finalUsage) !== Boolean(finalUsageCoverage)) {
    throw new SessionGoalValidationError('Final goal usage and coverage must be stored together.')
  }
  if (!terminal && finalUsage) {
    throw new SessionGoalValidationError('Only a completed or cancelled goal may have final usage.')
  }
  if (blockedAuditStartTurn !== undefined && blockedAuditStartTurn > turnCount) {
    throw new SessionGoalValidationError('Goal blockedAuditStartTurn must not exceed turnCount.')
  }

  return {
    schemaVersion: 1,
    revision: value.revision,
    updatedAt: value.updatedAt,
    goal: {
      id: goal.id.trim(),
      objective: normalizeGoalObjective(goal.objective),
      status,
      createdAt,
      updatedAt,
      ...(endedAt ? { endedAt } : {}),
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      ...(pauseReason ? { pauseReason } : {}),
      activeElapsedMs,
      ...(activeSince ? { activeSince } : {}),
      turnCount,
      ...(blockedAuditStartTurn === undefined ? {} : { blockedAuditStartTurn }),
      ...(finalUsage ? { finalUsage } : {}),
      ...(finalUsageCoverage ? { finalUsageCoverage } : {}),
    },
  }
}

export function isUnfinishedGoalStatus(status: SessionGoalStatus): boolean {
  return status === 'active' || status === 'paused' || status === 'blocked'
}

export function closeActiveElapsed(goal: StoredSessionGoal, now: string): number {
  if (!goal.activeSince) return goal.activeElapsedMs
  const delta = Math.max(0, Date.parse(now) - Date.parse(goal.activeSince))
  return goal.activeElapsedMs + delta
}

function normalizeStatus(value: unknown): SessionGoalStatus {
  if (
    value === 'active'
    || value === 'paused'
    || value === 'blocked'
    || value === 'completed'
    || value === 'cancelled'
  ) return value
  throw new SessionGoalValidationError('Goal status is invalid.')
}

function normalizePauseReason(value: unknown): SessionGoalPauseReason {
  if (value === 'user' || value === 'token_budget_exhausted') return value
  throw new SessionGoalValidationError('Goal pause reason is invalid.')
}

function normalizeCoverage(value: unknown): 'complete' | 'partial' {
  if (value === 'complete' || value === 'partial') return value
  throw new SessionGoalValidationError('Goal usage coverage is invalid.')
}

function normalizeUsage(value: unknown): TokenUsageTotals {
  if (!isRecord(value)) throw new SessionGoalValidationError('Goal usage must be an object.')
  return {
    input: normalizeNonNegativeInteger(value.input, 'usage.input'),
    output: normalizeNonNegativeInteger(value.output, 'usage.output'),
    cacheRead: normalizeNonNegativeInteger(value.cacheRead, 'usage.cacheRead'),
    cacheWrite: normalizeNonNegativeInteger(value.cacheWrite, 'usage.cacheWrite'),
    total: normalizeNonNegativeInteger(value.total, 'usage.total'),
  }
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new SessionGoalValidationError(`Goal ${field} must be a valid timestamp.`)
  }
  return value
}

function normalizeNonNegativeInteger(value: unknown, field: string): number {
  if (!isNonNegativeInteger(value)) {
    throw new SessionGoalValidationError(`Goal ${field} must be a non-negative integer.`)
  }
  return value
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
