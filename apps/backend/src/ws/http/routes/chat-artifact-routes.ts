import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { ChatArtifactError, chatArtifactStatus, readPresentedChatArtifact } from "../../../swarm/session/presented-chat-artifact.js";
import { applyCorsHeaders, parseJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const PATH = "/api/chat-artifacts/read";
const METHODS = "POST, OPTIONS";
export function createChatArtifactRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  return [{ methods: METHODS, matches: pathname => pathname === PATH, handle: async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { applyCorsHeaders(request, response, METHODS); response.statusCode = 204; response.end(); return; }
    if (request.method !== "POST") { applyCorsHeaders(request, response, METHODS); response.setHeader("Allow", METHODS); sendJson(response, 405, { error: "Method Not Allowed" }); return; }
    applyCorsHeaders(request, response, METHODS);
    try { const body = await parseJsonBody(request, 64 * 1024); const result = await readPresentedChatArtifact(options.swarmManager, body as any); sendJson(response, 200, result); }
    catch (error) { if (error instanceof ChatArtifactError) { sendJson(response, chatArtifactStatus(error.code), { error: error.code, code: error.code }); return; } const code = error instanceof Error && error.message.includes("exceeds") ? 413 : 500; sendJson(response, code, { error: "Unable to read chat artifact.", code: code === 413 ? "request_too_large" : "transcript_read_failed" }); }
  }}];
}
