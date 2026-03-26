import type { IncomingMessage, ServerResponse } from "node:http";

const ELECTRON_APP_PROTOCOL = "app:";
const ELECTRON_APP_HOST = "forge";

type TerminalHttpOriginValidationResult =
  | { ok: true; allowedOrigin: string | null }
  | { ok: false; allowedOrigin: null; errorMessage: string };

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

function isDesktopMode(): boolean {
  const raw = process.env.FORGE_DESKTOP?.trim().toLowerCase() ?? "";
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
