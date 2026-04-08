import { dirname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type {
  ApiProxyCommand,
  ApiProxyResponseEvent,
  FeedbackSubmitEvent,
  ServerEvent,
  TerminalCreateRequest,
  TerminalDescriptor,
  TerminalIssueTicketRequest,
  TerminalRenameRequest,
  TerminalResizeRequest,
} from "@forge/protocol";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import type { MobilePushService } from "../mobile/mobile-push-service.js";
import type { PlaywrightDiscoveryService } from "../playwright/playwright-discovery-service.js";
import { TerminalServiceError, type TerminalService } from "../terminal/terminal-service.js";
import { getGlobalSlashCommandsPath } from "../swarm/data-paths.js";
import type { UnreadTracker } from "../swarm/unread-tracker.js";
import { isPathWithinRoots, normalizeAllowlistRoots, resolveDirectoryPath } from "../swarm/cwd-policy.js";
import { FeedbackService } from "../swarm/feedback-service.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import { extractRequestId, parseClientCommand } from "./ws-command-parser.js";
import { handleAgentCommand } from "./commands/agent-command-handler.js";
import { handleConversationCommand } from "./commands/conversation-command-handler.js";
import { handleManagerCommand } from "./commands/manager-command-handler.js";
import { handleSessionCommand } from "./commands/session-command-handler.js";
import { resolveTerminalServiceStatusCode } from "./routes/terminal-routes.js";
import { resolveReadFileContentType } from "./http-utils.js";
import { resolveSessionAgentIdForUnread } from "./unread-utils.js";

const BOOTSTRAP_SUBSCRIPTION_AGENT_ID = "__bootstrap_manager__";
const DEFAULT_SUBSCRIBE_MESSAGE_COUNT = 200;
const MAX_SUBSCRIBE_MESSAGE_COUNT = 2000;
const API_PROXY_SMART_COMPACT_ENDPOINT_PATTERN = /^\/api\/agents\/([^/]+)\/smart-compact$/;
const API_PROXY_READ_FILE_PATH = "/api/read-file";
const API_PROXY_NOTIFICATION_PREFERENCES_PATH = "/api/mobile/notification-preferences";
const API_PROXY_REGISTER_DEVICE_PATH = "/api/mobile/devices/register";
const API_PROXY_LEGACY_REGISTER_DEVICE_PATH = "/api/mobile/push/register";
const API_PROXY_TEST_PUSH_PATH = "/api/mobile/push/test";
const API_PROXY_AUTH_TOKENS_PATH = "/api/auth/tokens";
const API_PROXY_UNREAD_PATH = "/api/unread";
const API_PROXY_FEEDBACK_PATH = "/api/feedback";
const API_PROXY_SLASH_COMMANDS_PATH = "/api/slash-commands";
const API_PROXY_TERMINALS_COLLECTION_PATH = "/api/terminals";
const API_PROXY_TERMINAL_ITEM_PATH_PATTERN = /^\/api\/terminals\/([^/]+)$/;
const API_PROXY_TERMINAL_TICKET_PATH_PATTERN = /^\/api\/terminals\/([^/]+)\/ticket$/;
const API_PROXY_TERMINAL_RESIZE_PATH_PATTERN = /^\/api\/terminals\/([^/]+)\/resize$/;
const API_PROXY_JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_READ_FILE_CONTENT_BYTES = 2 * 1024 * 1024;
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
  private readonly terminalService: TerminalService | null;
  private readonly listTerminalsForSession?: (sessionAgentId: string) => TerminalDescriptor[];
  private readonly unreadTracker: UnreadTracker | null;

  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Map<WebSocket, string>();

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
    this.integrationRegistry = options.integrationRegistry;
    this.mobilePushService = options.mobilePushService;
    this.playwrightDiscovery = options.playwrightDiscovery;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    this.feedbackService = new FeedbackService(this.swarmManager.getConfig().paths.dataDir);
    this.terminalService = options.terminalService ?? null;
    this.listTerminalsForSession = options.listTerminalsForSession;
    this.unreadTracker = options.unreadTracker ?? null;
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

      this.send(client, event);
    }
  }

  broadcastToSession(sessionAgentId: string, event: ServerEvent): void {
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

      const effectiveSessionAgentId = this.resolveTerminalScopeAgentId(subscribedAgent) ?? subscribedAgent;
      if (effectiveSessionAgentId !== sessionAgentId) {
        continue;
      }

      this.send(client, event);
    }
  }

  broadcastUnreadCountUpdate(sessionAgentId: string, count: number): void {
    if (!this.wss) {
      return;
    }

    const event: ServerEvent = {
      type: "unread_count_update",
      agentId: sessionAgentId,
      count,
    };

    for (const client of this.wss.clients) {
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

    if (command.type === "mark_unread") {
      if (!this.unreadTracker) {
        return;
      }

      const descriptor = this.swarmManager.getAgent(command.agentId);
      if (!descriptor || descriptor.role !== "manager") {
        return;
      }

      const profileId = this.resolveProfileIdFromDescriptor(descriptor);
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

        const agentProfileId = this.resolveProfileIdFromDescriptor(agent);
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

      if (pathname === API_PROXY_UNREAD_PATH) {
        return await this.handleApiProxyUnread(command);
      }

      if (pathname === API_PROXY_READ_FILE_PATH) {
        return await this.handleApiProxyReadFile(command, payload);
      }

      if (pathname === API_PROXY_FEEDBACK_PATH) {
        return await this.handleApiProxyFeedback(command, payload, subscribedAgentId);
      }

      if (pathname === API_PROXY_SLASH_COMMANDS_PATH) {
        return await this.handleApiProxySlashCommands(command);
      }

      if (pathname === API_PROXY_TERMINALS_COLLECTION_PATH) {
        return await this.handleApiProxyTerminals(command, payload);
      }

      const terminalTicketMatch = pathname.match(API_PROXY_TERMINAL_TICKET_PATH_PATTERN);
      if (terminalTicketMatch) {
        return await this.handleApiProxyTerminalTicket(command, terminalTicketMatch[1] ?? "", payload);
      }

      const terminalResizeMatch = pathname.match(API_PROXY_TERMINAL_RESIZE_PATH_PATTERN);
      if (terminalResizeMatch) {
        return await this.handleApiProxyTerminalResize(command, terminalResizeMatch[1] ?? "", payload);
      }

      const terminalItemMatch = pathname.match(API_PROXY_TERMINAL_ITEM_PATH_PATTERN);
      if (terminalItemMatch) {
        return await this.handleApiProxyTerminalItem(command, terminalItemMatch[1] ?? "", payload);
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

  private async handleApiProxyUnread(command: ApiProxyCommand): Promise<ApiProxyResponseEvent> {
    if (command.method !== "GET") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "GET");
    }

    return this.createApiProxyJsonResponse(command.requestId, 200, {
      counts: this.unreadTracker?.getSnapshot() ?? {},
    });
  }

  private async handleApiProxyReadFile(
    command: ApiProxyCommand,
    payload: unknown,
  ): Promise<ApiProxyResponseEvent> {
    if (command.method !== "GET" && command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "GET, POST");
    }

    let requestedPath = "";
    let agentId: string | undefined;

    if (command.method === "GET") {
      const queryUrl = new URL(command.path, "http://api-proxy.local");
      const queryPath = queryUrl.searchParams.get("path");
      if (typeof queryPath !== "string" || queryPath.trim().length === 0) {
        return this.createApiProxyJsonResponse(command.requestId, 400, { error: "path must be a non-empty string." });
      }

      requestedPath = queryPath.trim();
      const rawAgentId = queryUrl.searchParams.get("agentId")?.trim();
      agentId = rawAgentId || undefined;
    } else {
      if (!isRecord(payload)) {
        throw new Error("Request body must be a JSON object.");
      }

      const rawPath = (payload as { path?: unknown }).path;
      if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
        return this.createApiProxyJsonResponse(command.requestId, 400, { error: "path must be a non-empty string." });
      }

      requestedPath = rawPath.trim();
      const rawAgentId = (payload as { agentId?: unknown }).agentId;
      if (typeof rawAgentId === "string" && rawAgentId.trim().length > 0) {
        agentId = rawAgentId.trim();
      }
    }

    const resolvedPath = await resolveReadFilePath(requestedPath, this.swarmManager, agentId);

    let fileStats;
    try {
      fileStats = await stat(resolvedPath);
    } catch {
      return this.createApiProxyJsonResponse(command.requestId, 404, { error: "File not found." });
    }

    if (!fileStats.isFile()) {
      return this.createApiProxyJsonResponse(command.requestId, 400, { error: "Requested path must point to a file." });
    }

    if (fileStats.size > MAX_READ_FILE_CONTENT_BYTES) {
      return this.createApiProxyJsonResponse(command.requestId, 413, {
        error: `File is too large. Maximum supported size is ${MAX_READ_FILE_CONTENT_BYTES} bytes.`
      });
    }

    const fileContents = await readFile(resolvedPath);
    const contentType = resolveReadFileContentType(resolvedPath);
    const isBinary = isLikelyBinary(fileContents) || contentType.startsWith("image/");

    if (isBinary) {
      return this.createApiProxyJsonResponse(
        command.requestId,
        200,
        {
          path: resolvedPath,
          binary: true,
          encoding: "base64",
          contentType,
          content: fileContents.toString("base64")
        },
        {
          "x-read-file-content-type": contentType,
          "x-read-file-content-encoding": "base64"
        }
      );
    }

    const content = fileContents.toString("utf8");

    return this.createApiProxyJsonResponse(command.requestId, 200, {
      path: resolvedPath,
      content,
      contentType
    }, {
      "x-read-file-content-type": contentType
    });
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

  private async handleApiProxyTerminals(
    command: ApiProxyCommand,
    payload: unknown,
  ): Promise<ApiProxyResponseEvent> {
    if (!this.terminalService) {
      return this.createApiProxyJsonResponse(command.requestId, 503, { error: "Terminals not available" });
    }

    if (command.method !== "GET" && command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "GET, POST");
    }

    try {
      if (command.method === "GET") {
        const requestUrl = new URL(command.path, "http://api-proxy.local");
        const sessionAgentId = requireApiProxyQueryString(requestUrl, "sessionAgentId");
        return this.createApiProxyJsonResponse(command.requestId, 200, {
          terminals: this.terminalService.listTerminals(sessionAgentId),
        });
      }

      const request = parseApiProxyTerminalCreateBody(payload);
      const created = await this.terminalService.create(request);
      return this.createApiProxyJsonResponse(command.requestId, 201, { ...created });
    } catch (error) {
      return this.createApiProxyTerminalErrorResponse(command.requestId, error);
    }
  }

  private async handleApiProxyTerminalItem(
    command: ApiProxyCommand,
    rawTerminalId: string,
    payload: unknown,
  ): Promise<ApiProxyResponseEvent> {
    if (!this.terminalService) {
      return this.createApiProxyJsonResponse(command.requestId, 503, { error: "Terminals not available" });
    }

    if (command.method !== "PATCH" && command.method !== "DELETE") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "PATCH, DELETE");
    }

    const terminalId = decodeApiProxyPathSegment(rawTerminalId);
    if (!terminalId) {
      return this.createApiProxyJsonResponse(command.requestId, 400, {
        error: "Invalid terminal id",
        code: "INVALID_REQUEST",
      });
    }

    try {
      if (command.method === "PATCH") {
        const request = parseApiProxyTerminalRenameBody(payload);
        const terminal = await this.terminalService.renameTerminal({ terminalId, request });
        return this.createApiProxyJsonResponse(command.requestId, 200, { terminal });
      }

      const requestUrl = new URL(command.path, "http://api-proxy.local");
      const sessionAgentId = requireApiProxyQueryString(requestUrl, "sessionAgentId");
      await this.terminalService.close(terminalId, sessionAgentId, "user_closed");
      return this.createApiProxyJsonResponse(command.requestId, 200, { ok: true });
    } catch (error) {
      return this.createApiProxyTerminalErrorResponse(command.requestId, error);
    }
  }

  private async handleApiProxyTerminalTicket(
    command: ApiProxyCommand,
    rawTerminalId: string,
    payload: unknown,
  ): Promise<ApiProxyResponseEvent> {
    if (!this.terminalService) {
      return this.createApiProxyJsonResponse(command.requestId, 503, { error: "Terminals not available" });
    }

    if (command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "POST");
    }

    const terminalId = decodeApiProxyPathSegment(rawTerminalId);
    if (!terminalId) {
      return this.createApiProxyJsonResponse(command.requestId, 400, {
        error: "Invalid terminal id",
        code: "INVALID_REQUEST",
      });
    }

    try {
      const request = parseApiProxyTerminalIssueTicketBody(payload);
      const ticket = await this.terminalService.issueWsTicket({
        terminalId,
        sessionAgentId: request.sessionAgentId,
      });
      return this.createApiProxyJsonResponse(command.requestId, 200, { ...ticket });
    } catch (error) {
      return this.createApiProxyTerminalErrorResponse(command.requestId, error);
    }
  }

  private async handleApiProxyTerminalResize(
    command: ApiProxyCommand,
    rawTerminalId: string,
    payload: unknown,
  ): Promise<ApiProxyResponseEvent> {
    if (!this.terminalService) {
      return this.createApiProxyJsonResponse(command.requestId, 503, { error: "Terminals not available" });
    }

    if (command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "POST");
    }

    const terminalId = decodeApiProxyPathSegment(rawTerminalId);
    if (!terminalId) {
      return this.createApiProxyJsonResponse(command.requestId, 400, {
        error: "Invalid terminal id",
        code: "INVALID_REQUEST",
      });
    }

    try {
      const request = parseApiProxyTerminalResizeBody(payload);
      const terminal = await this.terminalService.resizeTerminal({ terminalId, request });
      return this.createApiProxyJsonResponse(command.requestId, 200, { terminal });
    } catch (error) {
      return this.createApiProxyTerminalErrorResponse(command.requestId, error);
    }
  }

  private async handleApiProxySmartCompact(
    command: ApiProxyCommand,
    rawAgentId: string,
  ): Promise<ApiProxyResponseEvent> {
    if (command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "POST");
    }

    const payload = parseApiProxyBody(command.body);
    const customInstructions = parseCompactCustomInstructionsBody(payload);

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
        customInstructions,
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
      normalizedChannel === "telegram"
        ? normalizedChannel
        : normalizedChannel === "web" || normalizedChannel === "mobile" || !normalizedChannel
          ? "web"
          : undefined;

    if (!channel) {
      throw new Error("channel must be one of: web, telegram.");
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

  private createApiProxyTerminalErrorResponse(
    requestId: string,
    error: unknown,
  ): ApiProxyResponseEvent {
    if (error instanceof TerminalServiceError) {
      return this.createApiProxyJsonResponse(requestId, resolveTerminalServiceStatusCode(error), {
        error: error.message,
        code: error.code,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    const statusCode =
      message.includes("must be") ||
      message.includes("Invalid") ||
      message.includes("Missing") ||
      message.includes("required") ||
      message.includes("too large")
        ? 400
        : 500;

    return this.createApiProxyJsonResponse(requestId, statusCode, {
      error: message,
      code: statusCode === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR",
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

    const readSessionAgentId =
      resolveSessionAgentIdForUnread(this.swarmManager, targetAgentId) ?? targetAgentId;
    const readProfileId = this.resolveProfileIdForAgent(readSessionAgentId);
    if (readProfileId && this.unreadTracker) {
      const previousCount = this.unreadTracker.markRead(readProfileId, readSessionAgentId);
      if (previousCount > 0) {
        this.broadcastUnreadCountUpdate(readSessionAgentId, 0);
      }
    }

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

  private resolveTerminalScopeAgentId(subscribedAgentId: string): string | undefined {
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
      agents: this.swarmManager.listBootstrapAgents()
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

    const pendingChoiceIds = this.swarmManager.getPendingChoiceIdsForSession(targetAgentId);
    this.send(socket, {
      type: "pending_choices_snapshot",
      agentId: targetAgentId,
      choiceIds: pendingChoiceIds,
    });

    const effectiveTerminalSessionId = this.resolveTerminalScopeAgentId(targetAgentId) ?? targetAgentId;
    this.send(socket, {
      type: "terminals_snapshot",
      sessionAgentId: effectiveTerminalSessionId,
      terminals:
        this.listTerminalsForSession?.(effectiveTerminalSessionId) ??
        this.terminalService?.listTerminals(effectiveTerminalSessionId) ??
        [],
    });

    if (this.unreadTracker) {
      this.send(socket, {
        type: "unread_counts_snapshot",
        counts: this.unreadTracker.getSnapshot(),
      });
    }

    const managerContextId = this.resolveManagerContextAgentId(targetAgentId);
    if (this.integrationRegistry && managerContextId) {
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
      (entry) =>
        entry.type === "conversation_message" ||
        entry.type === "conversation_log" ||
        entry.type === "choice_request",
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

    const socketIntegrity = this.validateSocketSendPath(socket);
    if (!socketIntegrity.ok) {
      console.warn("[swarm] ws:drop_event:invalid_socket", {
        eventType: event.type,
        reason: socketIntegrity.reason
      });
      this.dropSocket(socket);
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

    try {
      socket.send(serialized, (error) => {
        if (!error) {
          return;
        }

        console.warn("[swarm] ws:drop_event:send_failed", {
          eventType: event.type,
          message: error.message
        });
        this.dropSocket(socket);
      });
    } catch (error) {
      console.warn("[swarm] ws:drop_event:send_failed", {
        eventType: event.type,
        message: error instanceof Error ? error.message : String(error)
      });
      this.dropSocket(socket);
    }
  }

  private validateSocketSendPath(
    socket: WebSocket
  ): { ok: true } | { ok: false; reason: "missing_underlying_socket" | "missing_underlying_socket_write" | "socket_self_reference" | "socket_write_recurses_into_websocket_send" } {
    const rawSocket = (socket as WebSocket & { _socket?: unknown })._socket;
    if (!rawSocket || typeof rawSocket !== "object") {
      return { ok: false, reason: "missing_underlying_socket" };
    }

    if (rawSocket === socket) {
      return { ok: false, reason: "socket_self_reference" };
    }

    const rawSocketWrite = (rawSocket as { write?: unknown }).write;
    if (typeof rawSocketWrite !== "function") {
      return { ok: false, reason: "missing_underlying_socket_write" };
    }

    if (rawSocketWrite === socket.send) {
      return { ok: false, reason: "socket_write_recurses_into_websocket_send" };
    }

    return { ok: true };
  }

  private dropSocket(socket: WebSocket): void {
    this.subscriptions.delete(socket);

    try {
      socket.terminate();
    } catch {
      // best effort
    }
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

function resolveReadFilePath(
  requestedPath: string,
  swarmManager: SwarmManager,
  agentId?: string,
): Promise<string> {
  const requestedPathContext = resolveReadFileAccessContext(swarmManager, agentId);
  const normalizedRequestedPath = normalizeFileAccessPath(requestedPath);
  return resolveDirectoryPathWithinRoots(normalizedRequestedPath, requestedPathContext.rootDir, requestedPathContext.allowedRoots);
}

interface ReadFileAccessContext {
  rootDir: string;
  allowedRoots: string[];
}

function resolveReadFileAccessContext(
  swarmManager: SwarmManager,
  agentId?: string,
): ReadFileAccessContext {
  const config = swarmManager.getConfig();
  const normalizedAgentId = agentId?.trim();

  if (!normalizedAgentId) {
    return {
      rootDir: config.paths.rootDir,
      allowedRoots: normalizeAllowlistRoots([
        ...config.cwdAllowlistRoots,
        config.paths.rootDir,
        config.paths.dataDir,
        config.paths.uploadsDir
      ])
    };
  }

  const descriptor = swarmManager.getAgent(normalizedAgentId);
  if (!descriptor) {
    throw new Error(`Unknown agent: ${normalizedAgentId}`);
  }

  const contextualRoots = [descriptor.cwd];
  if (descriptor.role === "worker") {
    const owner = swarmManager.getAgent(descriptor.managerId);
    if (owner?.role === "manager") {
      contextualRoots.push(owner.cwd);
    }
  }

  return {
    rootDir: descriptor.cwd,
    allowedRoots: normalizeAllowlistRoots([
      ...contextualRoots,
      ...config.cwdAllowlistRoots,
      config.paths.dataDir,
      config.paths.uploadsDir
    ])
  };
}

function resolveDirectoryPathWithinRoots(
  requestedPath: string,
  rootDir: string,
  allowedRoots: string[],
): Promise<string> {
  const normalizedRequestedPath = resolveDirectoryPath(requestedPath, rootDir);

  return (async () => {
    if (await isPathWithinRoots(normalizedRequestedPath, allowedRoots)) {
      return normalizedRequestedPath;
    }

    let existingAncestor = normalizedRequestedPath;
    while (true) {
      try {
        await stat(existingAncestor);
        break;
      } catch {
        const parentPath = dirname(existingAncestor);
        if (parentPath === existingAncestor) {
          break;
        }

        existingAncestor = parentPath;
      }
    }

    if (!(await isPathWithinRoots(existingAncestor, allowedRoots))) {
      throw new Error("Path is outside allowed roots.");
    }

    return normalizedRequestedPath;
  })();
}

function normalizeFileAccessPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return "";
  }

  if (/^\/+[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed.replace(/^\/+/, "");
  }

  return trimmed;
}

function isLikelyBinary(content: Buffer): boolean {
  if (content.length === 0) {
    return false;
  }

  const sample = content.subarray(0, 4000);
  let suspiciousChars = 0;

  for (const code of sample) {
    const isAllowedControl = code === 9 || code === 10 || code === 13;
    if (!isAllowedControl && (code < 32 || code === 255)) {
      suspiciousChars += 1;
    }
  }

  return suspiciousChars > 0 && suspiciousChars / sample.length > 0.12;
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

function parseCompactCustomInstructionsBody(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const customInstructions = value.customInstructions;
  if (customInstructions === undefined) {
    return undefined;
  }

  if (typeof customInstructions !== "string") {
    throw new Error("customInstructions must be a string");
  }

  const trimmed = customInstructions.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseApiProxyTerminalCreateBody(value: unknown): TerminalCreateRequest {
  const record = requireApiProxyRecord(value, "Terminal create body must be an object.");
  const shellArgs = record.shellArgs;
  if (shellArgs !== undefined && (!Array.isArray(shellArgs) || shellArgs.some((entry) => typeof entry !== "string"))) {
    throw new Error("shellArgs must be an array of strings.");
  }

  return {
    sessionAgentId: requireApiProxyBodyString(record, "sessionAgentId"),
    name: optionalApiProxyTerminalName(record),
    shell: optionalApiProxyBodyString(record, "shell"),
    shellArgs: shellArgs as string[] | undefined,
    cwd: optionalApiProxyBodyString(record, "cwd"),
    cols: optionalApiProxyBodyInteger(record, "cols"),
    rows: optionalApiProxyBodyInteger(record, "rows"),
  };
}

function parseApiProxyTerminalRenameBody(value: unknown): TerminalRenameRequest {
  const record = requireApiProxyRecord(value, "Terminal rename body must be an object.");
  const name = optionalApiProxyBodyString(record, "title") ?? optionalApiProxyBodyString(record, "name");
  if (!name) {
    throw new Error("title must be a non-empty string.");
  }

  return {
    sessionAgentId: requireApiProxyBodyString(record, "sessionAgentId"),
    name,
  };
}

function parseApiProxyTerminalResizeBody(value: unknown): TerminalResizeRequest {
  const record = requireApiProxyRecord(value, "Terminal resize body must be an object.");
  const cols = record.cols;
  const rows = record.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new Error("cols and rows must be integers.");
  }

  return {
    sessionAgentId: requireApiProxyBodyString(record, "sessionAgentId"),
    cols: cols as number,
    rows: rows as number,
  };
}

function parseApiProxyTerminalIssueTicketBody(value: unknown): TerminalIssueTicketRequest {
  const record = requireApiProxyRecord(value, "Terminal ticket body must be an object.");
  return {
    sessionAgentId: requireApiProxyBodyString(record, "sessionAgentId"),
  };
}

function requireApiProxyRecord(input: unknown, message: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(message);
  }

  return input;
}

function requireApiProxyBodyString(record: Record<string, unknown>, field: string): string {
  const value = optionalApiProxyBodyString(record, field);
  if (!value) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value;
}

function optionalApiProxyBodyString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalApiProxyBodyInteger(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }

  return value as number;
}

function optionalApiProxyTerminalName(record: Record<string, unknown>): string | undefined {
  return optionalApiProxyBodyString(record, "title") ?? optionalApiProxyBodyString(record, "name");
}

function requireApiProxyQueryString(requestUrl: URL, field: string): string {
  const value = requestUrl.searchParams.get(field);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

function decodeApiProxyPathSegment(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
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
  if (
    message.includes("Unknown session") ||
    message.includes("Unknown target agent") ||
    message.includes("Unknown agent")
  ) {
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
