import type { AgentDescriptor, AgentStatus, ManagerProfile } from "@forge/protocol";

import type { AgentDirectory } from "../agent-directory.js";
import type { SessionPlanCoordinator } from "../planning/session-plan-coordinator.js";
import type { SwarmChoiceService } from "../swarm-choice-service.js";
import {
  SessionAttentionCoordinator,
  type SessionAttentionCoordinatorOptions,
} from "./session-attention-coordinator.js";
import { isSessionAttentionEligible } from "./session-attention-eligibility.js";
import { SessionAttentionReporter } from "./session-attention-reporter.js";
import { SessionAttentionStore } from "./session-attention-store.js";

export interface SessionAttentionRuntimeHooks {
  reportStatusTransition(input: {
    agentId: string;
    previousStatus: AgentStatus;
    nextStatus: AgentStatus;
    transitionedAt: string;
  }): Promise<void>;
  suppressWorkingEpoch(sessionAgentId: string): Promise<void>;
  retireSession(sessionAgentId: string): Promise<void>;
  reportPendingTurn(agentId: string): Promise<void>;
  reportContinuationAbandoned(agentId: string): Promise<void>;
}

interface SessionAttentionRuntimeOptions {
  dataDir: string;
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  profiles: ReadonlyMap<string, ManagerProfile>;
  workers: Pick<AgentDirectory, "getWorkersForManager">;
  choices: Pick<SwarmChoiceService, "getPendingChoiceIdsForSession">;
  turns: { getPendingContextCount(sessionAgentId: string): number };
  plans: Pick<SessionPlanCoordinator, "getAttentionReason">;
  onChange: NonNullable<SessionAttentionCoordinatorOptions["onChange"]>;
  log: NonNullable<SessionAttentionCoordinatorOptions["log"]>;
}

/** Composes persistence, aggregate readers, producer hooks, and facade access. */
export class SessionAttentionRuntime implements SessionAttentionRuntimeHooks {
  private readonly coordinator: SessionAttentionCoordinator;
  private readonly reporter: SessionAttentionReporter;
  private readonly descriptors: ReadonlyMap<string, AgentDescriptor>;

  readonly facade: {
    initialize(): Promise<void>;
    getSnapshot: SessionAttentionCoordinator["getSnapshot"];
    dismissAttentionIds: SessionAttentionCoordinator["dismissAttentionIds"];
  };

  constructor(options: SessionAttentionRuntimeOptions) {
    this.descriptors = options.descriptors;
    this.coordinator = new SessionAttentionCoordinator({
      store: new SessionAttentionStore({ dataDir: options.dataDir }),
      isEligible: isSessionAttentionEligible,
      getReason: (input) => options.plans.getAttentionReason(input),
      onChange: options.onChange,
      log: options.log,
    });
    this.reporter = new SessionAttentionReporter({
      coordinator: this.coordinator,
      getDescriptor: (agentId) => options.descriptors.get(agentId),
      getDescriptors: () => options.descriptors.values(),
      getProfile: (profileId) => options.profiles.get(profileId),
      getActiveWorkerCount: (sessionAgentId) =>
        options.workers.getWorkersForManager(sessionAgentId)
          .filter((worker) => worker.status === "streaming").length,
      hasTerminallyErroredWorker: (sessionAgentId) =>
        options.workers.getWorkersForManager(sessionAgentId)
          .some((worker) => worker.status === "error"),
      getPendingChoiceCount: (sessionAgentId) =>
        options.choices.getPendingChoiceIdsForSession(sessionAgentId).length,
      getPendingTurnContextCount: (sessionAgentId) =>
        options.turns.getPendingContextCount(sessionAgentId),
    });
    this.facade = {
      initialize: async () => {
        await this.coordinator.initialize();
        await this.coordinator.reconcileAfterBoot(this.reporter.listSessionSnapshots());
      },
      getSnapshot: () => this.coordinator.getSnapshot(),
      dismissAttentionIds: (attentionIds) => this.coordinator.dismissAttentionIds(attentionIds),
    };
  }

  reportStatusTransition(input: Parameters<SessionAttentionReporter["reportStatusTransition"]>[0]) {
    return this.reporter.reportStatusTransition(input);
  }

  reportAggregateChange(sessionAgentId: string) {
    return this.reporter.reportAggregateChange(sessionAgentId);
  }

  suppressWorkingEpoch(sessionAgentId: string) {
    return this.reporter.suppressWorkingEpoch(sessionAgentId);
  }

  retireSession(sessionAgentId: string) {
    return this.reporter.reportSessionRetired(sessionAgentId);
  }

  reportPendingTurn(agentId: string) {
    return this.reportManagerAggregateChange(agentId);
  }

  reportContinuationAbandoned(agentId: string) {
    if (!this.isManager(agentId)) return Promise.resolve();
    return this.reporter.reportContinuationAbandoned(agentId);
  }

  private reportManagerAggregateChange(agentId: string) {
    if (!this.isManager(agentId)) return Promise.resolve();
    return this.reporter.reportAggregateChange(agentId);
  }

  private isManager(agentId: string): boolean {
    return this.descriptors.get(agentId)?.role === "manager";
  }
}

/** Runtime composition is built first, so its callbacks dereference the owner lazily. */
export function createLazySessionAttentionRuntimeHooks(
  getRuntime: () => SessionAttentionRuntime | undefined,
): SessionAttentionRuntimeHooks {
  return {
    reportStatusTransition: (input) => getRuntime()?.reportStatusTransition(input) ?? Promise.resolve(),
    suppressWorkingEpoch: (agentId) => getRuntime()?.suppressWorkingEpoch(agentId) ?? Promise.resolve(),
    retireSession: (agentId) => getRuntime()?.retireSession(agentId) ?? Promise.resolve(),
    reportPendingTurn: (agentId) => getRuntime()?.reportPendingTurn(agentId) ?? Promise.resolve(),
    reportContinuationAbandoned: (agentId) =>
      getRuntime()?.reportContinuationAbandoned(agentId) ?? Promise.resolve(),
  };
}
