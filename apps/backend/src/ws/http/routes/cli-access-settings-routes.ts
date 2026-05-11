import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CliAccessKeyListResponse,
} from "@forge/protocol";
import type { CliAccessService } from "../../../swarm/cli-access-service.js";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import { sendJson } from "../../http-utils.js";
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

/* ------------------------------------------------------------------ */
/*  Same-origin CORS gate                                              */
/* ------------------------------------------------------------------ */

/**
 * Reject cross-origin requests to CLI access settings routes.
 *
 * These routes return plaintext API keys on generate/rotate — the default
 * builder CORS policy reflects any Origin, which would let a hostile page
 * read the key response cross-origin. Instead we:
 *
 *  - Allow requests with no Origin header (same-origin browser or
 *    non-browser callers like curl — not CSRF-vulnerable).
 *  - Allow requests whose Origin hostname is `127.0.0.1` or `localhost`
 *    (the local UI in dev/prod/Electron).
 *  - Block everything else with 403.
 *
 * For allowed-origin requests we set tight CORS headers so the browser
 * permits the response.
 */
function applySameOriginGate(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string,
): boolean {
  const origin = request.headers.origin;

  // No Origin header → same-origin or non-browser; allow.
  if (typeof origin !== "string" || origin.length === 0) {
    return true;
  }

  if (!isLocalOrigin(origin)) {
    sendJson(response, 403, {
      error: { code: "forbidden_origin", message: "Cross-origin requests are not allowed for CLI key management", status: 403 },
    });
    return false;
  }

  // Local origin — set tight CORS headers.
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", methods);
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Vary", "Origin");
  return true;
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Safe path segment decoding                                         */
/* ------------------------------------------------------------------ */

function safeDecodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Request handler                                                    */
/* ------------------------------------------------------------------ */

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

  // Determine effective methods for CORS/Allow header.
  const methods = isCollectionPath ? LIST_METHODS : ITEM_METHODS;

  // OPTIONS preflight — gate on origin before responding.
  if (request.method === "OPTIONS") {
    if (!applySameOriginGate(request, response, methods)) return;
    response.statusCode = 204;
    response.end();
    return;
  }

  // All non-preflight requests go through the same-origin gate.
  if (!applySameOriginGate(request, response, methods)) return;

  // GET /api/settings/cli-access/keys — list all keys
  if (isCollectionPath && request.method === "GET") {
    const keys = await cliAccessService.listKeys();
    const payload: CliAccessKeyListResponse = { keys };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  // POST /api/settings/cli-access/keys — generate new key
  if (isCollectionPath && request.method === "POST") {
    const body = await readJsonBodySafe(request, response);
    if (body === null) return;
    const name = parseOptionalName(body);
    const result = await cliAccessService.generateKey({ name });
    sendJson(response, 201, result as unknown as Record<string, unknown>);
    return;
  }

  // POST /api/settings/cli-access/keys/:keyId/rotate — rotate key
  if (rotateMatch && request.method === "POST") {
    const keyId = safeDecodeSegment(rotateMatch[1]!);
    if (!keyId) {
      sendJson(response, 400, { error: { code: "bad_request", message: "Malformed key ID in URL", status: 400 } });
      return;
    }
    const body = await readJsonBodySafe(request, response);
    if (body === null) return;
    const name = parseOptionalName(body);
    const result = await cliAccessService.rotateKey({ keyId, name });
    if (!result) {
      sendJson(response, 404, { error: { code: "not_found", message: "Key not found", status: 404 } });
      return;
    }
    sendJson(response, 200, result as unknown as Record<string, unknown>);
    return;
  }

  // DELETE /api/settings/cli-access/keys/:keyId — revoke key
  if (keyIdMatch && !rotateMatch && request.method === "DELETE") {
    const keyId = safeDecodeSegment(keyIdMatch[1]!);
    if (!keyId) {
      sendJson(response, 400, { error: { code: "bad_request", message: "Malformed key ID in URL", status: 400 } });
      return;
    }
    const revoked = await cliAccessService.revokeKey(keyId);
    if (!revoked) {
      sendJson(response, 404, { error: { code: "not_found", message: "Key not found", status: 404 } });
      return;
    }
    sendJson(response, 200, { key: revoked } as unknown as Record<string, unknown>);
    return;
  }

  // Unsupported method or path
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: { code: "method_not_allowed", message: "Method Not Allowed", status: 405 } });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function readJsonBodySafe(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | null> {
  const MAX_BODY_SIZE = 4096;
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of request) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_SIZE) {
        sendJson(response, 400, { error: { code: "bad_request", message: "Request body too large", status: 400 } });
        return null;
      }
      chunks.push(buf);
    }
  } catch {
    sendJson(response, 400, { error: { code: "bad_request", message: "Failed to read request body", status: 400 } });
    return null;
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    sendJson(response, 400, { error: { code: "bad_request", message: "Request body must be valid JSON", status: 400 } });
    return null;
  }
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
