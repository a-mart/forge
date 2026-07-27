import {
  collectKnownWorkerIds,
  isSystemProfile,
  isVisibleInBuilderTimeline,
  isWorkerQuickLookActivity,
  type BootstrapFailureCode,
  type BuilderTimelineChannelView,
  type ProjectPresenceViewer,
  type ServerEvent,
  type TerminalDescriptor,
} from "@forge/protocol";
import { getCollaborationSocketAuthContext } from "../collaboration/auth/collaboration-auth-middleware.js";
import { isCollaborationServerRuntimeTarget } from "../runtime-target.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { isEligibleLocalBuilderManager, type BrowserAutomationService } from "../swarm/browser-automation/index.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import type { UnreadTracker } from "../swarm/unread-tracker.js";
import { filterBuilderVisibleAgents, filterBuilderVisibleProfiles } from "./builder-visibility.js";
import { resolveSessionAgentIdForUnread } from "./unread-utils.js";
import {
  isConversationEntryServerEvent,
  projectConversationEntryForSubscriptionWire,
} from "./conversation-subscription-projection.js";
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
  selectedWorkerAgentId?: string;
}

interface SocketBootstrapRequest {
  generation: number;
  targetAgentId: string;
  messageCount?: number;
  supportsConversationPaging: boolean;
  conversationView: BuilderTimelineChannelView;
  supportsGoalControlRequestId: boolean;
  subscriptionId?: string;
}

interface SocketBootstrapControllerState {
  nextGeneration: number;
  latestRequest: SocketBootstrapRequest | null;
  activeRequest: SocketBootstrapRequest | null;
  activePromise: Promise<void> | null;
  cancelled: boolean;
}

export class WsSubscriptions {
  readonly subscriptions = new Map<WebSocket, string>();
  private readonly deliveredSnapshotVersions = new Map<WebSocket, DeliveredSnapshotVersions>();
  private readonly bootstrapControllers = new Map<WebSocket, SocketBootstrapControllerState>();
  private readonly conversationViews = new Map<WebSocket, BuilderTimelineChannelView>();
  private readonly conversationPagingCapabilities = new Map<WebSocket, boolean>();
  private readonly goalControlRequestIdCapabilities = new Map<WebSocket, boolean>();
  private readonly subscriptionCorrelationCapabilities = new Set<WebSocket>();

  private readonly swarmManager: SwarmManager;
  private readonly allowNonManagerSubscriptions: boolean;
  private readonly terminalService: TerminalService | null;
  private readonly listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
  private readonly unreadTracker: UnreadTracker | null;
  private readonly browserAutomationService: BrowserAutomationService | null;
  private readonly perf: SidebarPerfRecorder;
  private readonly send: (socket: WebSocket, event: ServerEvent) => number | null;
  private readonly sendBootstrapCritical: (
    socket: WebSocket,
    event: ServerEvent,
  ) => Promise<number | null>;
  private readonly getServer: () => WebSocketServer | null;
  private readonly getRemoteUpdateAwarenessBootstrapEvent?: (
    projectId: string
  ) => Extract<ServerEvent, { type: "remote_update_awareness_project_changed" | "remote_update_awareness_project_cleared" }> | null;

  constructor(options: {
    swarmManager: SwarmManager;
    allowNonManagerSubscriptions: boolean;
    terminalService: TerminalService | null;
    listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
    unreadTracker: UnreadTracker | null;
    browserAutomationService?: BrowserAutomationService | null;
    perf: SidebarPerfRecorder;
    send: (socket: WebSocket, event: ServerEvent) => number | null;
    sendBootstrapCritical?: (socket: WebSocket, event: ServerEvent) => Promise<number | null>;
    getServer: () => WebSocketServer | null;
    getRemoteUpdateAwarenessBootstrapEvent?: (
      projectId: string
    ) => Extract<ServerEvent, { type: "remote_update_awareness_project_changed" | "remote_update_awareness_project_cleared" }> | null;
  }) {
    this.swarmManager = options.swarmManager;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    this.terminalService = options.terminalService;
    this.listTerminalsForSession = options.listTerminalsForSession;
    this.unreadTracker = options.unreadTracker;
    this.browserAutomationService = options.browserAutomationService ?? null;
    this.perf = options.perf;
    this.send = options.send;
    // Falls back to the plain send when a backpressure-aware sender isn't wired (e.g. in tests).
    this.sendBootstrapCritical =
      options.sendBootstrapCritical ?? ((socket, event) => Promise.resolve(options.send(socket, event)));
    this.getServer = options.getServer;
    this.getRemoteUpdateAwarenessBootstrapEvent = options.getRemoteUpdateAwarenessBootstrapEvent;
  }

  clear(): void {
    this.subscriptions.clear();
    this.deliveredSnapshotVersions.clear();
    this.conversationPagingCapabilities.clear();
    this.goalControlRequestIdCapabilities.clear();
    this.subscriptionCorrelationCapabilities.clear();
    for (const socket of this.bootstrapControllers.keys()) {
      this.cancelBootstrapController(socket);
    }
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
    this.conversationViews.delete(socket);
    this.conversationPagingCapabilities.delete(socket);
    this.goalControlRequestIdCapabilities.delete(socket);
    this.subscriptionCorrelationCapabilities.delete(socket);
    this.deliveredSnapshotVersions.delete(socket);
    this.cancelBootstrapController(socket);
  }

  getSubscribedAgentId(socket: WebSocket): string | undefined {
    return this.subscriptions.get(socket);
  }

  supportsGoalControlRequestId(socket: WebSocket): boolean {
    return this.goalControlRequestIdCapabilities.get(socket) === true;
  }

  broadcastToSubscribed(event: ServerEvent): void {
    const wss = this.getServer();
    if (!wss) {
      return;
    }

    const sharedOutboundEvent = this.filterBuilderSnapshotEvent(event);

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      const subscribedAgent = this.subscriptions.get(client);
      if (!subscribedAgent) {
        continue;
      }

      let outboundEvent = sharedOutboundEvent;
      const currentConversationEntry = isConversationEntryServerEvent(outboundEvent)
        ? projectConversationEntryForSubscriptionWire(outboundEvent, true)
        : undefined;
      if (currentConversationEntry) {
        outboundEvent = currentConversationEntry;
      }

      if (
        outboundEvent.type === "conversation_message" ||
        outboundEvent.type === "conversation_log" ||
        outboundEvent.type === "activity_summary" ||
        outboundEvent.type === "agent_message" ||
        outboundEvent.type === "agent_tool_call" ||
        outboundEvent.type === "conversation_reset" ||
        outboundEvent.type === "choice_request" ||
        outboundEvent.type === "plan_summary" ||
        outboundEvent.type === "model_cache_observation" ||
        outboundEvent.type === "message_pinned"
      ) {
        if (!this.shouldDeliverConversationEventToSubscriber(outboundEvent, subscribedAgent)) {
          continue;
        }
        if (!this.isConversationEntryVisibleForSocket(client, subscribedAgent, outboundEvent)) {
          continue;
        }
      }

      if (currentConversationEntry && this.conversationPagingCapabilities.get(client) !== true) {
        const legacyConversationEntry = projectConversationEntryForSubscriptionWire(
          currentConversationEntry,
          false,
        );
        if (!legacyConversationEntry) {
          continue;
        }
        outboundEvent = legacyConversationEntry;
      }

      const payloadBytes = this.send(client, outboundEvent);
      if (payloadBytes !== null) {
        this.recordDeliveredSnapshotForEvent(client, outboundEvent);
      }
    }
  }

  broadcastToProfile(profileId: string, event: ServerEvent): void {
    const wss = this.getServer();
    if (!wss) return;
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const subscribedAgentId = this.subscriptions.get(client);
      if (!subscribedAgentId || this.resolveProfileIdForAgent(subscribedAgentId) !== profileId) continue;
      this.send(client, event);
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

  broadcastSecureSessionSnapshot(
    event: Extract<ServerEvent, { type: "secure_session_snapshot" }>,
  ): void {
    const wss = this.getServer();
    if (!wss) {
      return;
    }

    const ownerManagerAgentId =
      event.ownerManagerAgentId ?? event.sessionAgentId;
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      const subscribedAgentId = this.subscriptions.get(client);
      const subscribedAgent = subscribedAgentId
        ? this.swarmManager.getAgent(subscribedAgentId)
        : undefined;
      const subscribedAuthorityAgentId = subscribedAgent?.role === "worker"
        ? subscribedAgent.managerId
        : subscribedAgentId;
      if (
        subscribedAgentId !== event.sessionAgentId
        && subscribedAuthorityAgentId !== ownerManagerAgentId
      ) {
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

      // Goal-control request correlation is origin-scoped. Shared state fanout must never expose
      // one socket's request ID to observers, including other capability-enabled subscribers.
      let outboundEvent = event;
      if (event.type === "session_goal_snapshot" && event.requestId !== undefined) {
        const { requestId: _requestId, ...sharedEvent } = event;
        outboundEvent = sharedEvent;
      }
      this.send(client, outboundEvent);
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
    supportsConversationPaging = false,
    conversationView: BuilderTimelineChannelView = "all",
    supportsGoalControlRequestId = false,
    subscriptionId?: string,
  ): Promise<void> {
    if (subscriptionId !== undefined) {
      this.subscriptionCorrelationCapabilities.add(socket);
    }

    const managerId = this.resolveConfiguredManagerId();
    const targetAgentId =
      requestedAgentId ?? this.resolvePreferredManagerSubscriptionId() ?? this.resolveDefaultSubscriptionAgentId();
    const messageCount = requestedMessageCount !== undefined
      ? normalizeSubscribeMessageCount(requestedMessageCount)
      : undefined;

    if (!this.allowNonManagerSubscriptions && managerId && targetAgentId !== managerId) {
      const message = `Subscriptions are currently limited to ${managerId}.`;
      if (subscriptionId !== undefined) {
        this.cancelBootstrapController(socket);
        await this.sendBootstrapFailure(socket, {
          agentId: targetAgentId,
          subscriptionId,
          conversationView,
          code: "SUBSCRIPTION_NOT_SUPPORTED",
          message,
          retryable: false,
          stage: "subscription_validation",
        });
      } else {
        this.send(socket, {
          type: "error",
          code: "SUBSCRIPTION_NOT_SUPPORTED",
          message,
        });
      }
      return;
    }

    const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
    const canBootstrapSubscription =
      !targetDescriptor &&
      !this.hasRunningManagers() &&
      (managerId ? requestedAgentId === managerId : requestedAgentId === undefined);

    if (!targetDescriptor && requestedAgentId && !canBootstrapSubscription) {
      const message = `Agent ${targetAgentId} does not exist.`;
      if (subscriptionId !== undefined) {
        this.cancelBootstrapController(socket);
        await this.sendBootstrapFailure(socket, {
          agentId: targetAgentId,
          subscriptionId,
          conversationView,
          code: "UNKNOWN_AGENT",
          message,
          retryable: false,
          stage: "subscription_validation",
        });
      } else {
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message,
        });
      }
      return;
    }

    const previousAgentId = this.subscriptions.get(socket);
    const previousProjectId = previousAgentId ? this.resolveProfileIdForAgent(previousAgentId) : undefined;
    const nextProjectId = this.resolveProfileIdForAgent(targetAgentId) ?? targetAgentId;
    if (
      previousProjectId && previousProjectId !== nextProjectId &&
      this.getRemoteUpdateAwarenessBootstrapEvent
    ) {
      this.send(socket, {
        type: "remote_update_awareness_project_cleared",
        projectId: previousProjectId,
      });
    }
    this.subscriptions.set(socket, targetAgentId);
    this.conversationViews.set(socket, conversationView);
    this.conversationPagingCapabilities.set(socket, supportsConversationPaging);
    this.goalControlRequestIdCapabilities.set(socket, supportsGoalControlRequestId);
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

    await this.requestSubscriptionBootstrap(
      socket,
      targetAgentId,
      messageCount,
      supportsConversationPaging,
      conversationView,
      supportsGoalControlRequestId,
      subscriptionId,
    );
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

    if (this.subscriptionCorrelationCapabilities.has(socket)) {
      this.failRemovedBootstrapTarget(socket, subscribedAgentId);
      this.cancelBootstrapController(socket);
      this.resetDeliveredSnapshotVersions(socket);
      this.subscriptions.set(socket, BOOTSTRAP_SUBSCRIPTION_AGENT_ID);
      return BOOTSTRAP_SUBSCRIPTION_AGENT_ID;
    }

    const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
    if (!fallbackAgentId) {
      return subscribedAgentId;
    }

    this.subscriptions.set(socket, fallbackAgentId);
    this.resetDeliveredSnapshotVersions(socket);
    void this.requestSubscriptionBootstrap(
      socket,
      fallbackAgentId,
      DEFAULT_SUBSCRIBE_MESSAGE_COUNT,
      this.conversationPagingCapabilities.get(socket) === true,
      this.conversationViews.get(socket) ?? "all",
      this.supportsGoalControlRequestId(socket),
    );

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

  resolvePlanSnapshotSessionAgentId(subscribedAgentId: string): string | undefined {
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

      this.resetDeliveredSnapshotVersions(socket);
      if (this.subscriptionCorrelationCapabilities.has(socket)) {
        this.failRemovedBootstrapTarget(socket, subscribedAgentId);
        this.cancelBootstrapController(socket);
        this.subscriptions.set(socket, BOOTSTRAP_SUBSCRIPTION_AGENT_ID);
        continue;
      }

      const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
      if (!fallbackAgentId) {
        this.cancelBootstrapController(socket);
        this.subscriptions.set(socket, BOOTSTRAP_SUBSCRIPTION_AGENT_ID);
        continue;
      }

      this.subscriptions.set(socket, fallbackAgentId);
      void this.requestSubscriptionBootstrap(
        socket,
        fallbackAgentId,
        DEFAULT_SUBSCRIBE_MESSAGE_COUNT,
        this.conversationPagingCapabilities.get(socket) === true,
        this.conversationViews.get(socket) ?? "all",
        this.supportsGoalControlRequestId(socket),
      );
    }
  }

  private requestSubscriptionBootstrap(
    socket: WebSocket,
    targetAgentId: string,
    requestedMessageCount?: number,
    supportsConversationPaging = false,
    conversationView: BuilderTimelineChannelView = "all",
    supportsGoalControlRequestId = false,
    subscriptionId?: string,
  ): Promise<void> {
    const messageCount = normalizeSubscribeMessageCount(requestedMessageCount);
    let state = this.bootstrapControllers.get(socket);
    if (!state || (state.cancelled && !state.activePromise)) {
      state = {
        nextGeneration: 0,
        latestRequest: null,
        activeRequest: null,
        activePromise: null,
        cancelled: false,
      };
      this.bootstrapControllers.set(socket, state);
    }

    if (this.canJoinActiveBootstrap(
      state,
      targetAgentId,
      messageCount,
      supportsConversationPaging,
      conversationView,
      supportsGoalControlRequestId,
      subscriptionId,
    )) {
      return state.activePromise ?? Promise.resolve();
    }

    state.cancelled = false;
    state.nextGeneration += 1;
    state.latestRequest = {
      generation: state.nextGeneration,
      targetAgentId,
      messageCount,
      supportsConversationPaging,
      conversationView,
      supportsGoalControlRequestId,
      subscriptionId,
    };

    this.ensureBootstrapControllerDrain(socket, state);
    return state.activePromise ?? Promise.resolve();
  }

  private ensureBootstrapControllerDrain(socket: WebSocket, state: SocketBootstrapControllerState): void {
    if (state.activePromise || state.cancelled || !state.latestRequest) {
      return;
    }

    const activePromise = this.runBootstrapControllerDrain(socket, state)
      .catch(async (error) => {
        const failedRequest = state.activeRequest ?? state.latestRequest;
        if (!failedRequest || this.getBootstrapRequestDisposition(state, failedRequest) !== "current") {
          return;
        }

        console.warn("[swarm] ws:subscription_bootstrap_failed", {
          targetAgentId: failedRequest.targetAgentId,
          requestedMessageCount: failedRequest.messageCount ?? null,
          subscriptionId: failedRequest.subscriptionId ?? null,
          servedConversationView: failedRequest.conversationView,
          stage: "bootstrap",
          code: "BOOTSTRAP_FAILED",
          errorType: error instanceof Error ? error.name : typeof error,
        });
        if (failedRequest.subscriptionId !== undefined) {
          await this.sendBootstrapFailure(socket, {
            agentId: failedRequest.targetAgentId,
            subscriptionId: failedRequest.subscriptionId,
            conversationView: failedRequest.conversationView,
            code: "BOOTSTRAP_FAILED",
            message: "Conversation bootstrap failed.",
            retryable: true,
            stage: "bootstrap",
          });
        }
      })
      .finally(() => {
        if (state.activePromise !== activePromise) {
          return;
        }

        const lastAttemptedGeneration = state.activeRequest?.generation ?? 0;
        state.activePromise = null;
        state.activeRequest = null;

        if (state.cancelled || !state.latestRequest) {
          this.bootstrapControllers.delete(socket);
          return;
        }

        if (state.latestRequest.generation > lastAttemptedGeneration) {
          this.ensureBootstrapControllerDrain(socket, state);
          return;
        }

        this.bootstrapControllers.delete(socket);
      });

    state.activePromise = activePromise;
  }

  private async runBootstrapControllerDrain(
    socket: WebSocket,
    state: SocketBootstrapControllerState,
  ): Promise<void> {
    while (!state.cancelled) {
      const request = state.latestRequest;
      if (!request) {
        return;
      }

      state.activeRequest = request;
      const shouldContinue = (): boolean => this.getBootstrapRequestDisposition(state, request) === "current";

      try {
        await this.sendSubscriptionBootstrap(
          socket,
          request.targetAgentId,
          request.messageCount,
          request.supportsConversationPaging,
          request.conversationView,
          request.supportsGoalControlRequestId,
          request.subscriptionId,
          shouldContinue,
        );
      } catch (error) {
        if (this.getBootstrapRequestDisposition(state, request) === "current") {
          throw error;
        }
      }

      const disposition = this.getBootstrapRequestDisposition(state, request);
      if (disposition !== "superseded") {
        return;
      }
    }
  }

  private async sendSubscriptionBootstrap(
    socket: WebSocket,
    targetAgentId: string,
    requestedMessageCount?: number,
    supportsConversationPaging = false,
    conversationView: BuilderTimelineChannelView = "all",
    supportsGoalControlRequestId = false,
    subscriptionId?: string,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    const currentAgentsSnapshotVersion = this.swarmManager.getAgentsSnapshotVersion();
    const currentProfilesSnapshotVersion = this.swarmManager.getProfilesSnapshotVersion();
    const deliveredVersions = this.deliveredSnapshotVersions.get(socket);
    const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
    const selectedWorkerAgentId = targetDescriptor?.role === "worker" ? targetAgentId : undefined;
    const selectedWorkerSnapshotMissing =
      selectedWorkerAgentId !== undefined &&
      deliveredVersions?.selectedWorkerAgentId !== selectedWorkerAgentId;

    const result = await sendSubscriptionBootstrap({
      socket,
      targetAgentId,
      requestedMessageCount,
      supportsConversationPaging,
      conversationView,
      supportsGoalControlRequestId,
      subscriptionId,
      swarmManager: this.swarmManager,
      terminalService: this.terminalService,
      listTerminalsForSession: this.listTerminalsForSession,
      unreadTracker: this.unreadTracker,
      browserAutomationService: this.browserAutomationService,
      perf: this.perf,
      // Bootstrap-critical events flow-control (await drain) instead of dropping under backpressure.
      send: this.sendBootstrapCritical,
      resolveTerminalScopeAgentId: (agentId) => this.resolveTerminalScopeAgentId(agentId),
      resolvePlanSnapshotSessionAgentId: (agentId) => this.resolvePlanSnapshotSessionAgentId(agentId),
      resolveBrowserSessionAgentId: (agentId) => {
        const managerAgentId = this.resolveManagerContextAgentId(agentId);
        const descriptor = managerAgentId ? this.swarmManager.getAgent(managerAgentId) : undefined;
        return descriptor && isEligibleLocalBuilderManager(descriptor) ? managerAgentId : undefined;
      },
      includeAgentsSnapshot:
        deliveredVersions?.agentsSnapshotVersion !== currentAgentsSnapshotVersion ||
        selectedWorkerSnapshotMissing,
      includeProfilesSnapshot: deliveredVersions?.profilesSnapshotVersion !== currentProfilesSnapshotVersion,
      remoteUpdateAwarenessEvent: this.getRemoteUpdateAwarenessBootstrapEvent?.(
        this.resolveProfileIdForAgent(targetAgentId) ?? targetAgentId
      ),
      shouldContinue,
    });

    if (shouldContinue && !shouldContinue()) {
      return;
    }

    if (result.agentsSnapshotSent) {
      this.deliveredSnapshotVersions.set(socket, {
        ...(this.deliveredSnapshotVersions.get(socket) ?? {}),
        agentsSnapshotVersion: currentAgentsSnapshotVersion,
        selectedWorkerAgentId,
      });
    }
    if (result.profilesSnapshotSent) {
      this.setDeliveredSnapshotVersion(socket, "profilesSnapshotVersion", currentProfilesSnapshotVersion);
    }
  }

  private cancelBootstrapController(socket: WebSocket): void {
    const state = this.bootstrapControllers.get(socket);
    if (!state) {
      return;
    }

    state.cancelled = true;
    state.latestRequest = null;
    if (!state.activePromise) {
      this.bootstrapControllers.delete(socket);
    }
  }

  private failRemovedBootstrapTarget(socket: WebSocket, removedAgentId: string): void {
    const request = this.bootstrapControllers.get(socket)?.latestRequest;
    if (request?.subscriptionId === undefined || request.targetAgentId !== removedAgentId) {
      return;
    }

    void this.sendBootstrapFailure(socket, {
      agentId: removedAgentId,
      subscriptionId: request.subscriptionId,
      conversationView: request.conversationView,
      code: "TARGET_REMOVED",
      message: `Agent ${removedAgentId} was removed during bootstrap.`,
      retryable: false,
      stage: "target_resolution",
    });
  }

  private async sendBootstrapFailure(socket: WebSocket, options: {
    agentId: string;
    subscriptionId: string;
    conversationView: BuilderTimelineChannelView;
    code: BootstrapFailureCode;
    message: string;
    retryable: boolean;
    stage?: string;
  }): Promise<void> {
    try {
      await this.sendBootstrapCritical(socket, {
        type: "bootstrap_failed",
        agentId: options.agentId,
        subscriptionId: options.subscriptionId,
        servedConversationView: options.conversationView,
        code: options.code,
        message: options.message,
        retryable: options.retryable,
        ...(options.stage ? { stage: options.stage } : {}),
      });
    } catch (error) {
      console.warn("[swarm] ws:subscription_bootstrap_failure_send_failed", {
        targetAgentId: options.agentId,
        subscriptionId: options.subscriptionId,
        servedConversationView: options.conversationView,
        stage: options.stage ?? null,
        code: options.code,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private canJoinActiveBootstrap(
    state: SocketBootstrapControllerState,
    targetAgentId: string,
    messageCount?: number,
    supportsConversationPaging = false,
    conversationView: BuilderTimelineChannelView = "all",
    supportsGoalControlRequestId = false,
    subscriptionId?: string,
  ): boolean {
    const activeRequest = state.activeRequest;
    const latestRequest = state.latestRequest;
    if (!state.activePromise || !activeRequest || !latestRequest) {
      return false;
    }

    return (
      activeRequest.generation === latestRequest.generation &&
      activeRequest.targetAgentId === targetAgentId &&
      activeRequest.messageCount === messageCount &&
      activeRequest.supportsConversationPaging === supportsConversationPaging
      && activeRequest.conversationView === conversationView
      && activeRequest.supportsGoalControlRequestId === supportsGoalControlRequestId
      && activeRequest.subscriptionId === subscriptionId
    );
  }

  private getBootstrapRequestDisposition(
    state: SocketBootstrapControllerState,
    request: SocketBootstrapRequest,
  ): "current" | "superseded" | "cancelled" {
    if (state.cancelled || !state.latestRequest) {
      return "cancelled";
    }

    return state.latestRequest.generation === request.generation ? "current" : "superseded";
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
      | { type: "activity_summary" }
      | { type: "agent_message" }
      | { type: "agent_tool_call" }
      | { type: "conversation_reset" }
      | { type: "choice_request" }
      | { type: "plan_summary" }
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

  private isConversationEntryVisibleForSocket(
    socket: WebSocket,
    subscribedAgentId: string,
    event: ServerEvent,
  ): boolean {
    const view = this.conversationViews.get(socket) ?? "all";
    if (
      event.type !== "conversation_message" &&
      event.type !== "conversation_log" &&
      event.type !== "activity_summary" &&
      event.type !== "agent_message" &&
      event.type !== "agent_tool_call" &&
      event.type !== "choice_request" &&
      event.type !== "plan_summary" &&
      event.type !== "model_cache_observation"
    ) return true;

    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    if (view === "all" && descriptor?.role !== "manager") return true;
    const agents = this.swarmManager.listAgents();
    const visibleInTimeline = isVisibleInBuilderTimeline(event, {
      activeAgentId: subscribedAgentId,
      activeAgentRole: descriptor?.role ?? null,
      channelView: view,
      agents,
      history: descriptor?.role === "manager"
        ? this.swarmManager.getConversationHistory(subscribedAgentId)
        : [],
    });
    if (visibleInTimeline || descriptor?.role !== "manager") return visibleInTimeline;

    return isWorkerQuickLookActivity(
      event,
      subscribedAgentId,
      collectKnownWorkerIds(agents, subscribedAgentId),
    );
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
