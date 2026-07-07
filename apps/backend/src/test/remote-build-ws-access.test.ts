import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@forge/protocol";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { clearCollaborationBetterAuthService } from "../collaboration/auth/better-auth-service.js";
import { closeCollaborationAuthDb } from "../collaboration/auth/collaboration-db.js";
import { startServer, type StartedServer } from "../server.js";
import { createTempConfig, type TempConfigHandle } from "../test-support/temp-config.js";

/**
 * WS member-access matrix (SPEC §10.2, R1 scope).
 *
 * - Kill switch off (default): members get no builder WS access at all.
 * - Kill switch on: members can subscribe/read; mutating and admin-tier
 *   commands stay denied in R1.
 * - Admins pass the gate unconditionally (existing behavior preserved).
 * - The setting takes effect live — no restart.
 */

const ADMIN_EMAIL = "remote-ws-admin@example.com";
const ADMIN_PASSWORD = "remote-ws-admin-password-1";
const MEMBER_EMAIL = "remote-ws-member@example.com";
const MEMBER_PASSWORD = "remote-ws-member-password-1";

const SILENT_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const tempConfigHandles: TempConfigHandle[] = [];
const activeSockets: WebSocket[] = [];
let activeServer: StartedServer | null = null;

class WsEventHarness {
  readonly events: ServerEvent[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: RawData) => {
      this.events.push(JSON.parse(raw.toString("utf8")) as ServerEvent);
    });
  }

  send(command: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(command));
  }

  async waitForEvent<T extends ServerEvent["type"]>(
    type: T,
    predicate?: (event: Extract<ServerEvent, { type: T }>) => boolean,
    timeoutMs = 5_000,
  ): Promise<Extract<ServerEvent, { type: T }>> {
    const matches = (event: ServerEvent): event is Extract<ServerEvent, { type: T }> =>
      event.type === type && (predicate ? predicate(event as Extract<ServerEvent, { type: T }>) : true);

    const existing = this.events.find(matches);
    if (existing) {
      return existing;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        const seen = this.events.map((event) => JSON.stringify(event).slice(0, 160)).join("\n  ");
        reject(new Error(`Timed out waiting for WS event ${type}. Observed events:\n  ${seen}`));
      }, timeoutMs);

      const onMessage = (raw: RawData) => {
        const event = JSON.parse(raw.toString("utf8")) as ServerEvent;
        if (!matches(event)) {
          return;
        }
        cleanup();
        resolve(event);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("message", onMessage);
      };

      this.socket.on("message", onMessage);
    });
  }
}

afterEach(async () => {
  for (const socket of activeSockets.splice(0)) {
    try {
      socket.close();
    } catch {
      // best effort
    }
  }

  if (activeServer) {
    await activeServer.stop();
    activeServer = null;
  }

  while (tempConfigHandles.length > 0) {
    const handle = tempConfigHandles.pop();
    if (!handle) {
      continue;
    }
    clearCollaborationBetterAuthService(handle.config);
    closeCollaborationAuthDb(handle.config);
    await handle.cleanup();
  }
});

async function startCollaborationServer(): Promise<{ baseUrl: string }> {
  const tempRootDir = await mkdtemp(join(tmpdir(), "forge-remote-ws-access-"));
  const tempConfigHandle = await createTempConfig({
    runtimeTarget: "collaboration-server",
    tempRootDir,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    allowNonManagerSubscriptions: true,
  });
  tempConfigHandle.config.collaborationBaseUrl = `http://${tempConfigHandle.config.host}:${tempConfigHandle.config.port}`;
  tempConfigHandles.push(tempConfigHandle);

  const server = await startServer({
    config: tempConfigHandle.config,
    logger: SILENT_LOGGER,
  });
  activeServer = server;

  return { baseUrl: `http://${server.host}:${server.port}` };
}

function readSetCookieHeaders(response: Response): string[] {
  const headers = response.headers.getSetCookie?.() ?? [];
  return headers.length > 0 ? headers : response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : [];
}

function setCookieHeadersToCookieHeader(setCookies: string[]): string {
  return setCookies.map((value) => value.split(";")[0]).join("; ");
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const loginResponse = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
    },
    body: JSON.stringify({ email, password }),
  });
  expect(loginResponse.ok).toBe(true);
  return setCookieHeadersToCookieHeader(readSetCookieHeaders(loginResponse));
}

async function createMember(baseUrl: string, adminCookie: string): Promise<string> {
  const inviteResponse = await fetch(`${baseUrl}/api/collaboration/invites`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: adminCookie,
    },
    body: JSON.stringify({ email: MEMBER_EMAIL, expiresInDays: 14 }),
  });
  expect(inviteResponse.status).toBe(200);
  const inviteBody = await inviteResponse.json() as { ok: true; invite: { inviteUrl: string } };
  const inviteToken = inviteBody.invite.inviteUrl.split("/").at(-1);
  expect(inviteToken).toBeTruthy();

  const redeemResponse = await fetch(`${baseUrl}/api/collaboration/invites/${inviteToken}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: MEMBER_EMAIL, name: "Member", password: MEMBER_PASSWORD }),
  });
  expect(redeemResponse.status).toBe(200);

  return login(baseUrl, MEMBER_EMAIL, MEMBER_PASSWORD);
}

async function setRemoteBuildEnabled(baseUrl: string, adminCookie: string, enabled: boolean): Promise<void> {
  const response = await fetch(`${baseUrl}/api/settings/remote-build`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      cookie: adminCookie,
    },
    body: JSON.stringify({ enabled }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { ok: true; settings: { enabled: boolean } };
  expect(body.settings.enabled).toBe(enabled);
}

async function openAuthenticatedWs(baseUrl: string, cookie: string): Promise<WsEventHarness> {
  const wsUrl = baseUrl.replace(/^http/, "ws");
  const socket = new WebSocket(wsUrl, {
    headers: {
      origin: baseUrl,
      cookie,
    },
  });
  activeSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return new WsEventHarness(socket);
}

async function expectCommandDenied(
  harness: WsEventHarness,
  command: Record<string, unknown>,
  messageIncludes?: string,
): Promise<void> {
  const startIndex = harness.events.length;
  harness.send(command);
  const error = await harness.waitForEvent(
    "error",
    (event) => harness.events.indexOf(event) >= startIndex || !harness.events.includes(event),
  );
  expect(error.code).toBe("COLLABORATION_COMMAND_NOT_ALLOWED");
  if (messageIncludes) {
    expect(error.message).toContain(messageIncludes);
  }
}

describe("collaboration status handshake (SPEC §4.4)", () => {
  it("advertises instance name, versions, and capabilities; remoteBuild tracks the kill switch", async () => {
    const { baseUrl } = await startCollaborationServer();

    const before = await fetch(`${baseUrl}/api/collaboration/status`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    expect(before.enabled).toBe(true);
    expect(typeof before.instanceName).toBe("string");
    expect((before.instanceName as string).length).toBeGreaterThan(0);
    expect(typeof before.forgeVersion).toBe("string");
    expect(before.protocolVersion).toBe(1);
    expect(before.capabilities).toEqual({ collab: true, remoteBuild: false });

    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    await setRemoteBuildEnabled(baseUrl, adminCookie, true);

    const after = await fetch(`${baseUrl}/api/collaboration/status`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    expect(after.capabilities).toEqual({ collab: true, remoteBuild: true });

    // Admin-set instance name flows through the handshake.
    const renameResponse = await fetch(`${baseUrl}/api/settings/remote-build`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ instanceName: "Central Forge" }),
    });
    expect(renameResponse.status).toBe(200);
    const renamed = await fetch(`${baseUrl}/api/collaboration/status`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    expect(renamed.instanceName).toBe("Central Forge");
  }, 30_000);

  it("keeps the settings endpoint admin-only", async () => {
    const { baseUrl } = await startCollaborationServer();
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);

    const unauthenticated = await fetch(`${baseUrl}/api/settings/remote-build`);
    expect(unauthenticated.status).toBe(401);

    const asMember = await fetch(`${baseUrl}/api/settings/remote-build`, {
      headers: { cookie: memberCookie },
    });
    expect(asMember.status).toBe(403);

    const asMemberPut = await fetch(`${baseUrl}/api/settings/remote-build`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ enabled: true }),
    });
    expect(asMemberPut.status).toBe(403);

    const asAdmin = await fetch(`${baseUrl}/api/settings/remote-build`, {
      headers: { cookie: adminCookie },
    });
    expect(asAdmin.status).toBe(200);
    const body = await asAdmin.json() as { settings: { enabled: boolean; terminalsEnabled: boolean } };
    expect(body.settings).toMatchObject({ enabled: false, terminalsEnabled: true });
  }, 30_000);
});

describe("remote build WS access matrix (R1)", () => {
  it("denies members all builder commands while the kill switch is off", async () => {
    const { baseUrl } = await startCollaborationServer();
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);

    const member = await openAuthenticatedWs(baseUrl, memberCookie);
    await expectCommandDenied(member, { type: "subscribe" }, "Remote projects are disabled");
    await expectCommandDenied(member, { type: "user_message", text: "hello" }, "Remote projects are disabled");

    // The collaboration surface is unaffected by the kill switch.
    member.send({ type: "collab_bootstrap" });
    const bootstrap = await member.waitForEvent("collab_bootstrap");
    expect(bootstrap.currentUser.email).toBe(MEMBER_EMAIL);
  }, 30_000);

  it("grants members reads but not mutations when remote build is enabled", async () => {
    const { baseUrl } = await startCollaborationServer();
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);
    await setRemoteBuildEnabled(baseUrl, adminCookie, true);

    const member = await openAuthenticatedWs(baseUrl, memberCookie);

    // Read path: subscribe succeeds and the builder bootstrap arrives.
    member.send({ type: "subscribe" });
    const snapshot = await member.waitForEvent("agents_snapshot");
    expect(Array.isArray(snapshot.agents)).toBe(true);

    // R1: mutating commands stay denied for members.
    await expectCommandDenied(member, { type: "user_message", text: "hello" }, "read-only");
    await expectCommandDenied(
      member,
      { type: "create_manager", name: "proj", cwd: "/tmp" },
      "read-only",
    );
    await expectCommandDenied(member, { type: "delete_session", agentId: "agent-1" }, "read-only");

    // Admin-tier commands are denied for members regardless of phase.
    await expectCommandDenied(member, { type: "pick_directory" }, "admin");
    await expectCommandDenied(member, { type: "resume_restart_recovery" }, "admin");
  }, 30_000);

  it("applies kill-switch changes live and never gates admins", async () => {
    const { baseUrl } = await startCollaborationServer();
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);

    // Admin passes with the switch off (existing collaboration-server behavior).
    const admin = await openAuthenticatedWs(baseUrl, adminCookie);
    admin.send({ type: "subscribe" });
    await admin.waitForEvent("agents_snapshot");

    await setRemoteBuildEnabled(baseUrl, adminCookie, true);

    const member = await openAuthenticatedWs(baseUrl, memberCookie);
    member.send({ type: "subscribe" });
    await member.waitForEvent("agents_snapshot");

    // Flip the switch off — the same live socket loses builder access.
    await setRemoteBuildEnabled(baseUrl, adminCookie, false);
    await expectCommandDenied(member, { type: "subscribe" }, "Remote projects are disabled");

    // Admin remains unaffected.
    admin.send({ type: "ping" });
    await admin.waitForEvent("ready");
  }, 30_000);
});
