import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createTempConfig, getAvailablePort } from "../../../../test-support/index.js";
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
} from "../../../../test-support/ws-integration-harness.js";
import { CliAccessService } from "../../../../swarm/cli-access-service.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";
import { SwarmWebSocketServer } from "../../../server.js";
import { createCliRoutes } from "../cli-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];
const activeSwarmServers: SwarmWebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(activeSwarmServers.splice(0).map((server) => server.stop()));
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("CLI routes and bearer auth", () => {
  it("requires bearer auth for /api/cli/* and returns capabilities for a valid stored key", async () => {
    const { service } = await makeCliAccessService();
    const generated = await service.generateKey({ name: "Route test" });
    const server = await createCliRouteTestServer(service);

    const missing = await fetch(`${server.baseUrl}/api/cli/capabilities`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="forge-cli"');
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "missing_authorization", status: 401 },
    });

    const invalid = await fetch(`${server.baseUrl}/api/cli/capabilities`, {
      headers: { authorization: "Bearer invalid" },
    });
    await expect(parseJsonResponse(invalid)).resolves.toMatchObject({
      status: 401,
      json: { error: { code: "invalid_token", status: 401 } },
    });

    const valid = await fetch(`${server.baseUrl}/api/cli/capabilities`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });
    const payload = await parseJsonResponse(valid);
    expect(payload.status).toBe(200);
    expect(payload.json).toMatchObject({
      serverVersion: "1.0.0",
      capabilities: {
        protocolVersion: 1,
        available: true,
        runtimeTarget: "builder",
        features: {
          bearerAuth: true,
          headlessWs: false,
          cliSourceContext: true,
          cliSessionMetadata: false,
          builderRuntimeOnly: true,
        },
      },
    });
    await expect(service.listKeys()).resolves.toMatchObject([
      { id: generated.key.id, lastUsedAt: "2026-05-11T00:00:00.000Z", lastUsedSource: "http" },
    ]);

    const unknown = await fetch(`${server.baseUrl}/api/cli/not-found`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });
    await expect(parseJsonResponse(unknown)).resolves.toMatchObject({
      status: 404,
      json: { error: { code: "not_found", status: 404 } },
    });
  });

  it("allows authorization in CORS preflight responses", async () => {
    const { service } = await makeCliAccessService();
    const server = await createCliRouteTestServer(service);

    const response = await fetch(`${server.baseUrl}/api/cli/capabilities`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:47188",
        "access-control-request-headers": "authorization",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("does not register CLI HTTP routes for collaboration runtime", async () => {
    const configHandle = await createTempConfig({
      prefix: "cli-collab-route-",
      port: await getAvailablePort(),
      runtimeTarget: "collaboration-server",
    });
    activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });
    const service = new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
    });
    const generated = await service.generateKey({ name: "Collab route test" });
    const manager = new FakeSwarmManager(configHandle.config, [
      createManagerDescriptor(configHandle.config.paths.rootDir, "manager"),
    ]);
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: configHandle.config.host,
      port: configHandle.config.port,
      allowNonManagerSubscriptions: false,
      cliAccessService: service,
    });
    activeSwarmServers.push(server);
    await server.start();

    const response = await fetch(`http://${configHandle.config.host}:${configHandle.config.port}/api/cli/capabilities`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });

    expect(response.status).toBe(404);
    await expect(service.listKeys()).resolves.toEqual([generated.key]);
  });

  it("authenticates /api/cli/ws before accepting the isolated placeholder socket", async () => {
    const configHandle = await createTempConfig({ prefix: "cli-ws-route-", port: await getAvailablePort() });
    activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });
    const service = new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
    });
    const generated = await service.generateKey({ name: "WS test" });
    const manager = new FakeSwarmManager(configHandle.config, [
      createManagerDescriptor(configHandle.config.paths.rootDir, "manager"),
    ]);
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: configHandle.config.host,
      port: configHandle.config.port,
      allowNonManagerSubscriptions: false,
      cliAccessService: service,
    });
    activeSwarmServers.push(server);
    await server.start();

    await expect(connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`)).resolves.toMatchObject({
      opened: false,
      errorMessage: expect.stringContaining("Unexpected server response: 401") as string,
    });

    await expect(
      connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`, {
        authorization: "Bearer invalid",
      })
    ).resolves.toMatchObject({
      opened: false,
      errorMessage: expect.stringContaining("Unexpected server response: 401") as string,
    });

    await expect(
      connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`, {
        authorization: `Bearer ${generated.plaintextKey}`,
      })
    ).resolves.toMatchObject({
      opened: true,
      messages: [expect.objectContaining({ type: "cli_request_error", code: "not_implemented" })],
    });

    await expect(service.listKeys()).resolves.toMatchObject([
      { id: generated.key.id, lastUsedAt: "2026-05-11T00:00:00.000Z", lastUsedSource: "ws" },
    ]);
  });

  it("returns 404 for /api/cli/ws on collaboration runtime before bearer auth is evaluated", async () => {
    const configHandle = await createTempConfig({
      prefix: "cli-ws-collab-",
      port: await getAvailablePort(),
      runtimeTarget: "collaboration-server",
    });
    activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });
    const service = new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
    });
    const generated = await service.generateKey({ name: "Collab WS test" });
    const manager = new FakeSwarmManager(configHandle.config, [
      createManagerDescriptor(configHandle.config.paths.rootDir, "manager"),
    ]);
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: configHandle.config.host,
      port: configHandle.config.port,
      allowNonManagerSubscriptions: false,
      cliAccessService: service,
    });
    activeSwarmServers.push(server);
    await server.start();

    await expect(
      connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`, {
        authorization: `Bearer ${generated.plaintextKey}`,
      })
    ).resolves.toMatchObject({
      opened: false,
      errorMessage: expect.stringContaining("Unexpected server response: 404") as string,
    });
    await expect(service.listKeys()).resolves.toEqual([generated.key]);
  });
});

async function makeCliAccessService(): Promise<{ service: CliAccessService }> {
  const configHandle = await createTempConfig({ prefix: "cli-route-service-" });
  activeServers.push({
    baseUrl: "cleanup-only",
    close: configHandle.cleanup,
  });

  let counter = 0;
  return {
    service: new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
      generateId: () => {
        counter += 1;
        return `cli_key_${counter}`;
      },
      generateKeyBytes: () => Buffer.alloc(32, counter + 1),
    }),
  };
}

async function createCliRouteTestServer(cliAccessService: CliAccessService): Promise<TestServer> {
  const routes = createCliRoutes({ cliAccessService, runtimeTarget: "builder" });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
  activeServers.push(testServer);
  return testServer;
}

async function handleRouteRequest(
  routes: ReturnType<typeof createCliRoutes>,
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

async function connectWebSocket(
  url: string,
  headers?: Record<string, string>,
): Promise<{ opened: boolean; errorMessage?: string; messages: unknown[] }> {
  return new Promise((resolve) => {
    const client = new WebSocket(url, { headers });
    const messages: unknown[] = [];
    let settled = false;

    const settle = (result: { opened: boolean; errorMessage?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ...result, messages });
    };

    client.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()) as unknown);
    });
    client.once("error", (error) => {
      settle({ opened: false, errorMessage: error instanceof Error ? error.message : String(error) });
    });
    client.once("open", () => {
      const finish = (): void => {
        client.close();
        settle({ opened: true });
      };
      client.once("message", finish);
      client.once("close", finish);
    });
  });
}
