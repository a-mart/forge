import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CollaborationBootstrapEvent,
  CollaborationChannelActivityUpdatedEvent,
  CollaborationChannelMessageEvent,
  CollaborationReadStateUpdatedEvent,
  CollaborationServerEvent,
} from "@forge/protocol";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { clearCollaborationBetterAuthService } from "../collaboration/auth/better-auth-service.js";
import { closeCollaborationAuthDb } from "../collaboration/auth/collaboration-db.js";
import { startServer, type StartedServer } from "../server.js";
import { createTempConfig, type TempConfigHandle } from "../test-support/temp-config.js";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "super-secret-password";
const SILENT_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const tempConfigHandles: TempConfigHandle[] = [];
const activeSockets: WebSocket[] = [];
let activeServer: StartedServer | null = null;

class WsEventHarness {
  readonly events: CollaborationServerEvent[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      this.events.push(JSON.parse(raw.toString("utf8")) as CollaborationServerEvent);
    });
  }

  async waitForEvent<T extends CollaborationServerEvent["type"]>(
    type: T,
    predicate?: (event: Extract<CollaborationServerEvent, { type: T }>) => boolean,
    timeoutMs = 5_000,
  ): Promise<Extract<CollaborationServerEvent, { type: T }>> {
    const existing = this.events.find(
      (event): event is Extract<CollaborationServerEvent, { type: T }> =>
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
        const event = JSON.parse(raw.toString("utf8")) as CollaborationServerEvent;
        if (event.type !== type) {
          return;
        }
        if (predicate && !predicate(event as Extract<CollaborationServerEvent, { type: T }>)) {
          return;
        }

        cleanup();
        resolve(event as Extract<CollaborationServerEvent, { type: T }>);
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

async function login(baseUrl: string): Promise<string> {
  const loginResponse = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
    },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  expect(loginResponse.ok).toBe(true);
  return setCookieHeadersToCookieHeader(readSetCookieHeaders(loginResponse));
}

async function createChannel(baseUrl: string, cookie: string): Promise<{ channelId: string; name: string }> {
  const response = await fetch(`${baseUrl}/api/collaboration/channels`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ name: "Ops", aiEnabled: false }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { ok: true; channel: { channelId: string; name: string } };
  expect(body.ok).toBe(true);
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

describe("collaboration websocket protocol", () => {
  it("rejects websocket upgrades without an authenticated collaboration cookie session", async () => {
    const { baseUrl } = await startCollaborationServer();
    await expect(expectUnexpectedResponseStatus(baseUrl, { origin: baseUrl })).resolves.toBe(401);
  });

  it("supports authenticated collab bootstrap, subscribe, user message, and mark-read flows", async () => {
    const { baseUrl } = await startCollaborationServer();
    const cookie = await login(baseUrl);
    const channel = await createChannel(baseUrl, cookie);
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
