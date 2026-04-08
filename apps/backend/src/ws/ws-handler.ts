import type {
  ApiProxyCommand,
  ServerEvent,
  TerminalDescriptor,
} from "@forge/protocol";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import type { MobilePushService } from "../mobile/mobile-push-service.js";
import type { PlaywrightDiscoveryService } from "../playwright/playwright-discovery-service.js";
import { FeedbackService } from "../swarm/feedback-service.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { UnreadTracker } from "../swarm/unread-tracker.js";
import type { TerminalService } from "../terminal/terminal-service.js";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import { handleAgentCommand } from "./commands/agent-command-handler.js";
import { handleConversationCommand } from "./commands/conversation-command-handler.js";
import { handleManagerCommand } from "./commands/manager-command-handler.js";
import { handleSessionCommand } from "./commands/session-command-handler.js";
import { extractRequestId, parseClientCommand } from "./ws-command-parser.js";
import { WsApiProxy } from "./ws-api-proxy.js";
import { sendWsEvent } from "./ws-send.js";
import { WsSubscriptions } from "./ws-subscriptions.js";

export class WsHandler {
  private readonly swarmManager: SwarmManager;
  private readonly allowNonManagerSubscriptions: boolean;
  private readonly unreadTracker: UnreadTracker | null;
  private readonly subscriptionManager: WsSubscriptions;
  private readonly apiProxy: WsApiProxy;

  private wss: WebSocketServer | null = null;

  constructor(options: {
    swarmManager: SwarmManager;
    integrationRegistry: IntegrationRegistryService | null;
    mobilePushService: MobilePushService;
    playwrightDiscovery: PlaywrightDiscoveryService | null;
    allowNonManagerSubscriptions: boolean;
    terminalService?: TerminalService | null;
    listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
    unreadTracker?: UnreadTracker;
  }) {
    this.swarmManager = options.swarmManager;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    this.unreadTracker = options.unreadTracker ?? null;

    const feedbackService = new FeedbackService(this.swarmManager.getConfig().paths.dataDir);
    const terminalService = options.terminalService ?? null;

    this.subscriptionManager = new WsSubscriptions({
      swarmManager: this.swarmManager,
      integrationRegistry: options.integrationRegistry,
      playwrightDiscovery: options.playwrightDiscovery,
      allowNonManagerSubscriptions: this.allowNonManagerSubscriptions,
      terminalService,
      listTerminalsForSession: options.listTerminalsForSession,
      unreadTracker: this.unreadTracker,
      send: (socket, event) => this.send(socket, event),
      getServer: () => this.wss,
    });

    this.apiProxy = new WsApiProxy({
      swarmManager: this.swarmManager,
      mobilePushService: options.mobilePushService,
      feedbackService,
      terminalService,
      unreadTracker: this.unreadTracker,
    });
  }

  attach(server: WebSocketServer): void {
    this.wss = server;

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw);
      });

      socket.on("close", () => {
        this.subscriptionManager.remove(socket);
      });

      socket.on("error", () => {
        this.subscriptionManager.remove(socket);
      });
    });
  }

  reset(): void {
    this.wss = null;
    this.subscriptionManager.clear();
  }

  broadcastToSubscribed(event: ServerEvent): void {
    this.subscriptionManager.broadcastToSubscribed(event);
  }

  broadcastToSession(sessionAgentId: string, event: ServerEvent): void {
    this.subscriptionManager.broadcastToSession(sessionAgentId, event);
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

  private async handleSocketMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const parsed = parseClientCommand(raw);
    if (!parsed.ok) {
      this.logDebug("command:invalid", {
        message: parsed.error
      });
      this.send(socket, {
        type: "error",
        code: "INVALID_COMMAND",
        message: parsed.error
      });
      return;
    }

    const command = parsed.command;
    this.logDebug("command:received", {
      type: command.type,
      requestId: extractRequestId(command)
    });

    if (command.type === "ping") {
      this.send(socket, {
        type: "ready",
        serverTime: new Date().toISOString(),
        subscribedAgentId:
          this.subscriptionManager.getSubscribedAgentId(socket) ?? this.resolveDefaultSubscriptionAgentId()
      });
      return;
    }

    if (command.type === "subscribe") {
      await this.handleSubscribe(socket, command.agentId, command.messageCount);
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
        if (agent.role !== "manager") {
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
        type: command.type
      });
      this.send(socket, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: `Send subscribe before ${command.type}.`,
        requestId: extractRequestId(command)
      });
      return;
    }

    if (command.type === "api_proxy") {
      await this.handleApiProxyCommand(socket, command, subscribedAgentId);
      return;
    }

    if (command.type === "pin_message") {
      if (subscribedAgentId !== command.agentId) {
        this.send(socket, {
          type: "error",
          code: "PIN_MESSAGE_SUBSCRIPTION_MISMATCH",
          message: `Pin message rejected: not subscribed to agent ${command.agentId}`
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
          timestamp: result.timestamp
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "PIN_MESSAGE_FAILED",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (command.type === "clear_all_pins") {
      if (subscribedAgentId !== command.agentId) {
        this.send(socket, {
          type: "error",
          code: "CLEAR_ALL_PINS_SUBSCRIPTION_MISMATCH",
          message: `Clear all pins rejected: not subscribed to agent ${command.agentId}`
        });
        return;
      }

      try {
        await this.swarmManager.clearAllPins(command.agentId);
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "CLEAR_ALL_PINS_FAILED",
          message: error instanceof Error ? error.message : String(error)
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
      send: (targetSocket, event) => this.send(targetSocket, event)
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
      resolveConfiguredManagerId: () => this.resolveConfiguredManagerId()
    });
    if (conversationHandled) {
      return;
    }

    this.send(socket, {
      type: "error",
      code: "UNKNOWN_COMMAND",
      message: `Unsupported command type ${command.type}`
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
  ): Promise<void> {
    await this.subscriptionManager.handleSubscribe(socket, requestedAgentId, requestedMessageCount);
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

  private send(socket: WebSocket, event: ServerEvent): void {
    sendWsEvent({
      socket,
      event,
      onDropSocket: (targetSocket) => this.dropSocket(targetSocket),
    });
  }

  private dropSocket(socket: WebSocket): void {
    this.subscriptionManager.remove(socket);

    try {
      socket.terminate();
    } catch {
      // best effort
    }
  }
}
