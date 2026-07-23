import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { getCollaborationRequestAuthContext } from "../../../collaboration/auth/collaboration-auth-middleware.js";
import {
  ChatArtifactError,
  PresentedChatArtifactTicketStore,
  chatArtifactStatus,
  readPresentedChatArtifact,
} from "../../../swarm/session/presented-chat-artifact.js";
import { applyCorsHeaders, parseJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const READ_PATH = "/api/chat-artifacts/read";
const TICKET_PATH_PREFIX = "/api/chat-artifacts/tickets/";
const METHODS = "GET, POST, OPTIONS";

export function createChatArtifactRoutes(options: {
  swarmManager: SwarmManager;
  ticketStore?: PresentedChatArtifactTicketStore;
  /** Test-only seam for exercising the Windows handle-validation branch on other hosts. */
  artifactSecurityPlatform?: NodeJS.Platform;
}): HttpRoute[] {
  const ticketStore = options.ticketStore ?? new PresentedChatArtifactTicketStore();
  return [{
    methods: METHODS,
    matches: pathname => pathname === READ_PATH || pathname.startsWith(TICKET_PATH_PREFIX),
    handle: async (request, response, requestUrl) => {
      response.setHeader("Cache-Control", "no-store");
      applyCorsHeaders(request, response, METHODS);
      if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
      const authBinding = getCollaborationRequestAuthContext(request)?.userId;

      if (requestUrl.pathname.startsWith(TICKET_PATH_PREFIX)) {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET, OPTIONS");
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }
        const token = requestUrl.pathname.slice(TICKET_PATH_PREFIX.length);
        try {
          const result = await ticketStore.redeem(token, authBinding);
          response.statusCode = 200;
          response.setHeader("Content-Type", result.contentType);
          response.setHeader("Content-Length", String(result.content.byteLength));
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.end(result.content);
        } catch (error) {
          if (error instanceof ChatArtifactError) {
            sendJson(response, chatArtifactStatus(error.code), { error: error.code, code: error.code });
            return;
          }
          sendJson(response, 500, { error: "transcript_read_failed", code: "transcript_read_failed" });
        }
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        sendJson(response, 405, { error: "Method Not Allowed" });
        return;
      }
      try {
        const body = await parseJsonBody(request, 64 * 1024);
        const result = await readPresentedChatArtifact(options.swarmManager, body as any, {
          securityPlatform: options.artifactSecurityPlatform,
          ticketStore,
          ...(authBinding ? { ticketAuthBinding: authBinding } : {}),
        });
        sendJson(response, 200, { ...result });
      } catch (error) {
        if (error instanceof ChatArtifactError) {
          sendJson(response, chatArtifactStatus(error.code), { error: error.code, code: error.code });
          return;
        }
        const message = error instanceof Error ? error.message : "";
        if (message.includes("exceeds")) { sendJson(response, 413, { error: "request_too_large", code: "request_too_large" }); return; }
        if (message.includes("valid JSON")) { sendJson(response, 400, { error: "invalid_request", code: "invalid_request" }); return; }
        sendJson(response, 500, { error: "Unable to read chat artifact.", code: "transcript_read_failed" });
      }
    },
  }];
}
