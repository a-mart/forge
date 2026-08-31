import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GetSecureSecretSettingsResponse,
  UpdateSecureSecretSettingsResponse,
} from "@forge/protocol";
import { SecureSecretSettingsService } from "../../../../swarm/secure-sessions/secure-secret-settings-service.js";
import { sendJson } from "../../../http-utils.js";
import { createSecureSecretSettingsRoutes } from "../secure-secret-settings-routes.js";
import type { HttpRoute } from "../../shared/http-route.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("createSecureSecretSettingsRoutes", () => {
  it("serves the default automatic-grant limit for Builder runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-secure-secret-settings-get-"));
    const service = new SecureSecretSettingsService({ dataDir });
    await service.load();
    const server = await createRouteServer(
      createSecureSecretSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/secure-secrets`);
    const body = (await response.json()) as GetSecureSecretSettingsResponse;

    expect(response.status).toBe(200);
    expect(body.settings.maxProjectDefaults).toBe(50);
    expect(body.defaults.maxProjectDefaults).toBe(50);
    expect(body.constraints.maxProjectDefaults).toEqual({
      min: 1,
      max: 256,
      default: 50,
    });
  });

  it("persists a custom automatic-grant limit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-secure-secret-settings-put-"));
    const service = new SecureSecretSettingsService({ dataDir });
    await service.load();
    const server = await createRouteServer(
      createSecureSecretSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/secure-secrets`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxProjectDefaults: 12 }),
    });
    const body = (await response.json()) as UpdateSecureSecretSettingsResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.settings.maxProjectDefaults).toBe(12);
    expect(service.getMaxProjectDefaults()).toBe(12);
  });

  it("returns 404 for collaboration runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-secure-secret-settings-collab-"));
    const service = new SecureSecretSettingsService({ dataDir });
    await service.load();
    const server = await createRouteServer(
      createSecureSecretSettingsRoutes({
        settingsService: service,
        runtimeTarget: "collaboration-server",
      }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/secure-secrets`);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toContain("Builder runtime");
  });
});

async function createRouteServer(routes: HttpRoute[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const httpServer = createServer((request, response) => {
    void handleRoute(routes, request, response);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const server = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  activeServers.push(server);
  return server;
}

async function handleRoute(routes: HttpRoute[], request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    response.statusCode = 404;
    response.end();
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    if (response.writableEnded || response.headersSent) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: message });
  }
}
