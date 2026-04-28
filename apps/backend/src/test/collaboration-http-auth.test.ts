import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { CollaborationRequestAuthContext } from "../collaboration/auth/collaboration-auth-middleware.js";
import {
  classifyCollaborationHttpRequest,
  evaluateCollaborationAdminAccess,
  evaluateCollaborationAuthenticatedAccess,
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
):
  | { ok: true }
  | { ok: false; statusCode: 401 | 403; error: string } {
  const accessClass = classifyCollaborationHttpRequest(pathname, method);
  if (accessClass === "public") {
    return { ok: true };
  }

  if (accessClass === "authenticated") {
    const access = evaluateCollaborationAuthenticatedAccess(authContext);
    return access.ok ? { ok: true } : access;
  }

  const access = evaluateCollaborationAdminAccess(authContext);
  return access.ok ? { ok: true } : access;
}

describe("collaboration HTTP auth middleware", () => {
  it("classifies public, authenticated, and admin endpoints", () => {
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
    ).toBe("authenticated");
    expect(classifyCollaborationHttpRequest("/api/collaboration/users", "GET")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/collaboration/invites", "POST")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/collaboration/channels/channel-1/archive", "POST")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/collaboration/channels/reorder", "POST")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/collaboration/categories/category-1", "PATCH")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/auth", "GET")).toBe("admin");
    expect(classifyCollaborationHttpRequest("/api/settings/auth", "OPTIONS")).toBe("public");
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
  });

  it("allows password-change-required users to reach only exempt paths", () => {
    const user = createAuthContext("member", { passwordChangeRequired: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/api/collaboration/status", "GET")).toEqual({ ok: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/api/collaboration/me", "GET")).toEqual({ ok: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/api/collaboration/me/password", "POST")).toEqual({ ok: true });
    expect(evaluateCollaborationPasswordChangeAccess(user, "/api/auth/sign-in/email", "POST")).toEqual({ ok: true });
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
