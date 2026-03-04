import { getCommonKnowledgePath, getCortexNotesPath } from "../../swarm/data-paths.js";
import { scanCortexReviewStatus } from "../../swarm/scripts/cortex-scan.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const CORTEX_SCAN_ENDPOINT_PATH = "/api/cortex/scan";
const CORTEX_SCAN_METHODS = "GET, OPTIONS";

export function createCortexRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: CORTEX_SCAN_METHODS,
      matches: (pathname) => pathname === CORTEX_SCAN_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, CORTEX_SCAN_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, CORTEX_SCAN_METHODS);
          response.setHeader("Allow", CORTEX_SCAN_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, CORTEX_SCAN_METHODS);

        try {
          const config = swarmManager.getConfig();
          const dataDir = config.paths.dataDir;
          const scan = await scanCortexReviewStatus(dataDir);

          sendJson(response, 200, {
            scan,
            files: {
              commonKnowledge: getCommonKnowledgePath(dataDir),
              cortexNotes: getCortexNotesPath(dataDir)
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to scan Cortex review status.";
          sendJson(response, 500, { error: message });
        }
      }
    }
  ];
}
