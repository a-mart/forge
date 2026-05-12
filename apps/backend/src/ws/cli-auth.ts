import type { IncomingMessage, ServerResponse } from "node:http";
import type { CliHttpErrorResponse } from "@forge/protocol";
import type { CliAccessAuthResult, CliAccessService } from "../swarm/cli-access-service.js";
import { applyCorsHeaders, sendJson } from "./http-utils.js";

export const CLI_HTTP_ROUTE_PREFIX = "/api/cli";
export const CLI_WS_PATH = "/api/cli/ws";
export const CLI_HTTP_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
export const CLI_CORS_ALLOWED_HEADERS = "content-type, authorization";

export function isCliHttpPath(pathname: string): boolean {
  return pathname === CLI_HTTP_ROUTE_PREFIX || pathname.startsWith(`${CLI_HTTP_ROUTE_PREFIX}/`);
}

export function isCliWebSocketPath(pathname: string): boolean {
  return pathname === CLI_WS_PATH;
}

export async function authenticateCliHttpRequest(
  cliAccessService: CliAccessService,
  request: IncomingMessage,
): Promise<CliAccessAuthResult> {
  return cliAccessService.authenticateAuthorizationHeader(request.headers.authorization, "http");
}

export async function authenticateCliWebSocketRequest(
  cliAccessService: CliAccessService,
  request: IncomingMessage,
): Promise<CliAccessAuthResult> {
  return cliAccessService.authenticateAuthorizationHeader(request.headers.authorization, "ws");
}

export function sendCliAuthFailure(
  request: IncomingMessage,
  response: ServerResponse,
  result: Extract<CliAccessAuthResult, { ok: false }>,
): void {
  applyCorsHeaders(request, response, CLI_HTTP_METHODS, CLI_CORS_ALLOWED_HEADERS);
  if (result.statusCode === 401) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="forge-cli"');
  }

  const payload: CliHttpErrorResponse = {
    error: {
      code: result.code,
      message: result.message,
      status: result.statusCode,
    },
  };
  sendJson(response, result.statusCode, payload as unknown as Record<string, unknown>);
}
