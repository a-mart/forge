import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTempConfig } from "../../../../test-support/index.js";
import { CliAccessService } from "../../../../swarm/cli-access-service.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";
import { createCliAccessSettingsRoutes } from "../cli-access-settings-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("CLI access settings routes", () => {
  it("returns empty list when no keys exist", async () => {
    const { server } = await setup();
    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ keys: [] });
  });

  it("generates a key and returns plaintext once", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My key" }),
    });
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.key).toMatchObject({ name: "My key" });
    expect(json.plaintextKey).toBeTruthy();
    expect(json.plaintextKey).toMatch(/^forge_cli_/);

    // List should now show one active key without plaintext
    const list = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    const listJson = await list.json();
    expect(listJson.keys).toHaveLength(1);
    expect(listJson.keys[0].name).toBe("My key");
    expect(listJson.keys[0]).not.toHaveProperty("plaintextKey");
  });

  it("generates a key without a name", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.key.name).toBeUndefined();
    expect(json.plaintextKey).toBeTruthy();
  });

  it("revokes a key", async () => {
    const { server } = await setup();

    const gen = await (await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Revoke me" }),
    })).json();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/${gen.key.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.key.revokedAt).toBeTruthy();

    // List should show the revoked key
    const list = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    const listJson = await list.json();
    expect(listJson.keys).toHaveLength(1);
    expect(listJson.keys[0].revokedAt).toBeTruthy();
  });

  it("returns 404 when revoking a non-existent key", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/nonexistent`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  it("rotates a key — revokes old, creates new", async () => {
    const { server } = await setup();

    const gen = await (await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rotate me" }),
    })).json();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/${gen.key.id}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.key.id).not.toBe(gen.key.id);
    expect(json.key.name).toBe("Rotate me");
    expect(json.plaintextKey).toBeTruthy();
    expect(json.plaintextKey).not.toBe(gen.plaintextKey);

    // Old key should be revoked, new key active
    const list = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    const listJson = await list.json();
    expect(listJson.keys).toHaveLength(2);
    const active = listJson.keys.filter((k: { revokedAt?: string }) => !k.revokedAt);
    const revoked = listJson.keys.filter((k: { revokedAt?: string }) => k.revokedAt);
    expect(active).toHaveLength(1);
    expect(revoked).toHaveLength(1);
    expect(active[0].id).toBe(json.key.id);
    expect(revoked[0].id).toBe(gen.key.id);
  });

  it("returns 404 when rotating a non-existent key", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/nonexistent/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("returns 405 for unsupported methods", async () => {
    const { server } = await setup();

    const putResponse = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "PUT",
    });
    expect(putResponse.status).toBe(405);
  });

  it("handles CORS OPTIONS preflight", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
  });

  it("returns no routes for collaboration runtime", () => {
    const routes = createCliAccessSettingsRoutes({
      cliAccessService: {} as CliAccessService,
      runtimeTarget: "collaboration-server",
    });
    expect(routes).toEqual([]);
  });
});

async function setup(): Promise<{ service: CliAccessService; server: TestServer }> {
  const configHandle = await createTempConfig({ prefix: "cli-settings-" });
  activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });

  let counter = 0;
  const service = new CliAccessService({
    dataDir: configHandle.config.paths.dataDir,
    now: () => "2026-05-11T00:00:00.000Z",
    generateId: () => {
      counter += 1;
      return `cli_key_${counter}`;
    },
    generateKeyBytes: () => Buffer.alloc(32, counter + 1),
  });

  const routes = createCliAccessSettingsRoutes({
    cliAccessService: service,
    runtimeTarget: "builder",
  });

  const httpServer = createServer((request, response) => {
    void handleRoute(routes, request, response);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  activeServers.push(testServer);
  return { service, server: testServer };
}

async function handleRoute(
  routes: ReturnType<typeof createCliAccessSettingsRoutes>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
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
    applyCorsHeaders(request, response, route.methods);
    sendJson(response, 500, { error: message });
  }
}
