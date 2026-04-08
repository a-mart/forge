import { readFile } from "node:fs/promises";
import type {
  ApiProxyCommand,
  ApiProxyResponseEvent,
  FeedbackSubmitEvent,
} from "@forge/protocol";
import type { MobilePushService } from "../mobile/mobile-push-service.js";
import { getGlobalSlashCommandsPath } from "../swarm/data-paths.js";
import { FeedbackService } from "../swarm/feedback-service.js";
import type { UnreadTracker } from "../swarm/unread-tracker.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { TerminalServiceError, type TerminalService } from "../terminal/terminal-service.js";
import { resolveTerminalServiceStatusCode } from "./routes/terminal-routes.js";
import {
  decodeApiProxyPathSegment,
  isRecord,
  normalizeOptionalString,
  normalizeReasonCodes,
  parseApiProxyBody,
  parseApiProxyPath,
  parseApiProxyTerminalCreateBody,
  parseApiProxyTerminalIssueTicketBody,
  parseApiProxyTerminalRenameBody,
  parseApiProxyTerminalResizeBody,
  parseCompactCustomInstructionsBody,
  requireApiProxyQueryString,
} from "./ws-api-proxy-parse.js";
import { readApiProxyFile } from "./ws-file-access.js";

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

export class WsApiProxy {
  private readonly swarmManager: SwarmManager;
  private readonly mobilePushService: MobilePushService;
  private readonly feedbackService: FeedbackService;
  private readonly terminalService: TerminalService | null;
  private readonly unreadTracker: UnreadTracker | null;

  constructor(options: {
    swarmManager: SwarmManager;
    mobilePushService: MobilePushService;
    feedbackService: FeedbackService;
    terminalService: TerminalService | null;
    unreadTracker: UnreadTracker | null;
  }) {
    this.swarmManager = options.swarmManager;
    this.mobilePushService = options.mobilePushService;
    this.feedbackService = options.feedbackService;
    this.terminalService = options.terminalService;
    this.unreadTracker = options.unreadTracker;
  }

  async routeApiProxyCommand(
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
        return await this.handleApiProxySmartCompact(command, smartCompactMatch[1] ?? "", payload);
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

    const result = await readApiProxyFile({
      requestedPath,
      swarmManager: this.swarmManager,
      agentId,
    });

    return this.createApiProxyJsonResponse(command.requestId, result.status, result.payload, result.headers);
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
    payload: unknown,
  ): Promise<ApiProxyResponseEvent> {
    if (command.method !== "POST") {
      return this.createApiProxyMethodNotAllowedResponse(command.requestId, "POST");
    }

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

  private resolveProfileIdFromDescriptor(descriptor: { agentId: string; profileId?: string }): string {
    return typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0
      ? descriptor.profileId.trim()
      : descriptor.agentId;
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
