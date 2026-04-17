import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import type { SidebarPerfRecentSamples } from "../../../stats/sidebar-perf-types.js";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const SIDEBAR_PERF_ENDPOINT_PATH = "/api/debug/sidebar-perf";
const SIDEBAR_PERF_SCHEMA_VERSION = 1;

interface SidebarPerfDebugResponse {
  schemaVersion: number;
  summary: ReturnType<SwarmManager["readSidebarPerfSummary"]>;
  slowEvents: ReturnType<SwarmManager["readSidebarPerfSlowEvents"]>;
  recentSamples: SidebarPerfRecentSamples;
}

export function createDebugRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === SIDEBAR_PERF_ENDPOINT_PATH,
      handle: async (request, response) => {
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

        const recentSamples = swarmManager.getSidebarPerfRecorder().readRecentSamples?.() ?? {
          histograms: {},
        };
        const payload: SidebarPerfDebugResponse = {
          schemaVersion: SIDEBAR_PERF_SCHEMA_VERSION,
          summary: swarmManager.readSidebarPerfSummary(),
          slowEvents: swarmManager.readSidebarPerfSlowEvents(),
          recentSamples,
        };

        sendJson(response, 200, payload as unknown as Record<string, unknown>);
      },
    },
  ];
}
