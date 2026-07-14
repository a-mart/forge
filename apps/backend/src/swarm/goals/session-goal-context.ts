import type { SessionGoalSnapshot } from '@forge/protocol'

const ACTIVE_GOAL_CONTEXT_PREFIX = '[activeGoal] '

export function formatSessionGoalModelContext(snapshot: SessionGoalSnapshot): string | undefined {
  const goal = snapshot.goal
  if (!goal || goal.status === 'completed' || goal.status === 'cancelled') return undefined
  return `${ACTIVE_GOAL_CONTEXT_PREFIX}${JSON.stringify({
    revision: snapshot.revision,
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
    elapsedMs: goal.activeElapsedMs,
    turnCount: goal.turnCount,
    usage: goal.usage,
    ...(goal.remainingTokens === undefined ? {} : { remainingTokens: goal.remainingTokens }),
  })}`
}

export function appendSessionGoalCompactionInstructions(
  instructions: string | undefined,
  snapshot: SessionGoalSnapshot,
): string | undefined {
  const context = formatSessionGoalModelContext(snapshot)
  if (!context) return instructions
  const goalInstruction = [
    'Preserve this active goal across compaction. It remains authoritative until completed, blocked, paused, or cancelled.',
    context,
  ].join('\n')
  return instructions?.trim()
    ? `${instructions.trim()}\n\n${goalInstruction}`
    : goalInstruction
}
