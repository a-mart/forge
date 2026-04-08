import type {
  StatsRange,
  TokenAnalyticsAttributionFilter,
  TokenAnalyticsQuery,
  TokenAnalyticsRangePreset,
  TokenAnalyticsSortDirection,
  TokenAnalyticsWorkerSort,
} from "@forge/protocol";
import type { StatsService } from "../../../stats/stats-service.js";
import { TokenAnalyticsError, type TokenAnalyticsService } from "../../../stats/token-analytics-service.js";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const STATS_ENDPOINT_PATH = "/api/stats";
const STATS_REFRESH_ENDPOINT_PATH = "/api/stats/refresh";
const STATS_TOKENS_ENDPOINT_PATH = "/api/stats/tokens";
const STATS_TOKENS_REFRESH_ENDPOINT_PATH = "/api/stats/tokens/refresh";
const STATS_TOKENS_WORKERS_ENDPOINT_PATH = "/api/stats/tokens/workers";
const STATS_TOKENS_WORKER_EVENTS_ENDPOINT_PATH = "/api/stats/tokens/worker-events";
const PROVIDER_USAGE_ENDPOINT_PATH = "/api/provider-usage";

export function createStatsRoutes(options: {
  statsService: StatsService;
  tokenAnalyticsService: TokenAnalyticsService;
}): HttpRoute[] {
  const { statsService, tokenAnalyticsService } = options;

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
        const timezone = parseTimezone(requestUrl.searchParams.get("tz"));

        try {
          const stats = await statsService.getSnapshot(range, { timezone });
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
        const timezone = parseTimezone(requestUrl.searchParams.get("tz"));

        try {
          const stats = await statsService.getSnapshot(range, { forceRefresh: true, timezone });
          sendJson(response, 200, stats as unknown as Record<string, unknown>);
          void statsService.refreshAllRangesInBackground().catch(() => false);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Internal server error";
          sendJson(response, 500, { error: message });
        }
      }
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === STATS_TOKENS_ENDPOINT_PATH,
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

        try {
          const snapshot = await tokenAnalyticsService.getSnapshot(parseTokenAnalyticsQuery(requestUrl));
          sendJson(response, 200, snapshot as unknown as Record<string, unknown>);
        } catch (error) {
          handleTokenAnalyticsError(response, error);
        }
      }
    },
    {
      methods: "POST, OPTIONS",
      matches: (pathname) => pathname === STATS_TOKENS_REFRESH_ENDPOINT_PATH,
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

        try {
          const snapshot = await tokenAnalyticsService.getSnapshot(parseTokenAnalyticsQuery(requestUrl), {
            forceRefresh: true,
          });
          sendJson(response, 200, snapshot as unknown as Record<string, unknown>);
        } catch (error) {
          handleTokenAnalyticsError(response, error);
        }
      }
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === STATS_TOKENS_WORKERS_ENDPOINT_PATH,
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

        try {
          const page = await tokenAnalyticsService.getWorkerPage(parseTokenAnalyticsWorkerPageQuery(requestUrl));
          sendJson(response, 200, page as unknown as Record<string, unknown>);
        } catch (error) {
          handleTokenAnalyticsError(response, error);
        }
      }
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === STATS_TOKENS_WORKER_EVENTS_ENDPOINT_PATH,
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

        try {
          const events = await tokenAnalyticsService.getWorkerEvents(parseTokenAnalyticsWorkerEventsQuery(requestUrl));
          sendJson(response, 200, events as unknown as Record<string, unknown>);
        } catch (error) {
          handleTokenAnalyticsError(response, error);
        }
      }
    },
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === PROVIDER_USAGE_ENDPOINT_PATH,
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

        try {
          const providerUsage = await statsService.getProviderUsage();
          sendJson(response, 200, providerUsage as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Internal server error";
          sendJson(response, 500, { error: message });
        }
      }
    },
  ];
}

function handleTokenAnalyticsError(response: NodeJS.WritableStream & { statusCode?: number; setHeader(name: string, value: string): void }, error: unknown): void {
  if (error instanceof TokenAnalyticsError) {
    sendJson(response as never, error.statusCode, { error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Internal server error";
  sendJson(response as never, 500, { error: message });
}

function parseRange(value: string | null): StatsRange {
  if (value === "7d" || value === "30d" || value === "all") {
    return value;
  }

  return "7d";
}

function parseTimezone(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const timezone = value.trim();
  return timezone.length > 0 ? timezone : null;
}

function parseTokenAnalyticsQuery(requestUrl: URL): TokenAnalyticsQuery {
  const query: TokenAnalyticsQuery = {
    rangePreset: parseTokenRangePreset(requestUrl.searchParams.get("rangePreset")),
    startDate: trimOptional(requestUrl.searchParams.get("startDate")),
    endDate: trimOptional(requestUrl.searchParams.get("endDate")),
    timezone: parseTimezone(requestUrl.searchParams.get("tz")),
    profileId: trimOptional(requestUrl.searchParams.get("profileId")),
    provider: trimOptional(requestUrl.searchParams.get("provider")),
    modelId: trimOptional(requestUrl.searchParams.get("modelId")),
    attribution: parseAttribution(requestUrl.searchParams.get("attribution")),
    specialistId: trimOptional(requestUrl.searchParams.get("specialistId")),
  };

  validateTokenAnalyticsQuery(query);
  return query;
}

function parseTokenAnalyticsWorkerPageQuery(requestUrl: URL) {
  return {
    ...parseTokenAnalyticsQuery(requestUrl),
    limit: parsePositiveInt(requestUrl.searchParams.get("limit")),
    cursor: trimOptional(requestUrl.searchParams.get("cursor")),
    sort: parseWorkerSort(requestUrl.searchParams.get("sort")),
    direction: parseDirection(requestUrl.searchParams.get("direction")),
  };
}

function parseTokenAnalyticsWorkerEventsQuery(requestUrl: URL) {
  return {
    profileId: trimOptional(requestUrl.searchParams.get("profileId")) ?? "",
    sessionId: trimOptional(requestUrl.searchParams.get("sessionId")) ?? "",
    workerId: trimOptional(requestUrl.searchParams.get("workerId")) ?? "",
  };
}

function validateTokenAnalyticsQuery(query: TokenAnalyticsQuery): void {
  if (
    query.specialistId &&
    (query.attribution === "ad_hoc" || query.attribution === "unknown")
  ) {
    throw new TokenAnalyticsError(
      400,
      `specialistId cannot be combined with attribution=${query.attribution}; use attribution=all or attribution=specialist`
    );
  }

  if (query.rangePreset === "custom") {
    if (!query.startDate || !query.endDate) {
      throw new TokenAnalyticsError(400, "custom rangePreset requires startDate and endDate");
    }
    if (query.endDate < query.startDate) {
      throw new TokenAnalyticsError(400, "endDate must be on or after startDate");
    }
  }
}

function parseTokenRangePreset(value: string | null): TokenAnalyticsRangePreset {
  if (value === "7d" || value === "30d" || value === "all" || value === "custom") {
    return value;
  }
  return "7d";
}

function parseAttribution(value: string | null): TokenAnalyticsAttributionFilter {
  if (value === "all" || value === "specialist" || value === "ad_hoc" || value === "unknown") {
    return value;
  }
  return "all";
}

function parseWorkerSort(value: string | null): TokenAnalyticsWorkerSort | undefined {
  if (value === "startedAt" || value === "durationMs" || value === "totalTokens" || value === "cost") {
    return value;
  }
  return undefined;
}

function parseDirection(value: string | null): TokenAnalyticsSortDirection | undefined {
  if (value === "asc" || value === "desc") {
    return value;
  }
  return undefined;
}

function parsePositiveInt(value: string | null): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function trimOptional(value: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
