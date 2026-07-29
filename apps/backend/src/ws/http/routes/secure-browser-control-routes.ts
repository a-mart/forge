import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  SecureBrowserControlStatus,
  SecureBrowserDeviceDescriptor,
  SecureBrowserPairingClaimRequest,
  SecureBrowserPairingRequestInput,
  SecureBrowserSealedPrivateEntry,
} from "@forge/protocol";
import type { SecureBrowserAccessService } from "../../../swarm/secure-browser-access-service.js";
import { readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";
import {
  applySecureHeaders,
  handleSecureRouteError,
} from "./secure-secret-routes.js";

export const SECURE_BROWSER_COOKIE_NAME = "forge_secure_browser";
const ROOT = "/api/secure-browser-control";
const SETTINGS_ROOT = "/api/settings/secure-browsers";
const METHODS = "GET,POST,DELETE,OPTIONS";
const MAX_BODY_BYTES = 768 * 1024;
const COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export interface SecureBrowserVaultService {
  isSecurePrivateEntryAvailable(): Promise<boolean> | boolean;
  createRemotePrivateEntryChallenge(deviceId: string): Promise<{
    challengeId: string;
    keyId: string;
    publicKey: string;
    expiresAt: string;
  }>;
  encryptRemotePrivateEntry(
    deviceId: string,
    sealedEntry: SecureBrowserSealedPrivateEntry,
  ): Promise<string>;
  encryptTrustedBrowserPrivateEntry(encodedValue: string): Promise<string>;
}

const requestDevice = new WeakMap<
  IncomingMessage,
  SecureBrowserDeviceDescriptor
>();

export function setSecureBrowserRequestDevice(
  request: IncomingMessage,
  device: SecureBrowserDeviceDescriptor,
): void {
  requestDevice.set(request, device);
}

export function getSecureBrowserRequestDevice(
  request: IncomingMessage,
): SecureBrowserDeviceDescriptor | null {
  return requestDevice.get(request) ?? null;
}

export function isSecureBrowserControlPath(pathname: string): boolean {
  return (
    pathname === ROOT ||
    pathname.startsWith(`${ROOT}/`) ||
    pathname === SETTINGS_ROOT ||
    pathname.startsWith(`${SETTINGS_ROOT}/`)
  );
}

export function isPublicSecureBrowserPairingPath(
  method: string | undefined,
  pathname: string,
): boolean {
  if (method === "POST" && pathname === `${ROOT}/pairing/requests`) return true;
  return (
    method === "POST" &&
    /^\/api\/secure-browser-control\/pairing\/requests\/[^/]+\/claim$/u.test(
      pathname,
    )
  );
}

export function isSecureBrowserStatusPath(
  method: string | undefined,
  pathname: string,
): boolean {
  return method === "GET" && pathname === `${ROOT}/status`;
}

export function isDesktopOnlySecureBrowserPath(pathname: string): boolean {
  return pathname === SETTINGS_ROOT || pathname.startsWith(`${SETTINGS_ROOT}/`);
}

export function readSecureBrowserCookie(
  cookieHeader: string | string[] | undefined,
): string | undefined {
  if (typeof cookieHeader !== "string") return undefined;
  for (const field of cookieHeader.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0) continue;
    if (field.slice(0, separator).trim() !== SECURE_BROWSER_COOKIE_NAME)
      continue;
    const value = field.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32,256}$/u.test(value) ? value : undefined;
  }
  return undefined;
}

export function createSecureBrowserControlRoutes(options: {
  accessService: SecureBrowserAccessService;
  vaultService: SecureBrowserVaultService;
  secureControlAvailable: boolean;
}): HttpRoute[] {
  return [
    {
      methods: METHODS,
      matches: isSecureBrowserControlPath,
      handle: async (request, response, requestUrl) => {
        applySecureHeaders(request, response, METHODS);
        try {
          if (request.method === "OPTIONS") {
            response.statusCode = 204;
            response.end();
            return;
          }

          if (
            request.method === "GET" &&
            requestUrl.pathname === `${ROOT}/status`
          ) {
            const authenticatedDevice =
              getSecureBrowserRequestDevice(request) ??
              (await authenticateRequest(options.accessService, request)) ??
              null;
            let privateEntryAvailable = false;
            if (options.secureControlAvailable) {
              try {
                privateEntryAvailable =
                  await options.vaultService.isSecurePrivateEntryAvailable();
              } catch {
                privateEntryAvailable = false;
              }
            }
            const status: SecureBrowserControlStatus = {
              available: options.secureControlAvailable,
              authorized: authenticatedDevice !== null,
              privateEntryAvailable:
                authenticatedDevice !== null && privateEntryAvailable,
              secureContextRequired: false,
              privateEntryTransport: isTrustedHttpBrowserTransport(request)
                ? "trusted_http"
                : "browser_encrypted",
              ...(authenticatedDevice ? { device: authenticatedDevice } : {}),
            };
            sendJson(
              response,
              200,
              status as unknown as Record<string, unknown>,
            );
            return;
          }

          if (
            request.method === "POST" &&
            requestUrl.pathname === `${ROOT}/pairing/requests`
          ) {
            if (
              !options.secureControlAvailable ||
              !isSupportedBrowserRequest(request)
            ) {
              sendUnavailable(response);
              return;
            }
            const body = await readBody(request, response);
            if (!body || !isPairingInput(body)) {
              sendBadRequest(response, "deviceId and deviceName are required");
              return;
            }
            sendJson(
              response,
              201,
              (await options.accessService.createPairingRequest(
                body,
              )) as unknown as Record<string, unknown>,
            );
            return;
          }

          const claimMatch = requestUrl.pathname.match(
            /^\/api\/secure-browser-control\/pairing\/requests\/([^/]+)\/claim$/u,
          );
          if (request.method === "POST" && claimMatch) {
            if (
              !options.secureControlAvailable ||
              !isSupportedBrowserRequest(request)
            ) {
              sendUnavailable(response);
              return;
            }
            const body = await readBody(request, response);
            if (!body || !isClaimInput(body)) {
              sendBadRequest(response, "claimSecret is required");
              return;
            }
            const result = await options.accessService.claimPairing(
              safeDecode(claimMatch[1]),
              body.claimSecret,
            );
            if (!result) {
              sendJson(response, 404, {
                error: {
                  code: "not_found",
                  message: "Pending secure browser pairing was not found",
                  status: 404,
                },
              });
              return;
            }
            if (result.response.status === "approved" && result.accessToken) {
              response.setHeader(
                "Set-Cookie",
                buildSecureBrowserCookie(result.accessToken, request),
              );
            }
            sendJson(
              response,
              200,
              result.response as unknown as Record<string, unknown>,
            );
            return;
          }

          const authenticatedDevice =
            getSecureBrowserRequestDevice(request) ??
            (await authenticateRequest(options.accessService, request)) ??
            null;
          if (
            request.method === "POST" &&
            requestUrl.pathname === `${ROOT}/private-entry/challenge`
          ) {
            if (!authenticatedDevice) return sendUnauthorized(response);
            sendJson(
              response,
              200,
              await options.vaultService.createRemotePrivateEntryChallenge(
                authenticatedDevice.id,
              ),
            );
            return;
          }

          if (
            request.method === "POST" &&
            requestUrl.pathname === `${ROOT}/private-entry/encrypt`
          ) {
            if (!authenticatedDevice) return sendUnauthorized(response);
            const body = await readBody(request, response);
            if (!body || !isSealedPrivateEntry(body)) {
              sendBadRequest(response, "The private entry envelope is invalid");
              return;
            }
            const encryptedMaterial =
              await options.vaultService.encryptRemotePrivateEntry(
                authenticatedDevice.id,
                body,
              );
            sendJson(response, 200, { encryptedMaterial });
            return;
          }

          if (
            request.method === "POST" &&
            requestUrl.pathname === `${ROOT}/private-entry/trusted-http`
          ) {
            if (!authenticatedDevice || !isTrustedHttpBrowserRequest(request)) {
              return sendUnauthorized(response);
            }
            const body = await readBody(request, response);
            if (!body || !isTrustedPrivateEntry(body)) {
              sendBadRequest(response, "The trusted private entry is invalid");
              return;
            }
            const encryptedMaterial =
              await options.vaultService.encryptTrustedBrowserPrivateEntry(
                body.encodedValue,
              );
            sendJson(response, 200, { encryptedMaterial });
            return;
          }

          if (
            request.method === "GET" &&
            requestUrl.pathname === SETTINGS_ROOT
          ) {
            sendJson(
              response,
              200,
              (await options.accessService.getSettingsSnapshot()) as unknown as Record<
                string,
                unknown
              >,
            );
            return;
          }

          const decisionMatch = requestUrl.pathname.match(
            /^\/api\/settings\/secure-browsers\/requests\/([^/]+)\/(approve|deny)$/u,
          );
          if (request.method === "POST" && decisionMatch) {
            const requestId = safeDecode(decisionMatch[1]);
            const result =
              decisionMatch[2] === "approve"
                ? await options.accessService.approvePairing(requestId)
                : options.accessService.denyPairing(requestId)
                  ? true
                  : null;
            if (!result) {
              sendJson(response, 404, {
                error: {
                  code: "not_found",
                  message: "Pending secure browser pairing was not found",
                  status: 404,
                },
              });
              return;
            }
            sendJson(response, 200, { ok: true });
            return;
          }

          const deviceMatch = requestUrl.pathname.match(
            /^\/api\/settings\/secure-browsers\/devices\/([^/]+)$/u,
          );
          if (request.method === "DELETE" && deviceMatch) {
            const revoked = await options.accessService.revokeDevice(
              safeDecode(deviceMatch[1]),
            );
            if (!revoked) {
              sendJson(response, 404, {
                error: {
                  code: "not_found",
                  message: "Paired secure browser was not found",
                  status: 404,
                },
              });
              return;
            }
            sendJson(
              response,
              200,
              revoked as unknown as Record<string, unknown>,
            );
            return;
          }

          sendJson(response, 404, {
            error: {
              code: "not_found",
              message: "Secure browser endpoint not found",
              status: 404,
            },
          });
        } catch (error) {
          if (!response.headersSent) {
            handleSecureRouteError(response, error);
          } else if (!response.writableEnded) {
            response.end();
          }
        }
      },
    },
  ];
}

async function authenticateRequest(
  service: SecureBrowserAccessService,
  request: IncomingMessage,
): Promise<SecureBrowserDeviceDescriptor | null> {
  const authentication = await service.authenticateToken(
    readSecureBrowserCookie(request.headers.cookie),
  );
  return authentication.ok ? authentication.device : null;
}

async function readBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | null> {
  try {
    return await readJsonBody(request, MAX_BODY_BYTES);
  } catch {
    sendBadRequest(response, "Request body must be valid JSON");
    return null;
  }
}

function isPairingInput(
  value: unknown,
): value is SecureBrowserPairingRequestInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.deviceId === "string" &&
    input.deviceId.trim().length > 0 &&
    input.deviceId.length <= 160 &&
    typeof input.deviceName === "string" &&
    input.deviceName.trim().length > 0 &&
    input.deviceName.length <= 120 &&
    Object.keys(input).every(
      (key) => key === "deviceId" || key === "deviceName",
    )
  );
}

function isClaimInput(
  value: unknown,
): value is SecureBrowserPairingClaimRequest {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).claimSecret === "string" &&
      ((value as Record<string, unknown>).claimSecret as string).length > 0 &&
      Object.keys(value).length === 1,
  );
}

function isSealedPrivateEntry(
  value: unknown,
): value is SecureBrowserSealedPrivateEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = [
    "challengeId",
    "keyId",
    "ephemeralPublicKey",
    "iv",
    "ciphertext",
  ];
  return (
    keys.every(
      (key) =>
        typeof input[key] === "string" && (input[key] as string).length > 0,
    ) && Object.keys(input).every((key) => keys.includes(key))
  );
}

function isTrustedPrivateEntry(
  value: unknown,
): value is { encodedValue: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.encodedValue === "string"
    && input.encodedValue.length > 0
    && input.encodedValue.length <= 349_528
    && Object.keys(input).length === 1
  );
}

function isSupportedBrowserRequest(request: IncomingMessage): boolean {
  return isSecureBrowserRequest(request) || isTrustedHttpBrowserRequest(request);
}

function isTrustedHttpBrowserRequest(request: IncomingMessage): boolean {
  const origin = requestOrigin(request);
  try {
    return new URL(origin).protocol === "http:";
  } catch {
    return false;
  }
}

function isTrustedHttpBrowserTransport(request: IncomingMessage): boolean {
  const origin = requestOrigin(request);
  if (origin) {
    try {
      const url = new URL(origin);
      return url.protocol === "http:" && !isLoopbackHost(url.hostname);
    } catch {
      return false;
    }
  }
  const forwardedProtocol =
    typeof request.headers["x-forwarded-proto"] === "string"
      ? request.headers["x-forwarded-proto"].split(",", 1)[0]?.trim()
      : "";
  if (forwardedProtocol) {
    return forwardedProtocol === "http" && !isLoopbackRequestHost(request);
  }
  return (
    (request.socket as typeof request.socket & { encrypted?: boolean })
      .encrypted !== true && !isLoopbackRequestHost(request)
  );
}

function isSecureBrowserRequest(request: IncomingMessage): boolean {
  const origin = requestOrigin(request);
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function buildSecureBrowserCookie(
  accessToken: string,
  request: IncomingMessage,
): string {
  return [
    `${SECURE_BROWSER_COOKIE_NAME}=${accessToken}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    ...(isSecureBrowserRequest(request) && !isLoopbackRequestOrigin(request)
      ? ["Secure"]
      : []),
  ].join("; ");
}

function isLoopbackRequestOrigin(request: IncomingMessage): boolean {
  const origin = requestOrigin(request);
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function requestOrigin(request: IncomingMessage): string {
  const origin =
    typeof request.headers.origin === "string"
      ? request.headers.origin.trim()
      : "";
  return origin;
}

function isLoopbackRequestHost(request: IncomingMessage): boolean {
  const host =
    typeof request.headers.host === "string" ? request.headers.host.trim() : "";
  try {
    return isLoopbackHost(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function sendBadRequest(response: ServerResponse, message: string): void {
  sendJson(response, 400, {
    error: { code: "bad_request", message, status: 400 },
  });
}

function sendUnauthorized(response: ServerResponse): void {
  sendJson(response, 403, {
    code: "SECURE_PRIVATE_API_UNAVAILABLE",
    error: "SECURE_PRIVATE_API_UNAVAILABLE",
  });
}

function sendUnavailable(response: ServerResponse): void {
  sendJson(response, 503, {
    code: "SECURE_SOURCE_UNAVAILABLE",
    error: "SECURE_SOURCE_UNAVAILABLE",
  });
}
