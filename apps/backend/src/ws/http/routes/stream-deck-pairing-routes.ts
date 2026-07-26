import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  StreamDeckPairingClaimRequest,
  StreamDeckPairingRequestInput,
} from "@forge/protocol";
import { isBuilderRuntimeTarget, type RuntimeTarget } from "../../../runtime-target.js";
import type { StreamDeckAccessService } from "../../../swarm/stream-deck-access-service.js";
import { readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";
import { applySameOriginGate } from "./cli-access-settings-routes.js";

const PAIRING_PREFIX = "/api/stream-deck/pairing/requests";
const SETTINGS_PREFIX = "/api/settings/stream-deck";
const METHODS = "GET,POST,DELETE,OPTIONS";
const MAX_BODY_BYTES = 8 * 1024;

export function createStreamDeckPairingRoutes(options: {
  streamDeckAccessService: StreamDeckAccessService;
  runtimeTarget: RuntimeTarget;
}): HttpRoute[] {
  if (!isBuilderRuntimeTarget(options.runtimeTarget)) return [];
  return [{
    methods: METHODS,
    matches: (pathname) =>
      pathname === PAIRING_PREFIX ||
      pathname.startsWith(`${PAIRING_PREFIX}/`) ||
      pathname === SETTINGS_PREFIX ||
      pathname.startsWith(`${SETTINGS_PREFIX}/`),
    handle: (request, response, requestUrl) =>
      handleRequest(options.streamDeckAccessService, request, response, requestUrl),
  }];
}

async function handleRequest(
  service: StreamDeckAccessService,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (!applySameOriginGate(request, response, METHODS, "Stream Deck pairing")) return;
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === PAIRING_PREFIX) {
    const body = await readBody(request, response);
    if (!body || !isPairingInput(body)) return sendBadRequest(response, "deviceId, deviceName, and pluginVersion are required");
    const created = await service.createPairingRequest(body);
    sendJson(response, 201, created as unknown as Record<string, unknown>);
    return;
  }

  const claimMatch = requestUrl.pathname.match(/^\/api\/stream-deck\/pairing\/requests\/([^/]+)\/claim$/);
  if (request.method === "POST" && claimMatch) {
    const body = await readBody(request, response);
    if (!body || !isClaimInput(body)) return sendBadRequest(response, "claimSecret is required");
    const result = service.claimPairing(safeDecode(claimMatch[1]), body.claimSecret);
    if (!result) return sendJson(response, 404, { error: { code: "not_found", message: "Pairing request was not found", status: 404 } });
    sendJson(response, 200, result as unknown as Record<string, unknown>);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_PREFIX) {
    const snapshot = await service.getSettingsSnapshot();
    sendJson(response, 200, snapshot as unknown as Record<string, unknown>);
    return;
  }

  const decisionMatch = requestUrl.pathname.match(/^\/api\/settings\/stream-deck\/requests\/([^/]+)\/(approve|deny)$/);
  if (request.method === "POST" && decisionMatch) {
    const requestId = safeDecode(decisionMatch[1]);
    const decision = decisionMatch[2];
    const result = decision === "approve"
      ? await service.approvePairing(requestId)
      : service.denyPairing(requestId) ? true : null;
    if (!result) return sendJson(response, 404, { error: { code: "not_found", message: "Pending pairing request was not found", status: 404 } });
    sendJson(response, 200, { ok: true });
    return;
  }

  const deviceMatch = requestUrl.pathname.match(/^\/api\/settings\/stream-deck\/devices\/([^/]+)$/);
  if (request.method === "DELETE" && deviceMatch) {
    const device = await service.revokeDevice(safeDecode(deviceMatch[1]));
    if (!device) return sendJson(response, 404, { error: { code: "not_found", message: "Paired device was not found", status: 404 } });
    sendJson(response, 200, device as unknown as Record<string, unknown>);
    return;
  }

  sendJson(response, 404, { error: { code: "not_found", message: "Stream Deck pairing endpoint not found", status: 404 } });
}

async function readBody(request: IncomingMessage, response: ServerResponse): Promise<unknown | null> {
  try {
    return await readJsonBody(request, MAX_BODY_BYTES);
  } catch {
    sendBadRequest(response, "Request body must be valid JSON");
    return null;
  }
}

function isPairingInput(value: unknown): value is StreamDeckPairingRequestInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return ["deviceId", "deviceName", "pluginVersion"].every((key) =>
    typeof body[key] === "string" && body[key].trim().length > 0);
}

function isClaimInput(value: unknown): value is StreamDeckPairingClaimRequest {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).claimSecret === "string" &&
    ((value as Record<string, unknown>).claimSecret as string).length > 0);
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function sendBadRequest(response: ServerResponse, message: string): void {
  sendJson(response, 400, { error: { code: "bad_request", message, status: 400 } });
}
