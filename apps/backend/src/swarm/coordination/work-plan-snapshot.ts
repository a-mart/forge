import {
  MAX_RECENT_WORK_PLAN_SNAPSHOTS,
  type SessionTaskStateSnapshot,
  type SessionTaskStateDiagnostics,
  type WorkPlanSnapshot,
  type WorkPlanStatus,
} from '@forge/protocol'
import type {
  SessionCoordinationState,
  WorkPlanItem,
  WorkPlanRecord,
  WorkPlanWorkerLink,
} from './session-coordination-state.js'
import { sanitizeWorkPlanText } from './work-plan-text-safety.js'

export { REDACTED_WORK_PLAN_TEXT } from './work-plan-text-safety.js'

export const MAX_WORK_PLAN_ITEM_SNAPSHOTS = 12
export const MAX_WORK_PLAN_WORKER_LINK_SNAPSHOTS = 4
export const MAX_WORK_PLAN_WARNING_SNAPSHOTS = 4

const NON_TERMINAL_WORK_PLAN_STATUSES: ReadonlySet<WorkPlanStatus> = new Set([
  'active',
  'blocked',
  'needs_attention',
])

export function findNonTerminalWorkPlanRecords(state: SessionCoordinationState): WorkPlanRecord[] {
  return state.workPlans.filter((plan) => NON_TERMINAL_WORK_PLAN_STATUSES.has(plan.status))
}

export function hasNonTerminalWorkPlanConflict(state: SessionCoordinationState): boolean {
  return findNonTerminalWorkPlanRecords(state).length > 1
}

export function findActiveWorkPlanRecord(state: SessionCoordinationState): WorkPlanRecord | null {
  const activePlans = findNonTerminalWorkPlanRecords(state)
  if (activePlans.length !== 1) {
    return null
  }

  return activePlans[0] ?? null
}

export function findRecentTerminalWorkPlanRecords(state: SessionCoordinationState): WorkPlanRecord[] {
  return state.workPlans
    .filter((plan) => !NON_TERMINAL_WORK_PLAN_STATUSES.has(plan.status))
    .sort(comparePlansByMostRecent)
}

export function findWorkPlanRecordById(
  state: SessionCoordinationState,
  planId: string,
): WorkPlanRecord | null {
  return state.workPlans.find((plan) => plan.planId === planId) ?? null
}

export function projectWorkPlanSnapshot(plan: WorkPlanRecord): WorkPlanSnapshot {
  const items = projectItems(plan.items)
  const warnings = plan.warnings.slice(0, MAX_WORK_PLAN_WARNING_SNAPSHOTS).map((warning) => sanitizeWorkPlanText(warning))

  return {
    planId: plan.planId,
    title: sanitizeWorkPlanText(plan.title),
    ...(plan.goal ? { goal: sanitizeWorkPlanText(plan.goal) } : {}),
    ...(plan.mode ? { mode: plan.mode } : {}),
    status: plan.status,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    ...(plan.completedAt ? { completedAt: plan.completedAt } : {}),
    revision: plan.revision,
    items,
    itemCount: plan.items.length,
    itemsTruncated: plan.items.length > items.length,
    ...(plan.revisionNotes.length > 0
      ? {
          latestRevisionNote: {
            revision: plan.revisionNotes[plan.revisionNotes.length - 1]!.revision,
            note: sanitizeWorkPlanText(plan.revisionNotes[plan.revisionNotes.length - 1]!.note),
            createdAt: plan.revisionNotes[plan.revisionNotes.length - 1]!.createdAt,
          },
        }
      : {}),
    warnings,
    warningCount: plan.warnings.length,
    warningsTruncated: plan.warnings.length > warnings.length,
    ...(plan.finalSummary ? { finalSummary: sanitizeWorkPlanText(plan.finalSummary) } : {}),
    ...(plan.lifecycle ? { lifecycle: { ...plan.lifecycle } } : {}),
  }
}

export function projectSessionTaskStateSnapshot(params: {
  state: SessionCoordinationState
  diagnostics?: SessionTaskStateDiagnostics
  profileId: string
  sessionAgentId: string
}): SessionTaskStateSnapshot {
  const activeConflict = hasNonTerminalWorkPlanConflict(params.state)
  const activeWorkPlan = activeConflict ? null : findActiveWorkPlanRecord(params.state)
  const recentRecords = findRecentTerminalWorkPlanRecords(params.state)
  const recentWorkPlans = recentRecords.slice(0, MAX_RECENT_WORK_PLAN_SNAPSHOTS).map((plan) => projectWorkPlanSnapshot(plan))

  return {
    sessionAgentId: params.sessionAgentId,
    profileId: params.profileId,
    revision: params.state.revision,
    activeWorkPlan: activeWorkPlan ? projectWorkPlanSnapshot(activeWorkPlan) : null,
    recentWorkPlans,
    recentWorkPlanCount: recentRecords.length,
    recentWorkPlansTruncated: recentRecords.length > recentWorkPlans.length,
    ...(resolveSnapshotDiagnostics(params.diagnostics, activeConflict) ? { diagnostics: resolveSnapshotDiagnostics(params.diagnostics, activeConflict)! } : {}),
  }
}

function projectItems(items: WorkPlanItem[]): WorkPlanSnapshot['items'] {
  return items.slice(0, MAX_WORK_PLAN_ITEM_SNAPSHOTS).map((item) => {
    const workerLinks = projectWorkerLinks(item.workerLinks)
    return {
      itemId: item.itemId,
      title: sanitizeWorkPlanText(item.title),
      ...(item.phase ? { phase: sanitizeWorkPlanText(item.phase) } : {}),
      status: item.status,
      ...(item.note ? { note: sanitizeWorkPlanText(item.note) } : {}),
      ...(item.blocker ? { blocker: { reason: sanitizeWorkPlanText(item.blocker.reason), ...(item.blocker.needsUser === undefined ? {} : { needsUser: item.blocker.needsUser }) } } : {}),
      ...(item.result ? { result: { summary: sanitizeWorkPlanText(item.result.summary), status: item.result.status } } : {}),
      workerLinks,
      workerLinkCount: item.workerLinks.length,
      workerLinksTruncated: item.workerLinks.length > workerLinks.length,
    }
  })
}

function projectWorkerLinks(workerLinks: WorkPlanWorkerLink[]): WorkPlanSnapshot['items'][number]['workerLinks'] {
  return workerLinks.slice(0, MAX_WORK_PLAN_WORKER_LINK_SNAPSHOTS).map((link) => ({
    type: link.type,
    linkId: link.linkId,
    agentId: link.agentId,
    ...(link.label ? { label: sanitizeWorkPlanText(link.label) } : {}),
    ...(link.specialistId ? { specialistId: sanitizeWorkPlanText(link.specialistId) } : {}),
    linkedAt: link.linkedAt,
  }))
}

function resolveSnapshotDiagnostics(
  diagnostics: SessionTaskStateDiagnostics | undefined,
  activeConflict: boolean,
): SessionTaskStateDiagnostics | undefined {
  if (activeConflict) {
    return {
      state: 'unavailable',
      message: 'Session coordination state is inconsistent.',
    }
  }

  return diagnostics
}

function comparePlansByMostRecent(left: WorkPlanRecord, right: WorkPlanRecord): number {
  const leftTime = Date.parse(left.completedAt ?? left.updatedAt)
  const rightTime = Date.parse(right.completedAt ?? right.updatedAt)
  const timeDiff = rightTime - leftTime
  if (Number.isFinite(timeDiff) && timeDiff !== 0) {
    return timeDiff
  }

  return right.planId.localeCompare(left.planId)
}
