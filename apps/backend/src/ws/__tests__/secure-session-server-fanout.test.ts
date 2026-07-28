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
import { SecureBrowserAccessService } from "../../swarm/secure-browser-access-service.js";
import { SwarmWebSocketServer } from "../server.js";

describe("secure session server transport", () => {
  it("fans the manager session snapshot to its manager and every worker", async () => {
    const port = await getAvailablePort();
    const secureControlToken = "s".repeat(43);
    const config = await makeWsServerTempConfig(port, true);
    const manager = new WsServerTestSwarmManager(config);
    await bootWsServerTestManager(manager, config);
    const secureBrowserAccessService = new SecureBrowserAccessService({
      dataDir: config.paths.dataDir,
      generateVerificationCode: () => "482913",
    });
    const worker = await manager.spawnAgent("manager", { agentId: "worker-1" });
    const sibling = await manager.spawnAgent("manager", { agentId: "worker-2" });
    const { sessionAgent: otherSession } = await manager.createSession("manager", {
      label: "Other",
    });
    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      secureControlToken,
      secureBrowserAccessService,
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

    const authorizedMissingSecretMutation = await fetch(
      `http://${config.host}:${config.port}/api/secure-secrets/project-defaults/manager/secret-1`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-forge-secure-control": secureControlToken,
        },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(authorizedMissingSecretMutation.status).not.toBe(403);

    const browserOrigin = `http://${config.host}:${config.port}`;
    const pairingCreated = await fetch(
      `${browserOrigin}/api/secure-browser-control/pairing/requests`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: browserOrigin,
        },
        body: JSON.stringify({
          deviceId: "browser-installation-1",
          deviceName: "Remote test browser",
        }),
      },
    );
    expect(pairingCreated.status).toBe(201);
    const pairing = await pairingCreated.json() as {
      requestId: string;
      claimSecret: string;
    };
    const desktopSettingsPreflight = await fetch(
      `${browserOrigin}/api/settings/secure-browsers`,
      {
        method: "OPTIONS",
        headers: {
          Origin: browserOrigin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "x-forge-secure-control",
        },
      },
    );
    expect(desktopSettingsPreflight.status).toBe(204);
    expect(desktopSettingsPreflight.headers.get("access-control-allow-headers"))
      .toContain("x-forge-secure-control");
    await secureBrowserAccessService.approvePairing(pairing.requestId);
    const pairingClaimed = await fetch(
      `${browserOrigin}/api/secure-browser-control/pairing/requests/${encodeURIComponent(pairing.requestId)}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: browserOrigin,
        },
        body: JSON.stringify({ claimSecret: pairing.claimSecret }),
      },
    );
    expect(pairingClaimed.status).toBe(200);
    const pairedCookie = pairingClaimed.headers.get("set-cookie")?.split(";")[0];
    expect(pairedCookie).toMatch(/^forge_secure_browser=/u);
    const pairedBrowserMutation = await fetch(
      `http://${config.host}:${config.port}/api/secure-secrets/project-defaults/manager/secret-1`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: pairedCookie ?? "",
          Origin: browserOrigin,
        },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(pairedBrowserMutation.status).not.toBe(403);
    const pairedBrowserSettings = await fetch(
      `${browserOrigin}/api/settings/secure-browsers`,
      {
        headers: {
          cookie: pairedCookie ?? "",
          Origin: browserOrigin,
        },
      },
    );
    expect(pairedBrowserSettings.status).toBe(403);

    await manager.requestSecureSecretAccess("manager", "web-dismissal-tool", {
      displayAlias: "WEB_DISMISSAL_TEST",
      exposures: [{
        deliveryKind: "environment",
        targetName: "WEB_DISMISSAL_TEST",
      }],
      leaseKind: "task",
      purposeSummary: "Verify web-safe request dismissal",
    });
    const pending = await manager.getSecureSessionSnapshot("manager");
    const requestId = pending.pendingRequests[0]!.requestId;
    const requestUrl =
      `http://${config.host}:${config.port}/api/secure-sessions/manager/access-requests/${requestId}`;
    const dismissed = await fetch(requestUrl, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: pending.revision }),
    });
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json() as {
      pendingRequests: unknown[];
    }).pendingRequests).toEqual([]);

    const unauthorizedApproval = await fetch(`${requestUrl}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: pending.revision + 1,
        decision: "approve",
      }),
    });
    expect(unauthorizedApproval.status).toBe(403);
    expect(await unauthorizedApproval.json()).toEqual({
      code: "SECURE_PRIVATE_API_UNAVAILABLE",
      error: "SECURE_PRIVATE_API_UNAVAILABLE",
    });

    const hostileDismissal = await fetch(requestUrl, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ baseRevision: pending.revision + 1 }),
    });
    expect(hostileDismissal.status).toBe(403);

    const hostileWebSocketStatus = await rejectedWebSocketStatus(
      `ws://${config.host}:${config.port}`,
      "https://evil.example",
    );
    expect(hostileWebSocketStatus).toBe(403);

    const managerClient = new WebSocket(`ws://${config.host}:${config.port}`);
    const workerClient = new WebSocket(`ws://${config.host}:${config.port}`);
    const siblingClient = new WebSocket(`ws://${config.host}:${config.port}`);
    const otherClient = new WebSocket(`ws://${config.host}:${config.port}`);
    const managerEvents: ServerEvent[] = [];
    const workerEvents: ServerEvent[] = [];
    const siblingEvents: ServerEvent[] = [];
    const otherEvents: ServerEvent[] = [];
    managerClient.on("message", (raw) => {
      managerEvents.push(JSON.parse(raw.toString()) as ServerEvent);
    });
    workerClient.on("message", (raw) => {
      workerEvents.push(JSON.parse(raw.toString()) as ServerEvent);
    });
    siblingClient.on("message", (raw) => {
      siblingEvents.push(JSON.parse(raw.toString()) as ServerEvent);
    });
    otherClient.on("message", (raw) => {
      otherEvents.push(JSON.parse(raw.toString()) as ServerEvent);
    });

    try {
      await Promise.all([
        once(managerClient, "open"),
        once(workerClient, "open"),
        once(siblingClient, "open"),
        once(otherClient, "open"),
      ]);
      managerClient.send(JSON.stringify({
        type: "subscribe",
        agentId: "manager",
      }));
      otherClient.send(JSON.stringify({
        type: "subscribe",
        agentId: otherSession.agentId,
      }));
      workerClient.send(JSON.stringify({
        type: "subscribe",
        agentId: worker.agentId,
      }));
      siblingClient.send(JSON.stringify({
        type: "subscribe",
        agentId: sibling.agentId,
      }));
      await Promise.all([
        waitForEvent(managerEvents, (event) =>
          event.type === "ready" && event.subscribedAgentId === "manager"
        ),
        waitForEvent(otherEvents, (event) =>
          event.type === "ready"
          && event.subscribedAgentId === otherSession.agentId
        ),
        waitForEvent(workerEvents, (event) =>
          event.type === "ready"
          && event.subscribedAgentId === worker.agentId
        ),
        waitForEvent(siblingEvents, (event) =>
          event.type === "ready"
          && event.subscribedAgentId === sibling.agentId
        ),
      ]);
      managerEvents.length = 0;
      workerEvents.length = 0;
      siblingEvents.length = 0;
      otherEvents.length = 0;

      manager.emit("secure_session_snapshot", {
        type: "secure_session_snapshot",
        sessionAgentId: "manager",
        profileId: "manager",
        principalKind: "manager",
        ownerManagerAgentId: null,
        workerAssignmentId: null,
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
      await waitForEvent(workerEvents, (event) =>
        event.type === "secure_session_snapshot" && event.revision === 2
      );
      await waitForEvent(siblingEvents, (event) =>
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
      expect(siblingEvents.some((event) =>
        event.type === "secure_session_snapshot"
        && event.sessionAgentId === "manager"
        && event.revision === 2
      )).toBe(true);

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
        waitForEvent(workerEvents, (event) =>
          event.type === "secure_secret_catalog_changed" && event.revision === 9
        ),
        waitForEvent(siblingEvents, (event) =>
          event.type === "secure_secret_catalog_changed" && event.revision === 9
        ),
      ]);
    } finally {
      for (const client of [
        managerClient,
        workerClient,
        siblingClient,
        otherClient,
      ]) {
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
