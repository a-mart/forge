import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

export const MANAGER_SELECTION_CATALOG_ENDPOINT_PATH = "/api/settings/manager-selection-catalog";
const METHODS = "GET, OPTIONS";
const ALLOWED_HEADERS = "content-type, if-none-match";

export function createManagerSelectionCatalogRoutes(options: {
  swarmManager: SwarmManager;
}): HttpRoute[] {
  return [{
    methods: METHODS,
    matches: (pathname) => pathname === MANAGER_SELECTION_CATALOG_ENDPOINT_PATH,
    handle: async (request, response) => {
      await handleManagerSelectionCatalogRequest(options.swarmManager, request, response);
    },
  }];
}

async function handleManagerSelectionCatalogRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  applyCorsHeaders(request, response, METHODS, ALLOWED_HEADERS);
  response.setHeader("Access-Control-Expose-Headers", "ETag");

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", METHODS);
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const catalog = await swarmManager.getManagerSelectionCatalog();
    const etag = `"${catalog.revision}"`;
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, no-cache");

    if (ifNoneMatchIncludes(request.headers["if-none-match"], etag)) {
      response.statusCode = 304;
      response.end();
      return;
    }

    sendJson(response, 200, { ...catalog });
  } catch {
    // Do not reflect filesystem, provider, credential, or projection details
    // from this member-readable discovery route.
    sendJson(response, 500, { error: "Unable to load manager selection catalog" });
  }
}

function ifNoneMatchIncludes(
  header: string | string[] | undefined,
  currentEtag: string,
): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === currentEtag || normalized === `W/${currentEtag}`;
  });
}
