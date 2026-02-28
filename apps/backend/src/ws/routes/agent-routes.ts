import type { ClientCommand, ServerEvent } from "@middleman/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import {
  applyCorsHeaders,
  readJsonBody,
  sendJson
} from "../http-utils.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { HttpRoute } from "./http-route.js";

const AGENT_COMPACT_ENDPOINT_PATTERN = /^\/api\/agents\/([^/]+)\/compact$/;

export function createAgentHttpRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  return [
    {
      methods: "POST, OPTIONS",
      matches: (pathname) => AGENT_COMPACT_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleCompactAgentHttpRequest(options.swarmManager, request, response, requestUrl);
      }
    }
  ];
}

export interface AgentCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  subscribedAgentId: string;
  swarmManager: SwarmManager;
  resolveManagerContextAgentId: (subscribedAgentId: string) => string | undefined;
  send: (socket: WebSocket, event: ServerEvent) => void;
}

export async function handleAgentCommand(context: AgentCommandRouteContext): Promise<boolean> {
  const { command, socket, subscribedAgentId, swarmManager, resolveManagerContextAgentId, send } = context;

  if (command.type === "kill_agent") {
    const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
    if (!managerContextId) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${subscribedAgentId} does not exist.`
      });
      return true;
    }

    try {
      await swarmManager.killAgent(managerContextId, command.agentId);
    } catch (error) {
      send(socket, {
        type: "error",
        code: "KILL_AGENT_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }

    return true;
  }

  if (command.type === "stop_all_agents") {
    const managerContextId = resolveManagerContextAgentId(subscribedAgentId);
    if (!managerContextId) {
      send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${subscribedAgentId} does not exist.`,
        requestId: command.requestId
      });
      return true;
    }

    try {
      const stopped = await swarmManager.stopAllAgents(managerContextId, command.managerId);
      send(socket, {
        type: "stop_all_agents_result",
        managerId: stopped.managerId,
        stoppedWorkerIds: stopped.stoppedWorkerIds,
        managerStopped: stopped.managerStopped,
        // Backward compatibility for older clients still expecting terminated-oriented fields.
        terminatedWorkerIds: stopped.terminatedWorkerIds,
        managerTerminated: stopped.managerTerminated,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "STOP_ALL_AGENTS_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "list_directories") {
    try {
      const listed = await swarmManager.listDirectories(command.path);
      send(socket, {
        type: "directories_listed",
        path: listed.resolvedPath,
        directories: listed.directories.map((entry) => entry.path),
        requestId: command.requestId,
        requestedPath: listed.requestedPath,
        resolvedPath: listed.resolvedPath,
        roots: listed.roots,
        entries: listed.directories
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "LIST_DIRECTORIES_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "validate_directory") {
    try {
      const validation = await swarmManager.validateDirectory(command.path);
      send(socket, {
        type: "directory_validated",
        path: validation.requestedPath,
        valid: validation.valid,
        message: validation.message,
        requestId: command.requestId,
        requestedPath: validation.requestedPath,
        roots: validation.roots,
        resolvedPath: validation.resolvedPath
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "VALIDATE_DIRECTORY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "pick_directory") {
    try {
      const pickedPath = await swarmManager.pickDirectory(command.defaultPath);
      send(socket, {
        type: "directory_picked",
        path: pickedPath,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "PICK_DIRECTORY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  return false;
}

async function handleCompactAgentHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "POST, OPTIONS";
  const matched = requestUrl.pathname.match(AGENT_COMPACT_ENDPOINT_PATTERN);
  const rawAgentId = matched?.[1] ?? "";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "POST") {
    applyCorsHeaders(request, response, methods);
    response.setHeader("Allow", methods);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  applyCorsHeaders(request, response, methods);

  const agentId = decodeURIComponent(rawAgentId).trim();
  if (!agentId) {
    sendJson(response, 400, { error: "Missing agent id" });
    return;
  }

  const payload = await readJsonBody(request);
  const customInstructions = parseCompactCustomInstructionsBody(payload);

  try {
    const result = await swarmManager.compactAgentContext(agentId, {
      customInstructions,
      sourceContext: { channel: "web" },
      trigger: "api"
    });

    sendJson(response, 200, {
      ok: true,
      agentId,
      result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode =
      message.includes("Unknown target agent")
        ? 404
        : message.includes("not running") ||
            message.includes("does not support") ||
            message.includes("only supported")
          ? 409
          : message.includes("Invalid") || message.includes("Missing")
            ? 400
            : 500;

    sendJson(response, statusCode, { error: message });
  }
}

function parseCompactCustomInstructionsBody(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const customInstructions = (value as { customInstructions?: unknown }).customInstructions;
  if (customInstructions === undefined) {
    return undefined;
  }

  if (typeof customInstructions !== "string") {
    throw new Error("customInstructions must be a string");
  }

  const trimmed = customInstructions.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
