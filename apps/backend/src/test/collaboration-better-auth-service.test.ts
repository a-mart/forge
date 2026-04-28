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

async function createAuthHarness() {
  const handle = await createTempConfig({
    runtimeTarget: "collaboration-server",
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
