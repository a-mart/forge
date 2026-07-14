import type {
  ModelCacheObservationEvent,
  ServerEvent,
  SessionActiveToolsSnapshotEvent,
  SessionWorkersSnapshotEvent,
} from "@forge/protocol";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import type { ConversationProjector } from "./conversation-projector.js";
import type { SessionActiveToolsState } from "./session-active-tools.js";
import type { SwarmObservabilityCoordinator } from "./swarm-observability-coordinator.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentMessageEvent,
  AgentStatus,
  AgentStatusEvent,
  ChoiceRequestEvent,
  ConversationMessageEvent,
  ManagerProfile,
  SessionLifecycleEvent,
} from "./types.js";
import {
  cloneProjectAgentInfoValue,
  normalizeContextUsage,
  normalizeOptionalAgentId,
} from "./swarm-manager-utils.js";

export interface SwarmEventCoordinatorHost {
  emit(eventName: string, event: ServerEvent | SessionLifecycleEvent): void;
  getDescriptor(agentId: string): AgentDescriptor | undefined;
  getRuntime(agentId: string): SwarmAgentRuntime | undefined;
  listManagerAgents(): AgentDescriptor[];
  listProfiles(): ManagerProfile[];
  upsertDescriptor(descriptor: AgentDescriptor): void;
}

export interface SwarmEventCoordinatorOptions {
  host: SwarmEventCoordinatorHost;
  conversationProjector: ConversationProjector;
  observability: SwarmObservabilityCoordinator;
  sessionActiveTools: SessionActiveToolsState;
  now: () => string;
}

/** Owns event projection, snapshot coalescing/versioning, and session activity timestamps. */
export class SwarmEventCoordinator {
  private pendingAgentsSnapshotEmit = false;
  private agentsSnapshotVersion = 0;
  private profilesSnapshotVersion = 0;

  constructor(private readonly options: SwarmEventCoordinatorOptions) {}

  getAgentsSnapshotVersion(): number {
    return this.agentsSnapshotVersion;
  }

  getProfilesSnapshotVersion(): number {
    return this.profilesSnapshotVersion;
  }

  emitConversationMessage(
    event: ConversationMessageEvent,
    options?: {
      routingReceipt?: import("./session/message-routing-receipts.js").MessageRoutingReceiptRecord;
    },
  ): void {
    this.options.conversationProjector.emitConversationMessage(event, options);
    this.options.observability.recordUserVisibleMessage(event);
  }

  emitAgentMessage(event: AgentMessageEvent): void {
    this.options.conversationProjector.emitAgentMessage(event);
  }

  emitChoiceRequest(event: ChoiceRequestEvent): void {
    const historyAgentId = event.sessionAgentId?.trim() || event.agentId;
    this.options.conversationProjector.emitChoiceRequest(event, { historyAgentId });
  }

  emitModelCacheObservation(event: ModelCacheObservationEvent): void {
    this.options.conversationProjector.emitModelCacheObservation(event);
  }

  emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.options.conversationProjector.emitConversationReset(agentId, reason);
  }

  emitMessagePinned(agentId: string, messageId: string, pinned: boolean, timestamp: string): void {
    this.options.host.emit("message_pinned", {
      type: "message_pinned",
      agentId,
      messageId,
      pinned,
      timestamp,
    });
  }

  markSessionActivity(agentId: string, timestamp?: string): void {
    const descriptor = this.resolveSessionDescriptor(agentId);
    if (!descriptor) {
      return;
    }

    const normalizedTimestamp = normalizeOptionalAgentId(timestamp) ?? this.options.now();
    if (descriptor.updatedAt.localeCompare(normalizedTimestamp) >= 0) {
      return;
    }

    descriptor.updatedAt = normalizedTimestamp;
    this.options.host.upsertDescriptor(descriptor);
    this.emitAgentsSnapshot();
  }

  markSessionUserMessageActivity(agentId: string, timestamp: string): void {
    const descriptor = this.resolveSessionDescriptor(agentId);
    if (!descriptor) {
      return;
    }

    if (descriptor.lastUserMessageAt && descriptor.lastUserMessageAt.localeCompare(timestamp) >= 0) {
      return;
    }

    descriptor.lastUserMessageAt = timestamp;
    this.options.host.upsertDescriptor(descriptor);
    this.emitAgentsSnapshot();
  }

  emitSessionActiveToolsSnapshot(snapshot: SessionActiveToolsSnapshotEvent | null): void {
    if (snapshot) {
      this.options.host.emit("session_active_tools_snapshot", snapshot);
    }
  }

  emitSessionWorkersSnapshot(sessionAgentId: string, workers: AgentDescriptor[]): void {
    const payload: SessionWorkersSnapshotEvent = {
      type: "session_workers_snapshot",
      sessionAgentId,
      workers,
    };
    this.options.host.emit("session_workers_snapshot", payload);
  }

  emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage,
  ): void {
    const descriptor = this.options.host.getDescriptor(agentId);
    const resolvedContextUsage = normalizeContextUsage(contextUsage ?? descriptor?.contextUsage);
    const runtime = this.options.host.getRuntime(agentId);
    const contextRecoveryInProgress = runtime?.isContextRecoveryInProgress?.() === true;
    const payload: AgentStatusEvent = {
      type: "agent_status",
      agentId,
      ...(descriptor?.role === "worker" ? { managerId: descriptor.managerId } : {}),
      status,
      pendingCount,
      ...(resolvedContextUsage ? { contextUsage: resolvedContextUsage } : {}),
      ...(contextRecoveryInProgress ? { contextRecoveryInProgress } : {}),
      ...(descriptor?.streamingStartedAt != null
        ? { streamingStartedAt: descriptor.streamingStartedAt }
        : {}),
    };

    this.options.host.emit("agent_status", payload);
    for (const snapshot of this.options.sessionActiveTools.recordAgentStatus(payload, descriptor)) {
      this.emitSessionActiveToolsSnapshot(snapshot);
    }
  }

  emitAgentsSnapshot(): void {
    if (this.pendingAgentsSnapshotEmit) {
      return;
    }

    this.pendingAgentsSnapshotEmit = true;
    queueMicrotask(() => {
      if (!this.pendingAgentsSnapshotEmit) {
        return;
      }

      this.pendingAgentsSnapshotEmit = false;
      this.agentsSnapshotVersion += 1;
      this.options.host.emit("agents_snapshot", {
        type: "agents_snapshot",
        agents: this.options.host.listManagerAgents(),
      });
    });
  }

  emitProfilesSnapshot(): void {
    this.profilesSnapshotVersion += 1;
    this.options.host.emit("profiles_snapshot", {
      type: "profiles_snapshot",
      profiles: this.options.host.listProfiles(),
    });
  }

  emitSessionProjectAgentUpdated(
    agentId: string,
    profileId: string,
    projectAgent: AgentDescriptor["projectAgent"] | null,
  ): void {
    this.options.host.emit("session_project_agent_updated", {
      type: "session_project_agent_updated",
      agentId,
      profileId,
      projectAgent: cloneProjectAgentInfoValue(projectAgent) ?? null,
    });
  }

  emitSessionLifecycle(event: SessionLifecycleEvent): void {
    this.options.host.emit("session_lifecycle", event);
  }

  private resolveSessionDescriptor(agentId: string): (AgentDescriptor & { role: "manager" }) | undefined {
    const descriptor = this.options.host.getDescriptor(agentId);
    if (!descriptor) {
      return undefined;
    }

    if (descriptor.role === "manager") {
      return descriptor as AgentDescriptor & { role: "manager" };
    }

    const sessionDescriptor = this.options.host.getDescriptor(descriptor.managerId);
    return sessionDescriptor?.role === "manager"
      ? sessionDescriptor as AgentDescriptor & { role: "manager" }
      : undefined;
  }
}
