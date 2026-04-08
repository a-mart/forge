import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyCorsHeaders,
  readJsonBody,
  sendJson
} from "../../http-utils.js";
import { readSessionMeta } from "../../../swarm/session-manifest.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import type { HttpRoute } from "../shared/http-route.js";

const AGENT_COMPACT_ENDPOINT_PATTERN = /^\/api\/agents\/([^/]+)\/compact$/;
const AGENT_SMART_COMPACT_ENDPOINT_PATTERN = /^\/api\/agents\/([^/]+)\/smart-compact$/;
const AGENT_SYSTEM_PROMPT_PATTERN = /^\/api\/agents\/([^/]+)\/system-prompt$/;

export function createAgentHttpRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  return [
    {
      methods: "POST, OPTIONS",
      matches: (pathname) => AGENT_COMPACT_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleCompactAgentHttpRequest(options.swarmManager, request, response, requestUrl);
      }
    },
    {
      methods: "POST, OPTIONS",
      matches: (pathname) => AGENT_SMART_COMPACT_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleSmartCompactAgentHttpRequest(options.swarmManager, request, response, requestUrl);
      }
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => AGENT_SYSTEM_PROMPT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleAgentSystemPromptHttpRequest(options.swarmManager, request, response, requestUrl);
      }
    }
  ];
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

async function handleSmartCompactAgentHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "POST, OPTIONS";
  const matched = requestUrl.pathname.match(AGENT_SMART_COMPACT_ENDPOINT_PATTERN);
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
    await swarmManager.smartCompactAgentContext(agentId, {
      customInstructions,
      sourceContext: { channel: "web" },
      trigger: "api"
    });

    sendJson(response, 200, {
      ok: true,
      agentId
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

    sendJson(response, statusCode, { error: message });
  }
}

async function handleAgentSystemPromptHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "GET, OPTIONS";
  const matched = requestUrl.pathname.match(AGENT_SYSTEM_PROMPT_PATTERN);
  const rawAgentId = matched?.[1] ?? "";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "GET") {
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

  const descriptor = swarmManager.getAgent(agentId);
  if (!descriptor) {
    sendJson(response, 404, { error: `Unknown agent: ${agentId}` });
    return;
  }

  const dataDir = swarmManager.getConfig().paths.dataDir;

  if (descriptor.role === "manager") {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const meta = await readSessionMeta(dataDir, profileId, descriptor.agentId);

    sendJson(response, 200, {
      agentId: descriptor.agentId,
      role: descriptor.role,
      systemPrompt: meta?.resolvedSystemPrompt ?? null,
      model: buildAgentModelIdentifier(descriptor),
      archetypeId: descriptor.archetypeId ?? null
    });
    return;
  }

  const profileId = descriptor.profileId ?? descriptor.managerId;
  const meta = await readSessionMeta(dataDir, profileId, descriptor.managerId);
  const workerMeta = meta?.workers.find((worker) => worker.id === descriptor.agentId);

  sendJson(response, 200, {
    agentId: descriptor.agentId,
    role: descriptor.role,
    systemPrompt: workerMeta?.systemPrompt ?? null,
    model: workerMeta?.model ?? buildAgentModelIdentifier(descriptor),
    archetypeId: descriptor.archetypeId ?? null
  });
}

function buildAgentModelIdentifier(agent: {
  model: {
    provider?: string | null;
    modelId?: string | null;
  };
}): string | null {
  const provider = agent.model.provider?.trim();
  const modelId = agent.model.modelId?.trim();
  if (!provider || !modelId) {
    return null;
  }

  return `${provider}/${modelId}`;
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
