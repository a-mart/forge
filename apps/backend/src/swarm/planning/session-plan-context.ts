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
    ...(snapshot.coordinationMode ? { coordinationMode: snapshot.coordinationMode } : {}),
    ...(snapshot.workGraph ? {
      workGraph: {
        maxConcurrency: snapshot.workGraph.maxConcurrency,
        nodes: snapshot.workGraph.nodes.map((node) => {
          const latestAttempt = node.attempts[node.attempts.length - 1]
          return {
            id: node.id,
            title: node.title,
            task: truncateContextText(node.task, 800),
            kind: node.kind,
            status: node.status,
            dependsOn: node.dependsOn,
            ...(node.acceptanceCriteria
              ? { acceptanceCriteria: truncateContextText(node.acceptanceCriteria, 300) }
              : {}),
            route: node.route,
            ...(node.effort ? { legacyEffort: node.effort } : {}),
            ...(latestAttempt ? {
              latestAttempt: {
                number: latestAttempt.number,
                status: latestAttempt.status,
                ...(latestAttempt.workerId ? { workerId: latestAttempt.workerId } : {}),
                behaviorMode: latestAttempt.behaviorMode,
                ...(latestAttempt.requestedRoute
                  ? { requestedRoute: latestAttempt.requestedRoute }
                  : {}),
                ...(latestAttempt.resolvedRouteId
                  ? { resolvedRouteId: latestAttempt.resolvedRouteId }
                  : {}),
                ...(latestAttempt.resolvedRouteLabel
                  ? { resolvedRouteLabel: latestAttempt.resolvedRouteLabel }
                  : {}),
                ...(latestAttempt.rosterId ? { rosterId: latestAttempt.rosterId } : {}),
                ...(latestAttempt.rosterRevision
                  ? { rosterRevision: latestAttempt.rosterRevision }
                  : {}),
                ...(latestAttempt.model ? { model: latestAttempt.model } : {}),
                ...(latestAttempt.executionPolicy
                  ? { legacyExecutionPolicy: latestAttempt.executionPolicy }
                  : {}),
                ...(latestAttempt.summary
                  ? { summary: truncateContextText(latestAttempt.summary, 600) }
                  : {}),
              },
            } : {}),
          }
        }),
      },
    } : {}),
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

function truncateContextText(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  return `${value.slice(0, maximum - 1).trimEnd()}…`
}
