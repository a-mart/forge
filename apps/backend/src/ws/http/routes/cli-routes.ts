import type { IncomingMessage, ServerResponse } from "node:http";
import type { CliCapabilities, CliCapabilitiesResponse, CliHttpErrorResponse } from "@forge/protocol";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import type { CliAccessService } from "../../../swarm/cli-access-service.js";
import {
  authenticateCliHttpRequest,
  CLI_CORS_ALLOWED_HEADERS,
  CLI_HTTP_METHODS,
  CLI_HTTP_ROUTE_PREFIX,
  sendCliAuthFailure,
} from "../../cli-auth.js";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const CLI_CAPABILITIES_ENDPOINT_PATH = "/api/cli/capabilities";
const SERVER_VERSION = "1.0.0";

export function createCliRoutes(options: {
  cliAccessService: CliAccessService;
  runtimeTarget: RuntimeTarget;
}): HttpRoute[] {
  if (!isBuilderRuntimeTarget(options.runtimeTarget)) {
    return [];
  }

  return [
    {
      methods: CLI_HTTP_METHODS,
      matches: (pathname) => pathname === CLI_HTTP_ROUTE_PREFIX || pathname.startsWith(`${CLI_HTTP_ROUTE_PREFIX}/`),
      handle: async (request, response, requestUrl) => {
        await handleCliHttpRequest(options.cliAccessService, options.runtimeTarget, request, response, requestUrl);
      },
    },
  ];
}

function buildCliCapabilities(runtimeTarget: RuntimeTarget): CliCapabilities {
  return {
    protocolVersion: 1,
    minCliVersion: "0.1.0",
    available: isBuilderRuntimeTarget(runtimeTarget),
    runtimeTarget,
    features: {
      bearerAuth: true,
      headlessWs: false,
      cliSourceContext: true,
      cliSessionMetadata: false,
      choiceOwnerLookup: false,
      activeToolSnapshot: false,
      projectAgentRunTarget: false,
      builderRuntimeOnly: true,
    },
  };
}

async function handleCliHttpRequest(
  cliAccessService: CliAccessService,
  runtimeTarget: RuntimeTarget,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  applyCorsHeaders(request, response, CLI_HTTP_METHODS, CLI_CORS_ALLOWED_HEADERS);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  const authResult = await authenticateCliHttpRequest(cliAccessService, request);
  if (!authResult.ok) {
    sendCliAuthFailure(request, response, authResult);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === CLI_CAPABILITIES_ENDPOINT_PATH) {
    const payload: CliCapabilitiesResponse = {
      serverTime: new Date().toISOString(),
      serverVersion: SERVER_VERSION,
      capabilities: buildCliCapabilities(runtimeTarget),
    };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (requestUrl.pathname === CLI_CAPABILITIES_ENDPOINT_PATH) {
    response.setHeader("Allow", "GET, OPTIONS");
    const payload: CliHttpErrorResponse = {
      error: {
        code: "method_not_allowed",
        message: "Method Not Allowed",
        status: 405,
      },
    };
    sendJson(response, 405, payload as unknown as Record<string, unknown>);
    return;
  }

  const payload: CliHttpErrorResponse = {
    error: {
      code: "not_found",
      message: "Not Found",
      status: 404,
    },
  };
  sendJson(response, 404, payload as unknown as Record<string, unknown>);
}
