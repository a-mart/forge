import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitSetCookieHeader } from "better-auth/cookies";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCollaborationBetterAuthService,
  getOrCreateCollaborationBetterAuthService,
} from "../collaboration/auth/better-auth-service.js";
import { closeCollaborationAuthDb } from "../collaboration/auth/collaboration-db.js";
import { runCollaborationAuthMigrations } from "../collaboration/auth/migration-runner.js";
import { createTempConfig } from "../test-support/temp-config.js";
import type { SwarmConfig } from "../swarm/types.js";

const tempRoots: string[] = [];
const activeConfigs: SwarmConfig[] = [];

afterEach(async () => {
  for (const config of activeConfigs.splice(0)) {
    clearCollaborationBetterAuthService(config);
    closeCollaborationAuthDb(config);
  }

  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createAuthHarness(options: { collaborationAuthCookieName?: string } = {}) {
  const handle = await createTempConfig({
    runtimeTarget: "collaboration-server",
    collaborationAuthCookieName: options.collaborationAuthCookieName,
    tempRootDir: await mkdtemp(join(tmpdir(), "forge-collaboration-auth-service-")),
  });
  tempRoots.push(handle.tempRootDir);
  activeConfigs.push(handle.config);
  await runCollaborationAuthMigrations(handle.config);
  const authService = await getOrCreateCollaborationBetterAuthService(handle.config);
  return { config: handle.config, authService };
}

function toCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((header) => header.split(";", 1)[0]?.trim())
    .filter((header): header is string => Boolean(header))
    .join("; ");
}

function getCookieNames(setCookieHeaders: string[]): string[] {
  return setCookieHeaders
    .map((header) => header.split("=", 1)[0]?.trim())
    .filter((name): name is string => Boolean(name));
}

function expectNoSharedBetterAuthCookies(setCookieHeaders: string[]): void {
  expect(getCookieNames(setCookieHeaders).filter((name) => name.startsWith("better-auth."))).toEqual([]);
}

describe("collaboration better auth service", () => {
  it("round-trips bootstrap-created session cookies through getSessionFromCookieHeader", async () => {
    const { authService } = await createAuthHarness();
    const user = await authService.createUser("bootstrap@example.com", "Bootstrap User", "bootstrap-pass-123");

    const setCookieHeaders = await authService.createSessionCookies(user.id);
    const session = await authService.getSessionFromCookieHeader(toCookieHeader(setCookieHeaders));

    expect(setCookieHeaders).not.toHaveLength(0);
    expect(session?.user.id).toBe(user.id);
    expect(session?.user.email).toBe(user.email);
    expect(session?.session.userId).toBe(user.id);
  });

  it("uses a configured collaboration auth cookie name", async () => {
    const { authService } = await createAuthHarness({
      collaborationAuthCookieName: "forge_collab_secondary_session",
    });
    const password = "secondary-pass-123";
    const user = await authService.createUser(
      "secondary@example.com",
      "Secondary User",
      password,
    );

    const bootstrapSetCookieHeaders = await authService.createSessionCookies(user.id);
    const session = await authService.getSessionFromCookieHeader(
      toCookieHeader(bootstrapSetCookieHeaders),
    );
    const signInResult = await (authService as any).auth.api.signInEmail({
      body: {
        email: user.email,
        password,
        rememberMe: true,
      },
      headers: new Headers(),
      returnHeaders: true,
    });
    const signInSetCookieHeaders = splitSetCookieHeader(
      signInResult.headers?.get("set-cookie") ?? "",
    );

    for (const headers of [bootstrapSetCookieHeaders, signInSetCookieHeaders]) {
      expect(
        headers.some((header) => header.startsWith("forge_collab_secondary_session=")),
      ).toBe(true);
      expect(headers.some((header) => header.startsWith("forge_collab_session="))).toBe(
        false,
      );
    }
    expect(session?.user.id).toBe(user.id);
  });

  it("preserves Better Auth auxiliary cookie names when the configured cookie name equals the default", async () => {
    const { authService } = await createAuthHarness({
      collaborationAuthCookieName: "forge_collab_session",
    });
    const password = "default-explicit-pass-123";
    const user = await authService.createUser(
      "explicit-default@example.com",
      "Explicit Default User",
      password,
    );

    const signInResult = await (authService as any).auth.api.signInEmail({
      body: {
        email: user.email,
        password,
        rememberMe: false,
      },
      headers: new Headers(),
      returnHeaders: true,
    });
    const signInSetCookieHeaders = splitSetCookieHeader(
      signInResult.headers?.get("set-cookie") ?? "",
    );
    const signInCookieNames = getCookieNames(signInSetCookieHeaders);

    expect(signInCookieNames).toContain("forge_collab_session");
    expect(signInCookieNames).toContain("better-auth.dont_remember");
    expect(signInCookieNames).not.toContain("forge_collab_session_dont_remember");

    const signOutResult = await (authService as any).auth.api.signOut({
      headers: new Headers({ cookie: toCookieHeader(signInSetCookieHeaders) }),
      returnHeaders: true,
    });
    const signOutSetCookieHeaders = splitSetCookieHeader(
      signOutResult.headers?.get("set-cookie") ?? "",
    );
    const signOutCookieNames = getCookieNames(signOutSetCookieHeaders);

    expect(signOutCookieNames).toContain("forge_collab_session");
    expect(signOutCookieNames).toContain("better-auth.session_data");
    expect(signOutCookieNames).toContain("better-auth.dont_remember");
    expect(signOutCookieNames).not.toContain("forge_collab_session_session_data");
    expect(signOutCookieNames).not.toContain("forge_collab_session_dont_remember");
  });

  it("namespaces Better Auth remember-me auxiliary cookies when the collaboration auth cookie is customized", async () => {
    const customCookieName = "forge_collab_secondary_session";
    const { authService } = await createAuthHarness({
      collaborationAuthCookieName: customCookieName,
    });
    const password = "secondary-pass-123";
    const user = await authService.createUser(
      "secondary-remember@example.com",
      "Secondary Remember User",
      password,
    );

    const signInResult = await (authService as any).auth.api.signInEmail({
      body: {
        email: user.email,
        password,
        rememberMe: false,
      },
      headers: new Headers(),
      returnHeaders: true,
    });
    const signInSetCookieHeaders = splitSetCookieHeader(
      signInResult.headers?.get("set-cookie") ?? "",
    );
    const cookieNames = getCookieNames(signInSetCookieHeaders);

    expect(cookieNames).toContain(customCookieName);
    expect(cookieNames).toContain(`${customCookieName}_dont_remember`);
    expect(cookieNames).not.toContain("better-auth.dont_remember");
    expectNoSharedBetterAuthCookies(signInSetCookieHeaders);
  });

  it("namespaces Better Auth sign-out auxiliary cookies when the collaboration auth cookie is customized", async () => {
    const customCookieName = "forge_collab_secondary_session";
    const { authService } = await createAuthHarness({
      collaborationAuthCookieName: customCookieName,
    });
    const password = "secondary-pass-123";
    const user = await authService.createUser(
      "secondary-signout@example.com",
      "Secondary Sign Out User",
      password,
    );
    const signInResult = await (authService as any).auth.api.signInEmail({
      body: {
        email: user.email,
        password,
        rememberMe: false,
      },
      headers: new Headers(),
      returnHeaders: true,
    });
    const signInSetCookieHeaders = splitSetCookieHeader(
      signInResult.headers?.get("set-cookie") ?? "",
    );

    const signOutResult = await (authService as any).auth.api.signOut({
      headers: new Headers({ cookie: toCookieHeader(signInSetCookieHeaders) }),
      returnHeaders: true,
    });
    const signOutSetCookieHeaders = splitSetCookieHeader(
      signOutResult.headers?.get("set-cookie") ?? "",
    );
    const cookieNames = getCookieNames(signOutSetCookieHeaders);

    expect(cookieNames).toContain(customCookieName);
    expect(cookieNames).toContain(`${customCookieName}_session_data`);
    expect(cookieNames).toContain(`${customCookieName}_dont_remember`);
    expect(cookieNames).not.toContain("better-auth.session_data");
    expect(cookieNames).not.toContain("better-auth.dont_remember");
    expectNoSharedBetterAuthCookies(signOutSetCookieHeaders);
  });

  it("round-trips Better Auth sign-in cookies through getSessionFromCookieHeader", async () => {
    const { authService } = await createAuthHarness();
    const password = "signin-pass-123";
    const user = await authService.createUser("signin@example.com", "Sign In User", password);

    const signInResult = await (authService as any).auth.api.signInEmail({
      body: {
        email: user.email,
        password,
        rememberMe: true,
      },
      headers: new Headers(),
      returnHeaders: true,
    });

    const setCookieHeader = signInResult.headers?.get("set-cookie") ?? "";
    const session = await authService.getSessionFromCookieHeader(
      toCookieHeader(splitSetCookieHeader(setCookieHeader)),
    );

    expect(setCookieHeader).not.toBe("");
    expect(session?.user.id).toBe(user.id);
    expect(session?.user.email).toBe(user.email);
    expect(session?.session.userId).toBe(user.id);
  });
});
