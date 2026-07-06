import type { ServerEvent } from "@forge/protocol";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const RESTART_RECOVERY_ENDPOINT_PATH = "/api/restart-recovery";
const RESTART_RECOVERY_RESUME_ENDPOINT_PATH = "/api/restart-recovery/resume";
const RESTART_RECOVERY_DISMISS_ENDPOINT_PATH = "/api/restart-recovery/dismiss";
const METHODS = "GET, POST, OPTIONS";

export function createRestartRecoveryRoutes(options: {
  swarmManager: SwarmManager;
  broadcastEvent: (event: ServerEvent) => void;
}): HttpRoute[] {
  const { swarmManager, broadcastEvent } = options;

  return [
    {
      methods: METHODS,
      matches: (pathname) =>
        pathname === RESTART_RECOVERY_ENDPOINT_PATH ||
        pathname === RESTART_RECOVERY_RESUME_ENDPOINT_PATH ||
        pathname === RESTART_RECOVERY_DISMISS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        applyCorsHeaders(request, response, METHODS);

        if (request.method === "OPTIONS") {
          response.statusCode = 204;
          response.end();
          return;
        }

        if (requestUrl.pathname === RESTART_RECOVERY_ENDPOINT_PATH && request.method === "GET") {
          sendJson(response, 200, { snapshot: swarmManager.getRestartRecoverySnapshot() });
          return;
        }

        if (requestUrl.pathname === RESTART_RECOVERY_RESUME_ENDPOINT_PATH && request.method === "POST") {
          const snapshot = await swarmManager.resumeRestartRecovery();
          broadcastEvent({ type: "restart_recovery_snapshot", snapshot });
          sendJson(response, 200, { ok: true, snapshot });
          return;
        }

        if (requestUrl.pathname === RESTART_RECOVERY_DISMISS_ENDPOINT_PATH && request.method === "POST") {
          const snapshot = swarmManager.dismissRestartRecovery();
          broadcastEvent({ type: "restart_recovery_snapshot", snapshot });
          sendJson(response, 200, { ok: true, snapshot });
          return;
        }

        response.setHeader("Allow", METHODS);
        sendJson(response, 405, { error: "Method Not Allowed" });
      },
    },
  ];
}
