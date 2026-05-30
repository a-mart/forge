import type { AgentDescriptor, AgentStatus, SessionTaskStateSnapshotEvent, WorkPlanItemSnapshot, WorkPlanSnapshot, WorkPlanStatus } from '@forge/protocol'

export const ACTIVE_WORK_VISIBLE_ITEM_LIMIT = 5

export type WorkPlanSnapshotView = WorkPlanSnapshot

export type WorkPlanItemSnapshotView = WorkPlanItemSnapshot

export type SessionTaskStateSnapshotView = SessionTaskStateSnapshotEvent

const ATTENTION_ITEM_STATUSES = new Set(['blocked', 'needs_attention'])
const ACTIVE_ITEM_STATUSES = new Set(['active'])
const UP_NEXT_ITEM_STATUSES = new Set(['up_next'])
const PROBLEM_ITEM_STATUSES = new Set(['failed', 'unknown'])
const COMPLETE_ITEM_STATUSES = new Set(['done', 'skipped'])

export function toActiveWorkSnapshotView(
  snapshot: SessionTaskStateSnapshotEvent | null | undefined,
): SessionTaskStateSnapshotView | null {
  return snapshot ? (snapshot as SessionTaskStateSnapshotView) : null
}

export function hasActiveWork(snapshot: SessionTaskStateSnapshotEvent | null | undefined): boolean {
  const view = toActiveWorkSnapshotView(snapshot)
  if (!view) return false
  return Boolean(view.activeWorkPlan || view.recentWorkPlans.length > 0 || view.diagnostics?.state === 'corrupt_recovered' || view.diagnostics?.state === 'unavailable')
}

export function getDisplayPlan(snapshot: SessionTaskStateSnapshotEvent): WorkPlanSnapshotView | null {
  const view = toActiveWorkSnapshotView(snapshot)
  return view?.activeWorkPlan ?? view?.recentWorkPlans[0] ?? null
}

export function shouldEmphasizePlan(plan: WorkPlanSnapshotView | null): boolean {
  if (!plan) return false
  return ['blocked', 'needs_attention', 'failed', 'stopped', 'interrupted', 'completed_with_warnings'].includes(plan.status)
}

export function countDoneItems(plan: WorkPlanSnapshotView): number {
  return plan.items.filter((item) => item.status === 'done' || item.status === 'skipped').length
}

export function countAttentionItems(plan: WorkPlanSnapshotView): number {
  return plan.items.filter((item) => item.status === 'blocked' || item.status === 'needs_attention').length
}

export function formatPlanStatus(status: WorkPlanStatus): string {
  switch (status) {
    case 'active':
      return 'Active Work'
    case 'blocked':
      return 'Blocked'
    case 'needs_attention':
      return 'Needs attention'
    case 'stopped':
      return 'Stopped'
    case 'completed':
      return 'Completed'
    case 'completed_with_warnings':
      return 'Completed with warnings'
    case 'failed':
      return 'Failed'
    case 'interrupted':
      return 'Interrupted'
  }
}

export function getHeaderSummary(snapshot: SessionTaskStateSnapshotEvent | null | undefined): string | null {
  if (!snapshot) return null
  const plan = getDisplayPlan(snapshot)
  if (!plan) {
    if (snapshot.diagnostics?.state === 'corrupt_recovered') return 'Active Work unavailable'
    if (snapshot.diagnostics?.state === 'unavailable') return 'Active Work unavailable'
    return null
  }

  if (plan.status === 'completed') return 'Completed'
  if (plan.status === 'completed_with_warnings') return 'Completed with warnings'
  if (plan.status === 'failed') return 'Failed · review needed'
  if (plan.status === 'stopped') return 'Stopped · partial progress preserved'
  if (plan.status === 'interrupted') return 'Interrupted · historical'

  const attentionCount = countAttentionItems(plan)
  if (attentionCount > 0 || plan.status === 'blocked' || plan.status === 'needs_attention') {
    const hasBlockedItem = plan.items.some((item) => item.status === 'blocked')
    const attentionLabel = plan.status === 'blocked' || hasBlockedItem ? 'Blocked' : 'Needs attention'
    return `${attentionLabel} · ${attentionCount || 1} needs review`
  }

  const done = countDoneItems(plan)
  const total = plan.itemCount
  if (total > 0) return `${formatPlanStatus(plan.status)} · ${done}/${total}`
  return formatPlanStatus(plan.status)
}

function itemPriority(item: WorkPlanItemSnapshot): number {
  if (ATTENTION_ITEM_STATUSES.has(item.status)) return 0
  if (ACTIVE_ITEM_STATUSES.has(item.status)) return 1
  if (UP_NEXT_ITEM_STATUSES.has(item.status)) return 2
  if (PROBLEM_ITEM_STATUSES.has(item.status)) return 3
  if (!COMPLETE_ITEM_STATUSES.has(item.status)) return 4
  return 5
}

export function sortWorkPlanItems(items: WorkPlanItemSnapshotView[]): WorkPlanItemSnapshotView[] {
  return [...items].sort((a, b) => itemPriority(a) - itemPriority(b) || a.title.localeCompare(b.title))
}

export function resolveWorkerLabel(agentId: string, label: string | undefined, agents: AgentDescriptor[]): string {
  const agent = agents.find((candidate) => candidate.agentId === agentId)
  return agent?.displayName ?? label ?? 'Worker unavailable'
}

export function resolveWorkerStatus(agentId: string, statuses: Record<string, { status: AgentStatus }>, agents: AgentDescriptor[]): AgentStatus | 'unavailable' {
  return statuses[agentId]?.status ?? agents.find((candidate) => candidate.agentId === agentId)?.status ?? 'unavailable'
}
