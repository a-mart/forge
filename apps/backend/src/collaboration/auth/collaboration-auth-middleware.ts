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
const COLLABORATION_CHANNEL_SPECIALISTS_PATH =
  /^\/api\/collaboration\/channels\/[^/]+\/specialists$/;
const COLLABORATION_CHANNEL_SPECIALISTS_ROSTER_PROMPT_PATH =
  /^\/api\/collaboration\/channels\/[^/]+\/specialists\/roster-prompt$/;
const COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_PATH =
  /^\/api\/collaboration\/channels\/[^/]+\/specialists\/selection$/;
const COLLABORATION_CHANNEL_SKILLS_SELECTION_PATH =
  /^\/api\/collaboration\/channels\/[^/]+\/skills\/selection$/;
const COLLABORATION_CHANNEL_SPECIALIST_DETAIL_PATH =
  /^\/api\/collaboration\/channels\/[^/]+\/specialists\/[^/]+$/;
const COLLABORATION_CATEGORIES_PATH = "/api/collaboration/categories";
const COLLABORATION_ME_PASSWORD_PATH = "/api/collaboration/me/password";
const SETTINGS_SPECIALISTS_PATH = "/api/settings/specialists";

// --- Member-class routes (Wave R remote projects, SPEC §4.3) ---------------
//
// Member access is allowlist-only: every entry below is an individually
// reviewed, project-scoped surface. The default classification for anything
// not listed anywhere in this file stays `admin` — permanently.
//
// Member PROJECT routes are additionally gated by the `remoteBuild.enabled`
// instance setting (the kill switch): when it is off they classify as
// `admin`. Member COLLAB routes (the audited former `authenticated` class)
// are collaboration-surface features and are not kill-switched.

/** Former `authenticated`-class route, audited to `member` (collab surface). */
const MEMBER_COLLAB_CHANNEL_PROMPT_PREVIEW_PATH = COLLABORATION_CHANNEL_PROMPT_PREVIEW_PATH;

/** File browser reads (R1). */
const MEMBER_FILE_BROWSER_READ_PATHS = new Set([
  "/api/files/list",
  "/api/files/count",
  "/api/files/search",
  "/api/files/content",
  "/api/files/raw",
]);
/** Transcript file reads; POST /api/read-file is a read with body params. */
const MEMBER_READ_FILE_PATH = "/api/read-file";
/** Privileged transcript-authorized artifact reads remain Builder project surface. */
const MEMBER_CHAT_ARTIFACT_READ_PATH = "/api/chat-artifacts/read";
const MEMBER_CHAT_ARTIFACT_TICKET_PATH = /^\/api\/chat-artifacts\/tickets\/[A-Za-z0-9_-]+$/;
/** Conversation attachment downloads (R1). */
const MEMBER_ATTACHMENTS_PATH_PREFIX = "/api/attachments/";
/** Git read surfaces (R1). */
const MEMBER_GIT_READ_PATHS = new Set([
  "/api/git/status",
  "/api/git/diff",
  "/api/git/log",
  "/api/git/file-log",
  "/api/git/file-section-provenance",
  "/api/git/commit",
  "/api/git/commit-diff",
  "/api/git/worktrees",
  "/api/git/branches",
  "/api/git/mutation-preflight",
  "/api/git/provider/status",
  "/api/git/pull-requests",
]);
const MEMBER_GIT_PULL_REQUEST_DETAIL_PATH = /^\/api\/git\/pull-requests\/\d+$/;
/** Session-audit reads (R1). */
const MEMBER_SESSION_AUDIT_PATH = /^\/api\/sessions\/[^/]+\/audit(?:\/entry)?$/;
/** Project-scoped schedule reads (R1). */
const MEMBER_MANAGER_SCHEDULES_PATH = /^\/api\/managers\/[^/]+\/schedules$/;
/** Session system-prompt read for the audit drawer (R1). */
const MEMBER_AGENT_SYSTEM_PROMPT_PATH = /^\/api\/agents\/[^/]+\/system-prompt$/;
/** Per-session feedback reads (R1). */
const MEMBER_SESSION_FEEDBACK_PATH = /^\/api\/v1\/profiles\/[^/]+\/sessions\/[^/]+\/feedback(?:\/state)?$/;
/** Project resource reads (R1). */
const MEMBER_PROJECT_RESOURCES_PATH = "/api/settings/project-resources";
/**
 * Available-model listing (R2): feeds the create-project and session model
 * pickers, which are member surfaces. Model CONFIG writes stay admin-only.
 */
const MEMBER_MODELS_LIST_PATH = "/api/settings/models";
/** Exact manager-model and Work Mode projection for the same member pickers. */
const MEMBER_MANAGER_SELECTION_CATALOG_PATH = "/api/settings/manager-selection-catalog";
/** Model availability matrix read (R2) — feeds the same pickers; writes stay admin. */
const MEMBER_MODEL_OVERRIDES_PATH = "/api/settings/model-overrides";
/** Delegation roster read — feeds the per-session coordination picker; writes stay admin. */
const MEMBER_DELEGATION_ROSTERS_PATH = "/api/settings/delegation-rosters";
/** Terminal list/shell reads (R1); mutations and tickets are R2 surfaces. */
const MEMBER_TERMINALS_COLLECTION_PATH = "/api/terminals";
const MEMBER_TERMINALS_AVAILABLE_SHELLS_PATH = "/api/terminals/available-shells";

// --- R2 write surfaces (all kill-switched; terminals also honor
// `terminalsEnabled`) -------------------------------------------------------

/** File writes (R2). */
const MEMBER_WRITE_FILE_PATH = "/api/write-file";
const MEMBER_FILE_CONTENT_PATH = "/api/files/content";
/**
 * File browser create/rename — project-scoped file mutations (paths resolved
 * within the session cwd by file-browser-service), the same category as
 * write-file/content writes above and member-accessible under the same R2 kill
 * switch.
 */
const MEMBER_FILE_CREATE_PATH = "/api/files/create";
const MEMBER_FILE_RENAME_PATH = "/api/files/rename";
/** Git mutations (R2) — shell-equivalent access per the D6 trust model. */
const MEMBER_GIT_WRITE_PATHS = new Set([
  "/api/git/fetch",
  "/api/git/switch-branch",
  "/api/git/create-branch",
  "/api/git/pull-ff-only",
  "/api/git/push",
]);
const MEMBER_GIT_PULL_REQUEST_MERGE_PATH = /^\/api\/git\/pull-requests\/\d+\/merge$/;
/** Terminal lifecycle + HMAC ticket issuance (R2, honoring terminalsEnabled). */
const MEMBER_TERMINAL_ITEM_PATH = /^\/api\/terminals\/[^/]+$/;
const MEMBER_TERMINAL_RESIZE_PATH = /^\/api\/terminals\/[^/]+\/resize$/;
const MEMBER_TERMINAL_TICKET_PATH = /^\/api\/terminals\/[^/]+\/ticket$/;
/** Voice transcription for the composer (R2; uses the server's provider key). */
const MEMBER_TRANSCRIBE_PATH = "/api/transcribe";
/** Session context operations (R2). */
const MEMBER_AGENT_SESSION_OP_PATH = /^\/api\/agents\/[^/]+\/(?:compact|smart-compact|clear)$/;
/** Project resource writes (R2). */
const MEMBER_PROJECT_RESOURCE_WRITE_PATHS = new Set([
  "/api/settings/project-resources/override",
  "/api/settings/project-resources/trust",
  "/api/settings/project-resources/seed",
  "/api/settings/project-resources/project-agents/activate",
]);

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

/**
 * HTTP access classes. `member` grants any active signed-in user (member or
 * admin); `admin` requires the admin role. There is deliberately no broader
 * "authenticated" bucket — the old class of that name was audited into
 * `member` during Wave R (SPEC §4.3).
 */
export type CollaborationHttpAccessClass = "public" | "member" | "admin";

/**
 * Instance policy consulted for member PROJECT routes. When absent (or
 * `remoteBuildEnabled` is false) those routes classify as `admin` — the
 * remote-projects kill switch fails closed.
 */
export interface CollaborationHttpAccessPolicy {
  remoteBuildEnabled: boolean;
  terminalsEnabled: boolean;
}

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
  policy?: CollaborationHttpAccessPolicy,
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

  if (normalizedMethod === "GET" && MEMBER_COLLAB_CHANNEL_PROMPT_PREVIEW_PATH.test(pathname)) {
    // Collaboration-surface member route; intentionally not kill-switched.
    return "member";
  }

  if (
    (normalizedMethod === "GET" && COLLABORATION_CHANNEL_SPECIALISTS_PATH.test(pathname)) ||
    (normalizedMethod === "GET" && COLLABORATION_CHANNEL_SPECIALISTS_ROSTER_PROMPT_PATH.test(pathname)) ||
    (normalizedMethod === "PUT" && COLLABORATION_CHANNEL_SPECIALISTS_SELECTION_PATH.test(pathname)) ||
    (normalizedMethod === "PUT" && COLLABORATION_CHANNEL_SKILLS_SELECTION_PATH.test(pathname)) ||
    ((normalizedMethod === "PUT" || normalizedMethod === "DELETE") &&
      COLLABORATION_CHANNEL_SPECIALIST_DETAIL_PATH.test(pathname))
  ) {
    return "admin";
  }

  if (normalizedMethod === "POST" && COLLABORATION_INVITE_REDEEM_PATH.test(pathname)) {
    return "public";
  }

  if (!pathname.startsWith("/api/") && (normalizedMethod === "GET" || normalizedMethod === "HEAD")) {
    return "public";
  }

  if (isMemberProjectRoute(pathname, normalizedMethod, policy)) {
    // Kill switch (SPEC §4.3.5): member project routes require the
    // remoteBuild.enabled instance setting; otherwise they stay admin.
    return policy?.remoteBuildEnabled ? "member" : "admin";
  }

  // Settings specialist routes — all operations require admin on the collab server
  if (pathname === SETTINGS_SPECIALISTS_PATH || pathname.startsWith(`${SETTINGS_SPECIALISTS_PATH}/`)) {
    return "admin";
  }

  return "admin";
}

/**
 * Allowlist of project-scoped surfaces members may reach (SPEC §4.3). R1
 * grants reads; R2 extends to project-scoped writes. Anything not matched
 * here falls through to the default `admin` classification.
 */
function isMemberProjectRoute(
  pathname: string,
  normalizedMethod: string,
  policy?: CollaborationHttpAccessPolicy,
): boolean {
  const isReadMethod = normalizedMethod === "GET" || normalizedMethod === "HEAD";

  if (isReadMethod) {
    if (MEMBER_FILE_BROWSER_READ_PATHS.has(pathname)) {
      return true;
    }

    if (pathname.startsWith(MEMBER_ATTACHMENTS_PATH_PREFIX)) {
      return true;
    }

    if (MEMBER_CHAT_ARTIFACT_TICKET_PATH.test(pathname)) {
      return true;
    }

    if (MEMBER_GIT_READ_PATHS.has(pathname) || MEMBER_GIT_PULL_REQUEST_DETAIL_PATH.test(pathname)) {
      return true;
    }

    if (
      MEMBER_SESSION_AUDIT_PATH.test(pathname) ||
      MEMBER_MANAGER_SCHEDULES_PATH.test(pathname) ||
      MEMBER_AGENT_SYSTEM_PROMPT_PATH.test(pathname) ||
      MEMBER_SESSION_FEEDBACK_PATH.test(pathname)
    ) {
      return true;
    }

    if (pathname === MEMBER_PROJECT_RESOURCES_PATH) {
      return true;
    }

    if (
      pathname === MEMBER_MODELS_LIST_PATH
      || pathname === MEMBER_MANAGER_SELECTION_CATALOG_PATH
      || pathname === MEMBER_MODEL_OVERRIDES_PATH
      || pathname === MEMBER_DELEGATION_ROSTERS_PATH
    ) {
      return true;
    }

    if (pathname === MEMBER_TERMINALS_COLLECTION_PATH || pathname === MEMBER_TERMINALS_AVAILABLE_SHELLS_PATH) {
      return true;
    }
  }

  // POST /api/read-file is a read (path parameters travel in the body).
  if (pathname === MEMBER_READ_FILE_PATH && (isReadMethod || normalizedMethod === "POST")) {
    return true;
  }
  if (pathname === MEMBER_CHAT_ARTIFACT_READ_PATH && normalizedMethod === "POST") {
    return true;
  }

  // ---- R2 project-scoped writes -----------------------------------------

  if (pathname === MEMBER_WRITE_FILE_PATH && normalizedMethod === "POST") {
    return true;
  }

  if (pathname === MEMBER_FILE_CONTENT_PATH && (normalizedMethod === "PUT" || normalizedMethod === "DELETE")) {
    return true;
  }

  if (pathname === MEMBER_FILE_CREATE_PATH && normalizedMethod === "POST") {
    return true;
  }

  if (pathname === MEMBER_FILE_RENAME_PATH && normalizedMethod === "PATCH") {
    return true;
  }

  if (normalizedMethod === "POST" && (MEMBER_GIT_WRITE_PATHS.has(pathname) || MEMBER_GIT_PULL_REQUEST_MERGE_PATH.test(pathname))) {
    return true;
  }

  if (pathname === MEMBER_TRANSCRIBE_PATH && normalizedMethod === "POST") {
    return true;
  }

  // Session-scoped feedback votes (the /state suffix is read-only).
  if (
    normalizedMethod === "POST" &&
    MEMBER_SESSION_FEEDBACK_PATH.test(pathname) &&
    !pathname.endsWith("/state")
  ) {
    return true;
  }

  if (normalizedMethod === "POST" && MEMBER_AGENT_SESSION_OP_PATH.test(pathname)) {
    return true;
  }

  if (
    (normalizedMethod === "PUT" || normalizedMethod === "POST") &&
    MEMBER_PROJECT_RESOURCE_WRITE_PATHS.has(pathname)
  ) {
    return true;
  }

  // Terminal lifecycle and ticket issuance are member surfaces only while
  // the instance permits remote terminals (D6's one lever).
  if (policy?.terminalsEnabled) {
    if (pathname === MEMBER_TERMINALS_COLLECTION_PATH && normalizedMethod === "POST") {
      return true;
    }

    if (
      (normalizedMethod === "PATCH" || normalizedMethod === "DELETE") &&
      MEMBER_TERMINAL_ITEM_PATH.test(pathname) &&
      pathname !== MEMBER_TERMINALS_AVAILABLE_SHELLS_PATH &&
      pathname !== "/api/terminals/settings"
    ) {
      return true;
    }

    if (
      normalizedMethod === "POST" &&
      (MEMBER_TERMINAL_RESIZE_PATH.test(pathname) || MEMBER_TERMINAL_TICKET_PATH.test(pathname))
    ) {
      return true;
    }
  }

  return false;
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

/** Any active signed-in user — member or admin. */
export function evaluateCollaborationMemberAccess(
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
  const memberAccess = evaluateCollaborationMemberAccess(authContext);
  if (!memberAccess.ok) {
    return memberAccess;
  }

  if (memberAccess.authContext.role !== "admin") {
    return { ok: false, statusCode: 403, error: "Admin access required" };
  }

  return memberAccess;
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
    pathname === "/api/health" ||
    (!pathname.startsWith("/api/") && (normalizedMethod === "GET" || normalizedMethod === "HEAD"))
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
