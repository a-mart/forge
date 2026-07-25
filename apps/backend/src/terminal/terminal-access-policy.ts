import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export const SECURE_CONTROL_HEADER = "x-forge-secure-control";

export function validateSecureBuilderControlCapability(
  request: IncomingMessage,
  expectedToken = "",
): boolean {
  const supplied = request.headers[SECURE_CONTROL_HEADER];
  if (
    typeof supplied !== "string"
    || expectedToken.length < 32
    || supplied.length !== expectedToken.length
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expectedToken));
}

const ELECTRON_APP_PROTOCOL = "app:";
const ELECTRON_APP_HOST = "forge";

type TerminalHttpOriginValidationResult =
  | { ok: true; allowedOrigin: string | null }
  | { ok: false; allowedOrigin: null; errorMessage: string };

export function validateSecureBuilderControlOrigin(
  request: IncomingMessage,
  options: {
    backendHost: string;
    backendPort: number;
    uiPort?: number;
  },
): TerminalHttpOriginValidationResult {
  const rawOrigin = getRawOriginHeader(request);
  if (!rawOrigin) {
    return isLoopbackAddress(request.socket.remoteAddress)
      ? { ok: true, allowedOrigin: null }
      : { ok: false, allowedOrigin: null, errorMessage: "Missing Origin" };
  }

  const originUrl = parseOrigin(rawOrigin);
  if (!originUrl) {
    return { ok: false, allowedOrigin: null, errorMessage: "Invalid Origin" };
  }

  if (
    isDesktopMode()
    && isLoopbackAddress(request.socket.remoteAddress)
    && originUrl.protocol === ELECTRON_APP_PROTOCOL
    && normalizeHost(originUrl.hostname) === ELECTRON_APP_HOST
  ) {
    return { ok: true, allowedOrigin: rawOrigin };
  }

  const allowedOrigins = secureBuilderControlOrigins(options);
  if (
    (originUrl.protocol === "http:" || originUrl.protocol === "https:")
    && allowedOrigins.has(originUrl.origin)
  ) {
    return { ok: true, allowedOrigin: rawOrigin };
  }

  return { ok: false, allowedOrigin: null, errorMessage: "Origin not allowed" };
}

export function validateTerminalHttpOrigin(
  request: IncomingMessage,
  requestUrl: URL,
): TerminalHttpOriginValidationResult {
  const rawOrigin = getRawOriginHeader(request);
  if (!rawOrigin) {
    return { ok: true, allowedOrigin: null };
  }

  const originUrl = parseOrigin(rawOrigin);
  if (!originUrl) {
    return { ok: false, allowedOrigin: null, errorMessage: "Invalid Origin" };
  }

  if (isAllowedBrowserOrigin(originUrl, requestUrl)) {
    return { ok: true, allowedOrigin: rawOrigin };
  }

  if (isAllowedElectronOrigin(originUrl, requestUrl)) {
    return { ok: true, allowedOrigin: rawOrigin };
  }

  return { ok: false, allowedOrigin: null, errorMessage: "Origin not allowed" };
}

export function validateTerminalWsOrigin(
  request: IncomingMessage,
): { ok: true } | { ok: false; errorMessage: string } {
  const rawOrigin = getRawOriginHeader(request);
  if (!rawOrigin) {
    if (isDesktopMode() || isLoopbackAddress(request.socket.remoteAddress)) {
      return { ok: true };
    }
    return { ok: false, errorMessage: "Missing Origin" };
  }

  const originUrl = parseOrigin(rawOrigin);
  if (!originUrl) {
    return { ok: false, errorMessage: "Invalid Origin" };
  }

  const requestUrl = resolveRequestOrigin(request);
  if (!requestUrl) {
    return { ok: false, errorMessage: "Missing Host" };
  }

  if (isAllowedBrowserOrigin(originUrl, requestUrl)) {
    return { ok: true };
  }

  if (isAllowedElectronOrigin(originUrl, requestUrl)) {
    return { ok: true };
  }

  return { ok: false, errorMessage: "Origin not allowed" };
}

export function applyTerminalCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string,
  allowedOrigin: string | null,
): void {
  if (!allowedOrigin) {
    if (request.headers.origin) {
      response.setHeader("Vary", "Origin");
    }
    return;
  }

  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", methods);
  response.setHeader("Access-Control-Allow-Headers", "content-type");
}

function getRawOriginHeader(request: IncomingMessage): string {
  return typeof request.headers.origin === "string" ? request.headers.origin.trim() : "";
}

function parseOrigin(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function resolveRequestOrigin(request: IncomingMessage): URL | null {
  const hostHeader = typeof request.headers.host === "string" ? request.headers.host.trim() : "";
  if (!hostHeader) {
    return null;
  }

  const expectedProtocol = Boolean((request.socket as { encrypted?: boolean }).encrypted) ? "https:" : "http:";
  try {
    return new URL(`${expectedProtocol}//${hostHeader}`);
  } catch {
    return null;
  }
}

function isAllowedBrowserOrigin(originUrl: URL, requestUrl: URL): boolean {
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    return false;
  }

  if (originUrl.origin === requestUrl.origin) {
    return true;
  }

  return areHostsEquivalent(originUrl.hostname, requestUrl.hostname);
}

function isAllowedElectronOrigin(originUrl: URL, requestUrl: URL): boolean {
  if (!isDesktopMode()) {
    return false;
  }

  if (originUrl.protocol !== ELECTRON_APP_PROTOCOL || normalizeHost(originUrl.hostname) !== ELECTRON_APP_HOST) {
    return false;
  }

  return isLoopbackHost(requestUrl.hostname);
}

function areHostsEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizeHost(left);
  const normalizedRight = normalizeHost(right);

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  return isLoopbackHost(normalizedLeft) && isLoopbackHost(normalizedRight);
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function isLoopbackHost(value: string): boolean {
  const normalized = normalizeHost(value);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = normalizeHost(value.replace(/^::ffff:/, ""));
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

function secureBuilderControlOrigins(options: {
  backendHost: string;
  backendPort: number;
  uiPort?: number;
}): Set<string> {
  const origins = new Set<string>();
  const backendHost = normalizeHost(options.backendHost);
  const backendPort = validatePort(options.backendPort);
  const backendHosts = isLoopbackHost(backendHost)
    || backendHost === "0.0.0.0"
    || backendHost === "::"
    ? ["127.0.0.1", "localhost", "[::1]"]
    : [formatUrlHost(backendHost)];
  for (const host of backendHosts) {
    origins.add(`http://${host}:${backendPort}`);
  }

  const uiPort = validatePort(
    options.uiPort ?? parseConfiguredUiPort(process.env.FORGE_UI_PORT),
  );
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    origins.add(`http://${host}:${uiPort}`);
  }
  return origins;
}

function parseConfiguredUiPort(value: string | undefined): number {
  if (!value?.trim()) return 47188;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : 47188;
}

function validatePort(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535
    ? value
    : 47188;
}

function formatUrlHost(value: string): string {
  return value.includes(":") ? `[${value}]` : value;
}

function isDesktopMode(): boolean {
  const raw = process.env.FORGE_DESKTOP?.trim().toLowerCase() ?? "";
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
