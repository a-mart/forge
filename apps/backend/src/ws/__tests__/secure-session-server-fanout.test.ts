import { once } from "node:events";
import type { ServerEvent } from "@forge/protocol";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { getAvailablePort } from "../../test-support/index.js";
import {
  WsServerTestSwarmManager,
  bootWsServerTestManager,
  makeWsServerTempConfig,
} from "../../test-support/ws-integration-harness.js";
import { SwarmWebSocketServer } from "../server.js";

describe("secure session server transport", () => {
  it("registers private routes and fans snapshots only to the exact session", async () => {
    const port = await getAvailablePort();
    const config = await makeWsServerTempConfig(port, true);
    const manager = new WsServerTestSwarmManager(config);
    await bootWsServerTestManager(manager, config);
    const { sessionAgent: otherSession } = await manager.createSession("manager", {
      label: "Other",
    });
    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    });

    expect(server.listRegisteredHttpRoutes().some((route) =>
      route.matches("/api/secure-secrets/providers")
    )).toBe(true);
    expect(server.listRegisteredHttpRoutes().some((route) =>
      route.matches("/api/secure-sessions/manager")
    )).toBe(true);

    await server.start();
    const hostileHttpResponse = await fetch(
      `http://${config.host}:${config.port}/api/secure-secrets/providers`,
      { headers: { Origin: "https://evil.example" } },
    );
    expect(hostileHttpResponse.status).toBe(403);

    const unauthorizedDefaultMutation = await fetch(
      `http://${config.host}:${config.port}/api/secure-secrets/project-defaults/manager/secret-1`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(unauthorizedDefaultMutation.status).toBe(403);
    expect(await unauthorizedDefaultMutation.json()).toEqual({
      code: "SECURE_PRIVATE_API_UNAVAILABLE",
      error: "SECURE_PRIVATE_API_UNAVAILABLE",
    });

    const hostileWebSocketStatus = await rejectedWebSocketStatus(
      `ws://${config.host}:${config.port}`,
      "https://evil.example",
    );
    expect(hostileWebSocketStatus).toBe(403);

    const managerClient = new WebSocket(`ws://${config.host}:${config.port}`);
    const otherClient = new WebSocket(`ws://${config.host}:${config.port}`);
    const managerEvents: ServerEvent[] = [];
    const otherEvents: ServerEvent[] = [];
    managerClient.on("message", (raw) => {
      managerEvents.push(JSON.parse(raw.toString()) as ServerEvent);
    });
    otherClient.on("message", (raw) => {
      otherEvents.push(JSON.parse(raw.toString()) as ServerEvent);
    });

    try {
      await Promise.all([once(managerClient, "open"), once(otherClient, "open")]);
      managerClient.send(JSON.stringify({
        type: "subscribe",
        agentId: "manager",
      }));
      otherClient.send(JSON.stringify({
        type: "subscribe",
        agentId: otherSession.agentId,
      }));
      await Promise.all([
        waitForEvent(managerEvents, (event) =>
          event.type === "ready" && event.subscribedAgentId === "manager"
        ),
        waitForEvent(otherEvents, (event) =>
          event.type === "ready"
          && event.subscribedAgentId === otherSession.agentId
        ),
      ]);
      managerEvents.length = 0;
      otherEvents.length = 0;

      manager.emit("secure_session_snapshot", {
        type: "secure_session_snapshot",
        sessionAgentId: "manager",
        profileId: "manager",
        revision: 2,
        executionMode: "secure",
        environmentStatus: "ready",
        leases: [{
          leaseId: "lease-1",
          secretId: "secret-1",
          displayAlias: "DEPLOY_TOKEN",
          leaseKind: "task",
          exposures: [{
            deliveryKind: "environment",
            targetName: "DEPLOY_TOKEN",
          }],
          status: "active",
          expiresAt: null,
          lastUsedAt: null,
          remainingUses: null,
          grantSource: "project_default",
        }],
        pendingRequests: [],
        projectDefaults: [{
          secretId: "secret-1",
          displayAlias: "DEPLOY_TOKEN",
          state: "active",
          statusCode: "ok",
        }],
        updatedAt: "2026-07-23T00:00:00.000Z",
      } satisfies Extract<ServerEvent, { type: "secure_session_snapshot" }>);
      await waitForEvent(managerEvents, (event) =>
        event.type === "secure_session_snapshot" && event.revision === 2
      );
      expect(managerEvents).toContainEqual(expect.objectContaining({
        type: "secure_session_snapshot",
        leases: [expect.objectContaining({
          leaseId: "lease-1",
          grantSource: "project_default",
        })],
        projectDefaults: [{
          secretId: "secret-1",
          displayAlias: "DEPLOY_TOKEN",
          state: "active",
          statusCode: "ok",
        }],
      }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(otherEvents.some((event) =>
        event.type === "secure_session_snapshot"
        && event.sessionAgentId === "manager"
        && event.revision === 2
      )).toBe(false);

      manager.emit("secure_secret_catalog_changed", {
        type: "secure_secret_catalog_changed",
        revision: 9,
      } satisfies Extract<ServerEvent, {
        type: "secure_secret_catalog_changed";
      }>);
      await Promise.all([
        waitForEvent(managerEvents, (event) =>
          event.type === "secure_secret_catalog_changed" && event.revision === 9
        ),
        waitForEvent(otherEvents, (event) =>
          event.type === "secure_secret_catalog_changed" && event.revision === 9
        ),
      ]);
    } finally {
      for (const client of [managerClient, otherClient]) {
        if (client.readyState === WebSocket.OPEN) {
          client.close();
          await once(client, "close");
        }
      }
      await server.stop();
    }
  });
});

async function rejectedWebSocketStatus(url: string, origin: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const client = new WebSocket(url, { headers: { Origin: origin } });
    const timeout = setTimeout(() => {
      client.terminate();
      reject(new Error("Timed out waiting for rejected websocket upgrade"));
    }, 2_000);
    client.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    client.once("open", () => {
      clearTimeout(timeout);
      client.terminate();
      reject(new Error("Hostile websocket origin was accepted"));
    });
    client.once("error", () => {
      // `unexpected-response` carries the authoritative HTTP status.
    });
  });
}

async function waitForEvent(
  events: ServerEvent[],
  predicate: (event: ServerEvent) => boolean,
  timeoutMs = 2_000,
): Promise<ServerEvent> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const event = events.find(predicate);
    if (event) {
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for websocket event");
}
