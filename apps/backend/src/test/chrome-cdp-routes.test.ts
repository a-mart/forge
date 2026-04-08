import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { applyCorsHeaders, sendJson } from "../ws/http-utils.js";

const chromeCdpHelperState = vi.hoisted(() => ({
  queryChromeBrowserContexts: vi.fn(async () => ({
    endpoint: { port: 9222 },
    defaultBrowserContextId: "default-context",
    browserContextIds: ["default-context"],
  })),
  queryChromeCdpTargets: vi.fn(async () => ({ targets: [] })),
  queryChromeCdpVersion: vi.fn(async () => ({ version: { Browser: "Chrome/123.0.0.0" } })),
  resolveChromeCdpEndpoint: vi.fn(async () => ({ port: 9222 })),
}));

vi.mock("../ws/routes/chrome-cdp-helper.js", () => ({
  queryChromeBrowserContexts: (...args: unknown[]) => chromeCdpHelperState.queryChromeBrowserContexts(...args),
  queryChromeCdpTargets: (...args: unknown[]) => chromeCdpHelperState.queryChromeCdpTargets(...args),
  queryChromeCdpVersion: (...args: unknown[]) => chromeCdpHelperState.queryChromeCdpVersion(...args),
  resolveChromeCdpEndpoint: (...args: unknown[]) => chromeCdpHelperState.resolveChromeCdpEndpoint(...args),
}));

import { createChromeCdpRoutes } from "../ws/routes/chrome-cdp-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  Object.values(chromeCdpHelperState).forEach((mock) => mock.mockReset());
  chromeCdpHelperState.queryChromeBrowserContexts.mockResolvedValue({
    endpoint: { port: 9222 },
    defaultBrowserContextId: "default-context",
    browserContextIds: ["default-context"],
  });
  chromeCdpHelperState.queryChromeCdpTargets.mockResolvedValue({ targets: [] });
  chromeCdpHelperState.queryChromeCdpVersion.mockResolvedValue({ version: { Browser: "Chrome/123.0.0.0" } });
  chromeCdpHelperState.resolveChromeCdpEndpoint.mockResolvedValue({ port: 9222 });
  delete process.env.CDP_CONTEXT_ID;
  delete process.env.CDP_URL_ALLOW;
  delete process.env.CDP_URL_BLOCK;
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("chrome cdp routes", () => {
  it("returns current config plus connected status metadata", async () => {
    process.env.CDP_CONTEXT_ID = "context-a";
    process.env.CDP_URL_ALLOW = "https://allowed.example/*, https://second.example/*";
    process.env.CDP_URL_BLOCK = "https://blocked.example/*";

    const server = await createChromeCdpRouteTestServer({});
    const response = await fetch(`${server.baseUrl}/api/settings/chrome-cdp`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      config: {
        contextId: "context-a",
        urlAllow: ["https://allowed.example/*", "https://second.example/*"],
        urlBlock: ["https://blocked.example/*"],
      },
      status: {
        connected: true,
        port: 9222,
        browser: "Chrome",
        version: "123.0.0.0",
      },
    });
  });

  it("saves config by updating env vars and deleting emptied fields", async () => {
    process.env.CDP_CONTEXT_ID = "old-context";
    process.env.CDP_URL_ALLOW = "https://old.example/*";
    process.env.CDP_URL_BLOCK = "https://blocked.example/*";

    const swarmManager = {
      updateSettingsEnv: vi.fn(async (updates: Record<string, string>) => {
        Object.assign(process.env, updates);
      }),
      deleteSettingsEnv: vi.fn(async (name: string) => {
        delete process.env[name];
      }),
    };
    const server = await createChromeCdpRouteTestServer(swarmManager);

    const response = await fetch(`${server.baseUrl}/api/settings/chrome-cdp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contextId: null,
        urlAllow: [" https://allowed.example/* ", "https://allowed.example/*"],
        urlBlock: [],
      }),
    });

    expect(response.status).toBe(200);
    expect(swarmManager.updateSettingsEnv).toHaveBeenCalledWith({
      CDP_URL_ALLOW: "https://allowed.example/*",
    });
    expect(swarmManager.deleteSettingsEnv).toHaveBeenCalledWith("CDP_CONTEXT_ID");
    expect(swarmManager.deleteSettingsEnv).toHaveBeenCalledWith("CDP_URL_BLOCK");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      config: {
        contextId: null,
        urlAllow: ["https://allowed.example/*"],
        urlBlock: [],
      },
    });
  });

  it("validates config update payloads", async () => {
    const server = await createChromeCdpRouteTestServer({
      updateSettingsEnv: vi.fn(async () => undefined),
      deleteSettingsEnv: vi.fn(async () => undefined),
    });

    const response = await fetch(`${server.baseUrl}/api/settings/chrome-cdp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urlAllow: [123] }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "urlAllow must be an array of strings" });
  });

  it("tests the endpoint connection and reports tab counts", async () => {
    chromeCdpHelperState.queryChromeCdpTargets.mockResolvedValueOnce({
      targets: [
        { targetId: "page-1", type: "page", title: "Docs", url: "https://example.com/docs" },
        { targetId: "chrome-settings", type: "page", title: "Settings", url: "chrome://settings" },
      ],
    });

    const server = await createChromeCdpRouteTestServer({});
    const response = await fetch(`${server.baseUrl}/api/settings/chrome-cdp/test`, { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connected: true,
      port: 9222,
      browser: "Chrome",
      version: "123.0.0.0",
      tabCount: 1,
    });
  });

  it("enumerates browser contexts into sorted profile summaries", async () => {
    chromeCdpHelperState.queryChromeCdpTargets.mockResolvedValueOnce({
      targets: [
        { targetId: "1", type: "page", title: "Default", url: "https://default.example", browserContextId: undefined },
        { targetId: "2", type: "page", title: "Work", url: "https://work.example", browserContextId: "ctx-work" },
        { targetId: "3", type: "page", title: "Work 2", url: "https://work-2.example", browserContextId: "ctx-work" },
      ],
    });
    chromeCdpHelperState.queryChromeBrowserContexts.mockResolvedValueOnce({
      endpoint: { port: 9222 },
      defaultBrowserContextId: "default-context",
      browserContextIds: ["default-context", "ctx-work"],
    });

    const server = await createChromeCdpRouteTestServer({});
    const response = await fetch(`${server.baseUrl}/api/settings/chrome-cdp/profiles`, { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profiles: [
        {
          contextId: "default",
          tabCount: 1,
          sampleUrls: ["https://default.example"],
          isDefault: true,
        },
        {
          contextId: "ctx-work",
          tabCount: 2,
          sampleUrls: ["https://work.example", "https://work-2.example"],
          isDefault: false,
        },
      ],
    });
  });

  it("previews filtered tabs using merged config policy", async () => {
    process.env.CDP_CONTEXT_ID = "ctx-work";
    process.env.CDP_URL_BLOCK = "https://blocked.example/*";
    chromeCdpHelperState.queryChromeCdpTargets.mockResolvedValueOnce({
      targets: [
        { targetId: "1", type: "page", title: "Allowed", url: "https://allowed.example/docs", browserContextId: "ctx-work" },
        { targetId: "2", type: "page", title: "Blocked", url: "https://blocked.example/private", browserContextId: "ctx-work" },
        { targetId: "3", type: "page", title: "Other Ctx", url: "https://allowed.example/else", browserContextId: "ctx-other" },
      ],
    });

    const server = await createChromeCdpRouteTestServer({});
    const response = await fetch(`${server.baseUrl}/api/settings/chrome-cdp/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urlAllow: ["https://allowed.example/*"] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      tabs: [
        {
          targetId: "1",
          title: "Allowed",
          url: "https://allowed.example/docs",
        },
      ],
      totalFiltered: 2,
      totalUnfiltered: 3,
    });
  });

  it("returns connection errors from test and preview endpoints in-band", async () => {
    chromeCdpHelperState.resolveChromeCdpEndpoint.mockRejectedValueOnce(new Error("Chrome not reachable"));
    chromeCdpHelperState.queryChromeCdpTargets.mockRejectedValueOnce(new Error("No tabs available"));

    const server = await createChromeCdpRouteTestServer({});

    const testResponse = await fetch(`${server.baseUrl}/api/settings/chrome-cdp/test`, { method: "POST" });
    expect(testResponse.status).toBe(200);
    await expect(testResponse.json()).resolves.toEqual({
      connected: false,
      error: "Chrome not reachable",
    });

    const previewResponse = await fetch(`${server.baseUrl}/api/settings/chrome-cdp/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toEqual({
      tabs: [],
      totalFiltered: 0,
      totalUnfiltered: 0,
      error: "No tabs available",
    });
  });

  it("rejects unsupported methods", async () => {
    const server = await createChromeCdpRouteTestServer({});
    const response = await fetch(`${server.baseUrl}/api/settings/chrome-cdp`, { method: "DELETE" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PUT, POST, OPTIONS");
    await expect(response.json()).resolves.toEqual({ error: "Method Not Allowed" });
  });
});

async function createChromeCdpRouteTestServer(swarmManager: Record<string, unknown>): Promise<TestServer> {
  const routes = createChromeCdpRoutes({ swarmManager: swarmManager as never });
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
  routes: ReturnType<typeof createChromeCdpRoutes>,
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
    const statusCode =
      message.includes("must be") ||
      message.includes("Invalid") ||
      message.includes("Missing") ||
      message.includes("too large")
        ? 400
        : 500;

    applyCorsHeaders(request, response, route.methods);
    sendJson(response, statusCode, { error: message });
  }
}
