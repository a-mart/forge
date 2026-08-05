import { randomUUID } from 'node:crypto'
import {
  normalizePlanSummaryEntries,
  type PlanStep,
  type PlanSummaryEvent,
  type SessionAttentionReason,
  type SessionPlanSnapshotEvent,
  type WorkGraphSnapshot,
} from '@forge/protocol'
import type { AcceptedDeliveryMode, AgentModelDescriptor } from '../types.js'
import {
  appendSessionPlanCompactionInstructions,
  formatSessionPlanModelContext,
} from './session-plan-context.js'
import {
  type PlanStepAssignment,
  SessionPlanUsageTracker,
} from './plan-usage-tracker.js'
import { shouldCreateCompletedPlanSummary } from './plan-summary.js'
import {
  normalizeSessionPlanInput,
  type SessionPlanWriteInput,
  type SessionPlanState,
} from './session-plan-state.js'
import { SessionPlanStore } from './session-plan-store.js'
import type { UpdatePlanInput, UpdatePlanResult } from './update-plan-tool.js'
import {
  acceptWorkGraphNode,
  blockInterruptedWorkGraphWorkers,
  claimReadyWorkGraphNodes,
  findRunningWorkersToCancel,
  normalizeWorkGraphInput,
  projectWorkGraphPlan,
  recordWorkGraphDispatchFailure,
  recordWorkGraphWorkerResult,
  recordWorkGraphWorkerModelReroute,
  recordWorkGraphWorkerStarted,
  recoverInterruptedWorkGraphDispatches,
  type UpdateWorkGraphInput,
  type WorkGraphDispatchClaim,
} from './work-graph-state.js'

export interface SessionPlanOwner {
  agentId: string
  profileId: string
}

export interface SessionPlanUpdateReceipt {
  input: UpdatePlanInput
  result: UpdatePlanResult
}

export interface WorkGraphUpdateReceipt {
  input: UpdateWorkGraphInput
  cancelledWorkerIds: string[]
  snapshot: SessionPlanSnapshotEvent
}

export interface WorkGraphNodeAcceptanceReceipt {
  nodeId: string
  alreadyAccepted: boolean
  snapshot: SessionPlanSnapshotEvent
}

export interface SessionPlanCoordinatorOptions {
  dataDir: string
  now: () => string
  getPlanSummaries: (sessionAgentId: string) => readonly PlanSummaryEvent[]
  emitPlanSummary: (event: PlanSummaryEvent) => void
  emitSnapshot: (event: SessionPlanSnapshotEvent) => void
  isWorkerActive?: (workerId: string) => boolean
  logDebug: (message: string, details?: unknown) => void
}

/** Owns live working-plan state and its persistence, accounting, and projections. */
export class SessionPlanCoordinator {
  private readonly statesByAgentId = new Map<string, SessionPlanState>()
  private readonly mutationLocksByAgentId = new Map<string, Promise<void>>()

  constructor(private readonly options: SessionPlanCoordinatorOptions) {}

  async getSnapshot(
    owner: SessionPlanOwner,
    requestId?: string,
  ): Promise<SessionPlanSnapshotEvent> {
    const state = await this.getState(owner)
    return this.toSnapshotEvent(owner, state, requestId)
  }

  async update(
    owner: SessionPlanOwner,
    input: UpdatePlanInput,
  ): Promise<SessionPlanUpdateReceipt> {
    return this.withMutationLock(owner, async () => {
      const normalized = normalizeSessionPlanInput(input)
      const current = await this.getState(owner)
      const reconciled = {
        ...normalized,
        plan: reconcilePlanStepIds(normalized.plan, current.plan),
      }
      const snapshot = await this.write(owner, reconciled)
      const result = this.toUpdateResult(owner, snapshot)
      return { input: reconciled, result }
    })
  }

  async updateWorkGraph(
    owner: SessionPlanOwner,
    input: UpdateWorkGraphInput,
  ): Promise<WorkGraphUpdateReceipt> {
    return this.withMutationLock(owner, async () => {
      const current = await this.getState(owner)
      const explanation = normalizeSessionPlanInput({
        ...(input.explanation ? { explanation: input.explanation } : {}),
        plan: [],
      }).explanation
      const workGraph = normalizeWorkGraphInput(input, current.workGraph, { now: this.options.now })
      const cancelledWorkerIds = findRunningWorkersToCancel(current.workGraph, workGraph)
      const normalizedInput: UpdateWorkGraphInput = {
        ...(explanation ? { explanation } : {}),
        maxConcurrency: workGraph.maxConcurrency,
        nodes: workGraph.nodes.map((node) => ({
          id: node.id,
          title: node.title,
          task: node.task,
          kind: node.kind,
          status: node.status,
          dependsOn: [...node.dependsOn],
          ...(node.acceptanceCriteria ? { acceptanceCriteria: node.acceptanceCriteria } : {}),
          route: node.route,
          ...(node.effort ? { effort: node.effort } : {}),
        })),
      }
      const snapshot = await this.writeGraph(owner, explanation, workGraph)
      return {
        input: normalizedInput,
        cancelledWorkerIds,
        snapshot: this.toSnapshotEvent(owner, snapshot),
      }
    })
  }

  async acceptWorkGraphNode(
    owner: SessionPlanOwner,
    nodeId: string,
  ): Promise<WorkGraphNodeAcceptanceReceipt> {
    return this.withMutationLock(owner, async () => {
      const current = await this.getState(owner)
      if (!current.workGraph) {
        throw new Error('The current working plan is not a work graph.')
      }
      const accepted = acceptWorkGraphNode(current.workGraph, nodeId, this.options.now)
      if (accepted.alreadyAccepted) {
        return {
          nodeId,
          alreadyAccepted: true,
          snapshot: this.toSnapshotEvent(owner, current),
        }
      }
      const snapshot = await this.writeGraph(
        owner,
        current.explanation,
        accepted.graph,
      )
      return {
        nodeId,
        alreadyAccepted: false,
        snapshot: this.toSnapshotEvent(owner, snapshot),
      }
    })
  }

  async claimReadyWorkGraphNodes(owner: SessionPlanOwner): Promise<WorkGraphDispatchClaim[]> {
    return this.withMutationLock(owner, async () => {
      const current = await this.getState(owner)
      if (!current.workGraph) return []
      const claimed = claimReadyWorkGraphNodes(current.workGraph, { now: this.options.now })
      if (claimed.claims.length === 0) return []
      await this.writeGraph(owner, current.explanation, claimed.graph)
      return claimed.claims
    })
  }

  async recordWorkGraphWorkerStarted(
    owner: SessionPlanOwner,
    nodeId: string,
    attemptId: string,
    workerId: string,
    resolution: Parameters<typeof recordWorkGraphWorkerStarted>[4] = {},
  ): Promise<void> {
    await this.withMutationLock(owner, async () => {
      const current = await this.getState(owner)
      if (!current.workGraph) throw new Error('The current working plan is not a work graph.')
      await this.writeGraph(
        owner,
        current.explanation,
        recordWorkGraphWorkerStarted(
          current.workGraph,
          nodeId,
          attemptId,
          workerId,
          resolution,
        ),
      )
    })
  }

  async recordWorkGraphWorkerModelReroute(
    owner: SessionPlanOwner,
    workerId: string,
    model: AgentModelDescriptor,
  ): Promise<void> {
    await this.withMutationLock(owner, async () => {
      const current = await this.getState(owner)
      if (!current.workGraph) return
      const graph = recordWorkGraphWorkerModelReroute(current.workGraph, workerId, model)
      if (graph === current.workGraph) return
      await this.writeGraph(owner, current.explanation, graph)
    })
  }

  async recordWorkGraphDispatchFailure(
    owner: SessionPlanOwner,
    nodeId: string,
    attemptId: string,
    error: unknown,
  ): Promise<void> {
    await this.withMutationLock(owner, async () => {
      const current = await this.getState(owner)
      if (!current.workGraph) return
      await this.writeGraph(
        owner,
        current.explanation,
        recordWorkGraphDispatchFailure(
          current.workGraph,
          nodeId,
          attemptId,
          error,
          this.options.now,
        ),
      )
    })
  }

  async recordWorkGraphWorkerResult(
    owner: SessionPlanOwner,
    workerId: string,
    resultText: string,
  ): Promise<string | undefined> {
    return this.withMutationLock(owner, async () => {
      const current = await this.getState(owner)
      if (!current.workGraph) return undefined
      const settled = recordWorkGraphWorkerResult(
        current.workGraph,
        workerId,
        resultText,
        this.options.now,
      )
      if (!settled.nodeId) return undefined
      await this.writeGraph(owner, current.explanation, settled.graph)
      return settled.nodeId
    })
  }

  async clear(owner: SessionPlanOwner): Promise<SessionPlanSnapshotEvent> {
    return this.withMutationLock(owner, async () => {
      const tracker = this.createUsageTracker(owner)
      const { snapshot } = await this.createStore(owner).clearWithOutgoingState(
        ({ outgoing, snapshot: next }) => tracker.recordPlanTransition(outgoing, next)
          .catch((error) => this.logUsageError('plan_usage:clear:error', owner, error)),
      )

      this.statesByAgentId.set(owner.agentId, snapshot)
      const event = this.toSnapshotEvent(owner, snapshot)
      this.options.emitSnapshot(event)
      return event
    })
  }

  async preload(owners: readonly SessionPlanOwner[]): Promise<void> {
    await Promise.all(owners.map(async (owner) => {
      let state = await this.createStore(owner).load()
      this.statesByAgentId.set(owner.agentId, state)
      if (state.workGraph) {
        const recovered = recoverInterruptedWorkGraphDispatches(state.workGraph, this.options.now, {
          isWorkerActive: this.options.isWorkerActive,
        })
        if (recovered.changed) {
          state = await this.writeGraph(owner, state.explanation, recovered.graph)
        }
      }
      await this.finalizeUsage(owner, { recovered: true })
    }))
  }

  async blockInterruptedWorkGraphWorkers(
    owner: SessionPlanOwner,
    workerIds: readonly string[],
  ): Promise<string[]> {
    if (workerIds.length === 0) return []
    return this.withMutationLock(owner, async () => {
      const current = await this.getState(owner)
      if (!current.workGraph) return []
      const blocked = blockInterruptedWorkGraphWorkers(
        current.workGraph,
        new Set(workerIds),
        this.options.now,
      )
      if (blocked.changedNodeIds.length === 0) return []
      await this.writeGraph(owner, current.explanation, blocked.graph)
      return blocked.changedNodeIds
    })
  }

  forget(sessionAgentId: string): void {
    this.statesByAgentId.delete(sessionAgentId)
  }

  async resolveAssignment(
    owner: SessionPlanOwner,
    requestedStep: string,
  ): Promise<PlanStepAssignment> {
    const state = await this.getState(owner)
    return this.createUsageTracker(owner).resolveAssignment(state, requestedStep)
  }

  async recordWorkerAssignment(
    owner: SessionPlanOwner,
    assignment: PlanStepAssignment,
    input: {
      workerId: string
      source: 'spawn_agent' | 'send_message_to_agent'
      deliveryId?: string
      acceptedMode?: AcceptedDeliveryMode
    },
  ): Promise<void> {
    await this.createUsageTracker(owner)
      .recordWorkerAssignment({ ...assignment, ...input })
      .catch((error) => {
        this.options.logDebug('plan_usage:assignment:error', {
          agentId: owner.agentId,
          workerId: input.workerId,
          planStep: assignment.step,
          message: errorMessage(error),
        })
      })
  }

  async finalizeUsage(
    owner: SessionPlanOwner,
    options: { recovered?: boolean } = {},
  ): Promise<void> {
    await this.createUsageTracker(owner)
      .finalizePendingPlan(options)
      .catch((error) => {
        this.logUsageError(
          options.recovered === true
            ? 'plan_usage:boot_finalize:error'
            : 'plan_usage:finalize:error',
          owner,
          error,
        )
      })
  }

  async appendToManagerInput(owner: SessionPlanOwner, text: string): Promise<string> {
    const state = await this.getState(owner)
    if (isEmptyState(state)) return text

    const planContext = formatSessionPlanModelContext(state)
    return text.trim().length > 0 ? `${text}\n\n${planContext}` : planContext
  }

  async appendCompactionInstructions(
    owner: SessionPlanOwner,
    instructions?: string,
  ): Promise<string | undefined> {
    return appendSessionPlanCompactionInstructions(instructions, await this.getState(owner))
  }

  async hasIncompleteSteps(owner: SessionPlanOwner): Promise<boolean> {
    return (await this.getState(owner)).plan.some((step) => step.status !== 'completed')
  }

  /**
   * Read-only reason enrichment for an already-qualified attention settle edge.
   * Plan state never arms or evaluates attention. Only state updated during the
   * current work epoch may label it, so a completed plan from an older turn
   * cannot misclassify unrelated later work.
   */
  async getAttentionReason(input: {
    sessionAgentId: string
    profileId: string
    workStartedAt: string
  }): Promise<SessionAttentionReason | undefined> {
    const state = await this.getState({
      agentId: input.sessionAgentId,
      profileId: input.profileId,
    })
    if (!state.updatedAt || !timestampAtOrAfter(state.updatedAt, input.workStartedAt)) {
      return undefined
    }

    const graph = state.workGraph
    if (graph) {
      const changedDuringEpoch = (node: WorkGraphSnapshot['nodes'][number]): boolean =>
        Boolean(node.statusUpdatedAt && timestampAtOrAfter(node.statusUpdatedAt, input.workStartedAt))
      if (graph.nodes.some((node) => (
        node.kind === 'decision'
        && node.status === 'waiting'
        && changedDuringEpoch(node)
      ))) {
        return 'decision_waiting'
      }
      if (graph.nodes.some((node) => node.status === 'awaiting_review' && changedDuringEpoch(node))) {
        return 'awaiting_review'
      }
      if (
        graph.nodes.length > 0
        && graph.nodes.every((node) => node.status === 'completed' || node.status === 'cancelled')
        && graph.nodes.some(changedDuringEpoch)
      ) {
        return 'work_graph_completed'
      }
      // A graph-backed projection is not a light plan. If no graph status
      // relevant to this epoch qualifies, fall back to generic settled.
      return undefined
    }

    if (state.plan.length > 0 && state.plan.every((step) => step.status === 'completed')) {
      return 'plan_completed'
    }
    return undefined
  }

  private async getState(owner: SessionPlanOwner): Promise<SessionPlanState> {
    const cached = this.statesByAgentId.get(owner.agentId)
    if (cached) return cached

    const state = await this.createStore(owner).load()
    this.statesByAgentId.set(owner.agentId, state)
    return state
  }

  private recordPlanCardTransition(
    owner: SessionPlanOwner,
    snapshot: SessionPlanState,
  ): void {
    const id = snapshot.planSummaryId
    if (!id || snapshot.plan.length === 0) return

    const latestById = new Map<string, PlanSummaryEvent>()
    for (const event of normalizePlanSummaryEntries(this.options.getPlanSummaries(owner.agentId))) {
      latestById.set(event.id, event)
    }
    const existing = latestById.get(id)
    const state = snapshot.plan.every((step) => step.status === 'completed')
      ? 'completed'
      : 'active'
    if (existing && !(existing.state === 'active' && state === 'completed')) return

    this.options.emitPlanSummary({
      ...(existing ?? {
        type: 'plan_summary' as const,
        id,
        agentId: owner.agentId,
        timestamp: this.options.now(),
      }),
      state,
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt!,
      ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
      plan: snapshot.plan.map((step) => ({ ...step })),
      ...(snapshot.coordinationMode ? { coordinationMode: snapshot.coordinationMode } : {}),
      ...(snapshot.workGraph ? { workGraph: cloneWorkGraph(snapshot.workGraph) } : {}),
    })
  }

  private resolvePlanSummaryId(
    owner: SessionPlanOwner,
    current: SessionPlanState,
    nextPlan: SessionPlanWriteInput['plan'],
  ): string | undefined {
    if (nextPlan.length === 0) return undefined
    if (current.plan.length === 0 || shouldCreateCompletedPlanSummary(current, nextPlan)) {
      return randomUUID()
    }
    if (current.planSummaryId) return current.planSummaryId

    const summaries = normalizePlanSummaryEntries(this.options.getPlanSummaries(owner.agentId))
    const currentIsCompleted = current.plan.every((step) => step.status === 'completed')
    const recovered = [...summaries].reverse().find((event) => (
      currentIsCompleted ? event.state !== 'active' : event.state === 'active'
    ))
    return recovered?.id ?? randomUUID()
  }

  private createStore(owner: SessionPlanOwner): SessionPlanStore {
    return new SessionPlanStore({
      dataDir: this.options.dataDir,
      profileId: owner.profileId,
      sessionAgentId: owner.agentId,
    })
  }

  private createUsageTracker(owner: SessionPlanOwner): SessionPlanUsageTracker {
    return new SessionPlanUsageTracker({
      dataDir: this.options.dataDir,
      profileId: owner.profileId,
      sessionAgentId: owner.agentId,
      now: this.options.now,
    })
  }

  private toSnapshotEvent(
    owner: SessionPlanOwner,
    state: SessionPlanState,
    requestId?: string,
  ): SessionPlanSnapshotEvent {
    return {
      type: 'session_plan_snapshot',
      sessionAgentId: owner.agentId,
      profileId: owner.profileId,
      revision: state.revision,
      updatedAt: state.updatedAt,
      ...(state.explanation ? { explanation: state.explanation } : {}),
      plan: state.plan,
      ...(state.coordinationMode ? { coordinationMode: state.coordinationMode } : {}),
      ...(state.workGraph ? { workGraph: cloneWorkGraph(state.workGraph) } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    }
  }

  private toUpdateResult(owner: SessionPlanOwner, state: SessionPlanState): UpdatePlanResult {
    return {
      sessionAgentId: owner.agentId,
      revision: state.revision,
      updatedAt: state.updatedAt,
      ...(state.explanation ? { explanation: state.explanation } : {}),
      plan: state.plan,
      ...(state.coordinationMode ? { coordinationMode: state.coordinationMode } : {}),
      ...(state.workGraph ? { workGraph: cloneWorkGraph(state.workGraph) } : {}),
    }
  }

  private async writeGraph(
    owner: SessionPlanOwner,
    explanation: string | undefined,
    workGraph: WorkGraphSnapshot,
  ): Promise<SessionPlanState> {
    return this.write(owner, {
      ...(explanation ? { explanation } : {}),
      coordinationMode: 'graph',
      workGraph,
      plan: projectWorkGraphPlan(workGraph),
    })
  }

  private async write(
    owner: SessionPlanOwner,
    input: SessionPlanWriteInput,
  ): Promise<SessionPlanState> {
    const tracker = this.createUsageTracker(owner)
    const current = await this.getState(owner)
    const planSummaryId = this.resolvePlanSummaryId(owner, current, input.plan)
    const { snapshot } = await this.createStore(owner).updateWithOutgoingState(
      {
        ...input,
        ...(planSummaryId ? { planSummaryId } : {}),
      },
      async ({ outgoing, snapshot: next }) => {
        await tracker.recordPlanTransition(outgoing, next).catch((error) => {
          this.logUsageError('plan_usage:transition:error', owner, error)
        })
        this.recordPlanCardTransition(owner, next)
      },
    )
    this.statesByAgentId.set(owner.agentId, snapshot)
    this.options.emitSnapshot(this.toSnapshotEvent(owner, snapshot))
    return snapshot
  }

  private async withMutationLock<T>(
    owner: SessionPlanOwner,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutationLocksByAgentId.get(owner.agentId) ?? Promise.resolve()
    let release: (() => void) | undefined
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent })
    const queued = previous.catch(() => {}).then(() => current)
    this.mutationLocksByAgentId.set(owner.agentId, queued)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release?.()
      if (this.mutationLocksByAgentId.get(owner.agentId) === queued) {
        this.mutationLocksByAgentId.delete(owner.agentId)
      }
    }
  }

  private logUsageError(event: string, owner: SessionPlanOwner, error: unknown): void {
    this.options.logDebug(event, {
      agentId: owner.agentId,
      message: errorMessage(error),
    })
  }
}

function cloneWorkGraph(graph: WorkGraphSnapshot): WorkGraphSnapshot {
  return {
    maxConcurrency: graph.maxConcurrency,
    nodes: graph.nodes.map((node) => ({
      ...node,
      dependsOn: [...node.dependsOn],
      attempts: node.attempts.map((attempt) => ({ ...attempt })),
    })),
  }
}

function isEmptyState(state: SessionPlanState): boolean {
  return state.revision === 0 && state.plan.length === 0 && !state.explanation
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function timestampAtOrAfter(candidate: string, boundary: string): boolean {
  const candidateTime = Date.parse(candidate)
  const boundaryTime = Date.parse(boundary)
  return Number.isFinite(candidateTime)
    && Number.isFinite(boundaryTime)
    && candidateTime >= boundaryTime
}

function reconcilePlanStepIds(
  next: readonly PlanStep[],
  current: readonly PlanStep[],
): PlanStep[] {
  const reusableByText = new Map<string, string>()
  const ambiguousText = new Set<string>()
  for (const step of current) {
    if (!step.id) continue
    if (reusableByText.has(step.step)) {
      reusableByText.delete(step.step)
      ambiguousText.add(step.step)
    } else if (!ambiguousText.has(step.step)) {
      reusableByText.set(step.step, step.id)
    }
  }

  const used = new Set(next.flatMap((step) => step.id ? [step.id] : []))
  return next.map((step) => {
    if (step.id) return { ...step }
    const reusable = reusableByText.get(step.step)
    if (reusable && !used.has(reusable)) {
      used.add(reusable)
      return { ...step, id: reusable }
    }
    let id: string
    do {
      id = `step-${randomUUID()}`
    } while (used.has(id))
    used.add(id)
    return { ...step, id }
  })
}
