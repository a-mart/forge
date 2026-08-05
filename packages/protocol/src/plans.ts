import type { AgentModelDescriptor } from './agents.js'
import type { DelegationBehaviorMode } from './delegation.js'

export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'completed'] as const

export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number]

export interface PlanStep {
  /** Stable within a working plan. Missing only on legacy persisted snapshots. */
  id?: string
  step: string
  status: PlanStepStatus
}

export const WORK_GRAPH_NODE_KINDS = [
  'task',
  'plan',
  'research',
  'implementation',
  'review',
  'design-review',
  'synthesis',
  'decision',
] as const

export type WorkGraphNodeKind = (typeof WORK_GRAPH_NODE_KINDS)[number]

export const WORK_GRAPH_NODE_STATUSES = [
  'pending',
  'running',
  'awaiting_review',
  'waiting',
  'blocked',
  'completed',
  'cancelled',
] as const

export type WorkGraphNodeStatus = (typeof WORK_GRAPH_NODE_STATUSES)[number]

export const WORK_GRAPH_EFFORTS = ['auto', 'support', 'routine', 'deep'] as const

export type WorkGraphEffort = (typeof WORK_GRAPH_EFFORTS)[number]

export const WORK_GRAPH_ATTEMPT_STATUSES = [
  'dispatching',
  'running',
  'succeeded',
  'blocked',
  'cancelled',
] as const

export type WorkGraphAttemptStatus = (typeof WORK_GRAPH_ATTEMPT_STATUSES)[number]

export interface WorkGraphAttempt {
  id: string
  number: number
  status: WorkGraphAttemptStatus
  startedAt: string
  completedAt?: string
  workerId?: string
  behaviorMode: DelegationBehaviorMode
  requestedRoute?: string
  resolvedRouteId?: string
  resolvedRouteLabel?: string
  rosterId?: string
  rosterRevision?: number
  model?: AgentModelDescriptor
  capabilityEscalationRouteId?: string
  /** @deprecated Retained only for persisted pre-roster attempts. */
  executionPolicy?: 'support' | 'routine' | 'deep'
  summary?: string
}

export interface WorkGraphNode {
  id: string
  title: string
  task: string
  kind: WorkGraphNodeKind
  status: WorkGraphNodeStatus
  /** Last authoritative status transition; absent on legacy graph nodes. */
  statusUpdatedAt?: string
  dependsOn: string[]
  acceptanceCriteria?: string
  /** Missing on persisted pre-roster graphs and treated as auto. */
  route?: string
  /** @deprecated Retained only for persisted pre-roster graphs. */
  effort?: WorkGraphEffort
  attempts: WorkGraphAttempt[]
}

export interface WorkGraphSnapshot {
  maxConcurrency: number
  nodes: WorkGraphNode[]
}

export interface SessionPlanSnapshot {
  revision: number
  updatedAt: string | null
  explanation?: string
  plan: PlanStep[]
  /** Missing on legacy snapshots and light plans. */
  coordinationMode?: 'plan' | 'graph'
  /** Present only when the working plan has been promoted into an executable graph. */
  workGraph?: WorkGraphSnapshot
}

export interface SessionPlanSnapshotEvent extends SessionPlanSnapshot {
  type: 'session_plan_snapshot'
  sessionAgentId: string
  profileId: string
  requestId?: string
}

/** Durable transcript card anchored when a plan starts and updated in place when it completes. */
export interface PlanSummaryEvent extends SessionPlanSnapshot {
  type: 'plan_summary'
  id: string
  agentId: string
  timestamp: string
  updatedAt: string
  /** Missing on legacy records and therefore treated as completed. */
  state?: 'active' | 'completed'
}

/**
 * Collapses revisions of the same plan card and repairs legacy/polluted histories
 * that contain more than one active anchor. Completed cards are boundaries, so
 * distinct historical completed plans remain intact.
 */
export function normalizePlanSummaryEntries<Entry extends { type: string }>(
  entries: readonly Entry[],
): Entry[] {
  const slots: Array<{ id: string; event: PlanSummaryEvent }> = []
  const slotById = new Map<string, number>()

  for (const entry of entries) {
    if (entry.type !== 'plan_summary') continue
    const event = entry as unknown as PlanSummaryEvent
    const existing = slotById.get(event.id)
    if (existing === undefined) {
      slotById.set(event.id, slots.length)
      slots.push({ id: event.id, event })
    } else {
      slots[existing] = { id: event.id, event }
    }
  }

  const supersededActiveIds = new Set<string>()
  let activeIds: string[] = []
  for (const slot of slots) {
    if (slot.event.state === 'active') {
      activeIds.push(slot.id)
      continue
    }

    for (const activeId of activeIds) supersededActiveIds.add(activeId)
    activeIds = []
  }
  for (const activeId of activeIds.slice(0, -1)) supersededActiveIds.add(activeId)

  const canonicalById = new Map(
    slots
      .filter((slot) => !supersededActiveIds.has(slot.id))
      .map((slot) => [slot.id, slot.event] as const),
  )
  const emittedIds = new Set<string>()
  const normalized: Entry[] = []
  for (const entry of entries) {
    if (entry.type !== 'plan_summary') {
      normalized.push(entry)
      continue
    }

    const event = entry as unknown as PlanSummaryEvent
    const canonical = canonicalById.get(event.id)
    if (!canonical || emittedIds.has(event.id)) continue
    emittedIds.add(event.id)
    normalized.push(canonical as unknown as Entry)
  }

  return normalized
}
