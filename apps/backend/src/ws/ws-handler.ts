import { randomUUID } from "node:crypto";
import type {
  AgentMessageEvent,
  AgentStatusEvent,
  AgentToolCallEvent,
  ApiProxyCommand,
  BrowserClientCommand,
  BuilderTimelineChannelView,
  ChoiceRequestEvent,
  CollaborationServerEvent,
  ConversationMessageEvent,
  ServerEvent,
  SessionWorkersSnapshotEvent,
  TerminalDescriptor,
} from "@forge/protocol";
import {
  getCollaborationSocketAuthContext,
} from "../collaboration/auth/collaboration-auth-middleware.js";
import {
  getOrCreateCollaborationBetterAuthService,
} from "../collaboration/auth/better-auth-service.js";
import { CollaborationChannelMessageService } from "../collaboration/channel-message-service.js";
import { createCollaborationSkillHandleProvider } from "../collaboration/skill-handle-provider.js";
import { CollaborationChannelService } from "../collaboration/channel-service.js";
import { createCollaborationDbHelpers } from "../collaboration/collab-db-helpers.js";
import type { CollaborationReadinessRequestService } from "../collaboration/readiness-service.js";
import { CollaborationUserService } from "../collaboration/user-service.js";
import type { MobilePushService } from "../mobile/mobile-push-service.js";
import { isBuilderRuntimeTarget } from "../runtime-target.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import { FeedbackService } from "../swarm/feedback-service.js";
import {
  getCachedSharedSpecialistHandles,
  resolveSharedRoster,
} from "../swarm/specialists/specialist-registry.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { BrowserAutomationService } from "../swarm/browser-automation/index.js";
import { isCollabSession } from "../swarm/swarm-manager-utils.js";
import type { UnreadTracker } from "../swarm/unread-tracker.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import { evaluateApiProxyMemberAccess, evaluateBuilderCommandAccess } from "./builder-command-access.js";
import { handleAgentCommand } from "./commands/agent-command-handler.js";
import { handleBrowserCommand } from "./commands/browser-command-handler.js";
import {
  CollabCommandHandler,
  isCollaborationClientCommand,
  toCollaborationCommandError,
} from "./commands/collab-command-handler.js";
import { handleConversationCommand } from "./commands/conversation-command-handler.js";
import { handleManagerCommand } from "./commands/manager-command-handler.js";
import { handleSessionCommand } from "./commands/session-command-handler.js";
import { CollabSubscriptionManager } from "./collab-subscription-manager.js";
import { extractRequestId, parseClientCommand } from "./ws-command-parser.js";
import { WsApiProxy } from "./ws-api-proxy.js";
import { hasRequestId, sendWsEvent, sendWsEventWithBackpressure } from "./ws-send.js";
import { WsSubscriptions } from "./ws-subscriptions.js";
import type { RepositoryProjectCreationService } from "../swarm/repository-project-creation-service.js";

const CONVERSATION_PAGE_RATE_WINDOW_MS = 5_000;
const MAX_CONVERSATION_PAGE_REQUESTS_PER_WINDOW = 8;

export class WsHandler {
  private readonly swarmManager: SwarmManager;
  private readonly allowNonManagerSubscriptions: boolean;
  private readonly isRemoteBuildEnabled: () => boolean;
  private readonly areRemoteTerminalsEnabled: () => boolean;
  private readonly unreadTracker: UnreadTracker | null;
  private readonly browserAutomationService: BrowserAutomationService;
  private readonly subscriptionManager: WsSubscriptions;
  private readonly browserConnectionIds = new WeakMap<WebSocket, string>();
  private readonly apiProxy: WsApiProxy;
  private readonly collabSubscriptionManager: CollabSubscriptionManager;
  private readonly collabCommandHandler: CollabCommandHandler;
  private collaborationMessageServicePromise: Promise<CollaborationChannelMessageService> | null = null;
  private repositoryProjectCreationService: RepositoryProjectCreationService | null = null;
  private readonly conversationPageRequestTimes = new WeakMap<WebSocket, number[]>();

  private wss: WebSocketServer | null = null;

  constructor(options: {
    swarmManager: SwarmManager;
    mobilePushService: MobilePushService;
    allowNonManagerSubscriptions: boolean;
    terminalService?: TerminalService | null;
    listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
    unreadTracker?: UnreadTracker;
    perf: SidebarPerfRecorder;
    collaborationReadinessService?: CollaborationReadinessRequestService;
    feedbackService?: FeedbackService;
    isRemoteBuildEnabled?: () => boolean;
    areRemoteTerminalsEnabled?: () => boolean;
    browserAutomationService?: BrowserAutomationService;
    getRemoteUpdateAwarenessBootstrapEvent?: (
      projectId: string
    ) => Extract<ServerEvent, { type: "remote_update_awareness_project_changed" | "remote_update_awareness_project_cleared" }> | null;
  }) {
    this.swarmManager = options.swarmManager;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    // Default off: without the instance setting wired in, members get no
    // builder access (the remote-projects kill switch fails closed).
    this.isRemoteBuildEnabled = options.isRemoteBuildEnabled ?? (() => false);
    this.areRemoteTerminalsEnabled = options.areRemoteTerminalsEnabled ?? (() => true);
    this.unreadTracker = options.unreadTracker ?? null;
    this.browserAutomationService = options.browserAutomationService ?? new BrowserAutomationService({
      dataDir: this.swarmManager.getConfig().paths.dataDir,
    });

    const feedbackService = options.feedbackService ?? new FeedbackService(this.swarmManager.getConfig().paths.dataDir);
    const terminalService = options.terminalService ?? null;
    const perf = options.perf;

    this.subscriptionManager = new WsSubscriptions({
      swarmManager: this.swarmManager,
      allowNonManagerSubscriptions: this.allowNonManagerSubscriptions,
      terminalService,
      listTerminalsForSession: options.listTerminalsForSession,
      unreadTracker: this.unreadTracker,
      browserAutomationService: this.browserAutomationService,
      perf,
      send: (socket, event) => this.send(socket, event),
      sendBootstrapCritical: (socket, event) => this.sendWithBackpressure(socket, event),
      getServer: () => this.wss,
      getRemoteUpdateAwarenessBootstrapEvent: options.getRemoteUpdateAwarenessBootstrapEvent,
    });

    this.apiProxy = new WsApiProxy({
      swarmManager: this.swarmManager,
      mobilePushService: options.mobilePushService,
      feedbackService,
      terminalService,
      unreadTracker: this.unreadTracker,
    });

    this.collabSubscriptionManager = new CollabSubscriptionManager(
      (socket, event) => this.send(socket, event),
      async () => createCollaborationDbHelpers(this.swarmManager.getConfig()),
    );
    this.collabCommandHandler = new CollabCommandHandler(
      this.swarmManager,
      this.collabSubscriptionManager,
      (socket, event) => this.send(socket, event),
      async () => this.getCollaborationMessageService(),
      options.collaborationReadinessService,
    );
  }

  setRepositoryProjectCreationService(service: RepositoryProjectCreationService | null): void {
    this.repositoryProjectCreationService = service;
  }

  sendToSocket(socket: WebSocket, event: ServerEvent | CollaborationServerEvent): void {
    this.send(socket, event);
  }

  attach(server: WebSocketServer): void {
    this.wss = server;
    this.collabSubscriptionManager.attach(server);

    server.on("connection", (socket) => {
      this.browserConnectionIds.set(socket, randomUUID());
      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw);
      });

      socket.on("close", () => {
        this.unregisterBrowserHost(socket);
        this.subscriptionManager.remove(socket);
        this.collabSubscriptionManager.remove(socket);
      });

      socket.on("error", () => {
        this.unregisterBrowserHost(socket);
        this.subscriptionManager.remove(socket);
        this.collabSubscriptionManager.remove(socket);
      });
    });
  }

  reset(): void {
    this.wss = null;
    this.subscriptionManager.clear();
    this.collabSubscriptionManager.clear();
  }

  broadcastToSubscribed(event: ServerEvent): void {
    this.subscriptionManager.broadcastToSubscribed(event);
  }

  broadcastToProfile(profileId: string, event: ServerEvent): void {
    this.subscriptionManager.broadcastToProfile(profileId, event);
  }

  broadcastToSession(sessionAgentId: string, event: ServerEvent): void {
    this.subscriptionManager.broadcastToSession(sessionAgentId, event);
  }

  broadcastToExactSubscription(agentId: string, event: ServerEvent): void {
    this.subscriptionManager.broadcastToExactSubscription(agentId, event);
  }

  broadcastUnreadCountUpdate(sessionAgentId: string, count: number): void {
    this.subscriptionManager.broadcastUnreadCountUpdate(sessionAgentId, count);
  }

  hasActiveSubscription(agentId: string): boolean {
    return this.subscriptionManager.hasActiveSubscription(agentId);
  }

  hasActiveSubscriptionForSession(sessionAgentId: string): boolean {
    return this.subscriptionManager.hasActiveSubscriptionForSession(sessionAgentId);
  }

  broadcastCollaborationConversationMessage(event: ConversationMessageEvent): void {
    if (isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
      return;
    }

    this.collabSubscriptionManager.handleConversationMessage(event);
  }

  broadcastCollaborationAgentMessage(event: AgentMessageEvent): void {
    if (isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
      return;
    }

    this.collabSubscriptionManager.handleAgentMessage(event);
  }

  broadcastCollaborationAgentToolCall(event: AgentToolCallEvent): void {
    if (isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
      return;
    }

    this.collabSubscriptionManager.handleAgentToolCall(event);
  }

  broadcastCollaborationAgentStatus(event: AgentStatusEvent): void {
    if (isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
      return;
    }

    this.collabSubscriptionManager.handleAgentStatus(event);
  }

  broadcastCollaborationSessionWorkersSnapshot(event: SessionWorkersSnapshotEvent): void {
    if (isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
      return;
    }

    this.collabSubscriptionManager.handleSessionWorkersSnapshot(event);
  }

  broadcastCollaborationChoiceRequest(event: ChoiceRequestEvent, backingSessionAgentId: string): void {
    if (isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
      return;
    }

    this.collabSubscriptionManager.handleChoiceRequest(event, backingSessionAgentId);
  }

  getCollaborationSubscriptionManager(): CollabSubscriptionManager {
    return this.collabSubscriptionManager;
  }

  private async handleSocketMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const parsed = parseClientCommand(raw);
    if (!parsed.ok) {
      this.logDebug("command:invalid", {
        message: parsed.error,
      });
      this.send(socket, {
        type: "error",
        code: "INVALID_COMMAND",
        message: parsed.error,
      });
      return;
    }

    const command = parsed.command;
    const collaborationEnabled = !isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget);
    const authContext = collaborationEnabled ? getCollaborationSocketAuthContext(socket) : null;
    this.logDebug("command:received", {
      type: command.type,
      requestId: extractRequestId(command),
    });

    if (command.type === "ping") {
      // Members may hold builder subscriptions (remote projects); prefer the
      // builder subscription when present, else fall back to the collab one.
      const builderSubscribedAgentId = this.subscriptionManager.getSubscribedAgentId(socket);
      this.send(socket, {
        type: "ready",
        serverTime: new Date().toISOString(),
        subscribedAgentId:
          collaborationEnabled && authContext?.role !== "admin"
            ? builderSubscribedAgentId ?? this.collabSubscriptionManager.getReadySubscriptionId(socket)
            : builderSubscribedAgentId ?? this.resolveDefaultSubscriptionAgentId(),
        ...(this.subscriptionManager.supportsGoalControlRequestId(socket)
          ? { goalControlRequestId: true as const }
          : {}),
      });
      return;
    }

    if (isCollaborationClientCommand(command)) {
      if (!collaborationEnabled) {
        this.send(socket, toCollaborationCommandError(
          "COLLABORATION_DISABLED",
          "Collaboration WebSocket commands are unavailable while collaboration mode is disabled.",
        ));
        return;
      }

      if (!authContext) {
        this.send(socket, toCollaborationCommandError(
          "COLLABORATION_AUTH_REQUIRED",
          "Authentication is required for collaboration WebSocket commands.",
        ));
        return;
      }

      await this.collabCommandHandler.handleCommand(socket, authContext, command);
      return;
    }

    if (collaborationEnabled) {
      const access = evaluateBuilderCommandAccess({
        commandType: command.type,
        authContext,
        remoteBuildEnabled: this.isRemoteBuildEnabled(),
      });
      if (!access.ok) {
        this.logDebug("command:rejected:builder_access", {
          type: command.type,
          reason: access.reason,
          role: authContext?.role,
        });
        this.send(socket, toCollaborationCommandError(
          "COLLABORATION_COMMAND_NOT_ALLOWED",
          access.message ?? "This command is not permitted for this account.",
        ));
        return;
      }
    }

    if (isBrowserClientCommand(command)) {
      const subscribedAgentId = this.subscriptionManager.getSubscribedAgentId(socket);
      await handleBrowserCommand({
        command,
        socket,
        connectionId: this.getBrowserConnectionId(socket),
        subscribedAgentId,
        browserAutomationService: this.browserAutomationService,
        resolveManagerContextAgentId: (agentId) => this.subscriptionManager.resolveManagerContextAgentId(agentId),
        resolveProfileIdForAgent: (agentId) => this.subscriptionManager.resolveProfileIdForAgent(agentId),
        send: (targetSocket, event) => this.send(targetSocket, event),
        sendCritical: (targetSocket, event) => this.sendWithBackpressure(targetSocket, event),
        broadcastToSession: (sessionAgentId, event) => this.broadcastToSession(sessionAgentId, event),
        hydrateHostSessions: () => this.hydrateBrowserHostSessions(),
        logDebug: (message, details) => this.logDebug(message, details),
      });
      return;
    }

    if (command.type === "subscribe") {
      await this.handleSubscribe(
        socket,
        command.agentId,
        command.messageCount,
        command.conversationPaging === true,
        command.conversationView,
        command.goalControlRequestId === true,
      );
      return;
    }

    if (command.type === "get_conversation_page" && !this.allowConversationPageRequest(socket)) {
      this.send(socket, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Too many conversation page requests. Please wait before loading more history.",
        requestId: command.requestId,
      });
      return;
    }

    if (command.type === "mark_unread") {
      if (!this.unreadTracker) {
        return;
      }

      const descriptor = this.swarmManager.getAgent(command.agentId);
      if (!descriptor || descriptor.role !== "manager") {
        return;
      }

      if (isCollabSession(descriptor)) {
        this.send(socket, toCollaborationCommandError(
          "COLLABORATION_COMMAND_NOT_ALLOWED",
          "Builder unread commands cannot target collaboration-backed sessions.",
        ));
        return;
      }

      const profileId = this.subscriptionManager.resolveProfileIdForAgent(descriptor.agentId) ?? descriptor.agentId;
      this.unreadTracker.markUnread(profileId, descriptor.agentId);
      this.broadcastUnreadCountUpdate(
        descriptor.agentId,
        this.unreadTracker.getCount(profileId, descriptor.agentId),
      );
      return;
    }

    if (command.type === "mark_all_read") {
      if (!this.unreadTracker) {
        return;
      }

      const { profileId } = command;
      for (const agent of this.swarmManager.listAgents()) {
        if (agent.role !== "manager" || isCollabSession(agent)) {
          continue;
        }

        const agentProfileId = this.subscriptionManager.resolveProfileIdForAgent(agent.agentId) ?? agent.agentId;
        if (agentProfileId !== profileId) {
          continue;
        }

        const count = this.unreadTracker.getCount(profileId, agent.agentId);
        if (count > 0) {
          this.unreadTracker.markRead(profileId, agent.agentId);
          this.broadcastUnreadCountUpdate(agent.agentId, 0);
        }
      }
      return;
    }

    const subscribedAgentId = this.resolveSubscribedAgentId(socket);
    if (!subscribedAgentId) {
      this.logDebug("command:rejected:not_subscribed", {
        type: command.type,
      });
      this.send(socket, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: `Send subscribe before ${command.type}.`,
        requestId: command.type === "session_goal_control" &&
          !this.subscriptionManager.supportsGoalControlRequestId(socket)
          ? undefined
          : extractRequestId(command),
      });
      return;
    }

    if (command.type === "api_proxy") {
      // Second gate for members: the proxy fronts HTTP-shaped surfaces, so it
      // gets the HTTP discipline — per-path allowlist with default deny.
      if (collaborationEnabled && authContext && authContext.role !== "admin") {
        const proxyAccess = evaluateApiProxyMemberAccess({
          pathname: resolveApiProxyPathname(command.path),
          method: command.method,
          authContext,
          terminalsEnabled: this.areRemoteTerminalsEnabled(),
        });
        if (!proxyAccess.ok) {
          this.send(socket, {
            type: "api_proxy_response",
            requestId: command.requestId,
            status: proxyAccess.statusCode ?? 403,
            body: JSON.stringify({ error: proxyAccess.message ?? "Forbidden" }),
            headers: { "content-type": "application/json; charset=utf-8" },
          });
          return;
        }
      }

      await this.handleApiProxyCommand(socket, command, subscribedAgentId);
      return;
    }

    if (command.type === "resume_restart_recovery") {
      try {
        const snapshot = await this.swarmManager.resumeRestartRecovery();
        this.broadcastToSubscribed({
          type: "restart_recovery_snapshot",
          snapshot,
          requestId: command.requestId,
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "RESUME_RESTART_RECOVERY_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId,
        });
      }
      return;
    }

    if (command.type === "dismiss_restart_recovery") {
      try {
        const snapshot = await this.swarmManager.dismissRestartRecovery();
        this.broadcastToSubscribed({
          type: "restart_recovery_snapshot",
          snapshot,
          requestId: command.requestId,
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "DISMISS_RESTART_RECOVERY_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId,
        });
      }
      return;
    }

    if (command.type === "pin_message") {
      if (subscribedAgentId !== command.agentId) {
        this.send(socket, {
          type: "error",
          code: "PIN_MESSAGE_SUBSCRIPTION_MISMATCH",
          message: `Pin message rejected: not subscribed to agent ${command.agentId}`,
        });
        return;
      }

      try {
        const result = await this.swarmManager.pinMessage(command.agentId, command.messageId, command.pinned);
        this.broadcastToSubscribed({
          type: "message_pinned",
          agentId: command.agentId,
          messageId: command.messageId,
          pinned: result.pinned,
          timestamp: result.timestamp,
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "PIN_MESSAGE_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (command.type === "clear_all_pins") {
      if (subscribedAgentId !== command.agentId) {
        this.send(socket, {
          type: "error",
          code: "CLEAR_ALL_PINS_SUBSCRIPTION_MISMATCH",
          message: `Clear all pins rejected: not subscribed to agent ${command.agentId}`,
        });
        return;
      }

      try {
        await this.swarmManager.clearAllPins(command.agentId);
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "CLEAR_ALL_PINS_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const managerHandled = await handleManagerCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      send: (targetSocket, event) => this.send(targetSocket, event),
      broadcastToSubscribed: (event) => this.broadcastToSubscribed(event),
      handleDeletedAgentSubscriptions: (deletedAgentIds) => this.handleDeletedAgentSubscriptions(deletedAgentIds),
      unreadTracker: this.unreadTracker ?? undefined,
      repositoryProjectCreationService: this.repositoryProjectCreationService ?? undefined,
    });
    if (managerHandled) {
      return;
    }

    const sessionHandled = await handleSessionCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      send: (targetSocket, event) => this.send(targetSocket, event),
      handleDeletedAgentSubscriptions: (deletedAgentIds) => this.handleDeletedAgentSubscriptions(deletedAgentIds),
      unreadTracker: this.unreadTracker ?? undefined,
      broadcastUnreadCountUpdate: (sessionAgentId, count) => this.broadcastUnreadCountUpdate(sessionAgentId, count),
      supportsGoalControlRequestId: this.subscriptionManager.supportsGoalControlRequestId(socket),
    });
    if (sessionHandled) {
      return;
    }

    const agentHandled = await handleAgentCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      send: (targetSocket, event) => this.send(targetSocket, event),
    });
    if (agentHandled) {
      return;
    }

    const conversationHandled = await handleConversationCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      allowNonManagerSubscriptions: this.allowNonManagerSubscriptions,
      send: (targetSocket, event) => this.send(targetSocket, event),
      logDebug: (message, details) => this.logDebug(message, details),
      resolveConfiguredManagerId: () => this.resolveConfiguredManagerId(),
      dispatchCollaborationUserMessage: async (params) => {
        const service = await this.getCollaborationMessageService();
        await service.dispatchUserMessage(params);
      },
    });
    if (conversationHandled) {
      return;
    }

    this.send(socket, {
      type: "error",
      code: "UNKNOWN_COMMAND",
      message: `Unsupported command type ${command.type}`,
    });
  }

  private async handleApiProxyCommand(
    socket: WebSocket,
    command: ApiProxyCommand,
    subscribedAgentId: string,
  ): Promise<void> {
    const response = await this.routeApiProxyCommand(command, subscribedAgentId);
    this.send(socket, response);
  }

  private async routeApiProxyCommand(
    command: ApiProxyCommand,
    subscribedAgentId: string,
  ) {
    return this.apiProxy.routeApiProxyCommand(command, subscribedAgentId);
  }

  private async handleSubscribe(
    socket: WebSocket,
    requestedAgentId?: string,
    requestedMessageCount?: number,
    supportsConversationPaging = false,
    conversationView: BuilderTimelineChannelView = "all",
    supportsGoalControlRequestId = false,
  ): Promise<void> {
    await this.subscriptionManager.handleSubscribe(
      socket,
      requestedAgentId,
      requestedMessageCount,
      supportsConversationPaging,
      conversationView,
      supportsGoalControlRequestId,
    );
  }

  private allowConversationPageRequest(socket: WebSocket): boolean {
    const now = Date.now();
    const cutoff = now - CONVERSATION_PAGE_RATE_WINDOW_MS;
    const recent = (this.conversationPageRequestTimes.get(socket) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= MAX_CONVERSATION_PAGE_REQUESTS_PER_WINDOW) {
      this.conversationPageRequestTimes.set(socket, recent);
      return false;
    }

    recent.push(now);
    this.conversationPageRequestTimes.set(socket, recent);
    return true;
  }

  private resolveSubscribedAgentId(socket: WebSocket): string | undefined {
    return this.subscriptionManager.resolveSubscribedAgentId(socket);
  }

  private resolveManagerContextAgentId(subscribedAgentId: string): string | undefined {
    return this.subscriptionManager.resolveManagerContextAgentId(subscribedAgentId);
  }

  private handleDeletedAgentSubscriptions(deletedAgentIds: Set<string>): void {
    this.subscriptionManager.handleDeletedAgentSubscriptions(deletedAgentIds);
  }

  private resolveDefaultSubscriptionAgentId(): string {
    return this.subscriptionManager.resolveDefaultSubscriptionAgentId();
  }

  private resolveConfiguredManagerId(): string | undefined {
    const managerId = this.swarmManager.getConfig().managerId;
    if (typeof managerId !== "string") {
      return undefined;
    }

    const normalized = managerId.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private async getCollaborationMessageService(): Promise<CollaborationChannelMessageService> {
    if (isBuilderRuntimeTarget(this.swarmManager.getConfig().runtimeTarget)) {
      throw new Error("Collaboration message dispatch requested while collaboration mode is disabled");
    }

    if (!this.collaborationMessageServicePromise) {
      this.collaborationMessageServicePromise = this.createCollaborationMessageService().catch((error) => {
        this.collaborationMessageServicePromise = null;
        throw error;
      });
    }

    return this.collaborationMessageServicePromise;
  }

  private async createCollaborationMessageService(): Promise<CollaborationChannelMessageService> {
    const config = this.swarmManager.getConfig();
    const [dbHelpers, authService] = await Promise.all([
      createCollaborationDbHelpers(config),
      getOrCreateCollaborationBetterAuthService(config),
    ]);

    const [availableGlobalSpecialistHandles, availableGlobalSkillHandles] = await Promise.all([
      resolveSharedRoster(config.paths.dataDir, "collaboration").then((roster) =>
        roster.map((entry) => entry.specialistId),
      ),
      createCollaborationSkillHandleProvider({
        config,
        source: this.swarmManager,
      }),
    ]);
    const channelService = new CollaborationChannelService(dbHelpers, this.swarmManager, config.paths.dataDir, {
      availableGlobalSpecialistHandles: () =>
        getCachedSharedSpecialistHandles(config.paths.dataDir, "collaboration") ?? availableGlobalSpecialistHandles,
      availableGlobalSkillHandles,
    });
    const userService = new CollaborationUserService(dbHelpers.database, authService);
    return new CollaborationChannelMessageService(this.swarmManager, channelService, dbHelpers, userService);
  }

  private getBrowserConnectionId(socket: WebSocket): string {
    const existing = this.browserConnectionIds.get(socket);
    if (existing) return existing;
    const connectionId = randomUUID();
    this.browserConnectionIds.set(socket, connectionId);
    return connectionId;
  }

  private unregisterBrowserHost(socket: WebSocket): void {
    const connectionId = this.browserConnectionIds.get(socket);
    if (connectionId) this.browserAutomationService.unregisterHost(connectionId);
  }

  private async hydrateBrowserHostSessions() {
    const sessions = new Map<string, Awaited<ReturnType<BrowserAutomationService["getSessionSnapshot"]>>>();
    await Promise.all(this.swarmManager.listAgents()
      .filter((descriptor) => descriptor.role === "manager")
      .map(async (descriptor) => {
        const profileId = descriptor.profileId ?? descriptor.agentId;
        const snapshot = await this.browserAutomationService.getSessionSnapshot(profileId, descriptor.agentId);
        sessions.set(`${profileId}:${descriptor.agentId}`, snapshot);
      }));
    return [...sessions.values()];
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.swarmManager.getConfig().debug) {
      return;
    }

    const prefix = `[swarm][${new Date().toISOString()}] ws:${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }

    console.log(prefix, details);
  }

  private send(socket: WebSocket, event: ServerEvent | CollaborationServerEvent): number | null {
    // Request/response events (requestId present) must not be silently dropped
    // under transient backpressure — the requesting client would hang on its
    // pending promise until timeout, de-duplicating every retry onto the dead
    // request. Route them through the drain-aware sender; other live events
    // keep drop-on-backpressure. This includes broadcasts that echo a
    // requestId (e.g. manager_created): for the originator they ARE the
    // response. Two accepted tradeoffs: (1) bystander sockets get drain-await
    // for such broadcasts too, and (2) a drain-awaited event can be overtaken
    // on the wire by later synchronous sends to the same socket — clients
    // correlate by requestId, not delivery order, and the alternative under
    // backpressure was dropping the event entirely.
    if (hasRequestId(event)) {
      void this.sendWithBackpressure(socket, event);
      return null;
    }

    return sendWsEvent({
      socket,
      event,
      onDropSocket: (targetSocket) => this.dropSocket(targetSocket),
    });
  }

  private sendWithBackpressure(
    socket: WebSocket,
    event: ServerEvent | CollaborationServerEvent,
  ): Promise<number | null> {
    return sendWsEventWithBackpressure({
      socket,
      event,
      onDropSocket: (targetSocket) => this.dropSocket(targetSocket),
    });
  }

  private dropSocket(socket: WebSocket): void {
    this.unregisterBrowserHost(socket);
    this.subscriptionManager.remove(socket);
    this.collabSubscriptionManager.remove(socket);

    try {
      socket.terminate();
    } catch {
      // best effort
    }
  }
}

function isBrowserClientCommand(command: { type: string }): command is BrowserClientCommand {
  return command.type.startsWith("browser_");
}

function resolveApiProxyPathname(path: string): string {
  try {
    return new URL(path, "http://api-proxy.local").pathname;
  } catch {
    return path;
  }
}
