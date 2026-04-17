import type { ServerEvent, TerminalDescriptor } from "@forge/protocol";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import type { PlaywrightDiscoveryService } from "../playwright/playwright-discovery-service.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import type { UnreadTracker } from "../swarm/unread-tracker.js";
import { resolveSessionAgentIdForUnread } from "./unread-utils.js";
import {
  DEFAULT_SUBSCRIBE_MESSAGE_COUNT,
  normalizeSubscribeMessageCount,
  sendSubscriptionBootstrap,
} from "./ws-bootstrap.js";
import { WebSocket, WebSocketServer } from "ws";

const BOOTSTRAP_SUBSCRIPTION_AGENT_ID = "__bootstrap_manager__";

interface DeliveredSnapshotVersions {
  agentsSnapshotVersion?: number;
  profilesSnapshotVersion?: number;
  playwrightDiscoveryVersion?: number;
}

export class WsSubscriptions {
  readonly subscriptions = new Map<WebSocket, string>();
  private readonly deliveredSnapshotVersions = new Map<WebSocket, DeliveredSnapshotVersions>();

  private readonly swarmManager: SwarmManager;
  private readonly integrationRegistry: IntegrationRegistryService | null;
  private readonly playwrightDiscovery: PlaywrightDiscoveryService | null;
  private readonly allowNonManagerSubscriptions: boolean;
  private readonly terminalService: TerminalService | null;
  private readonly listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
  private readonly unreadTracker: UnreadTracker | null;
  private readonly perf: SidebarPerfRecorder;
  private readonly send: (socket: WebSocket, event: ServerEvent) => number | null;
  private readonly getServer: () => WebSocketServer | null;

  constructor(options: {
    swarmManager: SwarmManager;
    integrationRegistry: IntegrationRegistryService | null;
    playwrightDiscovery: PlaywrightDiscoveryService | null;
    allowNonManagerSubscriptions: boolean;
    terminalService: TerminalService | null;
    listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
    unreadTracker: UnreadTracker | null;
    perf: SidebarPerfRecorder;
    send: (socket: WebSocket, event: ServerEvent) => number | null;
    getServer: () => WebSocketServer | null;
  }) {
    this.swarmManager = options.swarmManager;
    this.integrationRegistry = options.integrationRegistry;
    this.playwrightDiscovery = options.playwrightDiscovery;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    this.terminalService = options.terminalService;
    this.listTerminalsForSession = options.listTerminalsForSession;
    this.unreadTracker = options.unreadTracker;
    this.perf = options.perf;
    this.send = options.send;
    this.getServer = options.getServer;
  }

  clear(): void {
    this.subscriptions.clear();
    this.deliveredSnapshotVersions.clear();
  }

  remove(socket: WebSocket): void {
    this.subscriptions.delete(socket);
    this.deliveredSnapshotVersions.delete(socket);
  }

  getSubscribedAgentId(socket: WebSocket): string | undefined {
    return this.subscriptions.get(socket);
  }

  broadcastToSubscribed(event: ServerEvent): void {
    const wss = this.getServer();
    if (!wss) {
      return;
    }

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      const subscribedAgent = this.subscriptions.get(client);
      if (!subscribedAgent) {
        continue;
      }

      if (
        event.type === "conversation_message" ||
        event.type === "conversation_log" ||
        event.type === "agent_message" ||
        event.type === "agent_tool_call" ||
        event.type === "conversation_reset" ||
        event.type === "choice_request" ||
        event.type === "message_pinned"
      ) {
        if (subscribedAgent !== event.agentId) {
          continue;
        }
      }

      if (event.type === "telegram_status") {
        if (event.managerId) {
          const subscribedProfileId = this.resolveProfileIdForAgent(subscribedAgent);
          if (subscribedProfileId !== event.managerId) {
            continue;
          }
        }
      }

      const payloadBytes = this.send(client, event);
      if (payloadBytes !== null) {
        this.recordDeliveredSnapshotForEvent(client, event);
      }
    }
  }

  broadcastToSession(sessionAgentId: string, event: ServerEvent): void {
    const wss = this.getServer();
    if (!wss) {
      return;
    }

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      const subscribedAgent = this.subscriptions.get(client);
      if (!subscribedAgent) {
        continue;
      }

      const effectiveSessionAgentId = this.resolveTerminalScopeAgentId(subscribedAgent) ?? subscribedAgent;
      if (effectiveSessionAgentId !== sessionAgentId) {
        continue;
      }

      this.send(client, event);
    }
  }

  broadcastUnreadCountUpdate(sessionAgentId: string, count: number): void {
    const wss = this.getServer();
    if (!wss) {
      return;
    }

    const event: ServerEvent = {
      type: "unread_count_update",
      agentId: sessionAgentId,
      count,
    };

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (!this.subscriptions.has(client)) {
        continue;
      }

      this.send(client, event);
    }
  }

  hasActiveSubscription(agentId: string): boolean {
    for (const [socket, subscribedAgentId] of this.subscriptions.entries()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (subscribedAgentId === agentId) {
        return true;
      }
    }

    return false;
  }

  hasActiveSubscriptionForSession(sessionAgentId: string): boolean {
    for (const [socket, subscribedAgentId] of this.subscriptions.entries()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      const resolved = resolveSessionAgentIdForUnread(this.swarmManager, subscribedAgentId);
      if (subscribedAgentId === sessionAgentId || resolved === sessionAgentId) {
        return true;
      }
    }

    return false;
  }

  async handleSubscribe(
    socket: WebSocket,
    requestedAgentId?: string,
    requestedMessageCount?: number,
  ): Promise<void> {
    const managerId = this.resolveConfiguredManagerId();
    const targetAgentId =
      requestedAgentId ?? this.resolvePreferredManagerSubscriptionId() ?? this.resolveDefaultSubscriptionAgentId();
    const messageCount = requestedMessageCount !== undefined
      ? normalizeSubscribeMessageCount(requestedMessageCount)
      : undefined;

    if (!this.allowNonManagerSubscriptions && managerId && targetAgentId !== managerId) {
      this.send(socket, {
        type: "error",
        code: "SUBSCRIPTION_NOT_SUPPORTED",
        message: `Subscriptions are currently limited to ${managerId}.`
      });
      return;
    }

    const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
    const canBootstrapSubscription =
      !targetDescriptor &&
      !this.hasRunningManagers() &&
      (managerId ? requestedAgentId === managerId : requestedAgentId === undefined);

    if (!targetDescriptor && requestedAgentId && !canBootstrapSubscription) {
      this.send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${targetAgentId} does not exist.`
      });
      return;
    }

    this.subscriptions.set(socket, targetAgentId);

    const readSessionAgentId = resolveSessionAgentIdForUnread(this.swarmManager, targetAgentId) ?? targetAgentId;
    const readProfileId = this.resolveProfileIdForAgent(readSessionAgentId);
    if (readProfileId && this.unreadTracker) {
      const previousCount = this.unreadTracker.markRead(readProfileId, readSessionAgentId);
      if (previousCount > 0) {
        this.broadcastUnreadCountUpdate(readSessionAgentId, 0);
      }
    }

    this.sendSubscriptionBootstrap(socket, targetAgentId, messageCount);
  }

  resolveSubscribedAgentId(socket: WebSocket): string | undefined {
    const subscribedAgentId = this.subscriptions.get(socket);
    if (!subscribedAgentId) {
      return undefined;
    }

    if (this.swarmManager.getAgent(subscribedAgentId)) {
      return subscribedAgentId;
    }

    const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
    if (!fallbackAgentId) {
      return subscribedAgentId;
    }

    this.subscriptions.set(socket, fallbackAgentId);
    this.resetDeliveredSnapshotVersions(socket);
    this.sendSubscriptionBootstrap(socket, fallbackAgentId, DEFAULT_SUBSCRIBE_MESSAGE_COUNT);

    return fallbackAgentId;
  }

  resolveManagerContextAgentId(subscribedAgentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    if (!descriptor) {
      if (!this.hasRunningManagers()) {
        return this.resolveConfiguredManagerId() ?? subscribedAgentId;
      }
      return undefined;
    }

    return descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
  }

  resolveTerminalScopeAgentId(subscribedAgentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    if (!descriptor) {
      if (!this.hasRunningManagers()) {
        return this.resolveConfiguredManagerId() ?? subscribedAgentId;
      }
      return undefined;
    }

    if (descriptor.role === "manager") {
      return descriptor.profileId ?? descriptor.agentId;
    }

    const managerDescriptor = this.swarmManager.getAgent(descriptor.managerId);
    if (managerDescriptor?.role === "manager") {
      return managerDescriptor.profileId ?? managerDescriptor.agentId;
    }

    return descriptor.managerId;
  }

  resolveProfileIdForAgent(agentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(agentId);
    if (!descriptor) {
      return this.resolveConfiguredManagerId() ?? agentId;
    }

    if (descriptor.role === "manager") {
      return this.resolveProfileIdFromDescriptor(descriptor);
    }

    const managerDescriptor = this.swarmManager.getAgent(descriptor.managerId);
    if (managerDescriptor?.role === "manager") {
      return this.resolveProfileIdFromDescriptor(managerDescriptor);
    }

    return descriptor.managerId;
  }

  handleDeletedAgentSubscriptions(deletedAgentIds: Set<string>): void {
    for (const [socket, subscribedAgentId] of this.subscriptions.entries()) {
      if (!deletedAgentIds.has(subscribedAgentId)) {
        continue;
      }

      const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
      this.resetDeliveredSnapshotVersions(socket);
      if (!fallbackAgentId) {
        this.subscriptions.set(socket, this.resolveDefaultSubscriptionAgentId());
        continue;
      }

      this.subscriptions.set(socket, fallbackAgentId);
      this.sendSubscriptionBootstrap(socket, fallbackAgentId, DEFAULT_SUBSCRIBE_MESSAGE_COUNT);
    }
  }

  private sendSubscriptionBootstrap(
    socket: WebSocket,
    targetAgentId: string,
    requestedMessageCount?: number,
  ): void {
    const currentAgentsSnapshotVersion = this.swarmManager.getAgentsSnapshotVersion();
    const currentProfilesSnapshotVersion = this.swarmManager.getProfilesSnapshotVersion();
    const currentPlaywrightDiscoveryVersion = this.playwrightDiscovery?.getSnapshot().sequence;
    const deliveredVersions = this.deliveredSnapshotVersions.get(socket);

    const result = sendSubscriptionBootstrap({
      socket,
      targetAgentId,
      requestedMessageCount,
      swarmManager: this.swarmManager,
      integrationRegistry: this.integrationRegistry,
      playwrightDiscovery: this.playwrightDiscovery,
      terminalService: this.terminalService,
      listTerminalsForSession: this.listTerminalsForSession,
      unreadTracker: this.unreadTracker,
      perf: this.perf,
      send: this.send,
      resolveTerminalScopeAgentId: (agentId) => this.resolveTerminalScopeAgentId(agentId),
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      includeAgentsSnapshot: deliveredVersions?.agentsSnapshotVersion !== currentAgentsSnapshotVersion,
      includeProfilesSnapshot: deliveredVersions?.profilesSnapshotVersion !== currentProfilesSnapshotVersion,
      includePlaywrightDiscoveryBootstrap:
        currentPlaywrightDiscoveryVersion === undefined ||
        deliveredVersions?.playwrightDiscoveryVersion !== currentPlaywrightDiscoveryVersion,
    });

    if (result.agentsSnapshotSent) {
      this.setDeliveredSnapshotVersion(socket, "agentsSnapshotVersion", currentAgentsSnapshotVersion);
    }
    if (result.profilesSnapshotSent) {
      this.setDeliveredSnapshotVersion(socket, "profilesSnapshotVersion", currentProfilesSnapshotVersion);
    }
    if (result.playwrightDiscoveryBootstrapSent && currentPlaywrightDiscoveryVersion !== undefined) {
      this.setDeliveredSnapshotVersion(socket, "playwrightDiscoveryVersion", currentPlaywrightDiscoveryVersion);
    }
  }

  private resetDeliveredSnapshotVersions(socket: WebSocket): void {
    this.deliveredSnapshotVersions.delete(socket);
  }

  private setDeliveredSnapshotVersion(
    socket: WebSocket,
    surface: keyof DeliveredSnapshotVersions,
    version: number,
  ): void {
    const next = {
      ...(this.deliveredSnapshotVersions.get(socket) ?? {}),
      [surface]: version,
    } satisfies DeliveredSnapshotVersions;
    this.deliveredSnapshotVersions.set(socket, next);
  }

  private recordDeliveredSnapshotForEvent(socket: WebSocket, event: ServerEvent): void {
    if (event.type === "agents_snapshot") {
      this.setDeliveredSnapshotVersion(socket, "agentsSnapshotVersion", this.swarmManager.getAgentsSnapshotVersion());
      return;
    }

    if (event.type === "profiles_snapshot") {
      this.setDeliveredSnapshotVersion(socket, "profilesSnapshotVersion", this.swarmManager.getProfilesSnapshotVersion());
      return;
    }

    if (event.type === "playwright_discovery_snapshot" || event.type === "playwright_discovery_updated") {
      this.setDeliveredSnapshotVersion(socket, "playwrightDiscoveryVersion", event.snapshot.sequence);
    }
  }

  private resolveProfileIdFromDescriptor(descriptor: { agentId: string; profileId?: string }): string {
    return typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0
      ? descriptor.profileId.trim()
      : descriptor.agentId;
  }

  resolveDefaultSubscriptionAgentId(): string {
    return (
      this.resolvePreferredManagerSubscriptionId() ??
      this.resolveConfiguredManagerId() ??
      BOOTSTRAP_SUBSCRIPTION_AGENT_ID
    );
  }

  private resolvePreferredManagerSubscriptionId(): string | undefined {
    const managerId = this.resolveConfiguredManagerId();
    if (managerId) {
      const configuredManager = this.swarmManager.getAgent(managerId);
      if (configuredManager && this.isSubscribable(configuredManager.status)) {
        return managerId;
      }
    }

    const firstManager = this.swarmManager
      .listAgents()
      .find((agent) => agent.role === "manager" && this.isSubscribable(agent.status));

    return firstManager?.agentId;
  }

  private resolveConfiguredManagerId(): string | undefined {
    const managerId = this.swarmManager.getConfig().managerId;
    if (typeof managerId !== "string") {
      return undefined;
    }

    const normalized = managerId.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private hasRunningManagers(): boolean {
    return this.swarmManager
      .listAgents()
      .some((agent) => agent.role === "manager" && this.isSubscribable(agent.status));
  }

  private isSubscribable(status: string): boolean {
    return status === "idle" || status === "streaming";
  }
}
