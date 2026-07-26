import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GetCompactionSettingsResponse,
  UpdateCompactionSettingsResponse,
} from "@forge/protocol";
import { CompactionSettingsService } from "../../../../swarm/compaction-settings-service.js";
import { sendJson } from "../../../http-utils.js";
import { createCompactionSettingsRoutes } from "../compaction-settings-routes.js";
import type { HttpRoute } from "../../shared/http-route.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("createCompactionSettingsRoutes", () => {
  it("serves default compaction settings for Builder runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-compaction-routes-get-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => new Map([["openai-codex", true]]),
    });
    await service.load();
    const server = await createRouteServer(
      createCompactionSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/compaction`);
    const body = (await response.json()) as GetCompactionSettingsResponse;

    expect(response.status).toBe(200);
    expect(body.settings.model).toEqual({ provider: "openai-codex", modelId: "gpt-5.5" });
    expect(body.settings.reasoningLevel).toBe("low");
    expect(body.settings.timeoutMs).toBe(300_000);
    expect(body.availability.providerConfigured).toBe(true);
    expect(body.defaults.timeoutMs).toBe(300_000);
    expect(body.constraints).toEqual({
      timeoutMs: { min: 60_000, max: 900_000, default: 300_000 },
    });
  });

  it("persists compaction settings updates", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-compaction-routes-put-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => new Map([["openai-codex", true]]),
    });
    await service.load();
    const server = await createRouteServer(
      createCompactionSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/compaction`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoningLevel: "medium", timeoutMs: 420_000 }),
    });
    const body = (await response.json()) as UpdateCompactionSettingsResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.settings.reasoningLevel).toBe("medium");
    expect(body.settings.timeoutMs).toBe(420_000);
    expect(body.availability.reasoningSupported).toBe(true);
  });

  it("clamps low and high timeout values on PUT", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-compaction-routes-clamp-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => new Map([["openai-codex", true]]),
    });
    await service.load();
    const server = await createRouteServer(
      createCompactionSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const lowResponse = await fetch(`${server.baseUrl}/api/settings/compaction`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 15_000 }),
    });
    const lowBody = (await lowResponse.json()) as UpdateCompactionSettingsResponse;

    expect(lowResponse.status).toBe(200);
    expect(lowBody.settings.timeoutMs).toBe(60_000);

    const highResponse = await fetch(`${server.baseUrl}/api/settings/compaction`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 2_000_000 }),
    });
    const highBody = (await highResponse.json()) as UpdateCompactionSettingsResponse;

    expect(highResponse.status).toBe(200);
    expect(highBody.settings.timeoutMs).toBe(900_000);
  });

  it("returns 400 for xAI compaction models", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-compaction-routes-xai-model-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => new Map([["openai-codex", true], ["xai", true]]),
    });
    await service.load();
    const server = await createRouteServer(
      createCompactionSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/compaction`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { provider: "xai", modelId: "grok-4" }, reasoningLevel: "medium" }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("Pi-compatible provider with raw API-key auth");
  });

  it("returns 400 for retired Claude SDK compaction models", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-compaction-routes-sdk-model-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => new Map([["openai-codex", true], ["claude-sdk", true]]),
    });
    await service.load();
    const server = await createRouteServer(
      createCompactionSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/compaction`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { provider: "claude-sdk", modelId: "claude-sonnet-5" } }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("Claude SDK has been retired");
  });

  it("returns 400 for non-finite timeout values", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-compaction-routes-invalid-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => new Map([["openai-codex", true]]),
    });
    await service.load();
    const server = await createRouteServer(
      createCompactionSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/compaction`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: "not-a-number" }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("timeoutMs must be a finite number");
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-compaction-routes-malformed-json-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => new Map([["openai-codex", true]]),
    });
    await service.load();
    const server = await createRouteServer(
      createCompactionSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/compaction`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Request body must be valid JSON");
  });

  it("returns 400 for oversized JSON bodies", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-compaction-routes-oversized-body-"));
    const service = new CompactionSettingsService({
      dataDir,
      getProviderAvailability: async () => new Map([["openai-codex", true]]),
    });
    await service.load();
    const server = await createRouteServer(
      createCompactionSettingsRoutes({ settingsService: service, runtimeTarget: "builder" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/compaction`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(65_536) }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/^Request body too large\./);
  });

  it("returns 404 for collaboration runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-compaction-routes-collab-"));
    const service = new CompactionSettingsService({ dataDir });
    await service.load();
    const server = await createRouteServer(
      createCompactionSettingsRoutes({ settingsService: service, runtimeTarget: "collaboration-server" }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/compaction`);
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
