import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import {
  getOpenAICodexWebSocketConstructorDiagnostics,
  installOpenAICodexWebSocketDiagnostics,
  type OpenAICodexWebSocketConstructorDiagnostics
} from "../../../swarm/runtime-utils.js";
import type { SidebarPerfRecentSamples } from "../../../stats/sidebar-perf-types.js";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const SIDEBAR_PERF_ENDPOINT_PATH = "/api/debug/sidebar-perf";
const CODEX_TRANSPORT_ENDPOINT_PATH = "/api/debug/codex-transport";
const SIDEBAR_PERF_SCHEMA_VERSION = 1;
const CODEX_TRANSPORT_SCHEMA_VERSION = 1;
const ALLOWED_CODEX_TRANSPORTS = new Set(["sse", "websocket", "websocket-cached", "auto"]);

interface SidebarPerfDebugResponse {
  schemaVersion: number;
  summary: ReturnType<SwarmManager["readSidebarPerfSummary"]>;
  slowEvents: ReturnType<SwarmManager["readSidebarPerfSlowEvents"]>;
  recentSamples: SidebarPerfRecentSamples;
}

interface CodexTransportDebugResponse {
  schemaVersion: number;
  env: {
    FORGE_OPENAI_CODEX_TRANSPORT: "sse" | "websocket" | "websocket-cached" | "auto" | "invalid" | null;
  };
  websocketConstructorDiagnostics: OpenAICodexWebSocketConstructorDiagnostics;
  agents: ReturnType<SwarmManager["getCodexTransportDebugDiagnostics"]>;
}

export function createDebugRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === CODEX_TRANSPORT_ENDPOINT_PATH,
      handle: async (request, response) => {
        const methods = "GET, OPTIONS";

        if (!isCodexTransportDebugEnabled()) {
          response.statusCode = 404;
          response.end();
          return;
        }

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
        installOpenAICodexWebSocketDiagnostics();

        const payload: CodexTransportDebugResponse = {
          schemaVersion: CODEX_TRANSPORT_SCHEMA_VERSION,
          env: {
            FORGE_OPENAI_CODEX_TRANSPORT: sanitizeConfiguredCodexTransport(),
          },
          websocketConstructorDiagnostics: getOpenAICodexWebSocketConstructorDiagnostics(),
          agents: swarmManager.getCodexTransportDebugDiagnostics(),
        };

        sendJson(response, 200, payload as unknown as Record<string, unknown>);
      },
    },
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

function isCodexTransportDebugEnabled(): boolean {
  const raw = process.env.FORGE_CODEX_TRANSPORT_DEBUG;
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}

function sanitizeConfiguredCodexTransport(): CodexTransportDebugResponse["env"]["FORGE_OPENAI_CODEX_TRANSPORT"] {
  const raw = process.env.FORGE_OPENAI_CODEX_TRANSPORT;
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  return ALLOWED_CODEX_TRANSPORTS.has(normalized)
    ? normalized as CodexTransportDebugResponse["env"]["FORGE_OPENAI_CODEX_TRANSPORT"]
    : "invalid";
}
