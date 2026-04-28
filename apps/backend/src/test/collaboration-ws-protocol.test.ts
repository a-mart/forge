import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CollaborationBootstrapEvent,
  CollaborationChannelActivityUpdatedEvent,
  CollaborationChannelMessageEvent,
  CollaborationReadStateUpdatedEvent,
  ServerEvent,
} from "@forge/protocol";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { clearCollaborationBetterAuthService } from "../collaboration/auth/better-auth-service.js";
import { closeCollaborationAuthDb } from "../collaboration/auth/collaboration-db.js";
import { startServer, type StartedServer } from "../server.js";
import { createTempConfig, type TempConfigHandle } from "../test-support/temp-config.js";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "super-secret-password";
const MEMBER_EMAIL = "member@example.com";
const MEMBER_PASSWORD = "member-password-123";
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
    socket.on("message", (raw) => {
      this.events.push(JSON.parse(raw.toString("utf8")) as ServerEvent);
    });
  }

  async waitForEvent<T extends ServerEvent["type"]>(
    type: T,
    predicate?: (event: Extract<ServerEvent, { type: T }>) => boolean,
    timeoutMs = 5_000,
  ): Promise<Extract<ServerEvent, { type: T }>> {
    const existing = this.events.find(
      (event): event is Extract<ServerEvent, { type: T }> =>
        event.type === type && (predicate ? predicate(event) : true),
    );
    if (existing) {
      return existing;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for WS event ${type}`));
      }, timeoutMs);

      const onMessage = (raw: RawData) => {
        const event = JSON.parse(raw.toString("utf8")) as ServerEvent;
        if (event.type !== type) {
          return;
        }
        if (predicate && !predicate(event as Extract<ServerEvent, { type: T }>)) {
          return;
        }

        cleanup();
        resolve(event as Extract<ServerEvent, { type: T }>);
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

async function startCollaborationServer(): Promise<{
  server: StartedServer;
  config: TempConfigHandle["config"];
  baseUrl: string;
}> {
  const tempRootDir = await mkdtemp(join(tmpdir(), "forge-collaboration-ws-protocol-"));
  const tempConfigHandle = await createTempConfig({
    runtimeTarget: "collaboration-server",
    tempRootDir,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
  });
  tempConfigHandle.config.collaborationBaseUrl = `http://${tempConfigHandle.config.host}:${tempConfigHandle.config.port}`;
  tempConfigHandles.push(tempConfigHandle);

  const server = await startServer({
    config: tempConfigHandle.config,
    logger: SILENT_LOGGER,
  });
  activeServer = server;

  return {
    server,
    config: tempConfigHandle.config,
    baseUrl: `http://${server.host}:${server.port}`,
  };
}

async function login(baseUrl: string, email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> {
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

async function createInvitedUser(
  baseUrl: string,
  adminCookie: string,
  user: { email: string; name: string; password: string },
): Promise<string> {
  const inviteResponse = await fetch(`${baseUrl}/api/collaboration/invites`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: adminCookie,
    },
    body: JSON.stringify({ email: user.email, expiresInDays: 14 }),
  });
  expect(inviteResponse.status).toBe(200);
  const inviteBody = await inviteResponse.json() as {
    ok: true;
    invite: { inviteUrl: string };
  };
  const inviteToken = inviteBody.invite.inviteUrl.split("/").at(-1);
  expect(inviteToken).toBeTruthy();

  const redeemResponse = await fetch(`${baseUrl}/api/collaboration/invites/${inviteToken}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(user),
  });
  expect(redeemResponse.status).toBe(200);

  return login(baseUrl, user.email, user.password);
}

async function createMember(baseUrl: string, adminCookie: string): Promise<string> {
  return createInvitedUser(baseUrl, adminCookie, {
    email: MEMBER_EMAIL,
    name: "Member",
    password: MEMBER_PASSWORD,
  });
}

async function getCurrentCollaborationUser(
  baseUrl: string,
  cookie: string,
): Promise<{ userId: string; email: string; name: string; role: string }> {
  const response = await fetch(`${baseUrl}/api/collaboration/me`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as {
    authenticated: boolean;
    user?: { userId: string; email: string; name: string; role: string };
  };
  expect(body.authenticated).toBe(true);
  expect(body.user).toBeTruthy();
  return body.user!;
}

async function createCategory(baseUrl: string, cookie: string, name: string): Promise<{ categoryId: string; workspaceId: string; name: string }> {
  const response = await fetch(`${baseUrl}/api/collaboration/categories`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as {
    ok: true;
    category: { categoryId: string; workspaceId: string; name: string };
  };
  expect(body.ok).toBe(true);
  return body.category;
}

async function createChannel(
  baseUrl: string,
  cookie: string,
  body: { name: string; categoryId?: string; description?: string; aiEnabled?: boolean },
): Promise<{ channelId: string; workspaceId: string; name: string }> {
  const response = await fetch(`${baseUrl}/api/collaboration/channels`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const payload = await response.json() as {
    ok: true;
    channel: { channelId: string; workspaceId: string; name: string };
  };
  expect(payload.ok).toBe(true);
  return payload.channel;
}

async function getChannel(
  baseUrl: string,
  cookie: string,
  channelId: string,
): Promise<{ channelId: string; archived: boolean; lastMessageSeq: number; lastMessageId?: string }> {
  const response = await fetch(`${baseUrl}/api/collaboration/channels/${encodeURIComponent(channelId)}`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as {
    channel: { channelId: string; archived: boolean; lastMessageSeq: number; lastMessageId?: string };
  };
  return body.channel;
}

async function expectUnexpectedResponseStatus(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<number> {
  const wsUrl = baseUrl.replace(/^http/, "ws");
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(wsUrl, { headers });
    activeSockets.push(socket);
    socket.once("unexpected-response", (_req, response) => {
      settled = true;
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Expected unexpected-response, but socket opened"));
      }
    });
    socket.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
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

async function waitForSocketClose(
  socket: WebSocket,
  timeoutMs = 5_000,
): Promise<{ code: number; reason: string }> {
  if (socket.readyState === WebSocket.CLOSED) {
    return { code: 1005, reason: "" };
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket close"));
    }, timeoutMs);

    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString("utf8") });
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function expectNoSocketEvent<T extends ServerEvent["type"]>(
  harness: WsEventHarness,
  type: T,
  predicate?: (event: Extract<ServerEvent, { type: T }>) => boolean,
  windowMs = 250,
): Promise<void> {
  const matchingEvents = harness.events.filter(
    (event): event is Extract<ServerEvent, { type: T }> =>
      event.type === type && (predicate ? predicate(event) : true),
  );
  expect(matchingEvents).toEqual([]);

  await new Promise((resolve) => setTimeout(resolve, windowMs));

  const matchingEventsAfterWait = harness.events.filter(
    (event): event is Extract<ServerEvent, { type: T }> =>
      event.type === type && (predicate ? predicate(event) : true),
  );
  expect(matchingEventsAfterWait).toEqual([]);
}

describe("collaboration websocket protocol", () => {
  it("rejects websocket upgrades without an authenticated collaboration cookie session", async () => {
    const { baseUrl } = await startCollaborationServer();
    await expect(expectUnexpectedResponseStatus(baseUrl, { origin: baseUrl })).resolves.toBe(401);
  });

  it("disconnects sibling collaboration sockets after self password change while preserving the current session", async () => {
    const { baseUrl } = await startCollaborationServer();
    const currentCookie = await login(baseUrl);
    const siblingCookie = await login(baseUrl);
    const currentWs = await openAuthenticatedWs(baseUrl, currentCookie);
    const siblingWs = await openAuthenticatedWs(baseUrl, siblingCookie);

    const response = await fetch(`${baseUrl}/api/collaboration/me/password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: currentCookie,
      },
      body: JSON.stringify({
        currentPassword: ADMIN_PASSWORD,
        newPassword: "rotated-admin-password-123",
      }),
    });
    expect(response.status).toBe(200);

    await expect(waitForSocketClose(siblingWs.socket)).resolves.toEqual({
      code: 4001,
      reason: "collaboration_session_invalidated",
    });

    currentWs.socket.send(JSON.stringify({ type: "collab_bootstrap" }));
    const bootstrap = await currentWs.waitForEvent("collab_bootstrap");
    expect(bootstrap.currentUser.email).toBe(ADMIN_EMAIL);

    await expect(expectUnexpectedResponseStatus(baseUrl, {
      origin: baseUrl,
      cookie: siblingCookie,
    })).resolves.toBe(401);
  });

  it("disconnects collaboration sockets when admin auth mutations invalidate their session state", async () => {
    const { baseUrl } = await startCollaborationServer();
    const adminCookie = await login(baseUrl);

    const roleCookie = await createInvitedUser(baseUrl, adminCookie, {
      email: "role-member@example.com",
      name: "Role Member",
      password: "role-member-password-123",
    });
    const resetCookie = await createInvitedUser(baseUrl, adminCookie, {
      email: "reset-member@example.com",
      name: "Reset Member",
      password: "reset-member-password-123",
    });
    const disableCookie = await createInvitedUser(baseUrl, adminCookie, {
      email: "disable-member@example.com",
      name: "Disable Member",
      password: "disable-member-password-123",
    });
    const deleteCookie = await createInvitedUser(baseUrl, adminCookie, {
      email: "delete-member@example.com",
      name: "Delete Member",
      password: "delete-member-password-123",
    });

    const roleUser = await getCurrentCollaborationUser(baseUrl, roleCookie);
    const resetUser = await getCurrentCollaborationUser(baseUrl, resetCookie);
    const disableUser = await getCurrentCollaborationUser(baseUrl, disableCookie);
    const deleteUser = await getCurrentCollaborationUser(baseUrl, deleteCookie);

    const roleWs = await openAuthenticatedWs(baseUrl, roleCookie);
    const resetWs = await openAuthenticatedWs(baseUrl, resetCookie);
    const disableWs = await openAuthenticatedWs(baseUrl, disableCookie);
    const deleteWs = await openAuthenticatedWs(baseUrl, deleteCookie);

    const roleResponse = await fetch(`${baseUrl}/api/collaboration/users/${encodeURIComponent(roleUser.userId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: adminCookie,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(roleResponse.status).toBe(200);
    await expect(waitForSocketClose(roleWs.socket)).resolves.toEqual({
      code: 4001,
      reason: "collaboration_session_invalidated",
    });

    const reopenedRoleWs = await openAuthenticatedWs(baseUrl, roleCookie);
    reopenedRoleWs.socket.send(JSON.stringify({ type: "collab_bootstrap" }));
    const roleBootstrap = await reopenedRoleWs.waitForEvent("collab_bootstrap");
    expect(roleBootstrap.currentUser.role).toBe("admin");

    const passwordResetResponse = await fetch(
      `${baseUrl}/api/collaboration/users/${encodeURIComponent(resetUser.userId)}/password-reset`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
        },
        body: JSON.stringify({ temporaryPassword: "temporary-reset-password-123" }),
      },
    );
    expect(passwordResetResponse.status).toBe(200);
    await expect(waitForSocketClose(resetWs.socket)).resolves.toEqual({
      code: 4001,
      reason: "collaboration_session_invalidated",
    });

    const disableResponse = await fetch(
      `${baseUrl}/api/collaboration/users/${encodeURIComponent(disableUser.userId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
        },
        body: JSON.stringify({ disabled: true }),
      },
    );
    expect(disableResponse.status).toBe(200);
    await expect(waitForSocketClose(disableWs.socket)).resolves.toEqual({
      code: 4001,
      reason: "collaboration_session_invalidated",
    });

    const deleteResponse = await fetch(
      `${baseUrl}/api/collaboration/users/${encodeURIComponent(deleteUser.userId)}`,
      {
        method: "DELETE",
        headers: { cookie: adminCookie },
      },
    );
    expect(deleteResponse.status).toBe(200);
    await expect(waitForSocketClose(deleteWs.socket)).resolves.toEqual({
      code: 4001,
      reason: "collaboration_session_invalidated",
    });
  });

  it("rejects archived channel messages before persistence or broadcast", async () => {
    const { baseUrl } = await startCollaborationServer();
    const cookie = await login(baseUrl);
    const channel = await createChannel(baseUrl, cookie, { name: "Archived Ops", aiEnabled: false });
    const ws = await openAuthenticatedWs(baseUrl, cookie);

    ws.socket.send(JSON.stringify({ type: "collab_subscribe_channel", channelId: channel.channelId }));
    await ws.waitForEvent("collab_channel_ready", (event) => event.channel.channelId === channel.channelId);
    await ws.waitForEvent("collab_channel_history", (event) => event.channelId === channel.channelId);

    const archiveResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(channel.channelId)}/archive`,
      {
        method: "POST",
        headers: { cookie },
      },
    );
    expect(archiveResponse.status).toBe(200);
    await ws.waitForEvent(
      "collab_channel_archived",
      (event) => event.channelId === channel.channelId && event.workspaceId === channel.workspaceId,
    );

    ws.socket.send(JSON.stringify({
      type: "collab_user_message",
      channelId: channel.channelId,
      content: "This should never persist",
    }));

    const archivedError = await ws.waitForEvent(
      "error",
      (event) =>
        event.code === "COLLAB_USER_MESSAGE_FAILED" &&
        event.message === `Cannot send messages to archived collaboration channel ${channel.channelId}`,
    );
    expect(archivedError.code).toBe("COLLAB_USER_MESSAGE_FAILED");

    await expectNoSocketEvent(
      ws,
      "collab_channel_message",
      (event) => event.channelId === channel.channelId && event.message.text === "This should never persist",
    );

    const persistedChannel = await getChannel(baseUrl, cookie, channel.channelId);
    expect(persistedChannel).toMatchObject({
      channelId: channel.channelId,
      archived: true,
      lastMessageSeq: 0,
    });
    expect(persistedChannel.lastMessageId).toBeUndefined();
  });

  it("supports authenticated collab bootstrap, subscribe, user message, and mark-read flows", async () => {
    const { baseUrl } = await startCollaborationServer();
    const cookie = await login(baseUrl);
    const channel = await createChannel(baseUrl, cookie, { name: "Ops", aiEnabled: false });
    const ws = await openAuthenticatedWs(baseUrl, cookie);

    ws.socket.send(JSON.stringify({ type: "collab_bootstrap" }));
    const bootstrap = await ws.waitForEvent("collab_bootstrap") as CollaborationBootstrapEvent;
    expect(bootstrap.currentUser.email).toBe(ADMIN_EMAIL);
    expect(bootstrap.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelId: channel.channelId, name: channel.name }),
      ]),
    );

    ws.socket.send(JSON.stringify({ type: "collab_subscribe_channel", channelId: channel.channelId }));
    const ready = await ws.waitForEvent("collab_channel_ready", (event) => event.channel.channelId === channel.channelId);
    expect(ready.channel.channelId).toBe(channel.channelId);
    const history = await ws.waitForEvent("collab_channel_history", (event) => event.channelId === channel.channelId);
    expect(history.messages).toEqual([]);
    const workers = await ws.waitForEvent(
      "collab_session_workers_snapshot",
      (event) => event.channelId === channel.channelId,
    );
    expect(Array.isArray(workers.workers)).toBe(true);

    ws.socket.send(JSON.stringify({
      type: "collab_user_message",
      channelId: channel.channelId,
      content: "Hello team",
    }));

    const messageEvent = await ws.waitForEvent(
      "collab_channel_message",
      (event) => event.channelId === channel.channelId && event.message.text === "Hello team",
    ) as CollaborationChannelMessageEvent;
    expect(messageEvent.message.collaborationAuthor).toEqual(
      expect.objectContaining({ channelId: channel.channelId, role: "admin" }),
    );

    const activityEvent = await ws.waitForEvent(
      "collab_channel_activity_updated",
      (event) => event.channelId === channel.channelId,
    ) as CollaborationChannelActivityUpdatedEvent;
    expect(activityEvent.lastMessageSeq).toBeGreaterThan(0);

    const ownReadEvent = await ws.waitForEvent(
      "collab_read_state_updated",
      (event) => event.channelId === channel.channelId && event.readState.unreadCount === 0,
    ) as CollaborationReadStateUpdatedEvent;
    expect(ownReadEvent.readState.lastReadMessageSeq).toBeGreaterThan(0);

    ws.socket.send(JSON.stringify({ type: "collab_mark_channel_read", channelId: channel.channelId }));
    const markedReadEvent = await ws.waitForEvent(
      "collab_read_state_updated",
      (event) =>
        event.channelId === channel.channelId &&
        event.readState.unreadCount === 0 &&
        event.readState.lastReadMessageSeq >= ownReadEvent.readState.lastReadMessageSeq,
    ) as CollaborationReadStateUpdatedEvent;
    expect(markedReadEvent.readState.unreadCount).toBe(0);
  });

  it("fans out HTTP channel/category mutations to authenticated websocket clients without leaking prompt overlays", async () => {
    const { baseUrl } = await startCollaborationServer();
    const adminCookie = await login(baseUrl);
    const memberCookie = await createMember(baseUrl, adminCookie);
    const adminWs = await openAuthenticatedWs(baseUrl, adminCookie);
    const memberWs = await openAuthenticatedWs(baseUrl, memberCookie);

    adminWs.socket.send(JSON.stringify({ type: "collab_bootstrap" }));
    memberWs.socket.send(JSON.stringify({ type: "collab_bootstrap" }));
    await Promise.all([
      adminWs.waitForEvent("collab_bootstrap"),
      memberWs.waitForEvent("collab_bootstrap"),
    ]);

    const categoryA = await createCategory(baseUrl, adminCookie, "Planning");
    const [adminCategoryCreated, memberCategoryCreated] = await Promise.all([
      adminWs.waitForEvent("collab_category_created", (event) => event.category.categoryId === categoryA.categoryId),
      memberWs.waitForEvent("collab_category_created", (event) => event.category.categoryId === categoryA.categoryId),
    ]);
    expect(adminCategoryCreated.category.name).toBe("Planning");
    expect(memberCategoryCreated.category.name).toBe("Planning");

    const categoryB = await createCategory(baseUrl, adminCookie, "Support");
    await Promise.all([
      adminWs.waitForEvent("collab_category_created", (event) => event.category.categoryId === categoryB.categoryId),
      memberWs.waitForEvent("collab_category_created", (event) => event.category.categoryId === categoryB.categoryId),
    ]);

    const updateCategoryResponse = await fetch(
      `${baseUrl}/api/collaboration/categories/${encodeURIComponent(categoryA.categoryId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
        },
        body: JSON.stringify({ name: "Planning Updated" }),
      },
    );
    expect(updateCategoryResponse.status).toBe(200);
    await Promise.all([
      adminWs.waitForEvent(
        "collab_category_updated",
        (event) => event.category.categoryId === categoryA.categoryId && event.category.name === "Planning Updated",
      ),
      memberWs.waitForEvent(
        "collab_category_updated",
        (event) => event.category.categoryId === categoryA.categoryId && event.category.name === "Planning Updated",
      ),
    ]);

    const reorderCategoriesResponse = await fetch(`${baseUrl}/api/collaboration/categories/reorder`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookie,
      },
      body: JSON.stringify({ categoryIds: [categoryB.categoryId, categoryA.categoryId] }),
    });
    expect(reorderCategoriesResponse.status).toBe(200);
    await Promise.all([
      adminWs.waitForEvent(
        "collab_category_reordered",
        (event) => event.categories.map((category) => category.categoryId).join(",") === `${categoryB.categoryId},${categoryA.categoryId}`,
      ),
      memberWs.waitForEvent(
        "collab_category_reordered",
        (event) => event.categories.map((category) => category.categoryId).join(",") === `${categoryB.categoryId},${categoryA.categoryId}`,
      ),
    ]);

    const channelA = await createChannel(baseUrl, adminCookie, {
      name: "General",
      categoryId: categoryA.categoryId,
      description: "Primary room",
    });
    await Promise.all([
      adminWs.waitForEvent("collab_channel_created", (event) => event.channel.channelId === channelA.channelId),
      memberWs.waitForEvent("collab_channel_created", (event) => event.channel.channelId === channelA.channelId),
    ]);

    const channelB = await createChannel(baseUrl, adminCookie, {
      name: "Escalations",
      categoryId: categoryA.categoryId,
    });
    await Promise.all([
      adminWs.waitForEvent("collab_channel_created", (event) => event.channel.channelId === channelB.channelId),
      memberWs.waitForEvent("collab_channel_created", (event) => event.channel.channelId === channelB.channelId),
    ]);

    const updateChannelResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(channelA.channelId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
        },
        body: JSON.stringify({
          description: "Updated room",
          promptOverlay: "Prefer concise answers.",
        }),
      },
    );
    expect(updateChannelResponse.status).toBe(200);
    const [adminChannelUpdated, memberChannelUpdated] = await Promise.all([
      adminWs.waitForEvent(
        "collab_channel_updated",
        (event) => event.channel.channelId === channelA.channelId && event.channel.description === "Updated room",
      ),
      memberWs.waitForEvent(
        "collab_channel_updated",
        (event) => event.channel.channelId === channelA.channelId && event.channel.description === "Updated room",
      ),
    ]);
    expect(adminChannelUpdated.channel).not.toHaveProperty("promptOverlay");
    expect(memberChannelUpdated.channel).not.toHaveProperty("promptOverlay");

    const reorderChannelsResponse = await fetch(`${baseUrl}/api/collaboration/channels/reorder`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookie,
      },
      body: JSON.stringify({ channelIds: [channelB.channelId, channelA.channelId] }),
    });
    expect(reorderChannelsResponse.status).toBe(200);
    await Promise.all([
      adminWs.waitForEvent(
        "collab_channel_reordered",
        (event) => event.channels.map((channel) => channel.channelId).join(",") === `${channelB.channelId},${channelA.channelId}`,
      ),
      memberWs.waitForEvent(
        "collab_channel_reordered",
        (event) => event.channels.map((channel) => channel.channelId).join(",") === `${channelB.channelId},${channelA.channelId}`,
      ),
    ]);

    const archiveChannelResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(channelA.channelId)}/archive`,
      {
        method: "POST",
        headers: { cookie: adminCookie },
      },
    );
    expect(archiveChannelResponse.status).toBe(200);
    await Promise.all([
      adminWs.waitForEvent(
        "collab_channel_archived",
        (event) => event.channelId === channelA.channelId && event.workspaceId === channelA.workspaceId,
      ),
      memberWs.waitForEvent(
        "collab_channel_archived",
        (event) => event.channelId === channelA.channelId && event.workspaceId === channelA.workspaceId,
      ),
    ]);

    const deleteCategoryResponse = await fetch(
      `${baseUrl}/api/collaboration/categories/${encodeURIComponent(categoryB.categoryId)}`,
      {
        method: "DELETE",
        headers: { cookie: adminCookie },
      },
    );
    expect(deleteCategoryResponse.status).toBe(200);
    await Promise.all([
      adminWs.waitForEvent(
        "collab_category_deleted",
        (event) => event.categoryId === categoryB.categoryId && event.workspaceId === categoryB.workspaceId,
      ),
      memberWs.waitForEvent(
        "collab_category_deleted",
        (event) => event.categoryId === categoryB.categoryId && event.workspaceId === categoryB.workspaceId,
      ),
    ]);
  });

  it("rejects member builder commands and covers collaboration choice/pin handlers", async () => {
    const { baseUrl } = await startCollaborationServer();
    const adminCookie = await login(baseUrl);
    const memberCookie = await createMember(baseUrl, adminCookie);
    const channel = await createChannel(baseUrl, adminCookie, { name: "Ops", aiEnabled: false });
    const adminWs = await openAuthenticatedWs(baseUrl, adminCookie);
    const memberWs = await openAuthenticatedWs(baseUrl, memberCookie);

    memberWs.socket.send(JSON.stringify({ type: "subscribe", agentId: "workspace" }));
    const memberGateError = await memberWs.waitForEvent(
      "error",
      (event) =>
        event.code === "COLLABORATION_COMMAND_NOT_ALLOWED" &&
        event.message === "Members may only use collab_* WebSocket commands.",
    );
    expect(memberGateError.code).toBe("COLLABORATION_COMMAND_NOT_ALLOWED");

    adminWs.socket.send(JSON.stringify({ type: "collab_subscribe_channel", channelId: channel.channelId }));
    await adminWs.waitForEvent("collab_channel_ready", (event) => event.channel.channelId === channel.channelId);

    adminWs.socket.send(JSON.stringify({
      type: "collab_choice_response",
      channelId: channel.channelId,
      choiceId: "choice-1",
      answers: "invalid",
    }));
    const malformedChoiceError = await adminWs.waitForEvent(
      "error",
      (event) =>
        event.code === "INVALID_COMMAND" &&
        event.message === "collab_choice_response.answers must be an array of valid ChoiceAnswer objects",
    );
    expect(malformedChoiceError.code).toBe("INVALID_COMMAND");

    adminWs.socket.send(JSON.stringify({
      type: "collab_pin_message",
      channelId: channel.channelId,
      messageId: "message-1",
      pinned: "yes",
    }));
    const malformedPinError = await adminWs.waitForEvent(
      "error",
      (event) =>
        event.code === "INVALID_COMMAND" &&
        event.message === "collab_pin_message.pinned must be a boolean",
    );
    expect(malformedPinError.code).toBe("INVALID_COMMAND");

    adminWs.socket.send(JSON.stringify({
      type: "collab_choice_response",
      channelId: channel.channelId,
      choiceId: "missing-choice",
      answers: [],
    }));
    const choiceNotPendingError = await adminWs.waitForEvent(
      "error",
      (event) => event.code === "CHOICE_NOT_PENDING" && event.message.includes("missing-choice"),
    );
    expect(choiceNotPendingError.code).toBe("CHOICE_NOT_PENDING");

    adminWs.socket.send(JSON.stringify({
      type: "collab_user_message",
      channelId: channel.channelId,
      content: "Pin this",
    }));
    const messageEvent = await adminWs.waitForEvent(
      "collab_channel_message",
      (event) => event.channelId === channel.channelId && event.message.text === "Pin this",
    ) as CollaborationChannelMessageEvent;
    expect(messageEvent.message.id).toBeTruthy();

    adminWs.socket.send(JSON.stringify({
      type: "collab_pin_message",
      channelId: channel.channelId,
      messageId: messageEvent.message.id,
      pinned: true,
    }));
    const pinnedEvent = await adminWs.waitForEvent(
      "collab_message_pinned",
      (event) => event.channelId === channel.channelId && event.messageId === messageEvent.message.id,
    );
    expect(pinnedEvent.pinned).toBe(true);
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
