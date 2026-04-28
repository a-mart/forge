import type { HttpRoute } from "../../shared/http-route.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";
import type { CollaborationSettingsService } from "../../../../collaboration/settings-service.js";

const COLLABORATION_STATUS_ENDPOINT_PATH = "/api/collaboration/status";
const COLLABORATION_STATUS_METHODS = "GET, OPTIONS";

export function createCollaborationStatusRoutes(options: {
  settingsService: CollaborationSettingsService;
}): HttpRoute[] {
  return [
    {
      methods: COLLABORATION_STATUS_METHODS,
      matches: (pathname) => pathname === COLLABORATION_STATUS_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, COLLABORATION_STATUS_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, COLLABORATION_STATUS_METHODS);

        if (request.method !== "GET") {
          response.setHeader("Allow", COLLABORATION_STATUS_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        sendJson(response, 200, options.settingsService.getCollaborationStatus() as unknown as Record<string, unknown>);
      },
    },
  ];
}
