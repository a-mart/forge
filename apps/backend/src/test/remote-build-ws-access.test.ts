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
 * WS member-access matrix + attribution/echo fixtures (SPEC §10.2–10.4).
 *
 * - Kill switch off (default): members get no builder WS access at all.
 * - Kill switch on (R2): members read AND write project surfaces; admin-tier
 *   commands stay denied.
 * - Admins pass the gate unconditionally (existing behavior preserved).
 * - The setting takes effect live — no restart.
 * - Two-client fixture: interleaved sends from two authenticated clients
 *   broadcast attributed, clientRequestId-echoed messages with no dupes,
 *   across live events and the bootstrap-history path.
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

async function startCollaborationServer(options?: {
  remoteProjectsEnv?: {
    enabled?: boolean;
    terminalsEnabled?: boolean;
    instanceName?: string;
  };
}): Promise<{ baseUrl: string; defaultCwd: string }> {
  const tempRootDir = await mkdtemp(join(tmpdir(), "forge-remote-ws-access-"));
  const tempConfigHandle = await createTempConfig({
    runtimeTarget: "collaboration-server",
    tempRootDir,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    allowNonManagerSubscriptions: true,
    remoteProjectsEnv: options?.remoteProjectsEnv,
  });
  tempConfigHandle.config.collaborationBaseUrl = `http://${tempConfigHandle.config.host}:${tempConfigHandle.config.port}`;
  tempConfigHandles.push(tempConfigHandle);

  const server = await startServer({
    config: tempConfigHandle.config,
    logger: SILENT_LOGGER,
  });
  activeServer = server;

  return {
    baseUrl: `http://${server.host}:${server.port}`,
    defaultCwd: tempConfigHandle.config.defaultCwd,
  };
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

function harnessCollectDenials(harness: WsEventHarness): () => string[] {
  const startIndex = harness.events.length;
  return () =>
    harness.events
      .slice(startIndex)
      .filter(
        (event): event is Extract<ServerEvent, { type: "error" }> =>
          event.type === "error" && event.code === "COLLABORATION_COMMAND_NOT_ALLOWED",
      )
      .map((event) => event.message);
}

async function fetchCurrentUser(
  baseUrl: string,
  cookie: string,
): Promise<{ userId: string; name: string; role: string }> {
  const response = await fetch(`${baseUrl}/api/collaboration/me`, { headers: { cookie } });
  expect(response.status).toBe(200);
  const body = await response.json() as {
    authenticated: boolean;
    user?: { userId: string; name: string; role: string };
  };
  expect(body.authenticated).toBe(true);
  expect(body.user).toBeTruthy();
  return body.user!;
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
    expect(before.protocolVersion).toBe(2);
    expect(before.capabilities).toEqual({ collab: true, remoteBuild: false, createDirectory: true });

    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    await setRemoteBuildEnabled(baseUrl, adminCookie, true);

    const after = await fetch(`${baseUrl}/api/collaboration/status`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    expect(after.capabilities).toEqual({ collab: true, remoteBuild: true, createDirectory: true });

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
    const body = await asAdmin.json() as {
      settings: { enabled: boolean; terminalsEnabled: boolean };
      persistedSettings: { enabled: boolean; terminalsEnabled: boolean };
      sources: { enabled: string; terminalsEnabled: string; instanceName: string };
    };
    expect(body.settings).toMatchObject({ enabled: false, terminalsEnabled: true });
    expect(body.persistedSettings).toMatchObject({ enabled: false, terminalsEnabled: true });
    expect(body.sources).toEqual({
      enabled: "settings",
      terminalsEnabled: "settings",
      instanceName: "settings",
    });
  }, 30_000);

  it("honors env overlays in handshake/GET and rejects controlled PUTs with 409", async () => {
    const { baseUrl } = await startCollaborationServer({
      remoteProjectsEnv: {
        enabled: true,
        terminalsEnabled: false,
        instanceName: "Env Handshake",
      },
    });
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    const status = await fetch(`${baseUrl}/api/collaboration/status`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    expect(status.instanceName).toBe("Env Handshake");
    expect(status.capabilities).toEqual({ collab: true, remoteBuild: true, createDirectory: true });

    const getResponse = await fetch(`${baseUrl}/api/settings/remote-build`, {
      headers: { cookie: adminCookie },
    });
    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json() as {
      settings: { enabled: boolean; terminalsEnabled: boolean; instanceName: string | null };
      persistedSettings: { enabled: boolean; terminalsEnabled: boolean; instanceName: string | null };
      sources: Record<string, string>;
    };
    expect(getBody.settings).toMatchObject({
      enabled: true,
      terminalsEnabled: false,
      instanceName: "Env Handshake",
    });
    expect(getBody.persistedSettings).toMatchObject({
      enabled: false,
      terminalsEnabled: true,
      instanceName: null,
    });
    expect(getBody.sources).toEqual({
      enabled: "environment",
      terminalsEnabled: "environment",
      instanceName: "environment",
    });

    const controlledPut = await fetch(`${baseUrl}/api/settings/remote-build`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ enabled: false, terminalsEnabled: true }),
    });
    expect(controlledPut.status).toBe(409);
    const conflict = await controlledPut.json() as {
      code: string;
      controlledFields: string[];
    };
    expect(conflict.code).toBe("REMOTE_BUILD_SETTINGS_ENV_OVERRIDE");
    expect(conflict.controlledFields).toEqual(["enabled", "terminalsEnabled"]);

    // After rejected write, persisted layer is unchanged.
    const afterConflict = await fetch(`${baseUrl}/api/settings/remote-build`, {
      headers: { cookie: adminCookie },
    }).then((response) => response.json() as Promise<typeof getBody>);
    expect(afterConflict.persistedSettings).toMatchObject({
      enabled: false,
      terminalsEnabled: true,
      instanceName: null,
    });
  }, 30_000);

  it("allows uncontrolled PUT while env overlays remain effective", async () => {
    const { baseUrl } = await startCollaborationServer({
      remoteProjectsEnv: { enabled: true },
    });
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    const putResponse = await fetch(`${baseUrl}/api/settings/remote-build`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ terminalsEnabled: false, instanceName: "Persisted Label" }),
    });
    expect(putResponse.status).toBe(200);
    const body = await putResponse.json() as {
      ok: true;
      settings: { enabled: boolean; terminalsEnabled: boolean; instanceName: string | null };
      persistedSettings: { enabled: boolean; terminalsEnabled: boolean; instanceName: string | null };
      sources: Record<string, string>;
    };
    expect(body.ok).toBe(true);
    expect(body.settings).toMatchObject({
      enabled: true,
      terminalsEnabled: false,
      instanceName: "Persisted Label",
    });
    expect(body.persistedSettings).toMatchObject({
      enabled: false,
      terminalsEnabled: false,
      instanceName: "Persisted Label",
    });
    expect(body.sources.enabled).toBe("environment");
    expect(body.sources.terminalsEnabled).toBe("settings");
  }, 30_000);

  it("grants member builder access when env enabled is true", async () => {
    const { baseUrl } = await startCollaborationServer({
      remoteProjectsEnv: { enabled: true },
    });
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);
    const member = await openAuthenticatedWs(baseUrl, memberCookie);
    member.send({ type: "subscribe" });
    const snapshot = await member.waitForEvent("agents_snapshot");
    expect(Array.isArray(snapshot.agents)).toBe(true);
  }, 30_000);

  it("denies member builder access when env enabled is false", async () => {
    const { baseUrl } = await startCollaborationServer({
      remoteProjectsEnv: { enabled: false },
    });
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);
    const member = await openAuthenticatedWs(baseUrl, memberCookie);
    await expectCommandDenied(member, { type: "subscribe" }, "Remote projects are disabled");
  }, 30_000);

  it("denies member terminal mutations/tickets when env terminalsEnabled is false", async () => {
    const { baseUrl } = await startCollaborationServer({
      remoteProjectsEnv: {
        enabled: true,
        terminalsEnabled: false,
      },
    });
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);

    const createTerminal = await fetch(`${baseUrl}/api/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ sessionAgentId: "any", cwd: "/tmp" }),
    });
    expect(createTerminal.status).toBe(403);

    const ticket = await fetch(`${baseUrl}/api/terminals/term-1/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({}),
    });
    expect(ticket.status).toBe(403);

    // Contrast: with terminals enabled via settings only, the same member
    // mutation path is member-class (auth passes; missing TerminalService may
    // still yield a non-auth error). Keep this assertion focused on env-disable.
    const resize = await fetch(`${baseUrl}/api/terminals/term-1/resize`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(resize.status).toBe(403);
  }, 30_000);
});

describe("project presence (R3)", () => {
  it("flips viewer snapshots as members subscribe and disconnect", async () => {
    const { baseUrl } = await startCollaborationServer();
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);
    await setRemoteBuildEnabled(baseUrl, adminCookie, true);

    const adminUser = await fetchCurrentUser(baseUrl, adminCookie);
    const memberUser = await fetchCurrentUser(baseUrl, memberCookie);

    const admin = await openAuthenticatedWs(baseUrl, adminCookie);
    admin.send({ type: "subscribe" });
    const readyPresence = await admin.waitForEvent("project_presence");
    const sessionAgentId = readyPresence.sessionAgentId;
    expect(readyPresence.viewers.map((viewer) => viewer.userId)).toEqual([adminUser.userId]);

    const member = await openAuthenticatedWs(baseUrl, memberCookie);
    member.send({ type: "subscribe", agentId: sessionAgentId });
    const joined = await admin.waitForEvent(
      "project_presence",
      (event) => event.sessionAgentId === sessionAgentId && event.viewers.length === 2,
    );
    const joinedIds = joined.viewers.map((viewer) => viewer.userId).sort();
    expect(joinedIds).toEqual([adminUser.userId, memberUser.userId].sort());
    expect(joined.viewers.find((viewer) => viewer.userId === memberUser.userId)?.role).toBe("member");

    // The member also learns who is here on subscribe.
    const memberView = await member.waitForEvent(
      "project_presence",
      (event) => event.sessionAgentId === sessionAgentId && event.viewers.length === 2,
    );
    expect(memberView.viewers).toHaveLength(2);

    // Disconnect flips presence for the remaining viewer.
    member.socket.close();
    const departed = await admin.waitForEvent(
      "project_presence",
      (event) =>
        event.sessionAgentId === sessionAgentId &&
        event.viewers.length === 1 &&
        event.viewers[0]?.userId === adminUser.userId,
      10_000,
    );
    expect(departed.viewers.map((viewer) => viewer.userId)).toEqual([adminUser.userId]);
  }, 30_000);
});

describe("remote build WS access matrix", () => {
  it("denies members all builder commands while the kill switch is off", async () => {
    const { baseUrl } = await startCollaborationServer();
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);

    const member = await openAuthenticatedWs(baseUrl, memberCookie);
    await expectCommandDenied(member, { type: "subscribe" }, "Remote projects are disabled");
    await expectCommandDenied(member, { type: "user_message", text: "hello" }, "Remote projects are disabled");
    await expectCommandDenied(
      member,
      { type: "create_directory", parentPath: "/tmp", name: "nope" },
      "Remote projects are disabled",
    );

    // The collaboration surface is unaffected by the kill switch.
    member.send({ type: "collab_bootstrap" });
    const bootstrap = await member.waitForEvent("collab_bootstrap");
    expect(bootstrap.currentUser.email).toBe(MEMBER_EMAIL);
  }, 30_000);

  it("grants members reads and project writes; admin-tier commands stay denied (R2)", async () => {
    const { baseUrl, defaultCwd } = await startCollaborationServer();
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);
    await setRemoteBuildEnabled(baseUrl, adminCookie, true);

    const member = await openAuthenticatedWs(baseUrl, memberCookie);

    // Read path: subscribe succeeds and the builder bootstrap arrives.
    member.send({ type: "subscribe" });
    const snapshot = await member.waitForEvent("agents_snapshot");
    expect(Array.isArray(snapshot.agents)).toBe(true);

    // R2: mutating commands pass the access gate for members. Targeting an
    // unknown agent proves the command reached the handler (UNKNOWN_AGENT)
    // instead of being rejected by the gate.
    const gateDenied = harnessCollectDenials(member);
    member.send({ type: "user_message", text: "hello", agentId: "no-such-agent" });
    const unknownAgent = await member.waitForEvent(
      "error",
      (event) => event.code === "UNKNOWN_AGENT",
    );
    expect(unknownAgent.code).toBe("UNKNOWN_AGENT");
    expect(gateDenied()).toEqual([]);

    // Admin-tier commands are denied for members in every phase.
    await expectCommandDenied(member, { type: "pick_directory" }, "admin");
    await expectCommandDenied(member, { type: "resume_restart_recovery" }, "admin");

    // create_directory is write-tier: members reach the handler when remoteBuild is on
    // (not gate-denied). Success vs path/policy error is orthogonal to access.
    const createDenied = harnessCollectDenials(member);
    member.send({
      type: "create_directory",
      parentPath: defaultCwd,
      name: "member-folder",
      requestId: "mkdir-1",
    });
    const createdOrFailed = await Promise.race([
      member.waitForEvent("directory_created", (event) => event.requestId === "mkdir-1"),
      member.waitForEvent("error", (event) => event.requestId === "mkdir-1"),
    ]);
    expect(createDenied()).toEqual([]);
    expect(createdOrFailed.type === "directory_created" || createdOrFailed.type === "error").toBe(true);
    if (createdOrFailed.type === "error") {
      expect(createdOrFailed.code).not.toMatch(/builder_access|FORBIDDEN|tier/i);
      expect(createdOrFailed.message ?? "").not.toMatch(/Remote projects are disabled|requires admin/i);
    }
  }, 30_000);

  it("broadcasts attributed, clientRequestId-echoed messages to both clients without dupes (R2 fixture)", async () => {
    const { baseUrl, defaultCwd } = await startCollaborationServer();
    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const memberCookie = await createMember(baseUrl, adminCookie);
    await setRemoteBuildEnabled(baseUrl, adminCookie, true);

    const memberUser = await fetchCurrentUser(baseUrl, memberCookie);
    const adminUser = await fetchCurrentUser(baseUrl, adminCookie);

    const admin = await openAuthenticatedWs(baseUrl, adminCookie);
    const member = await openAuthenticatedWs(baseUrl, memberCookie);

    admin.send({ type: "subscribe" });
    await admin.waitForEvent("agents_snapshot");

    // A fresh collaboration server has no plain projects; create one over the
    // remote socket (the R2 remote create-project path).
    admin.send({ type: "create_manager", name: "Fixture Project", cwd: defaultCwd, requestId: "create-1" });
    const created = await admin.waitForEvent("manager_created", (event) => event.requestId === "create-1");
    const targetAgentId = created.manager.agentId;
    expect(targetAgentId).toBeTruthy();
    admin.send({ type: "subscribe", agentId: targetAgentId });
    await admin.waitForEvent("conversation_history", (event) => event.agentId === targetAgentId);

    member.send({ type: "subscribe", agentId: targetAgentId });
    await member.waitForEvent("agents_snapshot");

    // Interleaved sends from two authenticated clients.
    member.send({
      type: "user_message",
      agentId: targetAgentId,
      text: "hello from the member",
      clientRequestId: "member-req-1",
    });
    const memberEchoAtMember = await member.waitForEvent(
      "conversation_message",
      (event) => event.clientRequestId === "member-req-1",
    );
    const memberEchoAtAdmin = await admin.waitForEvent(
      "conversation_message",
      (event) => event.clientRequestId === "member-req-1",
    );

    expect(memberEchoAtMember.collaborationAuthor).toMatchObject({
      userId: memberUser.userId,
      displayName: memberUser.name,
      role: "member",
    });
    expect(memberEchoAtAdmin.collaborationAuthor?.userId).toBe(memberUser.userId);
    expect(memberEchoAtMember.text).toBe("hello from the member");

    admin.send({
      type: "user_message",
      agentId: targetAgentId,
      text: "hello from the admin",
      clientRequestId: "admin-req-1",
    });
    const adminEchoAtMember = await member.waitForEvent(
      "conversation_message",
      (event) => event.clientRequestId === "admin-req-1",
    );
    expect(adminEchoAtMember.collaborationAuthor).toMatchObject({
      userId: adminUser.userId,
      role: "admin",
    });

    // No duplicates: each clientRequestId appears exactly once per client.
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const harness of [admin, member]) {
      const memberCopies = harness.events.filter(
        (event) => event.type === "conversation_message" && event.clientRequestId === "member-req-1",
      );
      const adminCopies = harness.events.filter(
        (event) => event.type === "conversation_message" && event.clientRequestId === "admin-req-1",
      );
      expect(memberCopies).toHaveLength(1);
      expect(adminCopies).toHaveLength(1);
    }

    // Bootstrap-replace path: a fresh client's history carries both messages
    // exactly once, attribution intact.
    const late = await openAuthenticatedWs(baseUrl, memberCookie);
    late.send({ type: "subscribe", agentId: targetAgentId });
    const history = await late.waitForEvent("conversation_history");
    const fromMember = history.messages.filter((message) => message.clientRequestId === "member-req-1");
    const fromAdmin = history.messages.filter((message) => message.clientRequestId === "admin-req-1");
    expect(fromMember).toHaveLength(1);
    expect(fromAdmin).toHaveLength(1);
    expect(fromMember[0]?.collaborationAuthor?.userId).toBe(memberUser.userId);
    expect(fromAdmin[0]?.collaborationAuthor?.userId).toBe(adminUser.userId);
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
