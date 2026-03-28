import type {
  TerminalCreateRequest,
  TerminalIssueTicketRequest,
  TerminalRenameRequest,
  TerminalResizeRequest,
} from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyTerminalCorsHeaders,
  validateTerminalHttpOrigin,
} from "../../terminal/terminal-access-policy.js";
import { TerminalService, TerminalServiceError } from "../../terminal/terminal-service.js";
import {
  decodePathSegment,
  matchPathPattern,
  readJsonBody,
  sendJson,
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const TERMINALS_COLLECTION_PATH = "/api/terminals";
const TERMINAL_ITEM_PATH_PATTERN = /^\/api\/terminals\/([^/]+)$/;
const TERMINAL_RESIZE_PATH_PATTERN = /^\/api\/terminals\/([^/]+)\/resize$/;
const TERMINAL_TICKET_PATH_PATTERN = /^\/api\/terminals\/([^/]+)\/ticket$/;
const TERMINALS_COLLECTION_METHODS = "GET, POST, OPTIONS";
const TERMINAL_ITEM_METHODS = "PATCH, DELETE, OPTIONS";
const TERMINAL_RESIZE_METHODS = "POST, OPTIONS";
const TERMINAL_TICKET_METHODS = "POST, OPTIONS";

export function createTerminalRoutes(options: { terminalService: TerminalService }): HttpRoute[] {
  const { terminalService } = options;

  return [
    {
      methods: TERMINALS_COLLECTION_METHODS,
      matches: (pathname) => pathname === TERMINALS_COLLECTION_PATH,
      handle: async (request, response, requestUrl) => {
        const access = beginTerminalRequest(request, response, requestUrl, TERMINALS_COLLECTION_METHODS);
        if (!access) {
          return;
        }

        if (request.method !== "GET" && request.method !== "POST") {
          response.setHeader("Allow", TERMINALS_COLLECTION_METHODS);
          sendTerminalJsonError(response, 405, "Method Not Allowed", "METHOD_NOT_ALLOWED");
          return;
        }

        try {
          if (request.method === "GET") {
            const sessionAgentId = requireQueryString(requestUrl, "sessionAgentId");
            sendJson(response, 200, {
              terminals: terminalService.listTerminals(sessionAgentId),
            });
            return;
          }

          const body = await readJsonBody(request);
          const payload = parseTerminalCreateRequest(body);
          const created = await terminalService.create(payload);
          sendJson(response, 201, { ...created });
        } catch (error) {
          sendTerminalRouteError(request, response, TERMINALS_COLLECTION_METHODS, access.allowedOrigin, error);
        }
      },
    },
    {
      methods: TERMINAL_ITEM_METHODS,
      matches: (pathname) => TERMINAL_ITEM_PATH_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const access = beginTerminalRequest(request, response, requestUrl, TERMINAL_ITEM_METHODS);
        if (!access) {
          return;
        }

        if (request.method !== "PATCH" && request.method !== "DELETE") {
          response.setHeader("Allow", TERMINAL_ITEM_METHODS);
          sendTerminalJsonError(response, 405, "Method Not Allowed", "METHOD_NOT_ALLOWED");
          return;
        }

        const terminalId = resolveTerminalIdFromPath(requestUrl.pathname, TERMINAL_ITEM_PATH_PATTERN);
        if (!terminalId) {
          sendTerminalJsonError(response, 400, "Invalid terminal id", "INVALID_TERMINAL_ID");
          return;
        }

        try {
          if (request.method === "PATCH") {
            const body = await readJsonBody(request);
            const payload = parseTerminalRenameRequest(body);
            const terminal = await terminalService.renameTerminal({ terminalId, request: payload });
            sendJson(response, 200, { terminal });
            return;
          }

          const sessionAgentId = requireQueryString(requestUrl, "sessionAgentId");
          await terminalService.close(terminalId, sessionAgentId, "user_closed");
          response.statusCode = 204;
          response.end();
        } catch (error) {
          sendTerminalRouteError(request, response, TERMINAL_ITEM_METHODS, access.allowedOrigin, error);
        }
      },
    },
    {
      methods: TERMINAL_RESIZE_METHODS,
      matches: (pathname) => TERMINAL_RESIZE_PATH_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const access = beginTerminalRequest(request, response, requestUrl, TERMINAL_RESIZE_METHODS);
        if (!access) {
          return;
        }

        if (request.method !== "POST") {
          response.setHeader("Allow", TERMINAL_RESIZE_METHODS);
          sendTerminalJsonError(response, 405, "Method Not Allowed", "METHOD_NOT_ALLOWED");
          return;
        }

        const terminalId = resolveTerminalIdFromPath(requestUrl.pathname, TERMINAL_RESIZE_PATH_PATTERN);
        if (!terminalId) {
          sendTerminalJsonError(response, 400, "Invalid terminal id", "INVALID_TERMINAL_ID");
          return;
        }

        try {
          const body = await readJsonBody(request);
          const payload = parseTerminalResizeRequest(body);
          const terminal = await terminalService.resizeTerminal({ terminalId, request: payload });
          sendJson(response, 200, { terminal });
        } catch (error) {
          sendTerminalRouteError(request, response, TERMINAL_RESIZE_METHODS, access.allowedOrigin, error);
        }
      },
    },
    {
      methods: TERMINAL_TICKET_METHODS,
      matches: (pathname) => TERMINAL_TICKET_PATH_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const access = beginTerminalRequest(request, response, requestUrl, TERMINAL_TICKET_METHODS);
        if (!access) {
          return;
        }

        if (request.method !== "POST") {
          response.setHeader("Allow", TERMINAL_TICKET_METHODS);
          sendTerminalJsonError(response, 405, "Method Not Allowed", "METHOD_NOT_ALLOWED");
          return;
        }

        const terminalId = resolveTerminalIdFromPath(requestUrl.pathname, TERMINAL_TICKET_PATH_PATTERN);
        if (!terminalId) {
          sendTerminalJsonError(response, 400, "Invalid terminal id", "INVALID_TERMINAL_ID");
          return;
        }

        try {
          const body = await readJsonBody(request);
          const payload = parseTerminalIssueTicketRequest(body);
          const ticket = await terminalService.issueWsTicket({
            terminalId,
            sessionAgentId: payload.sessionAgentId,
          });
          sendJson(response, 200, { ...ticket });
        } catch (error) {
          sendTerminalRouteError(request, response, TERMINAL_TICKET_METHODS, access.allowedOrigin, error);
        }
      },
    },
  ];
}

function beginTerminalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  methods: string,
): { allowedOrigin: string | null } | null {
  const validation = validateTerminalHttpOrigin(request, requestUrl);
  if (!validation.ok) {
    sendTerminalJsonError(response, 403, validation.errorMessage, "ORIGIN_NOT_ALLOWED");
    return null;
  }

  applyTerminalCorsHeaders(request, response, methods, validation.allowedOrigin);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return null;
  }

  return { allowedOrigin: validation.allowedOrigin };
}

function parseTerminalCreateRequest(input: unknown): TerminalCreateRequest {
  const record = requireRecord(input, "Terminal create body must be an object.");
  const shellArgs = record.shellArgs;
  if (shellArgs !== undefined && (!Array.isArray(shellArgs) || shellArgs.some((entry) => typeof entry !== "string"))) {
    throw new Error("shellArgs must be an array of strings.");
  }

  return {
    sessionAgentId: requireBodyString(record, "sessionAgentId"),
    name: optionalBodyString(record, "name"),
    shell: optionalBodyString(record, "shell"),
    shellArgs: shellArgs as string[] | undefined,
    cwd: optionalBodyString(record, "cwd"),
    cols: optionalBodyInteger(record, "cols"),
    rows: optionalBodyInteger(record, "rows"),
  };
}

function parseTerminalRenameRequest(input: unknown): TerminalRenameRequest {
  const record = requireRecord(input, "Terminal rename body must be an object.");
  return {
    sessionAgentId: requireBodyString(record, "sessionAgentId"),
    name: requireBodyString(record, "name"),
  };
}

function parseTerminalResizeRequest(input: unknown): TerminalResizeRequest {
  const record = requireRecord(input, "Terminal resize body must be an object.");
  const cols = record.cols;
  const rows = record.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new Error("cols and rows must be integers.");
  }

  return {
    sessionAgentId: requireBodyString(record, "sessionAgentId"),
    cols: cols as number,
    rows: rows as number,
  };
}

function parseTerminalIssueTicketRequest(input: unknown): TerminalIssueTicketRequest {
  const record = requireRecord(input, "Terminal ticket body must be an object.");
  return {
    sessionAgentId: requireBodyString(record, "sessionAgentId"),
  };
}

function requireRecord(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(message);
  }

  return input as Record<string, unknown>;
}

function requireBodyString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

function optionalBodyString(record: Record<string, unknown>, field: string): string | undefined {
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

function optionalBodyInteger(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }

  return value as number;
}

function requireQueryString(requestUrl: URL, field: string): string {
  const value = requestUrl.searchParams.get(field);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

function resolveTerminalIdFromPath(pathname: string, pattern: RegExp): string | null {
  const match = matchPathPattern(pathname, pattern);
  if (!match) {
    return null;
  }

  return decodePathSegment(match[1]) ?? null;
}

function sendTerminalRouteError(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string,
  allowedOrigin: string | null,
  error: unknown,
): void {
  applyTerminalCorsHeaders(request, response, methods, allowedOrigin);

  if (error instanceof TerminalServiceError) {
    sendJson(response, resolveTerminalServiceStatusCode(error), {
      error: error.message,
      code: error.code,
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const statusCode =
    message.includes("must be") || message.includes("Invalid") || message.includes("Missing") || message.includes("too large")
      ? 400
      : 500;
  sendTerminalJsonError(response, statusCode, message, statusCode === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR");
}

function sendTerminalJsonError(
  response: ServerResponse,
  statusCode: number,
  error: string,
  code?: string,
): void {
  sendJson(response, statusCode, code ? { error, code } : { error });
}

export function resolveTerminalServiceStatusCode(error: TerminalServiceError): number {
  switch (error.code) {
    case "SESSION_NOT_FOUND":
    case "TERMINAL_NOT_FOUND":
      return 404;
    case "TERMINAL_SESSION_MISMATCH":
      return 403;
    case "TERMINAL_LIMIT_REACHED":
    case "TERMINAL_ALREADY_CLOSING":
      return 409;
    case "PTY_UNAVAILABLE":
    case "SERVICE_SHUTTING_DOWN":
      return 503;
    case "INVALID_CWD":
    case "INVALID_SHELL":
    case "INVALID_REQUEST":
    case "INVALID_DIMENSIONS":
    case "INVALID_TICKET":
      return 400;
    case "SESSION_PROFILE_MISMATCH":
      return 403;
    case "RESTORE_FAILED":
      return 409;
    default:
      return 500;
  }
}
