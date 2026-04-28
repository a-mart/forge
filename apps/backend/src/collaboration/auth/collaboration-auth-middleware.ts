import type { IncomingMessage } from "node:http";
import type { CollaborationRole } from "@forge/protocol";
import type { WebSocket } from "ws";
import type { SwarmConfig } from "../../swarm/types.js";
import { isCollaborationServerRuntimeTarget } from "../../runtime-target.js";
import { getOrCreateCollaborationBetterAuthService } from "./better-auth-service.js";
import { collectCollaborationBrowserOrigins } from "./collaboration-origin-policy.js";
import { getOrCreateCollaborationAuthDb } from "./collaboration-db.js";

const COLLABORATION_INVITE_LOOKUP_PATH = /^\/api\/collaboration\/invites\/[^/]+$/;
const COLLABORATION_INVITE_REDEEM_PATH = /^\/api\/collaboration\/invites\/[^/]+\/redeem$/;
const COLLABORATION_CHANNELS_PATH = "/api/collaboration/channels";
const COLLABORATION_CHANNEL_DETAIL_PATH = /^\/api\/collaboration\/channels\/[^/]+$/;
const COLLABORATION_CHANNEL_PROMPT_PREVIEW_PATH =
  /^\/api\/collaboration\/channels\/[^/]+\/prompt-preview$/;
const COLLABORATION_CATEGORIES_PATH = "/api/collaboration/categories";
const COLLABORATION_ME_PASSWORD_PATH = "/api/collaboration/me/password";

interface CollaborationRequestAuthRow {
  user_id: string;
  email: string;
  name: string;
  role: CollaborationRole;
  disabled: number;
  password_change_required: number;
}

export interface CollaborationAuthContext {
  userId: string;
  email: string;
  name: string;
  role: CollaborationRole;
  disabled: boolean;
  passwordChangeRequired: boolean;
  sessionId?: string;
}

export type CollaborationRequestAuthContext = CollaborationAuthContext;

export type CollaborationHttpAccessClass = "public" | "authenticated" | "admin";

export type CollaborationHttpOriginValidationResult =
  | { ok: true; allowedOrigin: string | null }
  | { ok: false; allowedOrigin: null; errorMessage: string };

interface CollaborationRequestCorsContext {
  allowedOrigin: string | null;
}

const requestAuthContextMap = new WeakMap<IncomingMessage, CollaborationAuthContext | null>();
const socketAuthContextMap = new WeakMap<WebSocket, CollaborationAuthContext>();
const requestCorsContextMap = new WeakMap<IncomingMessage, CollaborationRequestCorsContext>();

export async function authenticateRequest(
  request: IncomingMessage,
  config: SwarmConfig,
): Promise<CollaborationRequestAuthContext | null> {
  if (!isCollaborationServerRuntimeTarget(config.runtimeTarget)) {
    return null;
  }

  const authService = await getOrCreateCollaborationBetterAuthService(config);
  const session = await authService.getSessionFromRequest(request);
  if (!session) {
    return null;
  }

  const authContext = await resolveCollaborationAuthContextForUserId(config, session.user.id);
  if (!authContext) {
    return null;
  }

  return {
    ...authContext,
    sessionId: session.session.id,
  };
}

export async function resolveCollaborationAuthContextForUserId(
  config: SwarmConfig,
  userId: string,
): Promise<CollaborationAuthContext | null> {
  const database = await getOrCreateCollaborationAuthDb(config);
  const row = database
    .prepare<[string], CollaborationRequestAuthRow>(
      `SELECT cu.user_id,
              u.email,
              u.name,
              cu.role,
              cu.disabled,
              cu.password_change_required
       FROM collaboration_user cu
       JOIN "user" u ON u.id = cu.user_id
       WHERE cu.user_id = ?`,
    )
    .get(userId);

  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: row.disabled === 1,
    passwordChangeRequired: row.password_change_required === 1,
  };
}

export function classifyCollaborationHttpRequest(
  pathname: string,
  method: string | undefined,
): CollaborationHttpAccessClass {
  const normalizedMethod = method?.toUpperCase() ?? "GET";

  if (normalizedMethod === "OPTIONS") {
    return "public";
  }

  if (
    pathname === "/api/health" ||
    pathname === "/api/collaboration/status" ||
    pathname === "/api/collaboration/me" ||
    pathname === COLLABORATION_ME_PASSWORD_PATH ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/")
  ) {
    return "public";
  }

  if (normalizedMethod === "GET" && COLLABORATION_INVITE_LOOKUP_PATH.test(pathname)) {
    return "public";
  }

  if (
    normalizedMethod === "GET" &&
    (
      pathname === COLLABORATION_CHANNELS_PATH ||
      COLLABORATION_CHANNEL_DETAIL_PATH.test(pathname) ||
      pathname === COLLABORATION_CATEGORIES_PATH
    )
  ) {
    return "public";
  }

  if (normalizedMethod === "GET" && COLLABORATION_CHANNEL_PROMPT_PREVIEW_PATH.test(pathname)) {
    return "authenticated";
  }

  if (normalizedMethod === "POST" && COLLABORATION_INVITE_REDEEM_PATH.test(pathname)) {
    return "public";
  }

  return "admin";
}

export function validateCollaborationHttpOrigin(
  request: IncomingMessage,
  config?: {
    collaborationBaseUrl?: string;
    collaborationTrustedOrigins?: string[];
  },
): CollaborationHttpOriginValidationResult {
  const rawOrigin = getRawOriginHeader(request);
  if (!rawOrigin) {
    return { ok: true, allowedOrigin: null };
  }

  const originUrl = parseOrigin(rawOrigin);
  if (!originUrl) {
    return { ok: false, allowedOrigin: null, errorMessage: "Invalid Origin" };
  }

  const requestOrigin = resolveRequestOrigin(request);
  if (!requestOrigin) {
    return { ok: false, allowedOrigin: null, errorMessage: "Missing Host" };
  }

  if (originUrl.origin === requestOrigin.origin) {
    return { ok: true, allowedOrigin: rawOrigin };
  }

  const allowedConfiguredOrigins = new Set(collectCollaborationBrowserOrigins(config));
  if (allowedConfiguredOrigins.has(originUrl.origin)) {
    return { ok: true, allowedOrigin: rawOrigin };
  }

  return { ok: false, allowedOrigin: null, errorMessage: "Origin not allowed" };
}

export function setCollaborationRequestAuthContext(
  request: IncomingMessage,
  authContext: CollaborationRequestAuthContext | null,
): void {
  requestAuthContextMap.set(request, authContext);
}

export function getCollaborationRequestAuthContext(
  request: IncomingMessage,
): CollaborationRequestAuthContext | null {
  return requestAuthContextMap.get(request) ?? null;
}

export function setCollaborationSocketAuthContext(
  socket: WebSocket,
  authContext: CollaborationAuthContext,
): void {
  socketAuthContextMap.set(socket, authContext);
}

export function getCollaborationSocketAuthContext(
  socket: WebSocket,
): CollaborationAuthContext | null {
  return socketAuthContextMap.get(socket) ?? null;
}

export function setCollaborationRequestCorsContext(
  request: IncomingMessage,
  context: CollaborationRequestCorsContext,
): void {
  requestCorsContextMap.set(request, context);
}

export function getCollaborationRequestCorsContext(
  request: IncomingMessage,
): CollaborationRequestCorsContext | null {
  return requestCorsContextMap.get(request) ?? null;
}

export function evaluateCollaborationAuthenticatedAccess(
  authContext: CollaborationRequestAuthContext | null,
):
  | { ok: true; authContext: CollaborationRequestAuthContext }
  | { ok: false; statusCode: 401 | 403; error: string } {
  if (!authContext) {
    return { ok: false, statusCode: 401, error: "Authentication required" };
  }

  if (authContext.disabled) {
    return { ok: false, statusCode: 403, error: "User account is disabled" };
  }

  if (authContext.passwordChangeRequired) {
    return { ok: false, statusCode: 403, error: "Password change required" };
  }

  return { ok: true, authContext };
}

export function evaluateCollaborationAdminAccess(
  authContext: CollaborationRequestAuthContext | null,
):
  | { ok: true; authContext: CollaborationRequestAuthContext }
  | { ok: false; statusCode: 401 | 403; error: string } {
  const authenticatedAccess = evaluateCollaborationAuthenticatedAccess(authContext);
  if (!authenticatedAccess.ok) {
    return authenticatedAccess;
  }

  if (authenticatedAccess.authContext.role !== "admin") {
    return { ok: false, statusCode: 403, error: "Admin access required" };
  }

  return authenticatedAccess;
}

export function evaluateCollaborationPasswordChangeAccess(
  authContext: CollaborationRequestAuthContext | null,
  pathname: string,
  method: string | undefined,
):
  | { ok: true }
  | { ok: false; statusCode: 403; error: string } {
  if (!authContext?.passwordChangeRequired) {
    return { ok: true };
  }

  return isPasswordChangeExemptPath(pathname, method)
    ? { ok: true }
    : { ok: false, statusCode: 403, error: "Password change required" };
}

function isPasswordChangeExemptPath(pathname: string, method: string | undefined): boolean {
  const normalizedMethod = method?.toUpperCase() ?? "GET";
  if (normalizedMethod === "OPTIONS") {
    return true;
  }

  return (
    pathname === "/api/collaboration/status" ||
    pathname === "/api/collaboration/me" ||
    pathname === COLLABORATION_ME_PASSWORD_PATH ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/health"
  );
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

  try {
    return new URL(`${resolveRequestProtocol(request)}://${hostHeader}`);
  } catch {
    return null;
  }
}

function resolveRequestProtocol(request: IncomingMessage): "http" | "https" {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const normalizedForwardedProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const directProto = normalizedForwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (directProto === "https") {
    return "https";
  }

  if (directProto === "http") {
    return "http";
  }

  const forwardedHeader = request.headers.forwarded;
  const forwardedValue = Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader;
  const forwardedProtoMatch = forwardedValue?.match(/proto=(https|http)/i);
  if (forwardedProtoMatch?.[1]?.toLowerCase() === "https") {
    return "https";
  }

  const originHeader = request.headers.origin;
  const originValue = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (originValue?.startsWith("https://")) {
    return "https";
  }

  return "http";
}
