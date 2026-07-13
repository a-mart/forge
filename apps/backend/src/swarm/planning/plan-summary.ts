import type { PlanStep } from '@forge/protocol'
import type { SessionPlanState } from './session-plan-state.js'

export function shouldCreateCompletedPlanSummary(
  current: SessionPlanState,
  nextPlan: readonly PlanStep[],
): boolean {
  if (current.plan.length === 0 || !current.plan.every((step) => step.status === 'completed')) {
    return false
  }

  if (current.plan.length !== nextPlan.length) return true
  return current.plan.some((step, index) => {
    const next = nextPlan[index]
    return !next || step.step !== next.step || step.status !== next.status
  })
}
