import { isNonRunningAgentStatus, transitionAgentStatus } from "../agent-state-machine.js";
import type {
  WorkerActivityStateLike,
  WorkerStallStateLike
} from "./worker-health-types.js";
import type { AgentContextUsage, AgentDescriptor, AgentStatus } from "../types.js";
import {
  areContextUsagesEqual,
  normalizeContextUsage
} from "../swarm-manager-utils.js";

export interface RuntimeStatusProjectorDeps {
  descriptors: Map<string, AgentDescriptor>;
  workerStallState: Map<string, WorkerStallStateLike>;
  workerActivityState: Map<string, WorkerActivityStateLike>;
  now: () => string;
  patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>
  ): Promise<AgentDescriptor | undefined>;
  updateSessionMetaForWorkerDescriptor(descriptor: AgentDescriptor): Promise<void>;
  refreshSessionMetaStatsBySessionId(sessionAgentId: string): Promise<void>;
  refreshSessionMetaStats(descriptor: AgentDescriptor): Promise<void>;
  saveStore(): Promise<void>;
  emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void;
  emitAgentsSnapshot(): void;
  logDebug(message: string, details?: unknown): void;
  handleManagerStatusTransition(
    descriptor: AgentDescriptor,
    status: AgentStatus,
    pendingCount: number
  ): void | Promise<void>;
  applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: "idle_transition"
  ): Promise<"recycled" | "deferred" | "none">;
}

export interface RuntimeStatusProjectionInput {
  agentId: string;
  status: AgentStatus;
  pendingCount: number;
  contextUsage?: AgentContextUsage;
}

export class RuntimeStatusProjector {
  constructor(private readonly deps: RuntimeStatusProjectorDeps) {}

  async projectStatus(input: RuntimeStatusProjectionInput): Promise<void> {
    const { agentId, status, pendingCount, contextUsage } = input;
    const descriptor = this.deps.descriptors.get(agentId);
    if (!descriptor) return;

    const normalizedContextUsage = normalizeContextUsage(contextUsage);
    const contextUsageChanged = !areContextUsagesEqual(descriptor.contextUsage, normalizedContextUsage);
    let shouldPersist = false;
    const descriptorPatch: Partial<AgentDescriptor> = {};

    if (contextUsageChanged) {
      descriptorPatch.contextUsage = normalizedContextUsage;
    }

    const previousStatus = descriptor.status;
    const nextStatus = transitionAgentStatus(previousStatus, status);
    const statusChanged = previousStatus !== nextStatus;
    if (statusChanged) {
      descriptorPatch.status = nextStatus;
      descriptorPatch.updatedAt = this.deps.now();
      shouldPersist = true;
    }

    if (previousStatus !== "streaming" && nextStatus === "streaming") {
      descriptorPatch.streamingStartedAt = Date.now();
      shouldPersist = true;
    }

    const effectiveContextUsage = Object.prototype.hasOwnProperty.call(descriptorPatch, "contextUsage")
      ? descriptorPatch.contextUsage
      : descriptor.contextUsage;
    if (isNonRunningAgentStatus(nextStatus) && effectiveContextUsage) {
      descriptorPatch.contextUsage = undefined;
      shouldPersist = true;
    }

    const updatedDescriptor = Object.keys(descriptorPatch).length > 0
      ? await this.deps.patchDescriptorFromRuntimeStatus(agentId, descriptorPatch) ?? descriptor
      : descriptor;

    if (updatedDescriptor.role === "worker") {
      const effectiveStatus = nextStatus;
      if (effectiveStatus === "streaming" && !this.deps.workerStallState.has(agentId)) {
        this.deps.workerStallState.set(agentId, {
          lastProgressAt: Date.now(),
          nudgeSent: false,
          nudgeSentAt: null,
          lastToolName: null,
          lastToolInput: null,
          lastToolOutput: null,
          lastDetailedReportAt: null
        });
      } else if (effectiveStatus !== "streaming" && this.deps.workerStallState.has(agentId)) {
        this.deps.workerStallState.delete(agentId);
        this.deps.workerActivityState.delete(agentId);
      }
    }

    if (updatedDescriptor.role === "worker" && (statusChanged || contextUsageChanged || nextStatus === "terminated")) {
      await this.deps.updateSessionMetaForWorkerDescriptor(updatedDescriptor);
      await this.deps.refreshSessionMetaStatsBySessionId(updatedDescriptor.managerId);
    } else if (updatedDescriptor.role === "manager" && statusChanged) {
      await this.deps.refreshSessionMetaStats(updatedDescriptor);
    }

    if (shouldPersist) {
      await this.deps.saveStore();
    }

    this.deps.emitStatus(agentId, status, pendingCount, updatedDescriptor.contextUsage);
    this.deps.logDebug("runtime:status", {
      agentId,
      status,
      pendingCount,
      contextUsage: updatedDescriptor.contextUsage
    });

    if (updatedDescriptor.role === "manager") {
      await this.deps.handleManagerStatusTransition(updatedDescriptor, nextStatus, pendingCount);
      if (nextStatus === "idle" && pendingCount === 0) {
        const recycleDisposition = await this.deps.applyManagerRuntimeRecyclePolicy(updatedDescriptor.agentId, "idle_transition");
        if (recycleDisposition === "recycled") {
          await this.deps.saveStore();
          this.deps.emitAgentsSnapshot();
        }
      }
    }
  }
}
