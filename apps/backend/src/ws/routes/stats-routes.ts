import type { StatsRange } from "@forge/protocol";
import type { StatsService } from "../../stats/stats-service.js";
import { applyCorsHeaders, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const STATS_ENDPOINT_PATH = "/api/stats";
const STATS_REFRESH_ENDPOINT_PATH = "/api/stats/refresh";

export function createStatsRoutes(options: { statsService: StatsService }): HttpRoute[] {
  const { statsService } = options;

  return [
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === STATS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
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
        const range = parseRange(requestUrl.searchParams.get("range"));

        try {
          const stats = await statsService.getSnapshot(range);
          sendJson(response, 200, stats as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Internal server error";
          sendJson(response, 500, { error: message });
        }
      }
    },
    {
      methods: "POST, OPTIONS",
      matches: (pathname) => pathname === STATS_REFRESH_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        const methods = "POST, OPTIONS";

        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, methods);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, methods);
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, methods);
        const range = parseRange(requestUrl.searchParams.get("range"));

        try {
          const stats = await statsService.getSnapshot(range, { forceRefresh: true });
          sendJson(response, 200, stats as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Internal server error";
          sendJson(response, 500, { error: message });
        }
      }
    }
  ];
}

function parseRange(value: string | null): StatsRange {
  if (value === "7d" || value === "30d" || value === "all") {
    return value;
  }

  return "7d";
}
