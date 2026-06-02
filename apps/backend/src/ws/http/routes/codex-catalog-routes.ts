import type { IncomingMessage, ServerResponse } from "node:http";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import type { HttpRoute } from "../shared/http-route.js";

const CODEX_CATALOG_PATTERN = /^\/api\/codex-app-server\/catalog$/;

export function createCodexCatalogRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  return [
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => CODEX_CATALOG_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleCodexCatalogRequest(options.swarmManager, request, response, requestUrl);
      },
    },
  ];
}

async function handleCodexCatalogRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  const methods = "GET, OPTIONS";

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

  const managerAgentId = requestUrl.searchParams.get("managerAgentId")?.trim() ?? "";
  if (!managerAgentId) {
    sendJson(response, 400, { error: "managerAgentId is required" });
    return;
  }

  try {
    const snapshot = await swarmManager.listCodexAppTools(managerAgentId);
    sendJson(response, 200, snapshot as unknown as Record<string, unknown>);
  } catch (error) {
    sendJson(response, 503, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
