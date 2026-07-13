import { PLAN_STEP_STATUSES, type PlanStep, type SessionPlanSnapshot } from '@forge/protocol'

export const SESSION_PLAN_SCHEMA_VERSION = 1
export const MAX_PLAN_STEPS = 20
export const MAX_PLAN_STEP_LENGTH = 500
export const MAX_PLAN_EXPLANATION_LENGTH = 2_000

export interface SessionPlanState extends SessionPlanSnapshot {
  schemaVersion: typeof SESSION_PLAN_SCHEMA_VERSION
}

export class SessionPlanValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionPlanValidationError'
  }
}

export function createEmptySessionPlanState(): SessionPlanState {
  return {
    schemaVersion: SESSION_PLAN_SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    plan: [],
  }
}

export function normalizeSessionPlanInput(value: unknown): {
  explanation?: string
  plan: PlanStep[]
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionPlanValidationError('update_plan input must be an object.')
  }

  const input = value as { explanation?: unknown; plan?: unknown }
  const explanation = normalizeOptionalText(
    input.explanation,
    'explanation',
    MAX_PLAN_EXPLANATION_LENGTH,
  )
  if (!Array.isArray(input.plan)) {
    throw new SessionPlanValidationError('plan must be an array.')
  }
  if (input.plan.length > MAX_PLAN_STEPS) {
    throw new SessionPlanValidationError(`plan must contain at most ${MAX_PLAN_STEPS} steps.`)
  }

  const plan = input.plan.map((step, index) => normalizePlanStep(step, index))

  return {
    ...(explanation ? { explanation } : {}),
    plan,
  }
}

export function normalizeSessionPlanState(value: unknown): SessionPlanState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionPlanValidationError('Session plan state must be an object.')
  }

  const state = value as Partial<SessionPlanState>
  if (state.schemaVersion !== SESSION_PLAN_SCHEMA_VERSION) {
    throw new SessionPlanValidationError(
      `Unsupported session plan schema version: ${String(state.schemaVersion)}.`,
    )
  }
  const revision = state.revision
  if (!Number.isInteger(revision) || (revision ?? -1) < 0) {
    throw new SessionPlanValidationError('revision must be a non-negative integer.')
  }
  if (typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))) {
    throw new SessionPlanValidationError('updatedAt must be an ISO timestamp.')
  }

  const normalized = normalizeSessionPlanInput({
    explanation: state.explanation,
    plan: state.plan,
  })
  return {
    schemaVersion: SESSION_PLAN_SCHEMA_VERSION,
    revision: revision as number,
    updatedAt: state.updatedAt,
    ...normalized,
  }
}

function normalizePlanStep(value: unknown, index: number): PlanStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionPlanValidationError(`plan[${index}] must be an object.`)
  }

  const item = value as { step?: unknown; status?: unknown }
  const step = normalizeRequiredText(item.step, `plan[${index}].step`, MAX_PLAN_STEP_LENGTH)
  if (
    typeof item.status !== 'string'
    || !PLAN_STEP_STATUSES.includes(item.status as PlanStep['status'])
  ) {
    throw new SessionPlanValidationError(
      `plan[${index}].status must be one of: ${PLAN_STEP_STATUSES.join(', ')}.`,
    )
  }

  return { step, status: item.status as PlanStep['status'] }
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SessionPlanValidationError(`${field} must be a non-empty string.`)
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new SessionPlanValidationError(`${field} must be at most ${maxLength} characters.`)
  }
  return normalized
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return normalizeRequiredText(value, field, maxLength)
}
