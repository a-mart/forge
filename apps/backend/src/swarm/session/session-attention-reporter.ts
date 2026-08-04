import type { AgentDescriptor, AgentStatus, ManagerProfile } from "@forge/protocol";

import type {
  SessionAttentionCoordinator,
  SessionAttentionSessionSnapshot,
} from "./session-attention-coordinator.js";

/**
 * Producers each own only a slice of the attention aggregate: the status
 * projector knows descriptors, the choice service knows choices, the turn
 * coordinator knows the accepted-turn queue. Rather than threading all of them
 * through every call site, producers report a single fact here and this seam
 * assembles the committed aggregate from the authoritative readers.
 *
 * Every method is called AFTER the producer has committed its own state, so a
 * read here always observes durable truth rather than an in-flight mutation.
 */
export interface SessionAttentionReporterOptions {
  coordinator: SessionAttentionCoordinator;
  /** Committed descriptor lookup; undefined for unknown/removed agents. */
  getDescriptor: (agentId: string) => AgentDescriptor | undefined;
  /** Committed owning profile; undefined keeps the session ineligible. */
  getProfile: (profileId: string) => ManagerProfile | undefined;
  /** Committed streaming-worker count for a session. */
  getActiveWorkerCount: (sessionAgentId: string) => number;
  /** Committed pending-choice count for a session. */
  getPendingChoiceCount: (sessionAgentId: string) => number;
  /** Committed accepted-turn queue depth for a session. */
  getPendingTurnContextCount: (sessionAgentId: string) => number;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

export class SessionAttentionReporter {
  private readonly options: SessionAttentionReporterOptions;

  constructor(options: SessionAttentionReporterOptions) {
    this.options = options;
  }

  /**
   * Runtime and lifecycle status transitions. `agentId` may be a manager or one
   * of its owned workers; the session is resolved from managerId so a worker
   * streaming arms the owning session's epoch.
   */
  async reportStatusTransition(input: {
    agentId: string;
    previousStatus: AgentStatus;
    nextStatus: AgentStatus;
  }): Promise<void> {
    const descriptor = this.options.getDescriptor(input.agentId);
    if (!descriptor) return;

    const sessionAgentId = descriptor.role === "worker" ? descriptor.managerId : descriptor.agentId;
    const snapshot = this.snapshot(sessionAgentId);
    if (!snapshot) return;

    await this.options.coordinator.observeStatus({
      ...snapshot,
      agentId: input.agentId,
      source: descriptor.role === "worker" ? "owned_worker" : "manager",
      previousStatus: input.previousStatus,
      nextStatus: input.nextStatus,
    });
  }

  /**
   * Choice insert/resolve/cancel, worker create/remove, and accepted-turn queue
   * movement. Cannot arm an epoch; it only re-evaluates an existing one.
   */
  async reportAggregateChange(sessionAgentId: string): Promise<void> {
    const snapshot = this.snapshot(sessionAgentId);
    if (!snapshot) return;
    await this.options.coordinator.observeAggregateChange(snapshot);
  }

  /**
   * The accepted turn ended without producing a continuation (rollback/discard),
   * so the deferred epoch may settle on its own merits again.
   */
  async reportContinuationAbandoned(sessionAgentId: string): Promise<void> {
    const snapshot = this.snapshot(sessionAgentId);
    if (!snapshot) return;
    await this.options.coordinator.releaseContinuationBarrier(snapshot);
  }

  /** Archive, delete, or loss of eligibility. Restore seeds unarmed. */
  async reportSessionRetired(sessionAgentId: string): Promise<void> {
    await this.options.coordinator.retireSession(sessionAgentId);
  }

  /** Resolves a session's committed aggregate, or undefined if unresolvable. */
  private snapshot(sessionAgentId: string): SessionAttentionSessionSnapshot | undefined {
    const manager = this.options.getDescriptor(sessionAgentId);
    if (!manager || manager.role !== "manager") return undefined;

    return {
      manager,
      profile: manager.profileId ? this.options.getProfile(manager.profileId) : undefined,
      activeWorkerCount: this.options.getActiveWorkerCount(sessionAgentId),
      pendingChoiceCount: this.options.getPendingChoiceCount(sessionAgentId),
      pendingTurnContextCount: this.options.getPendingTurnContextCount(sessionAgentId),
    };
  }
}
