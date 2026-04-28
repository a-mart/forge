import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const activeServers: Server[] = [];

afterEach(async () => {
  for (const server of activeServers.splice(0)) {
    await closeServer(server);
  }

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
    tempRootDir: await mkdtemp(join(tmpdir(), "forge-collaboration-better-auth-")),
  });
  tempRoots.push(handle.tempRootDir);
  activeConfigs.push(handle.config);
  await runCollaborationAuthMigrations(handle.config);
  const authService = await getOrCreateCollaborationBetterAuthService(handle.config);
  return { config: handle.config, authService };
}

describe("collaboration Better Auth service", () => {
  it("round-trips login and bootstrap session cookies through session lookup", async () => {
    const { config, authService } = await createAuthHarness();
    const email = "person@example.com";
    const password = "Password123!";
    const user = await authService.createUser(email, "Person", password);

    const bootstrapCookieHeader = setCookieHeadersToCookieHeader(await authService.createSessionCookies(user.id));
    const bootstrapSession = await authService.getSessionFromCookieHeader(bootstrapCookieHeader);
    expect(bootstrapSession?.user.id).toBe(user.id);
    expect(bootstrapSession?.user.email).toBe(email);

    const server = createServer((request, response) => {
      void authService.handleAuthRequest(request, response);
    });
    activeServers.push(server);
    await listen(server, config.host, config.port);

    const response = await fetch(`http://${config.host}:${config.port}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://${config.host}:${config.port}`,
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      throw new Error(`Expected login to succeed, got ${response.status}: ${await response.text()}`);
    }

    const loginCookieHeader = setCookieHeadersToCookieHeader(readSetCookieHeaders(response));
    const loginSession = await authService.getSessionFromCookieHeader(loginCookieHeader);
    expect(loginSession?.user.id).toBe(user.id);
    expect(loginSession?.user.email).toBe(email);
  });
});

function readSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    return setCookies;
  }

  const joinedHeader = response.headers.get("set-cookie");
  return joinedHeader ? [joinedHeader] : [];
}

function setCookieHeadersToCookieHeader(setCookies: string[]): string {
  return setCookies
    .map((cookie) => {
      const firstSeparatorIndex = cookie.indexOf(";");
      return firstSeparatorIndex >= 0 ? cookie.slice(0, firstSeparatorIndex) : cookie;
    })
    .join("; ");
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
