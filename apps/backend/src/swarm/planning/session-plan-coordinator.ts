import { randomUUID } from 'node:crypto'
import type { PlanSummaryEvent, SessionPlanSnapshotEvent } from '@forge/protocol'
import type { AcceptedDeliveryMode } from '../types.js'
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
  type SessionPlanState,
} from './session-plan-state.js'
import { SessionPlanStore } from './session-plan-store.js'
import type { UpdatePlanInput, UpdatePlanResult } from './update-plan-tool.js'

export interface SessionPlanOwner {
  agentId: string
  profileId: string
}

export interface SessionPlanUpdateReceipt {
  input: UpdatePlanInput
  result: UpdatePlanResult
}

export interface SessionPlanCoordinatorOptions {
  dataDir: string
  now: () => string
  getPlanSummaries: (sessionAgentId: string) => readonly PlanSummaryEvent[]
  emitPlanSummary: (event: PlanSummaryEvent) => void
  emitSnapshot: (event: SessionPlanSnapshotEvent) => void
  logDebug: (message: string, details?: unknown) => void
}

/** Owns live working-plan state and its persistence, accounting, and projections. */
export class SessionPlanCoordinator {
  private readonly statesByAgentId = new Map<string, SessionPlanState>()

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
    const normalized = normalizeSessionPlanInput(input)
    const tracker = this.createUsageTracker(owner)
    const { snapshot } = await this.createStore(owner).updateWithOutgoingState(
      normalized,
      async ({ outgoing, snapshot: next }) => {
        await tracker.recordPlanTransition(outgoing, next).catch((error) => {
          this.logUsageError('plan_usage:transition:error', owner, error)
        })
        this.recordPlanCardTransition(owner, outgoing, next)
      },
    )

    this.statesByAgentId.set(owner.agentId, snapshot)
    const result = this.toUpdateResult(owner, snapshot)
    this.options.emitSnapshot({
      type: 'session_plan_snapshot',
      profileId: owner.profileId,
      ...result,
    })
    return { input: normalized, result }
  }

  async clear(owner: SessionPlanOwner): Promise<SessionPlanSnapshotEvent> {
    const tracker = this.createUsageTracker(owner)
    const { snapshot } = await this.createStore(owner).clearWithOutgoingState(
      ({ outgoing, snapshot: next }) => tracker.recordPlanTransition(outgoing, next).catch((error) => {
        this.logUsageError('plan_usage:clear:error', owner, error)
      }),
    )

    this.statesByAgentId.set(owner.agentId, snapshot)
    const event = this.toSnapshotEvent(owner, snapshot)
    this.options.emitSnapshot(event)
    return event
  }

  async preload(owners: readonly SessionPlanOwner[]): Promise<void> {
    await Promise.all(owners.map(async (owner) => {
      const state = await this.createStore(owner).load()
      this.statesByAgentId.set(owner.agentId, state)
      await this.finalizeUsage(owner, { recovered: true })
    }))
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

  private async getState(owner: SessionPlanOwner): Promise<SessionPlanState> {
    const cached = this.statesByAgentId.get(owner.agentId)
    if (cached) return cached

    const state = await this.createStore(owner).load()
    this.statesByAgentId.set(owner.agentId, state)
    return state
  }

  private recordPlanCardTransition(
    owner: SessionPlanOwner,
    outgoing: SessionPlanState,
    snapshot: SessionPlanState,
  ): void {
    const latestById = new Map<string, PlanSummaryEvent>()
    for (const event of this.options.getPlanSummaries(owner.agentId)) {
      latestById.set(event.id, event)
    }
    let active = Array.from(latestById.values()).reverse().find((event) => event.state === 'active')
    const replacingCompletedPlan = shouldCreateCompletedPlanSummary(outgoing, snapshot.plan)

    const needsAnchor = snapshot.plan.length > 0 && (
      outgoing.plan.length === 0
      || replacingCompletedPlan
      || (!active && outgoing.plan.some((step) => step.status !== 'completed'))
    )
    if (needsAnchor) {
      active = {
        type: 'plan_summary',
        id: randomUUID(),
        agentId: owner.agentId,
        timestamp: this.options.now(),
        state: 'active',
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt!,
        ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
        plan: snapshot.plan.map((step) => ({ ...step })),
      }
      this.options.emitPlanSummary(active)
    }

    if (active && snapshot.plan.length > 0 && snapshot.plan.every((step) => step.status === 'completed')) {
      this.options.emitPlanSummary({
        ...active,
        state: 'completed',
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt!,
        ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
        plan: snapshot.plan.map((step) => ({ ...step })),
      })
    }
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
    }
  }

  private logUsageError(event: string, owner: SessionPlanOwner, error: unknown): void {
    this.options.logDebug(event, {
      agentId: owner.agentId,
      message: errorMessage(error),
    })
  }
}

function isEmptyState(state: SessionPlanState): boolean {
  return state.revision === 0 && state.plan.length === 0 && !state.explanation
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
