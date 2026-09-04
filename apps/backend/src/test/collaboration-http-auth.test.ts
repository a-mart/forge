import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type {
  CollaborationHttpAccessPolicy,
  CollaborationRequestAuthContext,
} from "../collaboration/auth/collaboration-auth-middleware.js";
import {
  classifyCollaborationHttpRequest,
  evaluateCollaborationAdminAccess,
  evaluateCollaborationMemberAccess,
  evaluateCollaborationPasswordChangeAccess,
  getCollaborationRequestAuthContext,
  getCollaborationRequestCorsContext,
  setCollaborationRequestAuthContext,
  setCollaborationRequestCorsContext,
  validateCollaborationHttpOrigin,
} from "../collaboration/auth/collaboration-auth-middleware.js";
import { applyCorsHeaders } from "../ws/http-utils.js";

type TestRequest = IncomingMessage & {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
};

function createRequest(options?: {
  pathname?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}): TestRequest {
  return {
    headers: options?.headers ?? {},
    method: options?.method,
    url: options?.pathname ?? "/",
  } as TestRequest;
}

function createResponse(): {
  response: ServerResponse;
  getHeader: (name: string) => string | undefined;
} {
  const headers = new Map<string, string>();

  return {
    response: {
      setHeader(name: string, value: string): void {
        headers.set(name.toLowerCase(), value);
      },
      removeHeader(name: string): void {
        headers.delete(name.toLowerCase());
      },
    } as unknown as ServerResponse,
    getHeader(name: string): string | undefined {
      return headers.get(name.toLowerCase());
    },
  };
}

function createAuthContext(
  role: CollaborationRequestAuthContext["role"],
  overrides?: Partial<CollaborationRequestAuthContext>,
): CollaborationRequestAuthContext {
  return {
    userId: overrides?.userId ?? `${role}-user`,
    email: overrides?.email ?? `${role}@example.com`,
    name: overrides?.name ?? `${role} user`,
    role,
    disabled: overrides?.disabled ?? false,
    passwordChangeRequired: overrides?.passwordChangeRequired ?? false,
    sessionId: overrides?.sessionId,
  };
}

function enforcePathAccess(
  pathname: string,
  method: string | undefined,
  authContext: CollaborationRequestAuthContext | null,
  policy?: CollaborationHttpAccessPolicy,
):
  | { ok: true }
  | { ok: false; statusCode: 401 | 403; error: string } {
  const accessClass = classifyCollaborationHttpRequest(pathname, method, policy);
  if (accessClass === "public") {
    return { ok: true };
  }

  if (accessClass === "member") {
    const access = evaluateCollaborationMemberAccess(authContext);
    return access.ok ? { ok: true } : access;
  }

  const access = evaluateCollaborationAdminAccess(authContext);
  return access.ok ? { ok: true } : access;
}

const REMOTE_BUILD_ON: CollaborationHttpAccessPolicy = { remoteBuildEnabled: true, terminalsEnabled: true };
const REMOTE_BUILD_OFF: CollaborationHttpAccessPolicy = { remoteBuildEnabled: false, terminalsEnabled: true };

describe("collaboration HTTP auth middleware", () => {
  it("classifies public, member, and admin endpoints", () => {
    expect(classifyCollaborationHttpRequest("/api/health", "GET")).toBe("public");
    expect(classifyCollaborationHttpRequest("/api/auth/sign-in/email", "POST")).toBe("public");
    expect(classifyCollaborationHttpRequest("/api/collaboration/status", "GET")).toBe("public");
    expect(classifyCollaborationHttpRequest("/api/collaboration/me", "GET")).toBe("public");
    expect(classifyCollaborationHttpRequest("/api/collaboration/me/password", "POST")).toBe("public");
    expect(classifyCollaborationHttpRequest("/api/collaboration/invites/token-1", "GET")).toBe("public");
    expect(classifyCollaborationHttpRequest("/api/collaboration/invites/token-1/redeem", "POST")).toBe("public");
    expect(classifyCollaborationHttpRequest("/api/collaboration/channels", "GET")).toBe("public");
    expect(classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1", "GET")).toBe("public");
    expect(classifyCollaborationHttpRequest("/api/collaboration/categories", "GET")).toBe("public");
    expect(
      classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/prompt-preview", "GET"),
    ).toBe("member");
    expect(classifyCollaborationHttpRequest("/api/collaboration/users", "GET")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/collaboration/invites", "POST")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/specialists", "GET")).toBe("admin");
    expect(
      classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/specialists/roster-prompt", "GET"),
    ).toBe("admin");
    expect(
      classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/specialists/selection", "PUT"),
    ).toBe("admin");
    expect(
      classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/skills/selection", "PUT"),
    ).toBe("admin");
    expect(
      classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/specialists/local-specialist", "PUT"),
    ).toBe("admin");
    expect(
      classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/specialists/local-specialist", "DELETE"),
    ).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/archive", "POST")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/collaboration/channels/reorder", "POST")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/collaboration/categories/category-1", "PATCH")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/auth", "GET")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/auth", "OPTIONS")).toBe("public");

    // Settings specialist routes — all require admin
    expect(classifyCollaborationHttpRequest("/api/settings/specialists", "GET")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/specialists/tiers", "GET")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/specialists/tiers", "PUT")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/specialists/template", "GET")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/specialists/backend", "PUT")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/specialists/backend", "DELETE")).toBe("admin");
    expect(
      classifyCollaborationHttpRequest("/api/settings/specialists/roster-prompt", "GET"),
    ).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/specialists", "OPTIONS")).toBe("public");
    expect(classifyCollaborationHttpRequest("/", "GET")).toBe("public");
    expect(classifyCollaborationHttpRequest("/settings", "HEAD")).toBe("public");
  });

  it("classifies member project routes behind the remoteBuild kill switch", () => {
    const memberReadRoutes: Array<[string, string]> = [
      ["/api/files/list", "GET"],
      ["/api/files/count", "GET"],
      ["/api/files/search", "GET"],
      ["/api/files/content", "GET"],
      ["/api/files/raw", "GET"],
      ["/api/read-file", "GET"],
      ["/api/read-file", "POST"],
      ["/api/chat-artifacts/read", "POST"],
      ["/api/chat-artifacts/tickets/opaque_token_1234", "GET"],
      ["/api/attachments/file-abc123", "GET"],
      ["/api/git/status", "GET"],
      ["/api/git/diff", "GET"],
      ["/api/git/log", "GET"],
      ["/api/git/file-log", "GET"],
      ["/api/git/file-section-provenance", "GET"],
      ["/api/git/commit", "GET"],
      ["/api/git/commit-diff", "GET"],
      ["/api/git/worktrees", "GET"],
      ["/api/git/branches", "GET"],
      ["/api/git/mutation-preflight", "GET"],
      ["/api/git/provider/status", "GET"],
      ["/api/git/pull-requests", "GET"],
      ["/api/git/pull-requests/42", "GET"],
      ["/api/sessions/sess-1/audit", "GET"],
      ["/api/sessions/sess-1/audit/entry", "GET"],
      ["/api/managers/mgr-1/schedules", "GET"],
      ["/api/agents/agent-1/system-prompt", "GET"],
      ["/api/v1/profiles/prof-1/sessions/sess-1/feedback", "GET"],
      ["/api/v1/profiles/prof-1/sessions/sess-1/feedback/state", "GET"],
      ["/api/settings/project-resources", "GET"],
      ["/api/settings/manager-selection-catalog", "GET"],
      ["/api/settings/delegation-rosters", "GET"],
      ["/api/terminals", "GET"],
      ["/api/terminals/available-shells", "GET"],
    ];

    for (const [pathname, method] of memberReadRoutes) {
      expect(classifyCollaborationHttpRequest(pathname, method, REMOTE_BUILD_ON), `${method} ${pathname} (on)`).toBe(
        "member",
      );
      // Kill switch: same routes classify admin when remote build is off or
      // when no policy is supplied (fail closed).
      expect(classifyCollaborationHttpRequest(pathname, method, REMOTE_BUILD_OFF), `${method} ${pathname} (off)`).toBe(
        "admin",
      );
      expect(classifyCollaborationHttpRequest(pathname, method), `${method} ${pathname} (no policy)`).toBe("admin");
    }

    // R2: project-scoped writes are member routes while the switch is on and
    // fall back to admin when it is off (or when no policy is supplied).
    const memberWriteRoutes: Array<[string, string]> = [
      ["/api/files/content", "PUT"],
      ["/api/files/content", "DELETE"],
      ["/api/write-file", "POST"],
      ["/api/git/fetch", "POST"],
      ["/api/git/switch-branch", "POST"],
      ["/api/git/create-branch", "POST"],
      ["/api/git/pull-ff-only", "POST"],
      ["/api/git/push", "POST"],
      ["/api/git/pull-requests/42/merge", "POST"],
      ["/api/transcribe", "POST"],
      ["/api/agents/agent-1/compact", "POST"],
      ["/api/agents/agent-1/smart-compact", "POST"],
      ["/api/agents/agent-1/clear", "POST"],
      ["/api/settings/project-resources/override", "PUT"],
      ["/api/settings/project-resources/trust", "PUT"],
      ["/api/settings/project-resources/seed", "POST"],
      ["/api/settings/project-resources/project-agents/activate", "POST"],
      ["/api/terminals", "POST"],
      ["/api/terminals/term-1", "PATCH"],
      ["/api/terminals/term-1", "DELETE"],
      ["/api/terminals/term-1/resize", "POST"],
      ["/api/terminals/term-1/ticket", "POST"],
    ];
    for (const [pathname, method] of memberWriteRoutes) {
      expect(classifyCollaborationHttpRequest(pathname, method, REMOTE_BUILD_ON), `${method} ${pathname} (on)`).toBe("member");
      expect(classifyCollaborationHttpRequest(pathname, method, REMOTE_BUILD_OFF), `${method} ${pathname} (off)`).toBe("admin");
      expect(classifyCollaborationHttpRequest(pathname, method), `${method} ${pathname} (no policy)`).toBe("admin");
    }

    // Terminal mutations/tickets additionally honor terminalsEnabled (D6).
    const TERMINALS_DISABLED = { remoteBuildEnabled: true, terminalsEnabled: false };
    expect(classifyCollaborationHttpRequest("/api/terminals", "POST", TERMINALS_DISABLED)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/terminals/term-1", "DELETE", TERMINALS_DISABLED)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/terminals/term-1/resize", "POST", TERMINALS_DISABLED)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/terminals/term-1/ticket", "POST", TERMINALS_DISABLED)).toBe("admin");
    // Terminal reads stay member-readable regardless of the terminals lever.
    expect(classifyCollaborationHttpRequest("/api/terminals", "GET", TERMINALS_DISABLED)).toBe("member");
    expect(classifyCollaborationHttpRequest("/api/terminals/available-shells", "GET", TERMINALS_DISABLED)).toBe("member");
    // The terminal-settings instance surface never becomes a member route.
    expect(classifyCollaborationHttpRequest("/api/terminals/settings", "PATCH", REMOTE_BUILD_ON)).toBe("admin");

    // Instance-scoped surfaces never become member routes, whatever the policy.
    expect(classifyCollaborationHttpRequest("/api/settings/env", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/auth", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/remote-build", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/remote-build", "PUT", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/model-overrides", "PUT", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/manager-selection-catalog", "POST", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/delegation-rosters", "PUT", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/extensions", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/cli-access/keys", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/debug/sidebar-perf", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/stats", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/stats/throughput", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/stats/throughput/refresh", "POST", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/stats/throughput/calls", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/terminals/settings", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/restart-recovery", "GET", REMOTE_BUILD_ON)).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/mobile/push/register", "POST", REMOTE_BUILD_ON)).toBe("admin");

    // The member collab route (audited former `authenticated` class) is not
    // kill-switched.
    expect(
      classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/prompt-preview", "GET", REMOTE_BUILD_OFF),
    ).toBe("member");
  });

  it("grants members access to member project routes only while remote build is enabled", () => {
    const member = createAuthContext("member");
    const admin = createAuthContext("admin");

    expect(enforcePathAccess("/api/files/list", "GET", member, REMOTE_BUILD_ON)).toEqual({ ok: true });
    expect(enforcePathAccess("/api/files/list", "GET", null, REMOTE_BUILD_ON)).toEqual({
      ok: false,
      statusCode: 401,
      error: "Authentication required",
    });
    expect(
      enforcePathAccess("/api/files/list", "GET", createAuthContext("member", { disabled: true }), REMOTE_BUILD_ON),
    ).toEqual({ ok: false, statusCode: 403, error: "User account is disabled" });
    expect(enforcePathAccess("/api/files/list", "GET", member, REMOTE_BUILD_OFF)).toEqual({
      ok: false,
      statusCode: 403,
      error: "Admin access required",
    });
    expect(enforcePathAccess("/api/files/list", "GET", admin, REMOTE_BUILD_OFF)).toEqual({ ok: true });
    expect(enforcePathAccess("/api/files/list", "GET", admin, REMOTE_BUILD_ON)).toEqual({ ok: true });
  });

  it("enforces admin-only access for admin routes and member access for prompt preview", () => {
    expect(enforcePathAccess("/api/collaboration/users", "GET", null)).toEqual({
      ok: false,
      statusCode: 401,
      error: "Authentication required",
    });
    expect(enforcePathAccess("/api/collaboration/users", "GET", createAuthContext("member"))).toEqual({
      ok: false,
      statusCode: 403,
      error: "Admin access required",
    });
    expect(
      enforcePathAccess(
        "/api/collaboration/users",
        "GET",
        createAuthContext("admin", { passwordChangeRequired: true }),
      ),
    ).toEqual({
      ok: false,
      statusCode: 403,
      error: "Password change required",
    });
    expect(enforcePathAccess("/api/collaboration/users", "GET", createAuthContext("admin"))).toEqual({ ok: true });

    expect(enforcePathAccess("/api/collaboration/channels/channel-1/prompt-preview", "GET", null)).toEqual({
      ok: false,
      statusCode: 401,
      error: "Authentication required",
    });
    expect(
      enforcePathAccess(
        "/api/collaboration/channels/channel-1/prompt-preview",
        "GET",
        createAuthContext("member"),
      ),
    ).toEqual({ ok: true });

    expect(enforcePathAccess("/api/collaboration/channels/channel-1/specialists", "GET", null)).toEqual({
      ok: false,
      statusCode: 401,
      error: "Authentication required",
    });
    expect(
      enforcePathAccess("/api/collaboration/channels/channel-1/specialists", "GET", createAuthContext("member")),
    ).toEqual({ ok: false, statusCode: 403, error: "Admin access required" });
    expect(
      enforcePathAccess(
        "/api/collaboration/channels/channel-1/specialists/roster-prompt",
        "GET",
        createAuthContext("member"),
      ),
    ).toEqual({ ok: false, statusCode: 403, error: "Admin access required" });

    // Settings specialist routes require admin
    expect(enforcePathAccess("/api/settings/specialists", "GET", null)).toEqual({
      ok: false,
      statusCode: 401,
      error: "Authentication required",
    });
    expect(enforcePathAccess("/api/settings/specialists", "GET", createAuthContext("member"))).toEqual({
      ok: false,
      statusCode: 403,
      error: "Admin access required",
    });
    expect(enforcePathAccess("/api/settings/specialists", "GET", createAuthContext("admin"))).toEqual({ ok: true });
    expect(enforcePathAccess("/api/settings/specialists/backend", "PUT", createAuthContext("member"))).toEqual({
      ok: false,
      statusCode: 403,
      error: "Admin access required",
    });
    expect(enforcePathAccess("/api/settings/specialists/tiers", "PUT", createAuthContext("admin"))).toEqual({
      ok: true,
    });
  });

  it("allows password-change-required users to reach only exempt paths", () => {
    const user = createAuthContext("member", { passwordChangeRequired: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/api/collaboration/status", "GET")).toEqual({ ok: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/api/collaboration/me", "GET")).toEqual({ ok: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/api/collaboration/me/password", "POST")).toEqual({ ok: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/api/auth/sign-in/email", "POST")).toEqual({ ok: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/settings", "GET")).toEqual({ ok: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/", "HEAD")).toEqual({ ok: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/api/settings/auth", "GET")).toEqual({
      ok: false,
      statusCode: 403,
      error: "Password change required",
    });
  });

  it("stores and retrieves request auth and CORS context", () => {
    const request = createRequest();
    const authContext = createAuthContext("admin");

    expect(getCollaborationRequestAuthContext(request)).toBeNull();
    expect(getCollaborationRequestCorsContext(request)).toBeNull();

    setCollaborationRequestAuthContext(request, authContext);
    setCollaborationRequestCorsContext(request, { allowedOrigin: "http://127.0.0.1:47188" });

    expect(getCollaborationRequestAuthContext(request)).toEqual(authContext);
    expect(getCollaborationRequestCorsContext(request)).toEqual({ allowedOrigin: "http://127.0.0.1:47188" });
  });

  it("emits credentialed fallback CORS headers when echoing a non-collaboration origin", () => {
    const request = createRequest({
      method: "GET",
      headers: {
        origin: "http://127.0.0.1:47188",
      },
    });
    const { response, getHeader } = createResponse();
    applyCorsHeaders(request, response, "GET,POST,OPTIONS");

    expect(getHeader("access-control-allow-origin")).toBe("http://127.0.0.1:47188");
    expect(getHeader("access-control-allow-credentials")).toBe("true");
    expect(getHeader("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    expect(getHeader("access-control-allow-headers")).toBe("content-type");
    expect(getHeader("vary")).toBe("Origin");
  });

  it("keeps wildcard fallback CORS non-credentialed when no origin is present", () => {
    const request = createRequest({ method: "GET" });
    const { response, getHeader } = createResponse();
    applyCorsHeaders(request, response, "GET,POST,OPTIONS");

    expect(getHeader("access-control-allow-origin")).toBe("*");
    expect(getHeader("access-control-allow-credentials")).toBeUndefined();
    expect(getHeader("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    expect(getHeader("access-control-allow-headers")).toBe("content-type");
  });

  it("allows same-origin and trusted-origin requests and emits credentialed CORS headers", () => {
    const request = createRequest({
      method: "GET",
      headers: {
        host: "127.0.0.1:47187",
        origin: "http://127.0.0.1:47187",
      },
    });
    const originValidation = validateCollaborationHttpOrigin(request);
    expect(originValidation).toEqual({ ok: true, allowedOrigin: "http://127.0.0.1:47187" });

    setCollaborationRequestCorsContext(request, { allowedOrigin: originValidation.allowedOrigin });
    const { response, getHeader } = createResponse();
    applyCorsHeaders(request, response, "GET,POST,OPTIONS");

    expect(getHeader("access-control-allow-origin")).toBe("http://127.0.0.1:47187");
    expect(getHeader("access-control-allow-credentials")).toBe("true");
    expect(getHeader("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    expect(getHeader("access-control-allow-headers")).toBe("content-type");
    expect(getHeader("vary")).toBe("Origin");

    const trustedOriginRequest = createRequest({
      method: "GET",
      headers: {
        host: "127.0.0.1:47187",
        origin: "http://127.0.0.1:47188",
      },
    });
    expect(
      validateCollaborationHttpOrigin(trustedOriginRequest, {
        collaborationTrustedOrigins: ["http://127.0.0.1:47188"],
      }),
    ).toEqual({ ok: true, allowedOrigin: "http://127.0.0.1:47188" });
  });

  it("rejects cross-origin requests and suppresses CORS headers when no origin is allowed", () => {
    const request = createRequest({
      method: "GET",
      headers: {
        host: "127.0.0.1:47187",
        origin: "https://evil.example.com",
      },
    });

    expect(validateCollaborationHttpOrigin(request)).toEqual({
      ok: false,
      allowedOrigin: null,
      errorMessage: "Origin not allowed",
    });

    setCollaborationRequestCorsContext(request, { allowedOrigin: null });
    const { response, getHeader } = createResponse();
    applyCorsHeaders(request, response, "GET,POST,OPTIONS");

    expect(getHeader("access-control-allow-origin")).toBeUndefined();
    expect(getHeader("access-control-allow-credentials")).toBeUndefined();
    expect(getHeader("vary")).toBeUndefined();
  });
});
