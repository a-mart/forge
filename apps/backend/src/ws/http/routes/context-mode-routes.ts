import type {
  ProjectContextModeSnapshot,
  SessionContextModeSnapshot,
} from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import {
  ContextModeValidationError,
  parseSessionContextModeWrite,
  requireContextMode,
} from "../../../swarm/context-mode.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, decodePathSegment, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const PROFILE_CONTEXT_MODE_PATTERN = /^\/api\/profiles\/([^/]+)\/context-mode$/;
const AGENT_CONTEXT_MODE_PATTERN = /^\/api\/agents\/([^/]+)\/context-mode$/;
const CONTEXT_MODE_METHODS = "GET, PUT, OPTIONS";

export function createContextModeRoutes(options: {
  swarmManager: SwarmManager;
  runtimeTarget: RuntimeTarget;
}): HttpRoute[] {
  return [
    {
      methods: CONTEXT_MODE_METHODS,
      matches: (pathname) => PROFILE_CONTEXT_MODE_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleProfileContextModeRequest(options, request, response, requestUrl);
      },
    },
    {
      methods: CONTEXT_MODE_METHODS,
      matches: (pathname) => AGENT_CONTEXT_MODE_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleAgentContextModeRequest(options, request, response, requestUrl);
      },
    },
  ];
}

async function handleProfileContextModeRequest(
  options: { swarmManager: SwarmManager; runtimeTarget: RuntimeTarget },
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, CONTEXT_MODE_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, CONTEXT_MODE_METHODS);

  if (!isBuilderRuntimeTarget(options.runtimeTarget)) {
    sendJson(response, 404, { error: "Context mode settings are only available in Builder runtime." });
    return;
  }

  const profileId = decodePathSegment(requestUrl.pathname.match(PROFILE_CONTEXT_MODE_PATTERN)?.[1]);
  if (!profileId) {
    sendJson(response, 400, { error: "Missing profile id" });
    return;
  }

  if (request.method === "GET") {
    try {
      const payload: ProjectContextModeSnapshot = options.swarmManager.getProjectContextMode(profileId);
      sendJson(response, 200, payload as unknown as Record<string, unknown>);
    } catch (error) {
      sendContextModeError(response, error);
    }
    return;
  }

  if (request.method !== "PUT") {
    response.setHeader("Allow", CONTEXT_MODE_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const mode = requireContextMode(readModeField(body), "mode");
    await options.swarmManager.updateProjectContextMode(profileId, mode);
    const payload: ProjectContextModeSnapshot = options.swarmManager.getProjectContextMode(profileId);
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
  } catch (error) {
    sendContextModeError(response, error);
  }
}

async function handleAgentContextModeRequest(
  options: { swarmManager: SwarmManager; runtimeTarget: RuntimeTarget },
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, CONTEXT_MODE_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, CONTEXT_MODE_METHODS);

  if (!isBuilderRuntimeTarget(options.runtimeTarget)) {
    sendJson(response, 404, { error: "Context mode settings are only available in Builder runtime." });
    return;
  }

  const agentId = decodePathSegment(requestUrl.pathname.match(AGENT_CONTEXT_MODE_PATTERN)?.[1]);
  if (!agentId) {
    sendJson(response, 400, { error: "Missing agent id" });
    return;
  }

  if (request.method === "GET") {
    try {
      const payload: SessionContextModeSnapshot = options.swarmManager.getSessionContextMode(agentId);
      sendJson(response, 200, payload as unknown as Record<string, unknown>);
    } catch (error) {
      sendContextModeError(response, error);
    }
    return;
  }

  if (request.method !== "PUT") {
    response.setHeader("Allow", CONTEXT_MODE_METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const mode = parseSessionContextModeWrite(readModeField(body, { allowNull: true }));
    await options.swarmManager.updateSessionContextMode(agentId, mode);
    const payload: SessionContextModeSnapshot = options.swarmManager.getSessionContextMode(agentId);
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
  } catch (error) {
    sendContextModeError(response, error);
  }
}

function readModeField(value: unknown, options?: { allowNull?: boolean }): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextModeValidationError("Request body must be a JSON object");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "mode")) {
    throw new ContextModeValidationError("mode is required");
  }
  const mode = (value as { mode?: unknown }).mode;
  if (mode === null && options?.allowNull) {
    return null;
  }
  return mode;
}

function sendContextModeError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ContextModeValidationError || isBadRequestBodyError(message)) {
    sendJson(response, 400, { error: message });
    return;
  }
  if (
    message.startsWith("Unknown manager profile:") ||
    message.startsWith("Unknown session") ||
    message.startsWith("Unknown agent:") ||
    message.startsWith("Unknown manager:")
  ) {
    sendJson(response, 404, { error: message });
    return;
  }
  if (
    message.includes("only available") ||
    message.includes("only supported") ||
    message.includes("not supported") ||
    message.includes("only be updated on manager sessions") ||
    message.includes("Cannot update Builder") ||
    message.includes("archived")
  ) {
    sendJson(response, 409, { error: message });
    return;
  }
  sendJson(response, 500, { error: message });
}

function isBadRequestBodyError(message: string): boolean {
  return message === "Request body must be valid JSON" || message.startsWith("Request body too large");
}
