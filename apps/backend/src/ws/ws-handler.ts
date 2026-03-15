import { readFile } from "node:fs/promises";
import type {
  ApiProxyCommand,
  ApiProxyResponseEvent,
  FeedbackSubmitEvent,
  ServerEvent
} from "@middleman/protocol";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import type { MobilePushService } from "../mobile/mobile-push-service.js";
import type { PlaywrightDiscoveryService } from "../playwright/playwright-discovery-service.js";
import { getGlobalSlashCommandsPath } from "../swarm/data-paths.js";
import { FeedbackService } from "../swarm/feedback-service.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import { extractRequestId, parseClientCommand } from "./ws-command-parser.js";
import { handleAgentCommand } from "./routes/agent-routes.js";
import { handleConversationCommand } from "./routes/conversation-routes.js";
import { handleManagerCommand } from "./routes/manager-routes.js";
import { handleSessionCommand } from "./routes/session-routes.js";

const BOOTSTRAP_SUBSCRIPTION_AGENT_ID = "__bootstrap_manager__";
const DEFAULT_SUBSCRIBE_MESSAGE_COUNT = 200;
const MAX_SUBSCRIBE_MESSAGE_COUNT = 2000;
const API_PROXY_SMART_COMPACT_ENDPOINT_PATTERN = /^\/api\/agents\/([^/]+)\/smart-compact$/;
const API_PROXY_NOTIFICATION_PREFERENCES_PATH = "/api/mobile/notification-preferences";
const API_PROXY_REGISTER_DEVICE_PATH = "/api/mobile/devices/register";
const API_PROXY_LEGACY_REGISTER_DEVICE_PATH = "/api/mobile/push/register";
const API_PROXY_TEST_PUSH_PATH = "/api/mobile/push/test";
const API_PROXY_AUTH_TOKENS_PATH = "/api/auth/tokens";
const API_PROXY_FEEDBACK_PATH = "/api/feedback";
const API_PROXY_SLASH_COMMANDS_PATH = "/api/slash-commands";
const API_PROXY_JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_WS_EVENT_BYTES = 1 * 1024 * 1024;
const MAX_WS_BUFFERED_AMOUNT_BYTES = 1 * 1024 * 1024;
const BOOTSTRAP_HISTORY_BYTE_BUDGET = MAX_WS_EVENT_BYTES - 16 * 1024;

type BootstrapConversationHistory = ReturnType<SwarmManager["getConversationHistory"]>;
type BootstrapConversationEntry = BootstrapConversationHistory[number];

export class WsHandler {
  private readonly swarmManager: SwarmManager;
  private readonly integrationRegistry: IntegrationRegistryService | null;
  private readonly mobilePushService: MobilePushService;
  private readonly playwrightDiscovery: PlaywrightDiscoveryService | null;
  private readonly allowNonManagerSubscriptions: boolean;
  private readonly feedbackService: FeedbackService;

  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Map<WebSocket, string>();

  constructor(options: {
    swarmManager: SwarmManager;
    integrationRegistry: IntegrationRegistryService | null;
    mobilePushService: MobilePushService;
    playwrightDiscovery: PlaywrightDiscoveryService | null;
    allowNonManagerSubscriptions: boolean;
  }) {
    this.swarmManager = options.swarmManager;
    this.integrationRegistry = options.integrationRegistry;
    this.mobilePushService = options.mobilePushService;
    this.playwrightDiscovery = options.playwrightDiscovery;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    this.feedbackService = new FeedbackService(this.swarmManager.getConfig().paths.dataDir);
  }

  attach(server: WebSocketServer): void {
    this.wss = server;

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw);
      });

      socket.on("close", () => {
        this.subscriptions.delete(socket);
      });

      socket.on("error", () => {
        this.subscriptions.delete(socket);
      });
    });
  }

  reset(): void {
    this.wss = null;
    this.subscriptions.clear();
  }

  broadcastToSubscribed(event: ServerEvent): void {
    if (!this.wss) {
      return;
    }

    for (const client of this.wss.clients) {
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
        event.type === "conversation_reset"
      ) {
        if (subscribedAgent !== event.agentId) {
          continue;
        }
      }

      if (event.type === "slack_status" || event.type === "telegram_status") {
        if (event.managerId) {
          const subscribedProfileId = this.resolveProfileIdForAgent(subscribedAgent);
          if (subscribedProfileId !== event.managerId) {
            continue;
          }
        }
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
        subscribedAgentId: this.subscriptions.get(socket) ?? this.resolveDefaultSubscriptionAgentId()
      });
      return;
    }

    if (command.type === "subscribe") {
      await this.handleSubscribe(socket, command.agentId, command.messageCount);
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

    const managerHandled = await handleManagerCommand({
      command,
      socket,
      subscribedAgentId,
      swarmManager: this.swarmManager,
      resolveManagerContextAgentId: (agentId) => this.resolveManagerContextAgentId(agentId),
      send: (targetSocket, event) => this.send(targetSocket, event),
      broadcastToSubscribed: (event) => this.broadcastToSubscribed(event),
      handleDeletedAgentSubscriptions: (deletedAgentIds) => this.handleDeletedAgentSubscriptions(deletedAgentIds)
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
      handleDeletedAgentSubscriptions: (deletedAgentIds) => this.handleDeletedAgentSubscriptions(deletedAgentIds)
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
  ): Promise<ApiProxyResponseEvent> {
    const parsedPath = parseApiProxyPath(command.path);
    if (!parsedPath.ok) {
      return this.createApiProxyJsonResponse(command.requestId, 400, { error: parsedPath.error });
    }

    let payload: unknown;
    try {
      payload = parseApiProxyBody(command.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.createApiProxyJsonResponse(command.requestId, 400, { error: message });
    }

    const pathname = parsedPath.pathname;

    try {
      if (pathname === API_PROXY_NOTIFICATION_PREFERENCES_PATH) {
        return await this.handleApiProxyNotificationPreferences(command, payload);
      }

      if (pathname === API_PROXY_REGISTER_DEVICE_PATH || pathname === API_PROXY_LEGACY_REGISTER_DEVICE_PATH) {
        return await this.handleApiProxyRegisterDevice(command, payload);
      }

      if (pathname === API_PROXY_TEST_PUSH_PATH) {
        return await this.handleApiProxyTestPush(command, payload);
      }

      if (pathname === API_PROXY_AUTH_TOKENS_PATH) {
        return await this.handleApiProxyAuthTokens(command);
      }

      if (pathname === API_PROXY_FEEDBACK_PATH) {
        return await this.handleApiProxyFeedback(command, payload, subscribedAgentId);
      }

      if (pathname === API_PROXY_SLASH_COMMANDS_PATH) {
        return await this.handleApiProxySlashCommands(command);
      }

      const smartCompactMatch = pathname.match(API_PROXY_SMART_COMPACT_ENDPOINT_PATTERN);
      if (smartCompactMatch) {
        return await this.handleApiProxySmartCompact(command, smartCompactMatch[1] ?? "");
      }

      return this.createApiProxyJsonResponse(command.requestId, 404, {
        error: `Unsupported api proxy path: ${pathname}`
      });
    } catch (error) {
      return this.createApiProxyErrorResponse(command.requestId, error);
    }
  }

  private async handleApiProxyNotificationPreferences(
    command: ApiProxyCommand,
    payload: unknown,
  ): Promise<ApiProxyResponseEvent> {
    if (command.method === "GET") {
      const preferences = await this.mobilePushService.getNotificationPreferences();
      return this.createApiProxyJsonResponse(command.requestId, 200, { preferences });
    }

    if (command.method === "PUT") {
      const preferences = await this.mobilePushService.updateNotificationPreferences(payload);
      return this.createApiProxyJsonResponse(command.requestId, 200, { ok: true, preferences });
    }

    return this.createApiProxyMethodNotAllowedResponse(command.requestId, "GET, PUT");
  }

  private async handleApiProxyRegisterDevice(
    command: ApiProxyCommand,
    payload: unknown,
  ): Promise<ApiProxyResponseEvent> {
    if (command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "POST");
    }

    const device = await this.mobilePushService.registerDevice(payload);
    return this.createApiProxyJsonResponse(command.requestId, 200, { ok: true, device });
  }

  private async handleApiProxyTestPush(
    command: ApiProxyCommand,
    payload: unknown,
  ): Promise<ApiProxyResponseEvent> {
    if (command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "POST");
    }

    const result = await this.mobilePushService.sendTestNotification(payload);
    if (!result.ok) {
      return this.createApiProxyJsonResponse(command.requestId, 502, {
        ok: false,
        error: result.error ?? "Failed to send Expo push notification"
      });
    }

    return this.createApiProxyJsonResponse(command.requestId, 200, {
      ok: true,
      ticketId: result.ticketId
    });
  }

  private async handleApiProxyAuthTokens(command: ApiProxyCommand): Promise<ApiProxyResponseEvent> {
    if (command.method !== "GET") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "GET");
    }

    const tokens = await this.swarmManager.listSettingsAuth();
    return this.createApiProxyJsonResponse(command.requestId, 200, { tokens });
  }

  private async handleApiProxyFeedback(
    command: ApiProxyCommand,
    payload: unknown,
    subscribedAgentId: string,
  ): Promise<ApiProxyResponseEvent> {
    if (command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "POST");
    }

    const submission = this.parseApiProxyFeedbackPayload(payload, subscribedAgentId);
    const submitted = await this.feedbackService.submitFeedback(submission);
    return this.createApiProxyJsonResponse(command.requestId, 201, { feedback: submitted });
  }

  private async handleApiProxySlashCommands(command: ApiProxyCommand): Promise<ApiProxyResponseEvent> {
    if (command.method !== "GET") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "GET");
    }

    const commands = await this.listApiProxySlashCommands();
    return this.createApiProxyJsonResponse(command.requestId, 200, { commands });
  }

  private async handleApiProxySmartCompact(
    command: ApiProxyCommand,
    rawAgentId: string,
  ): Promise<ApiProxyResponseEvent> {
    if (command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "POST");
    }

    let decodedAgentId = "";
    try {
      decodedAgentId = decodeURIComponent(rawAgentId).trim();
    } catch {
      decodedAgentId = "";
    }

    if (!decodedAgentId) {
      return this.createApiProxyJsonResponse(command.requestId, 400, { error: "Missing agent id" });
    }

    try {
      await this.swarmManager.smartCompactAgentContext(decodedAgentId, {
        sourceContext: { channel: "web" },
        trigger: "api"
      });
      return this.createApiProxyJsonResponse(command.requestId, 200, {
        ok: true,
        agentId: decodedAgentId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message.includes("Unknown target agent")
          ? 404
          : message.includes("not running") ||
              message.includes("does not support") ||
              message.includes("only supported") ||
              message.includes("already in progress")
            ? 409
            : message.includes("Invalid") || message.includes("Missing")
              ? 400
              : 500;

      return this.createApiProxyJsonResponse(command.requestId, statusCode, { error: message });
    }
  }

  private parseApiProxyFeedbackPayload(
    payload: unknown,
    subscribedAgentId: string,
  ): Omit<FeedbackSubmitEvent, "id" | "createdAt"> {
    if (!isRecord(payload)) {
      throw new Error("Request body must be a JSON object.");
    }

    const maybe = payload as {
      profileId?: unknown;
      sessionId?: unknown;
      scope?: unknown;
      targetId?: unknown;
      value?: unknown;
      reasonCodes?: unknown;
      comment?: unknown;
      channel?: unknown;
      clearKind?: unknown;
    };

    const defaults = this.resolveApiProxyFeedbackContext(subscribedAgentId);
    const profileId = normalizeOptionalString(maybe.profileId) ?? defaults?.profileId;
    const sessionId = normalizeOptionalString(maybe.sessionId) ?? defaults?.sessionId;

    if (!profileId || !sessionId) {
      throw new Error("profileId and sessionId are required.");
    }

    const scope = maybe.scope === "message" || maybe.scope === "session" ? maybe.scope : undefined;
    if (!scope) {
      throw new Error("scope is required.");
    }

    const targetIdRaw = normalizeOptionalString(maybe.targetId);
    const targetId = scope === "session" ? targetIdRaw ?? sessionId : targetIdRaw;
    if (!targetId) {
      throw new Error("targetId must be a non-empty string.");
    }

    const value =
      maybe.value === "up" || maybe.value === "down" || maybe.value === "comment" || maybe.value === "clear"
        ? maybe.value
        : undefined;
    if (!value) {
      throw new Error("value is required.");
    }

    const reasonCodes = normalizeReasonCodes(maybe.reasonCodes);

    if (maybe.comment !== undefined && typeof maybe.comment !== "string") {
      throw new Error("comment must be a string.");
    }
    const comment = typeof maybe.comment === "string" ? maybe.comment : "";

    if (maybe.clearKind !== undefined && maybe.clearKind !== "vote" && maybe.clearKind !== "comment") {
      throw new Error("clearKind must be one of: vote, comment.");
    }
    const clearKind = maybe.clearKind === "vote" || maybe.clearKind === "comment" ? maybe.clearKind : undefined;

    const normalizedChannel = normalizeOptionalString(maybe.channel)?.toLowerCase();
    const channel =
      normalizedChannel === "telegram" || normalizedChannel === "slack"
        ? normalizedChannel
        : normalizedChannel === "web" || normalizedChannel === "mobile" || !normalizedChannel
          ? "web"
          : undefined;

    if (!channel) {
      throw new Error("channel must be one of: web, telegram, slack.");
    }

    return {
      profileId,
      sessionId,
      scope,
      targetId,
      value,
      reasonCodes,
      comment,
      channel,
      actor: "user",
      ...(value === "clear" && clearKind ? { clearKind } : {})
    };
  }

  private resolveApiProxyFeedbackContext(
    subscribedAgentId: string,
  ): { profileId: string; sessionId: string } | undefined {
    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    if (!descriptor) {
      return undefined;
    }

    if (descriptor.role === "manager") {
      return {
        profileId: this.resolveProfileIdFromDescriptor(descriptor),
        sessionId: descriptor.agentId
      };
    }

    const managerDescriptor = this.swarmManager.getAgent(descriptor.managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager") {
      return undefined;
    }

    return {
      profileId: this.resolveProfileIdFromDescriptor(managerDescriptor),
      sessionId: managerDescriptor.agentId
    };
  }

  private async listApiProxySlashCommands(): Promise<unknown[]> {
    const slashCommandsPath = getGlobalSlashCommandsPath(this.swarmManager.getConfig().paths.dataDir);

    try {
      const raw = await readFile(slashCommandsPath, "utf8");
      if (raw.trim().length === 0) {
        return [];
      }

      const parsed = JSON.parse(raw) as { commands?: unknown };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid slash command storage format");
      }

      if (parsed.commands === undefined) {
        return [];
      }

      if (!Array.isArray(parsed.commands)) {
        throw new Error("Invalid slash command storage format: commands must be an array");
      }

      return parsed.commands;
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }

      throw error;
    }
  }

  private createApiProxyMethodNotAllowedResponse(
    requestId: string,
    allow: string,
  ): ApiProxyResponseEvent {
    return this.createApiProxyJsonResponse(
      requestId,
      405,
      { error: "Method Not Allowed" },
      { allow }
    );
  }

  private createApiProxyErrorResponse(
    requestId: string,
    error: unknown,
  ): ApiProxyResponseEvent {
    const message = error instanceof Error ? error.message : String(error);
    return this.createApiProxyJsonResponse(requestId, resolveApiProxyErrorStatusCode(message), {
      error: message
    });
  }

  private createApiProxyJsonResponse(
    requestId: string,
    status: number,
    payload: Record<string, unknown>,
    headers?: Record<string, string>,
  ): ApiProxyResponseEvent {
    const responseHeaders: Record<string, string> = {
      "content-type": API_PROXY_JSON_CONTENT_TYPE,
      ...(headers ?? {})
    };

    return {
      type: "api_proxy_response",
      requestId,
      status,
      body: JSON.stringify(payload),
      headers: responseHeaders
    };
  }

  private async handleSubscribe(
    socket: WebSocket,
    requestedAgentId?: string,
    requestedMessageCount?: number,
  ): Promise<void> {
    const managerId = this.resolveConfiguredManagerId();
    const targetAgentId =
      requestedAgentId ?? this.resolvePreferredManagerSubscriptionId() ?? this.resolveDefaultSubscriptionAgentId();
    const messageCount = requestedMessageCount !== undefined
      ? normalizeMessageCount(requestedMessageCount)
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
    this.sendSubscriptionBootstrap(socket, targetAgentId, messageCount);
  }

  private resolveSubscribedAgentId(socket: WebSocket): string | undefined {
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
    this.sendSubscriptionBootstrap(socket, fallbackAgentId, DEFAULT_SUBSCRIBE_MESSAGE_COUNT);

    return fallbackAgentId;
  }

  private resolveManagerContextAgentId(subscribedAgentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    if (!descriptor) {
      if (!this.hasRunningManagers()) {
        return this.resolveConfiguredManagerId() ?? subscribedAgentId;
      }
      return undefined;
    }

    return descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
  }

  private resolveProfileIdForAgent(agentId: string): string | undefined {
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

  private resolveProfileIdFromDescriptor(descriptor: {
    agentId: string;
    profileId?: string;
  }): string {
    return typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0
      ? descriptor.profileId.trim()
      : descriptor.agentId;
  }

  private handleDeletedAgentSubscriptions(deletedAgentIds: Set<string>): void {
    for (const [socket, subscribedAgentId] of this.subscriptions.entries()) {
      if (!deletedAgentIds.has(subscribedAgentId)) {
        continue;
      }

      const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
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
    this.send(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      subscribedAgentId: targetAgentId
    });
    this.send(socket, {
      type: "agents_snapshot",
      agents: this.swarmManager.listAgents()
    });
    this.send(socket, {
      type: "profiles_snapshot",
      profiles: this.swarmManager.listProfiles()
    });
    if (this.playwrightDiscovery) {
      this.send(socket, {
        type: "playwright_discovery_snapshot",
        snapshot: this.playwrightDiscovery.getSnapshot()
      });
      this.send(socket, {
        type: "playwright_discovery_settings_updated",
        settings: this.playwrightDiscovery.getSettings()
      });
    }
    const historyMessageCount = requestedMessageCount !== undefined
      ? normalizeMessageCount(requestedMessageCount)
      : undefined;
    const conversationHistory = this.selectBootstrapConversationHistory(targetAgentId, historyMessageCount);

    this.send(socket, {
      type: "conversation_history",
      agentId: targetAgentId,
      messages: conversationHistory
    });

    const managerContextId = this.resolveManagerContextAgentId(targetAgentId);
    if (this.integrationRegistry && managerContextId) {
      this.send(socket, this.integrationRegistry.getStatus(managerContextId, "slack"));
      this.send(socket, this.integrationRegistry.getStatus(managerContextId, "telegram"));
    }
  }

  private resolveDefaultSubscriptionAgentId(): string {
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

  private selectBootstrapConversationHistory(
    targetAgentId: string,
    requestedMessageCount?: number,
  ) {
    const fullHistory = this.swarmManager.getConversationHistory(targetAgentId);
    const requestedHistory = requestedMessageCount !== undefined
      ? fullHistory.slice(-requestedMessageCount)
      : fullHistory;

    if (this.isBootstrapConversationHistoryWithinBudget(targetAgentId, requestedHistory)) {
      return requestedHistory;
    }

    const conversationEntries = requestedHistory.filter(
      (entry) => entry.type === "conversation_message" || entry.type === "conversation_log",
    );
    const activityEntries = requestedHistory.filter(
      (entry) => entry.type === "agent_message" || entry.type === "agent_tool_call",
    );

    if (!this.isBootstrapConversationHistoryWithinBudget(targetAgentId, conversationEntries)) {
      const trimmedConversationEntries = this.trimBootstrapConversationHistoryTailToBudget(
        targetAgentId,
        conversationEntries,
      );
      this.logBootstrapHistoryTrim(targetAgentId, requestedHistory.length, trimmedConversationEntries.length);
      return trimmedConversationEntries;
    }

    const selectedActivityEntries = this.selectTailActivityEntriesWithinBootstrapBudget(
      targetAgentId,
      requestedHistory,
      conversationEntries,
      activityEntries,
    );
    const trimmedHistory = this.mergeBootstrapConversationHistory(
      requestedHistory,
      conversationEntries,
      selectedActivityEntries,
    );

    this.logBootstrapHistoryTrim(targetAgentId, requestedHistory.length, trimmedHistory.length);
    return trimmedHistory;
  }

  private isBootstrapConversationHistoryWithinBudget(
    targetAgentId: string,
    messages: BootstrapConversationHistory,
  ): boolean {
    const eventBytes = this.measureEventBytes({
      type: "conversation_history",
      agentId: targetAgentId,
      messages,
    });

    return eventBytes !== null && eventBytes <= BOOTSTRAP_HISTORY_BYTE_BUDGET;
  }

  private trimBootstrapConversationHistoryTailToBudget(
    targetAgentId: string,
    history: BootstrapConversationHistory,
  ): BootstrapConversationHistory {
    let low = 0;
    let high = history.length;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = history.slice(mid);

      if (this.isBootstrapConversationHistoryWithinBudget(targetAgentId, candidate)) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    return history.slice(low);
  }

  private selectTailActivityEntriesWithinBootstrapBudget(
    targetAgentId: string,
    sourceHistory: BootstrapConversationHistory,
    conversationEntries: BootstrapConversationHistory,
    activityEntries: BootstrapConversationHistory,
  ): BootstrapConversationHistory {
    if (activityEntries.length === 0) {
      return [];
    }

    let low = 0;
    let high = activityEntries.length;

    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      const candidateActivityEntries = activityEntries.slice(-mid);
      const candidateHistory = this.mergeBootstrapConversationHistory(
        sourceHistory,
        conversationEntries,
        candidateActivityEntries,
      );

      if (this.isBootstrapConversationHistoryWithinBudget(targetAgentId, candidateHistory)) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    return activityEntries.slice(-low);
  }

  private mergeBootstrapConversationHistory(
    sourceHistory: BootstrapConversationHistory,
    conversationEntries: BootstrapConversationHistory,
    activityEntries: BootstrapConversationHistory,
  ): BootstrapConversationHistory {
    if (conversationEntries.length === 0) {
      return activityEntries;
    }

    if (activityEntries.length === 0) {
      return conversationEntries;
    }

    const selectedEntries = new Set<BootstrapConversationEntry>();
    for (const entry of conversationEntries) {
      selectedEntries.add(entry);
    }
    for (const entry of activityEntries) {
      selectedEntries.add(entry);
    }

    return sourceHistory.filter((entry) => selectedEntries.has(entry));
  }

  private logBootstrapHistoryTrim(targetAgentId: string, originalCount: number, trimmedCount: number): void {
    if (trimmedCount === originalCount) {
      return;
    }

    console.warn("[swarm] ws:trim_bootstrap_history", {
      agentId: targetAgentId,
      originalCount,
      trimmedCount,
      maxEventBytes: BOOTSTRAP_HISTORY_BYTE_BUDGET,
    });
  }

  private measureEventBytes(event: ServerEvent): number | null {
    try {
      return Buffer.byteLength(JSON.stringify(event), "utf8");
    } catch {
      return null;
    }
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
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (socket.bufferedAmount > MAX_WS_BUFFERED_AMOUNT_BYTES) {
      console.warn("[swarm] ws:drop_event:backpressure", {
        eventType: event.type,
        bufferedAmount: socket.bufferedAmount,
        maxBufferedAmountBytes: MAX_WS_BUFFERED_AMOUNT_BYTES
      });
      return;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(event);
    } catch (error) {
      console.warn("[swarm] ws:drop_event:serialize_failed", {
        eventType: event.type,
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const eventBytes = Buffer.byteLength(serialized, "utf8");
    if (eventBytes > MAX_WS_EVENT_BYTES) {
      console.warn("[swarm] ws:drop_event:oversized", {
        eventType: event.type,
        eventBytes,
        maxEventBytes: MAX_WS_EVENT_BYTES
      });
      return;
    }

    socket.send(serialized);
  }
}

function normalizeMessageCount(messageCount: number | undefined): number | undefined {
  if (messageCount === undefined || messageCount === null) {
    return undefined; // no limit — send full history (web UI default)
  }
  if (typeof messageCount !== "number" || Number.isNaN(messageCount) || !Number.isFinite(messageCount)) {
    return undefined;
  }

  const rounded = Math.floor(messageCount);
  if (rounded <= 0) {
    return DEFAULT_SUBSCRIBE_MESSAGE_COUNT;
  }

  if (rounded > MAX_SUBSCRIBE_MESSAGE_COUNT) {
    return MAX_SUBSCRIBE_MESSAGE_COUNT;
  }

  return rounded;
}

function parseApiProxyPath(path: string): { ok: true; pathname: string } | { ok: false; error: string } {
  const normalized = path.trim();
  if (!normalized || !normalized.startsWith("/")) {
    return { ok: false, error: "api_proxy.path must start with /" };
  }

  try {
    const requestUrl = new URL(normalized, "http://api-proxy.local");
    return {
      ok: true,
      pathname: requestUrl.pathname
    };
  } catch {
    return { ok: false, error: "api_proxy.path must be a valid URL path" };
  }
}

function parseApiProxyBody(body: string | undefined): unknown {
  if (body === undefined) {
    return {};
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function normalizeReasonCodes(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("reasonCodes must be an array of strings.");
  }

  const reasonCodes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error("reasonCodes must be an array of strings.");
    }

    const normalized = entry.trim();
    if (!normalized) {
      throw new Error("reasonCodes must be an array of non-empty strings.");
    }

    reasonCodes.push(normalized);
  }

  return reasonCodes;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveApiProxyErrorStatusCode(message: string): number {
  if (message.includes("Unknown session") || message.includes("Unknown target agent")) {
    return 404;
  }

  if (
    message.includes("not running") ||
    message.includes("does not support") ||
    message.includes("only supported") ||
    message.includes("already in progress")
  ) {
    return 409;
  }

  if (
    message.includes("must be") ||
    message.includes("Invalid") ||
    message.includes("Missing") ||
    message.includes("required") ||
    message.includes("too large")
  ) {
    return 400;
  }

  return 500;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
