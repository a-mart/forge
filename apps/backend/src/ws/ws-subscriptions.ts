import { isSystemProfile, type ProjectPresenceViewer, type ServerEvent, type TerminalDescriptor } from "@forge/protocol";
import { getCollaborationSocketAuthContext } from "../collaboration/auth/collaboration-auth-middleware.js";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import { isCollaborationServerRuntimeTarget } from "../runtime-target.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import type { UnreadTracker } from "../swarm/unread-tracker.js";
import { filterBuilderVisibleAgents, filterBuilderVisibleProfiles } from "./builder-visibility.js";
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
}

interface SocketBootstrapControllerState {
  generation: number;
  latestTargetAgentId: string;
  latestMessageCount?: number;
  activePromise: Promise<void> | null;
  activeTargetAgentId: string | null;
  activeGeneration: number;
  lastCompletedGeneration: number;
  lastCompletedTargetAgentId: string | null;
}

export class WsSubscriptions {
  readonly subscriptions = new Map<WebSocket, string>();
  private readonly deliveredSnapshotVersions = new Map<WebSocket, DeliveredSnapshotVersions>();
  private readonly bootstrapControllers = new Map<WebSocket, SocketBootstrapControllerState>();

  private readonly swarmManager: SwarmManager;
  private readonly integrationRegistry: IntegrationRegistryService | null;
  private readonly allowNonManagerSubscriptions: boolean;
  private readonly terminalService: TerminalService | null;
  private readonly listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
  private readonly unreadTracker: UnreadTracker | null;
  private readonly perf: SidebarPerfRecorder;
  private readonly send: (socket: WebSocket, event: ServerEvent) => number | null;
  private readonly sendBootstrapCritical: (
    socket: WebSocket,
    event: ServerEvent,
  ) => Promise<number | null>;
  private readonly getServer: () => WebSocketServer | null;

  constructor(options: {
    swarmManager: SwarmManager;
    integrationRegistry: IntegrationRegistryService | null;
    allowNonManagerSubscriptions: boolean;
    terminalService: TerminalService | null;
    listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
    unreadTracker: UnreadTracker | null;
    perf: SidebarPerfRecorder;
    send: (socket: WebSocket, event: ServerEvent) => number | null;
    sendBootstrapCritical?: (socket: WebSocket, event: ServerEvent) => Promise<number | null>;
    getServer: () => WebSocketServer | null;
  }) {
    this.swarmManager = options.swarmManager;
    this.integrationRegistry = options.integrationRegistry;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    this.terminalService = options.terminalService;
    this.listTerminalsForSession = options.listTerminalsForSession;
    this.unreadTracker = options.unreadTracker;
    this.perf = options.perf;
    this.send = options.send;
    // Falls back to the plain send when a backpressure-aware sender isn't wired (e.g. in tests).
    this.sendBootstrapCritical =
      options.sendBootstrapCritical ?? ((socket, event) => Promise.resolve(options.send(socket, event)));
    this.getServer = options.getServer;
  }

  clear(): void {
    this.subscriptions.clear();
    this.deliveredSnapshotVersions.clear();
    this.bootstrapControllers.clear();
  }

  /**
   * Wave R presence (SPEC §4.7): broadcast the full viewer snapshot for a
   * session to every socket subscribed to it. Viewer identities come from
   * the collaboration auth contexts attached at upgrade; builder-runtime
   * sockets carry none, so local instances emit nothing.
   */
  private emitProjectPresence(sessionAgentId: string): void {
    // Presence is a collaboration-server feature: local builder sockets have
    // no member identities to report.
    if (!isCollaborationServerRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
      return;
    }

    const viewersByUserId = new Map<string, ProjectPresenceViewer>();
    const subscribers: WebSocket[] = [];
    for (const [socket, subscribedAgentId] of this.subscriptions.entries()) {
      if (subscribedAgentId !== sessionAgentId || socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      subscribers.push(socket);
      const authContext = getCollaborationSocketAuthContext(socket);
      if (!authContext) {
        continue;
      }
      viewersByUserId.set(authContext.userId, {
        userId: authContext.userId,
        displayName: authContext.name,
        role: authContext.role,
      });
    }

    const event: ServerEvent = {
      type: "project_presence",
      sessionAgentId,
      profileId: this.resolveProfileIdForAgent(sessionAgentId),
      viewers: [...viewersByUserId.values()],
    };

    for (const socket of subscribers) {
      this.send(socket, event);
    }
  }

  remove(socket: WebSocket): void {
    const previousAgentId = this.subscriptions.get(socket);
    this.removeInternal(socket);
    if (previousAgentId) {
      this.emitProjectPresence(previousAgentId);
    }
  }

  private removeInternal(socket: WebSocket): void {
    this.subscriptions.delete(socket);
    this.deliveredSnapshotVersions.delete(socket);
    this.bootstrapControllers.delete(socket);
  }

  getSubscribedAgentId(socket: WebSocket): string | undefined {
    return this.subscriptions.get(socket);
  }

  broadcastToSubscribed(event: ServerEvent): void {
    const wss = this.getServer();
    if (!wss) {
      return;
    }

    const outboundEvent = this.filterBuilderSnapshotEvent(event);

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      const subscribedAgent = this.subscriptions.get(client);
      if (!subscribedAgent) {
        continue;
      }

      if (
        outboundEvent.type === "conversation_message" ||
        outboundEvent.type === "conversation_log" ||
        outboundEvent.type === "agent_message" ||
        outboundEvent.type === "agent_tool_call" ||
        outboundEvent.type === "conversation_reset" ||
        outboundEvent.type === "choice_request" ||
        outboundEvent.type === "work_plan_created" ||
        outboundEvent.type === "model_cache_observation" ||
        outboundEvent.type === "message_pinned"
      ) {
        if (!this.shouldDeliverConversationEventToSubscriber(outboundEvent, subscribedAgent)) {
          continue;
        }
      }

      if (outboundEvent.type === "telegram_status") {
        if (outboundEvent.managerId) {
          const subscribedProfileId = this.resolveProfileIdForAgent(subscribedAgent);
          if (subscribedProfileId !== outboundEvent.managerId) {
            continue;
          }
        }
      }

      const payloadBytes = this.send(client, outboundEvent);
      if (payloadBytes !== null) {
        this.recordDeliveredSnapshotForEvent(client, outboundEvent);
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

  broadcastToExactSubscription(agentId: string, event: ServerEvent): void {
    const wss = this.getServer();
    if (!wss) {
      return;
    }

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (this.subscriptions.get(client) !== agentId) {
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

    const previousAgentId = this.subscriptions.get(socket);
    this.subscriptions.set(socket, targetAgentId);
    if (previousAgentId && previousAgentId !== targetAgentId) {
      this.emitProjectPresence(previousAgentId);
    }

    const readSessionAgentId = resolveSessionAgentIdForUnread(this.swarmManager, targetAgentId) ?? targetAgentId;
    const readProfileId = this.resolveProfileIdForAgent(readSessionAgentId);
    if (readProfileId && this.unreadTracker) {
      const previousCount = this.unreadTracker.markRead(readProfileId, readSessionAgentId);
      if (previousCount > 0) {
        this.broadcastUnreadCountUpdate(readSessionAgentId, 0);
      }
    }

    await this.requestSubscriptionBootstrap(socket, targetAgentId, messageCount);
    this.emitProjectPresence(targetAgentId);
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
    void this.requestSubscriptionBootstrap(socket, fallbackAgentId, DEFAULT_SUBSCRIBE_MESSAGE_COUNT);

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

  resolveTaskSnapshotSessionAgentId(subscribedAgentId: string): string | undefined {
    if (this.swarmManager.isWorkPlansEnabled?.() === false) {
      return undefined;
    }

    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    return descriptor?.role === "manager" ? descriptor.agentId : undefined;
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
      this.requestSubscriptionBootstrap(socket, fallbackAgentId, DEFAULT_SUBSCRIBE_MESSAGE_COUNT);
    }
  }

  private requestSubscriptionBootstrap(
    socket: WebSocket,
    targetAgentId: string,
    requestedMessageCount?: number,
  ): Promise<void> {
    let state = this.bootstrapControllers.get(socket);
    if (!state) {
      state = {
        generation: 0,
        latestTargetAgentId: targetAgentId,
        latestMessageCount: requestedMessageCount,
        activePromise: null,
        activeTargetAgentId: null,
        activeGeneration: 0,
        lastCompletedGeneration: 0,
        lastCompletedTargetAgentId: null,
      };
      this.bootstrapControllers.set(socket, state);
    }

    if (state.activePromise && state.activeTargetAgentId === targetAgentId) {
      if (requestedMessageCount !== undefined) {
        state.latestMessageCount = requestedMessageCount;
      }
      return state.activePromise;
    }

    state.generation += 1;
    state.latestTargetAgentId = targetAgentId;
    state.latestMessageCount = requestedMessageCount;

    if (!state.activePromise) {
      state.activePromise = this.runBootstrapControllerDrain(socket).catch((error) => {
        console.warn("[swarm] ws:subscription_bootstrap_failed", {
          targetAgentId: state.latestTargetAgentId,
          requestedMessageCount: state.latestMessageCount ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return state.activePromise;
  }

  private async runBootstrapControllerDrain(socket: WebSocket): Promise<void> {
    const state = this.bootstrapControllers.get(socket);
    if (!state) {
      return;
    }

    try {
      while (true) {
        const generation = state.generation;
        const targetAgentId = state.latestTargetAgentId;
        const requestedMessageCount = state.latestMessageCount;
        state.activeTargetAgentId = targetAgentId;
        state.activeGeneration = generation;

        const shouldContinue = (): boolean => {
          const current = this.bootstrapControllers.get(socket);
          return (
            current !== undefined &&
            current.generation === generation &&
            current.latestTargetAgentId === targetAgentId
          );
        };

        try {
          await this.sendSubscriptionBootstrap(socket, targetAgentId, requestedMessageCount, shouldContinue);
        } catch (error) {
          if (shouldContinue()) {
            throw error;
          }
        }

        if (shouldContinue()) {
          state.lastCompletedGeneration = generation;
          state.lastCompletedTargetAgentId = targetAgentId;
        }

        if (!shouldContinue()) {
          continue;
        }

        if (state.generation === generation) {
          break;
        }

        if (state.latestTargetAgentId === targetAgentId) {
          break;
        }
      }
    } finally {
      state.activePromise = null;
      state.activeTargetAgentId = null;
      state.activeGeneration = 0;

      const needsFollowUp =
        state.generation > state.lastCompletedGeneration &&
        state.latestTargetAgentId !== state.lastCompletedTargetAgentId;

      if (needsFollowUp) {
        state.activePromise = this.runBootstrapControllerDrain(socket);
      }
    }
  }

  private async sendSubscriptionBootstrap(
    socket: WebSocket,
    targetAgentId: string,
    requestedMessageCount?: number,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    const currentAgentsSnapshotVersion = this.swarmManager.getAgentsSnapshotVersion();
    const currentProfilesSnapshotVersion = this.swarmManager.getProfilesSnapshotVersion();
    const deliveredVersions = this.deliveredSnapshotVersions.get(socket);

    const result = await sendSubscriptionBootstrap({
      socket,
      targetAgentId,
      requestedMessageCount,
      swarmManager: this.swarmManager,
      integrationRegistry: this.integrationRegistry,
      terminalService: this.terminalService,
      listTerminalsForSession: this.listTerminalsForSession,
      unreadTracker: this.unreadTracker,
      perf: this.perf,
      // Bootstrap-critical events flow-control (await drain) instead of dropping under backpressure.
      send: this.sendBootstrapCritical,
      resolveTerminalScopeAgentId: (agentId) => this.resolveTerminalScopeAgentId(agentId),
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      resolveTaskSnapshotSessionAgentId: (agentId) => this.resolveTaskSnapshotSessionAgentId(agentId),
      includeAgentsSnapshot: deliveredVersions?.agentsSnapshotVersion !== currentAgentsSnapshotVersion,
      includeProfilesSnapshot: deliveredVersions?.profilesSnapshotVersion !== currentProfilesSnapshotVersion,
      shouldContinue,
    });

    if (shouldContinue && !shouldContinue()) {
      return;
    }

    if (result.agentsSnapshotSent) {
      this.setDeliveredSnapshotVersion(socket, "agentsSnapshotVersion", currentAgentsSnapshotVersion);
    }
    if (result.profilesSnapshotSent) {
      this.setDeliveredSnapshotVersion(socket, "profilesSnapshotVersion", currentProfilesSnapshotVersion);
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
    }
  }

  private resolveProfileIdFromDescriptor(descriptor: { agentId: string; profileId?: string }): string {
    return typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0
      ? descriptor.profileId.trim()
      : descriptor.agentId;
  }

  private shouldDeliverConversationEventToSubscriber(
    event: Extract<
      ServerEvent,
      | { type: "conversation_message" }
      | { type: "conversation_log" }
      | { type: "agent_message" }
      | { type: "agent_tool_call" }
      | { type: "conversation_reset" }
      | { type: "choice_request" }
      | { type: "work_plan_created" }
      | { type: "model_cache_observation" }
      | { type: "message_pinned" }
    >,
    subscribedAgent: string,
  ): boolean {
    if (subscribedAgent === event.agentId) {
      return true;
    }

    if (event.type === "choice_request") {
      const sessionAgentId = event.sessionAgentId?.trim();
      return sessionAgentId !== undefined && sessionAgentId.length > 0 && subscribedAgent === sessionAgentId;
    }

    return false;
  }

  private filterBuilderSnapshotEvent(event: ServerEvent): ServerEvent {
    if (event.type === "profiles_snapshot") {
      return {
        ...event,
        profiles: filterBuilderVisibleProfiles(event.profiles),
      };
    }

    if (event.type === "agents_snapshot") {
      const systemProfileIds = new Set(
        this.swarmManager
          .listProfiles()
          .filter((profile) => isSystemProfile(profile))
          .map((profile) => profile.profileId),
      );

      return {
        ...event,
        agents: filterBuilderVisibleAgents(event.agents, systemProfileIds),
      };
    }

    return event;
  }

  resolveDefaultSubscriptionAgentId(): string {
    const preferredManagerId = this.resolvePreferredManagerSubscriptionId();
    if (preferredManagerId) {
      return preferredManagerId;
    }

    const configuredManagerId = this.resolveConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.swarmManager.getAgent(configuredManagerId);
      if (!configuredManager || configuredManager.role === "manager") {
        return configuredManagerId;
      }
    }

    return BOOTSTRAP_SUBSCRIPTION_AGENT_ID;
  }

  private resolvePreferredManagerSubscriptionId(): string | undefined {
    const managerId = this.resolveConfiguredManagerId();
    if (managerId) {
      const configuredManager = this.swarmManager.getAgent(managerId);
      if (configuredManager && configuredManager.role === "manager" && this.isSubscribable(configuredManager.status)) {
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

