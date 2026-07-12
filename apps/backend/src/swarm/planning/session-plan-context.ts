import type { SessionPlanSnapshot } from '@forge/protocol'

export const WORKING_PLAN_CONTEXT_MARKER = '[workingPlan]'

/**
 * Runtime-only context appended to manager-bound turns. Repeating the latest
 * bounded snapshot makes plan state recoverable after compaction or runtime
 * replacement without adding another model tool.
 */
export function formatSessionPlanModelContext(snapshot: SessionPlanSnapshot): string {
  return `${WORKING_PLAN_CONTEXT_MARKER} ${JSON.stringify({
    revision: snapshot.revision,
    ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
    plan: snapshot.plan,
  })}`
}

export function appendSessionPlanCompactionInstructions(
  existingInstructions: string | undefined,
  snapshot: SessionPlanSnapshot,
): string | undefined {
  const existing = existingInstructions?.trim() || undefined
  if (snapshot.revision === 0 && snapshot.plan.length === 0 && !snapshot.explanation) {
    return existing
  }
  if (existing?.includes(WORKING_PLAN_CONTEXT_MARKER)) {
    return existing
  }

  const planInstructions = [
    'Preserve the following authoritative working-plan state in the compaction summary. Keep every step and status; an empty plan means there are no current steps:',
    '',
    formatSessionPlanModelContext(snapshot),
  ].join('\n')
  return existing ? `${existing}\n\n${planInstructions}` : planInstructions
}
