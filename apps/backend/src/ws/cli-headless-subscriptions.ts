import type {
  CliAgentStatusSnapshot,
  CliHeadlessReadyEvent,
  CliHeadlessSubscriptionTarget,
  CliPendingChoicesSnapshotEvent,
  CliServerEvent,
  CliSubscribeHeadlessCommand,
  ManagerProfile,
  ServerEvent,
} from "@forge/protocol";
import { isSystemProfile } from "@forge/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { AgentDescriptor } from "../swarm/types.js";
import { buildCliCapabilities } from "./cli-capabilities.js";
import { listCliChoiceOwnersForSession } from "./cli-choice-owners.js";
import { toPublicCliAgentDescriptor } from "./cli-public-descriptors.js";

export type CliSendEvent = (socket: WebSocket, event: CliServerEvent | ServerEvent) => void;

export class CliHeadlessSubscriptions {
  private readonly subscriptions = new Map<WebSocket, string>();
  private readonly latestStatus = new Map<string, CliAgentStatusSnapshot>();
  private wss: WebSocketServer | null = null;

  constructor(
    private readonly swarmManager: SwarmManager,
    private readonly send: CliSendEvent,
  ) {}

  attach(server: WebSocketServer): void {
    this.wss = server;
  }

  clear(): void {
    this.subscriptions.clear();
    this.latestStatus.clear();
  }

  remove(socket: WebSocket): void {
    this.subscriptions.delete(socket);
  }

  getSubscribedSessionAgentId(socket: WebSocket): string | undefined {
    return this.subscriptions.get(socket);
  }

  async subscribe(socket: WebSocket, command: CliSubscribeHeadlessCommand): Promise<void> {
    const targetAgent = this.resolveSubscriptionTarget(command);
    if (!targetAgent) {
      this.send(socket, {
        type: "cli_request_error",
        requestId: command.requestId,
        commandType: command.type,
        code: "unknown_session",
        message: "No matching session found for headless subscription.",
        status: 404,
      });
      return;
    }

    this.subscriptions.set(socket, targetAgent.agentId);
    this.send(socket, this.buildHeadlessReady(command, targetAgent));
    this.send(socket, await this.swarmManager.getSessionTaskStateSnapshot(targetAgent.agentId));
  }

  broadcast(event: ServerEvent): void {
    if (event.type === "agent_status") {
      this.latestStatus.set(event.agentId, {
        agentId: event.agentId,
        status: event.status,
        pendingCount: event.pendingCount,
        ...(event.contextUsage !== undefined ? { contextUsage: { ...event.contextUsage } } : {}),
        ...(event.contextRecoveryInProgress !== undefined
          ? { contextRecoveryInProgress: event.contextRecoveryInProgress }
          : {}),
        ...(event.streamingStartedAt !== undefined ? { streamingStartedAt: event.streamingStartedAt } : {}),
      });
    }

    const wss = this.wss;
    if (!wss) {
      return;
    }

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      const sessionAgentId = this.subscriptions.get(client);
      if (!sessionAgentId) {
        continue;
      }

      if (!this.eventBelongsToSession(event, sessionAgentId)) {
        continue;
      }

      this.send(client, event);
      if (event.type === "choice_request") {
        queueMicrotask(() => {
          if (client.readyState !== WebSocket.OPEN || this.subscriptions.get(client) !== sessionAgentId) {
            return;
          }
          this.send(client, this.buildPendingChoicesSnapshot(sessionAgentId));
        });
      }
    }
  }

  buildPendingChoicesSnapshot(sessionAgentId: string, requestId?: string): CliPendingChoicesSnapshotEvent {
    return {
      type: "cli_pending_choices_snapshot",
      sessionAgentId,
      choices: listCliChoiceOwnersForSession(this.swarmManager, sessionAgentId),
      ...(requestId !== undefined ? { requestId } : {}),
    };
  }

  private buildHeadlessReady(
    command: CliSubscribeHeadlessCommand,
    targetAgent: AgentDescriptor & { role: "manager" },
  ): CliHeadlessReadyEvent {
    const profile = this.resolveProfile(targetAgent.profileId ?? targetAgent.agentId);
    const activeTools = this.swarmManager.getSessionActiveToolsSnapshot(targetAgent.agentId).activeTools;
    const subscribed: CliHeadlessSubscriptionTarget = {
      agentId: targetAgent.agentId,
      ...(profile ? { profileId: profile.profileId } : targetAgent.profileId ? { profileId: targetAgent.profileId } : {}),
    };

    return {
      type: "headless_ready",
      requestId: command.requestId,
      serverTime: new Date().toISOString(),
      capabilities: buildCliCapabilities(this.swarmManager.getConfig().runtimeTarget),
      subscribed,
      targetAgent: toPublicCliAgentDescriptor(targetAgent),
      ...(profile ? { profile: cloneProfile(profile) } : {}),
      pendingChoices: listCliChoiceOwnersForSession(this.swarmManager, targetAgent.agentId),
      workers: this.swarmManager.listWorkersForSession(targetAgent.agentId).map(toPublicCliAgentDescriptor),
      activeTools,
      status: this.buildStatusSnapshot(targetAgent),
    };
  }

  private resolveSubscriptionTarget(command: CliSubscribeHeadlessCommand): (AgentDescriptor & { role: "manager" }) | undefined {
    if (command.agentId !== undefined) {
      const agentId = normalizeIdentifier(command.agentId);
      if (!agentId) {
        return undefined;
      }

      const descriptor = this.swarmManager.getAgent(agentId);
      if (!this.isCliSessionDescriptor(descriptor)) {
        return undefined;
      }
      return descriptor;
    }

    const profileId = normalizeIdentifier(command.profileId);
    const candidates = this.swarmManager
      .listAgents()
      .filter((agent): agent is AgentDescriptor & { role: "manager" } => this.isCliSessionDescriptor(agent))
      .filter((agent) => !profileId || (agent.profileId ?? agent.agentId) === profileId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return candidates[0];
  }

  private isCliSessionDescriptor(descriptor: AgentDescriptor | undefined): descriptor is AgentDescriptor & { role: "manager" } {
    if (!descriptor || descriptor.role !== "manager" || descriptor.sessionSurface === "collab") {
      return false;
    }

    const profile = this.resolveProfile(descriptor.profileId ?? descriptor.agentId);
    return profile ? !isSystemProfile(profile) : (descriptor.profileId ?? descriptor.agentId) !== "cortex";
  }

  private eventBelongsToSession(event: ServerEvent, sessionAgentId: string): boolean {
    switch (event.type) {
      case "session_workers_snapshot":
      case "session_active_tools_snapshot":
      case "session_task_state_snapshot":
      case "cli_pending_choices_snapshot":
        return event.sessionAgentId === sessionAgentId;

      case "agent_status":
        return event.agentId === sessionAgentId || event.managerId === sessionAgentId;

      case "conversation_message":
      case "conversation_log":
      case "agent_message":
      case "agent_tool_call":
      case "choice_request":
      case "work_plan_created":
      case "model_cache_observation":
      case "conversation_reset":
      case "message_pinned":
        return this.resolveSessionAgentIdForAgent(event.agentId) === sessionAgentId;

      default:
        return false;
    }
  }

  private resolveSessionAgentIdForAgent(agentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(agentId);
    if (!descriptor) {
      return undefined;
    }

    return descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
  }

  private buildStatusSnapshot(agent: AgentDescriptor & { role: "manager" }): CliHeadlessReadyEvent["status"] {
    const latest = this.latestStatus.get(agent.agentId);
    if (latest) {
      return {
        ...latest,
        ...(latest.contextUsage !== undefined ? { contextUsage: { ...latest.contextUsage } } : {}),
      };
    }

    return {
      agentId: agent.agentId,
      status: agent.status,
      pendingCount: 0,
      ...(agent.contextUsage !== undefined ? { contextUsage: { ...agent.contextUsage } } : {}),
      ...(agent.streamingStartedAt !== undefined ? { streamingStartedAt: agent.streamingStartedAt } : {}),
    };
  }

  private resolveProfile(profileId: string | undefined): ManagerProfile | undefined {
    const normalizedProfileId = normalizeIdentifier(profileId);
    if (!normalizedProfileId) {
      return undefined;
    }

    return this.swarmManager.listProfiles().find((profile) => profile.profileId === normalizedProfileId);
  }
}

function cloneProfile(profile: ManagerProfile): ManagerProfile {
  return {
    ...profile,
    defaultModel: { ...profile.defaultModel },
  };
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
