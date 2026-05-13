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
 *  - Allow only loopback socket clients (same-machine settings UI or local
 *    CLI tools). Forwarded/proxy headers cause fail-closed rejection because
 *    a same-host reverse proxy also presents as a loopback socket client.
 *  - Allow requests whose Origin matches the server's own origin derived
 *    from the request Host header (covers localhost, LAN IPs, Tailscale
 *    hostnames, and any custom bind address).
 *  - Block everything else with 403 and no Access-Control-Allow-Origin.
 */
function applySameOriginGate(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string,
): boolean {
  const origin = request.headers.origin;

  // Local-admin only: the CLI key settings surface can expose plaintext keys,
  // so every request must originate from the same machine over a direct socket.
  // A same-host reverse proxy also reaches us from loopback, so fail closed as
  // soon as proxy/forwarding headers are present instead of trying to interpret
  // or trust them for authorization.
  if (hasProxyForwardingHeaders(request)) {
    sendJson(response, 403, {
      error: { code: "forbidden_origin", message: "CLI key management requires a direct local connection", status: 403 },
    });
    return false;
  }

  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    sendJson(response, 403, {
      error: { code: "forbidden_origin", message: "CLI key management is allowed only from local clients", status: 403 },
    });
    return false;
  }

  // No Origin header from loopback → local settings UI / local CLI callers.
  if (typeof origin !== "string" || origin.length === 0) {
    return true;
  }

  if (!isSameOrigin(origin, request)) {
    sendJson(response, 403, {
      error: { code: "forbidden_origin", message: "Cross-origin requests are not allowed for CLI key management", status: 403 },
    });
    return false;
  }

  // Same-origin — set tight CORS headers so the browser permits the response.
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", methods);
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Vary", "Origin");
  return true;
}

/**
 * Compare the request Origin against the server's own origin derived from
 * the Host header. This works for localhost, LAN IPs, Tailscale hostnames,
 * and any custom bind address — the browser's same-origin policy guarantees
 * that a legitimate same-origin request has Origin === scheme+host+port.
 */
function stripAddressPortAndQuotes(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.startsWith("[")) {
    const endBracket = normalized.indexOf("]");
    if (endBracket > 0) {
      return normalized.slice(1, endBracket);
    }
  }
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon > -1 && normalized.indexOf(":") === lastColon) {
    const maybePort = normalized.slice(lastColon + 1);
    if (/^\d+$/.test(maybePort)) {
      return normalized.slice(0, lastColon);
    }
  }
  return normalized;
}

function hasProxyForwardingHeaders(request: IncomingMessage): boolean {
  return (
    request.headers["x-forwarded-for"] !== undefined ||
    request.headers["x-forwarded-proto"] !== undefined ||
    request.headers["x-forwarded-host"] !== undefined ||
    request.headers.forwarded !== undefined
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = stripAddressPortAndQuotes(address).toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const ipv4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = ipv4Mapped?.[1] ?? normalized;
  const octets = ipv4.split(".");
  if (octets.length !== 4) return false;
  const first = Number(octets[0]);
  return Number.isInteger(first) && first === 127;
}

function isSameOrigin(origin: string, request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host) {
    // No Host header — cannot verify; reject to be safe.
    return false;
  }

  const scheme = resolveRequestProtocol(request);
  const expectedOrigin = `${scheme}://${host}`;

  try {
    // Normalize both through URL to handle default port stripping, trailing
    // slashes, and case differences.
    const originUrl = new URL(origin);
    const expectedUrl = new URL(expectedOrigin);
    return originUrl.origin === expectedUrl.origin;
  } catch {
    return false;
  }
}

/**
 * Resolve the direct request protocol. Proxy headers are intentionally ignored
 * for CLI key management; their presence is rejected before same-origin checks.
 */
function resolveRequestProtocol(request: IncomingMessage): "http" | "https" {
  if ((request.socket as { encrypted?: boolean }).encrypted) return "https";
  return "http";
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
