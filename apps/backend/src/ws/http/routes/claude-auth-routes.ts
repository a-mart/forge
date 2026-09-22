import type { ClaudeAuthService } from "../../../swarm/runtime/claude/claude-auth-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

/** Composed only by the local Builder; never a Collab credential endpoint. */
export function createClaudeAuthRoutes(service: Pick<ClaudeAuthService, "status" | "start" | "cancel" | "submitCode">): HttpRoute[] {
  const path = "/api/settings/claude-native";
  const methods = "GET, POST, DELETE, OPTIONS";
  return [{ methods, matches: pathname => pathname === path, handle: async (request, response) => {
    applyCorsHeaders(request, response, methods);
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    if (request.method === "GET") { sendJson(response, 200, { ...await service.status() }); return; }
    if (request.method !== "POST" && request.method !== "DELETE") {
      sendJson(response, 405, { error: "Method not allowed" }); return;
    }
    try {
      const body = await readJsonBody(request, 8192) as { action?: unknown; flowId?: unknown; code?: unknown } | null;
      if (request.method === "DELETE" && typeof body?.flowId === "string") {
        await service.cancel(body.flowId);
      } else if (body?.action === "start" && request.method === "POST") {
        sendJson(response, 200, { ...await service.start() }); return;
      } else if (body?.action === "code" && typeof body.flowId === "string" && typeof body.code === "string" && request.method === "POST") {
        service.submitCode(body.flowId, body.code.trim());
      } else { sendJson(response, 400, { error: "Invalid Claude sign-in request" }); return; }
      sendJson(response, 200, { ...await service.status() });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Claude sign-in request failed" });
    }
  } }];
}
