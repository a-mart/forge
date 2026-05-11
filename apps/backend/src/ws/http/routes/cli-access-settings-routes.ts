import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CliAccessKeyListResponse,
} from "@forge/protocol";
import type { CliAccessService } from "../../../swarm/cli-access-service.js";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const ENDPOINT_PREFIX = "/api/settings/cli-access";
const LIST_METHODS = "GET, POST, OPTIONS";
const ITEM_METHODS = "DELETE, POST, OPTIONS";

export function createCliAccessSettingsRoutes(options: {
  cliAccessService: CliAccessService;
  runtimeTarget: RuntimeTarget;
}): HttpRoute[] {
  if (!isBuilderRuntimeTarget(options.runtimeTarget)) {
    return [];
  }

  return [
    {
      methods: `${LIST_METHODS}, ${ITEM_METHODS}`,
      matches: (pathname) =>
        pathname === `${ENDPOINT_PREFIX}/keys` ||
        pathname.startsWith(`${ENDPOINT_PREFIX}/keys/`),
      handle: async (request, response, requestUrl) => {
        await handleKeysRequest(options.cliAccessService, request, response, requestUrl);
      },
    },
  ];
}

async function handleKeysRequest(
  cliAccessService: CliAccessService,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  const pathname = requestUrl.pathname;
  const isCollectionPath = pathname === `${ENDPOINT_PREFIX}/keys`;
  const keyIdMatch = pathname.match(/^\/api\/settings\/cli-access\/keys\/([^/]+)$/);
  const rotateMatch = pathname.match(/^\/api\/settings\/cli-access\/keys\/([^/]+)\/rotate$/);

  if (request.method === "OPTIONS") {
    const methods = isCollectionPath ? LIST_METHODS : ITEM_METHODS;
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  // GET /api/settings/cli-access/keys — list all keys
  if (isCollectionPath && request.method === "GET") {
    applyCorsHeaders(request, response, LIST_METHODS);
    const keys = await cliAccessService.listKeys();
    const payload: CliAccessKeyListResponse = { keys };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  // POST /api/settings/cli-access/keys — generate new key
  if (isCollectionPath && request.method === "POST") {
    applyCorsHeaders(request, response, LIST_METHODS);
    const body = await readJsonBody(request);
    const name = parseOptionalName(body);
    const result = await cliAccessService.generateKey({ name });
    sendJson(response, 201, result as unknown as Record<string, unknown>);
    return;
  }

  // POST /api/settings/cli-access/keys/:keyId/rotate — rotate key
  if (rotateMatch && request.method === "POST") {
    applyCorsHeaders(request, response, ITEM_METHODS);
    const keyId = decodeURIComponent(rotateMatch[1]!);
    const body = await readJsonBody(request);
    const name = parseOptionalName(body);
    const result = await cliAccessService.rotateKey({ keyId, name });
    if (!result) {
      sendJson(response, 404, { error: { code: "not_found", message: "Key not found" } });
      return;
    }
    sendJson(response, 200, result as unknown as Record<string, unknown>);
    return;
  }

  // DELETE /api/settings/cli-access/keys/:keyId — revoke key
  if (keyIdMatch && !rotateMatch && request.method === "DELETE") {
    applyCorsHeaders(request, response, ITEM_METHODS);
    const keyId = decodeURIComponent(keyIdMatch[1]!);
    const revoked = await cliAccessService.revokeKey(keyId);
    if (!revoked) {
      sendJson(response, 404, { error: { code: "not_found", message: "Key not found" } });
      return;
    }
    sendJson(response, 200, { key: revoked } as unknown as Record<string, unknown>);
    return;
  }

  // Unsupported method or path
  const methods = isCollectionPath ? LIST_METHODS : ITEM_METHODS;
  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: { code: "method_not_allowed", message: "Method Not Allowed" } });
}

function parseOptionalName(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const maybe = body as Record<string, unknown>;
  if (typeof maybe.name === "string" && maybe.name.trim().length > 0) {
    return maybe.name.trim();
  }
  return undefined;
}
