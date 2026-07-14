import type {
  SessionGoalControlAction,
  SessionGoalSnapshot,
  SessionGoalSnapshotEvent,
} from "@forge/protocol";
import { isNonRunningAgentStatus } from "../agent-state-machine.js";
import { normalizeArchetypeId } from "../prompt-registry.js";
import { emptyTokenUsage, scanSessionTokenUsage } from "../session/session-token-usage.js";
import type { SwarmToolSideEffectEvent } from "../swarm-tool-host.js";
import type { AgentDescriptor, SendMessageReceipt } from "../types.js";
import type { CreateGoalInput, UpdateGoalInput } from "./goal-tools.js";
import {
  appendSessionGoalCompactionInstructions,
  formatSessionGoalModelContext,
} from "./session-goal-context.js";
import type { SessionGoalState } from "./session-goal-state.js";
import { SessionGoalStore } from "./session-goal-store.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const GOAL_CONTINUATION_DELAY_MS = 100;
const GOAL_CONTINUATION_MESSAGE = [
  "[goalContinuation] Continue pursuing the active goal from the current persisted state.",
  "Make the next meaningful safe progress without waiting for another user message.",
  "Use working plans when a visible checklist helps, and keep coordinating existing workers rather than duplicating them.",
  "When the objective is genuinely achieved, publish the accepted outcome to the user if this is a background turn, then call update_goal with complete.",
  "Call update_goal with blocked only after the same blocker has persisted for at least three goal turns and no meaningful safe progress remains.",
].join(" ");

export type SessionGoalOwner = AgentDescriptor & { role: "manager"; profileId: string };

export interface SessionGoalCoordinatorOptions {
  dataDir: string;
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  now(): string;
  isSessionAgent(descriptor: AgentDescriptor | undefined): descriptor is SessionGoalOwner;
  assertNotArchived(descriptor: AgentDescriptor): void;
  isArchived(descriptor: AgentDescriptor): boolean;
  getWorkers(managerId: string): AgentDescriptor[];
  hasPendingChoices(sessionAgentId: string): boolean;
  hasIncompletePlanSteps(owner: SessionGoalOwner): Promise<boolean>;
  isRuntimeRecoveryActive(agentId: string): boolean;
  hasPendingRuntimeRecycle(agentId: string): boolean;
  isRestartRecoveryDecisionPending(): boolean;
  getActiveExternalTurn(agentId: string):
    | { fromAgentId: string; fromDisplayName: string }
    | undefined;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    options: { origin: "internal" },
  ): Promise<SendMessageReceipt>;
  emitSnapshot(event: SessionGoalSnapshotEvent): void;
  recordToolSideEffect(callerAgentId: string, event: SwarmToolSideEffectEvent): void;
  logDebug(message: string, details?: unknown): void;
}

/** Owns durable session goals, usage snapshots, context, and continuation scheduling. */
export class SessionGoalCoordinator {
  private readonly statesByAgentId = new Map<string, SessionGoalState>();
  private readonly continuationTimersByAgentId = new Map<string, NodeJS.Timeout>();
  private readonly continuationsInFlight = new Set<string>();
  private readonly continuationGenerationsByAgentId = new Map<string, number>();
  private readonly continuationRescheduleRequested = new Set<string>();

  constructor(private readonly options: SessionGoalCoordinatorOptions) {}

  async create(
    callerAgentId: string,
    toolCallId: string,
    input: CreateGoalInput,
  ): Promise<SessionGoalSnapshot> {
    const owner = this.requireOwner(callerAgentId, "create_goal");
    const state = await this.store(owner).create(input);
    this.statesByAgentId.set(owner.agentId, state);
    const snapshot = await this.buildSnapshot(owner, state);
    this.emitSnapshot(owner, snapshot);
    this.recordToolSideEffect(callerAgentId, "create_goal", toolCallId, input, snapshot, {
      revision: snapshot.revision,
      goalId: snapshot.goal?.id,
    });
    return snapshot;
  }

  async get(callerAgentId: string): Promise<SessionGoalSnapshot> {
    const owner = this.requireOwner(callerAgentId, "get_goal");
    return this.buildSnapshot(owner, await this.getState(owner));
  }

  async update(
    callerAgentId: string,
    toolCallId: string,
    input: UpdateGoalInput,
  ): Promise<SessionGoalSnapshot> {
    const owner = this.requireOwner(callerAgentId, "update_goal");
    this.cancelScheduledContinuation(owner.agentId);
    try {
      if (input.status === "complete" && await this.options.hasIncompletePlanSteps(owner)) {
        throw new Error("Complete the current working-plan steps before marking the goal complete.");
      }
      const measured = await this.buildSnapshot(owner, await this.getState(owner));
      const final = measured.goal
        ? { usage: measured.goal.usage, coverage: measured.goal.usageCoverage }
        : undefined;
      const state = await this.store(owner).updateFromAgent(input.status, final);
      this.statesByAgentId.set(owner.agentId, state);
      const snapshot = await this.buildSnapshot(owner, state);
      this.emitSnapshot(owner, snapshot);
      this.recordToolSideEffect(callerAgentId, "update_goal", toolCallId, input, snapshot, {
        revision: snapshot.revision,
        status: snapshot.goal?.status,
      });
      return snapshot;
    } catch (error) {
      this.scheduleContinuation(owner);
      throw error;
    }
  }

  async getSnapshotEvent(sessionAgentId: string): Promise<SessionGoalSnapshotEvent> {
    const descriptor = this.options.descriptors.get(sessionAgentId);
    if (!descriptor || descriptor.role !== "manager" || !this.options.isSessionAgent(descriptor)) {
      throw new Error("read session goals requires a manager session with profile context.");
    }
    if (!this.supportsGoals(descriptor)) {
      return {
        type: "session_goal_snapshot",
        sessionAgentId: descriptor.agentId,
        profileId: descriptor.profileId,
        revision: 0,
        measuredAt: this.options.now(),
        goal: null,
      };
    }
    return this.toEvent(descriptor, await this.buildSnapshot(descriptor, await this.getState(descriptor)));
  }

  async control(
    sessionAgentId: string,
    action: SessionGoalControlAction,
  ): Promise<SessionGoalSnapshot> {
    const owner = this.requireOwner(sessionAgentId, "control session goals", false);
    const invalidatesContinuation = action.action === "pause" || action.action === "cancel";
    if (invalidatesContinuation) {
      this.cancelScheduledContinuation(owner.agentId);
    }
    try {
      const measured = await this.buildSnapshot(owner, await this.getState(owner));
      const final = action.action === "cancel" && measured.goal
        ? { usage: measured.goal.usage, coverage: measured.goal.usageCoverage }
        : undefined;
      const state = await this.store(owner).control(action, final);
      this.statesByAgentId.set(owner.agentId, state);
      if (action.action === "resume") this.scheduleContinuation(owner);
      const snapshot = await this.buildSnapshot(owner, state);
      this.emitSnapshot(owner, snapshot);
      return snapshot;
    } catch (error) {
      if (invalidatesContinuation) this.scheduleContinuation(owner);
      throw error;
    }
  }

  async clear(owner: SessionGoalOwner): Promise<SessionGoalSnapshotEvent> {
    this.cancelScheduledContinuation(owner.agentId);
    try {
      const measured = await this.buildSnapshot(owner, await this.getState(owner));
      const final = measured.goal
        ? { usage: measured.goal.usage, coverage: measured.goal.usageCoverage }
        : undefined;
      const state = await this.store(owner).clear(final);
      this.statesByAgentId.set(owner.agentId, state);
      const event = this.toEvent(owner, await this.buildSnapshot(owner, state));
      this.options.emitSnapshot(event);
      return event;
    } catch (error) {
      this.scheduleContinuation(owner);
      throw error;
    }
  }

  async preload(): Promise<void> {
    const owners = Array.from(this.options.descriptors.values()).filter(
      (descriptor): descriptor is SessionGoalOwner =>
        descriptor.role === "manager" &&
        this.options.isSessionAgent(descriptor) &&
        this.supportsGoals(descriptor),
    );
    await Promise.all(owners.map(async (owner) => {
      this.statesByAgentId.set(owner.agentId, await this.store(owner).load());
    }));
  }

  forget(agentId: string): void {
    this.cancelScheduledContinuation(agentId);
    this.statesByAgentId.delete(agentId);
  }

  async noteUserTurn(descriptor: AgentDescriptor): Promise<void> {
    if (!this.options.isSessionAgent(descriptor) || !this.supportsGoals(descriptor)) return;
    this.cancelScheduledContinuation(descriptor.agentId);
    const state = await this.getState(descriptor);
    if (state.goal?.status !== "active") return;
    const incremented = await this.store(descriptor).incrementTurn();
    this.statesByAgentId.set(descriptor.agentId, incremented);
    this.emitSnapshot(descriptor, await this.buildSnapshot(descriptor, incremented));
  }

  async appendToManagerInput(owner: SessionGoalOwner, text: string): Promise<string> {
    const context = formatSessionGoalModelContext(
      await this.buildSnapshot(owner, await this.getState(owner)),
    );
    if (!context) return text;
    return text.trim().length > 0 ? `${text}\n\n${context}` : context;
  }

  async appendCompactionInstructions(
    owner: SessionGoalOwner,
    instructions?: string,
  ): Promise<string | undefined> {
    const snapshot = await this.buildSnapshot(owner, await this.getState(owner));
    return appendSessionGoalCompactionInstructions(instructions, snapshot);
  }

  scheduleContinuation(owner: SessionGoalOwner): void {
    if (owner.status !== "idle" || this.continuationTimersByAgentId.has(owner.agentId)) return;
    if (this.continuationsInFlight.has(owner.agentId)) {
      this.continuationRescheduleRequested.add(owner.agentId);
      return;
    }

    const generation = this.getContinuationGeneration(owner.agentId);
    const timer = setTimeout(() => {
      this.continuationTimersByAgentId.delete(owner.agentId);
      void this.runContinuation(owner.agentId, generation);
    }, GOAL_CONTINUATION_DELAY_MS);
    timer.unref?.();
    this.continuationTimersByAgentId.set(owner.agentId, timer);
  }

  cancelScheduledContinuation(agentId: string): void {
    this.continuationGenerationsByAgentId.set(
      agentId,
      this.getContinuationGeneration(agentId) + 1,
    );
    this.continuationRescheduleRequested.delete(agentId);
    const timer = this.continuationTimersByAgentId.get(agentId);
    if (timer) clearTimeout(timer);
    this.continuationTimersByAgentId.delete(agentId);
  }

  scheduleContinuationsAfterBoot(): void {
    if (this.options.isRestartRecoveryDecisionPending()) return;
    for (const descriptor of this.options.descriptors.values()) {
      if (
        descriptor.status === "idle" &&
        this.options.isSessionAgent(descriptor) &&
        this.supportsGoals(descriptor) &&
        this.statesByAgentId.get(descriptor.agentId)?.goal?.status === "active"
      ) this.scheduleContinuation(descriptor);
    }
  }

  private requireOwner(
    agentId: string,
    action: "create_goal" | "get_goal" | "update_goal" | "control session goals",
    requireRunning = true,
  ): SessionGoalOwner {
    this.assertExternalTurnAllowed(agentId, action);
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager" || !this.options.isSessionAgent(descriptor)) {
      throw new Error(`${action} requires a manager session with profile context.`);
    }
    if (descriptor.sessionSurface === "collab") {
      throw new Error(`${action} is not available for Collaboration sessions.`);
    }
    if (normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID) {
      throw new Error(`${action} is not available for Cortex sessions.`);
    }
    this.options.assertNotArchived(descriptor);
    if (requireRunning && isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Manager is not running: ${agentId}`);
    }
    return descriptor;
  }

  private assertExternalTurnAllowed(agentId: string, capability: string): void {
    const context = this.options.getActiveExternalTurn(agentId);
    if (!context) return;
    throw new Error(
      `External project-agent messages are restricted to a direct reply back to ${context.fromDisplayName} (${context.fromAgentId}). ${capability} is disabled for this turn.`,
    );
  }

  private supportsGoals(owner: SessionGoalOwner): boolean {
    return owner.sessionSurface !== "collab" &&
      normalizeArchetypeId(owner.archetypeId ?? "") !== CORTEX_ARCHETYPE_ID;
  }

  private store(owner: SessionGoalOwner): SessionGoalStore {
    return new SessionGoalStore({
      dataDir: this.options.dataDir,
      profileId: owner.profileId,
      sessionAgentId: owner.agentId,
      now: this.options.now,
    });
  }

  private async getState(owner: SessionGoalOwner): Promise<SessionGoalState> {
    const cached = this.statesByAgentId.get(owner.agentId);
    if (cached) return cached;
    const state = await this.store(owner).load();
    this.statesByAgentId.set(owner.agentId, state);
    return state;
  }

  private async buildSnapshot(
    owner: SessionGoalOwner,
    state: SessionGoalState,
  ): Promise<SessionGoalSnapshot> {
    const measuredAt = this.options.now();
    const goal = state.goal;
    if (!goal) return { revision: state.revision, measuredAt, goal: null };

    const usageResult = goal.finalUsage
      ? {
          totalUsage: goal.finalUsage,
          missingTimestampCount: goal.finalUsageCoverage === "partial" ? 1 : 0,
        }
      : await scanSessionTokenUsage({
          dataDir: this.options.dataDir,
          profileId: owner.profileId,
          sessionAgentId: owner.agentId,
          startAt: goal.createdAt,
          endAt: goal.endedAt ?? measuredAt,
        });
    const activeElapsedMs = goal.activeSince
      ? goal.activeElapsedMs + Math.max(0, Date.parse(measuredAt) - Date.parse(goal.activeSince))
      : goal.activeElapsedMs;
    const usage = usageResult.totalUsage ?? emptyTokenUsage();
    return {
      revision: state.revision,
      measuredAt,
      goal: {
        id: goal.id,
        objective: goal.objective,
        status: goal.status,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        ...(goal.endedAt ? { endedAt: goal.endedAt } : {}),
        ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
        ...(goal.pauseReason ? { pauseReason: goal.pauseReason } : {}),
        activeElapsedMs,
        turnCount: goal.turnCount,
        usage,
        usageCoverage: usageResult.missingTimestampCount > 0 ? "partial" : "complete",
        ...(goal.tokenBudget === undefined
          ? {}
          : { remainingTokens: Math.max(0, goal.tokenBudget - usage.total) }),
      },
    };
  }

  private emitSnapshot(owner: SessionGoalOwner, snapshot: SessionGoalSnapshot): void {
    this.options.emitSnapshot(this.toEvent(owner, snapshot));
  }

  private toEvent(owner: SessionGoalOwner, snapshot: SessionGoalSnapshot): SessionGoalSnapshotEvent {
    return {
      type: "session_goal_snapshot",
      sessionAgentId: owner.agentId,
      profileId: owner.profileId,
      ...snapshot,
    };
  }

  private recordToolSideEffect(
    callerAgentId: string,
    toolName: "create_goal" | "update_goal",
    toolCallId: string,
    input: unknown,
    output: SessionGoalSnapshot,
    metadata: Record<string, unknown>,
  ): void {
    this.options.recordToolSideEffect(callerAgentId, {
      toolName,
      toolCallId,
      phase: "side_effect",
      input,
      output,
      metadata,
    });
  }

  async runContinuation(
    agentId: string,
    generation = this.getContinuationGeneration(agentId),
  ): Promise<void> {
    if (
      generation !== this.getContinuationGeneration(agentId) ||
      this.continuationsInFlight.has(agentId)
    ) return;
    this.continuationsInFlight.add(agentId);
    try {
      const descriptor = this.options.descriptors.get(agentId);
      if (
        generation !== this.getContinuationGeneration(agentId) ||
        !this.options.isSessionAgent(descriptor) ||
        descriptor.status !== "idle" ||
        !this.supportsGoals(descriptor) ||
        this.options.isArchived(descriptor) ||
        this.options.isRestartRecoveryDecisionPending() ||
        this.options.isRuntimeRecoveryActive(agentId) ||
        this.options.hasPendingRuntimeRecycle(agentId) ||
        this.options.hasPendingChoices(agentId) ||
        this.options.getWorkers(agentId).some((worker) => worker.status === "streaming")
      ) return;

      const state = await this.getState(descriptor);
      if (
        generation !== this.getContinuationGeneration(agentId) ||
        state.goal?.status !== "active"
      ) return;
      const snapshot = await this.buildSnapshot(descriptor, state);
      if (generation !== this.getContinuationGeneration(agentId)) return;
      if (
        snapshot.goal?.tokenBudget !== undefined &&
        snapshot.goal.usage.total >= snapshot.goal.tokenBudget
      ) {
        const paused = await this.store(descriptor).pauseForBudget();
        if (generation !== this.getContinuationGeneration(agentId)) {
          this.statesByAgentId.delete(agentId);
          return;
        }
        this.statesByAgentId.set(agentId, paused);
        const pausedSnapshot = await this.buildSnapshot(descriptor, paused);
        if (generation !== this.getContinuationGeneration(agentId)) {
          this.statesByAgentId.delete(agentId);
          return;
        }
        this.emitSnapshot(descriptor, pausedSnapshot);
        return;
      }

      const incremented = await this.store(descriptor).incrementTurn();
      if (
        generation !== this.getContinuationGeneration(agentId) ||
        incremented.goal?.status !== "active"
      ) {
        this.statesByAgentId.delete(agentId);
        return;
      }
      this.statesByAgentId.set(agentId, incremented);
      const incrementedSnapshot = await this.buildSnapshot(descriptor, incremented);
      if (generation !== this.getContinuationGeneration(agentId)) {
        this.statesByAgentId.delete(agentId);
        return;
      }
      this.emitSnapshot(descriptor, incrementedSnapshot);
      if (generation !== this.getContinuationGeneration(agentId)) return;
      await this.options.sendMessage(agentId, agentId, GOAL_CONTINUATION_MESSAGE, {
        origin: "internal",
      });
    } catch (error) {
      this.options.logDebug("goal:continuation:error", {
        agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.continuationsInFlight.delete(agentId);
      if (this.continuationRescheduleRequested.delete(agentId)) {
        const descriptor = this.options.descriptors.get(agentId);
        if (this.options.isSessionAgent(descriptor)) this.scheduleContinuation(descriptor);
      }
    }
  }

  private getContinuationGeneration(agentId: string): number {
    return this.continuationGenerationsByAgentId.get(agentId) ?? 0;
  }
}
