import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { isBuilderRuntimeTarget } from "../../../runtime-target.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

export function createHistoryIndexRoutes(options: {
  swarmManager: Pick<SwarmManager, "getConfig" | "getHistoryIndexStatus" | "setHistoryIndexPaused">;
}): HttpRoute[] {
  const manager = options.swarmManager;
  if (!isBuilderRuntimeTarget(manager.getConfig().runtimeTarget)) return [];
  const methods = "GET, PATCH, OPTIONS";
  return [{
    methods,
    matches: (pathname) => pathname === "/api/history/index",
    handle: async (request, response) => {
      applyCorsHeaders(request, response, methods);
      if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
      if (request.method !== "GET" && request.method !== "PATCH") {
        response.setHeader("Allow", methods); sendJson(response, 405, { error: "Method Not Allowed" }); return;
      }
      let paused: boolean | undefined;
      if (request.method === "PATCH") {
        let body: unknown;
        try { body = await readJsonBody(request); }
        catch { sendJson(response, 400, { error: "Expected a JSON object containing paused." }); return; }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { paused?: unknown }).paused !== "boolean") {
          sendJson(response, 400, { error: "paused must be a boolean; no other settings are accepted." }); return;
        }
        paused = (body as { paused: boolean }).paused;
      }
      try {
        const result = paused === undefined ? await manager.getHistoryIndexStatus() : await manager.setHistoryIndexPaused(paused);
        response.setHeader("Cache-Control", "no-store");
        sendJson(response, 200, result as unknown as Record<string, unknown>);
      } catch {
        sendJson(response, 500, { error: "History index settings could not be loaded or saved." });
      }
    },
  }];
}
