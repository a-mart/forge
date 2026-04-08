import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ServerEvent } from "@forge/protocol";
import { applyCorsHeaders, sendJson } from "../ws/http-utils.js";

const cortexPromptSurfaceState = vi.hoisted(() => ({
  listCortexPromptSurfaces: vi.fn(async () => ({ enabled: true, surfaces: [] })),
  readCortexPromptSurface: vi.fn(async () => ({ surfaceId: "worker-prompts", content: "content" })),
  resetCortexPromptSurface: vi.fn(async () => undefined),
  saveCortexPromptSurface: vi.fn(async () => undefined),
}));

vi.mock("../swarm/cortex-prompt-surfaces.js", () => ({
  listCortexPromptSurfaces: (...args: unknown[]) => cortexPromptSurfaceState.listCortexPromptSurfaces(...args),
  readCortexPromptSurface: (...args: unknown[]) => cortexPromptSurfaceState.readCortexPromptSurface(...args),
  resetCortexPromptSurface: (...args: unknown[]) => cortexPromptSurfaceState.resetCortexPromptSurface(...args),
  saveCortexPromptSurface: (...args: unknown[]) => cortexPromptSurfaceState.saveCortexPromptSurface(...args),
}));

import { createPromptRoutes, type PromptRegistryForRoutes } from "../ws/routes/prompt-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  Object.values(cortexPromptSurfaceState).forEach((mock) => mock.mockReset());
  cortexPromptSurfaceState.listCortexPromptSurfaces.mockResolvedValue({ enabled: true, surfaces: [] });
  cortexPromptSurfaceState.readCortexPromptSurface.mockResolvedValue({ surfaceId: "worker-prompts", content: "content" });
  cortexPromptSurfaceState.resetCortexPromptSurface.mockResolvedValue(undefined);
  cortexPromptSurfaceState.saveCortexPromptSurface.mockResolvedValue(undefined);
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("prompt routes", () => {
  it("returns 501 when preview support is unavailable", async () => {
    const server = await createPromptRouteTestServer({
      promptRegistry: createPromptRegistryStub(),
    });

    const response = await fetch(`${server.baseUrl}/api/prompts/preview?profileId=alpha`);
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({ error: "Prompt preview not available" });
  });

  it("requires profileId for prompt preview and proxies successful preview payloads", async () => {
    const previewManagerSystemPrompt = vi.fn(async () => ({
      sections: [{ label: "System Prompt", content: "Hello", source: "profile" }],
    }));
    const server = await createPromptRouteTestServer({
      promptRegistry: createPromptRegistryStub(),
      promptPreviewProvider: { previewManagerSystemPrompt },
    });

    const missingProfile = await fetch(`${server.baseUrl}/api/prompts/preview`);
    expect(missingProfile.status).toBe(400);
    await expect(missingProfile.json()).resolves.toEqual({ error: "profileId query parameter is required." });

    const response = await fetch(`${server.baseUrl}/api/prompts/preview?profileId=alpha`);
    expect(response.status).toBe(200);
    expect(previewManagerSystemPrompt).toHaveBeenCalledWith("alpha");
    await expect(response.json()).resolves.toEqual({
      sections: [{ label: "System Prompt", content: "Hello", source: "profile" }],
    });
  });

  it("lists prompts with activeLayer and hasProfileOverride metadata", async () => {
    const promptRegistry = createPromptRegistryStub({
      listAll: vi.fn(async (profileId?: string) => {
        expect(profileId).toBe("cortex");
        return [
          {
            category: "archetype",
            promptId: "manager",
            content: "manager content",
            sourceLayer: "repo",
            sourcePath: "/repo/manager.md",
          },
          {
            category: "archetype",
            promptId: "cortex",
            content: "cortex content",
            sourceLayer: "profile",
            sourcePath: "/profiles/cortex/prompt.md",
          },
        ];
      }),
    });

    const server = await createPromptRouteTestServer({ promptRegistry });
    const response = await fetch(`${server.baseUrl}/api/prompts?profileId=cortex`);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { prompts: Array<Record<string, unknown>> };
    expect(payload.prompts).toContainEqual(
      expect.objectContaining({
        category: "archetype",
        promptId: "manager",
        activeLayer: "repo",
        hasProfileOverride: false,
      }),
    );
    expect(payload.prompts).toContainEqual(
      expect.objectContaining({
        category: "archetype",
        promptId: "cortex",
        activeLayer: "profile",
        hasProfileOverride: true,
      }),
    );
  });

  it("gets a resolved prompt entry and supports layer-specific reads", async () => {
    const promptRegistry = createPromptRegistryStub({
      resolveEntry: vi.fn(async () => ({
        category: "archetype",
        promptId: "manager",
        content: "manager-content",
        sourceLayer: "repo",
        sourcePath: "/repo/manager.md",
      })),
      resolveAtLayer: vi.fn(async () => "builtin-manager"),
    });

    const server = await createPromptRouteTestServer({ promptRegistry });

    const resolvedResponse = await fetch(`${server.baseUrl}/api/prompts/archetype/manager`);
    expect(resolvedResponse.status).toBe(200);
    await expect(resolvedResponse.json()).resolves.toEqual(
      expect.objectContaining({
        category: "archetype",
        promptId: "manager",
        content: "manager-content",
        sourceLayer: "repo",
        sourcePath: "/repo/manager.md",
      }),
    );

    const layerResponse = await fetch(`${server.baseUrl}/api/prompts/archetype/manager?layer=builtin`);
    expect(layerResponse.status).toBe(200);
    await expect(layerResponse.json()).resolves.toEqual(
      expect.objectContaining({
        category: "archetype",
        promptId: "manager",
        content: "builtin-manager",
        sourceLayer: "builtin",
        sourcePath: "",
      }),
    );
  });

  it("validates prompt category, layer, and unknown prompt ids", async () => {
    const server = await createPromptRouteTestServer({
      promptRegistry: createPromptRegistryStub(),
    });

    const invalidCategory = await fetch(`${server.baseUrl}/api/prompts/not-real/manager`);
    expect(invalidCategory.status).toBe(400);
    await expect(invalidCategory.json()).resolves.toEqual({
      error: "Invalid category 'not-real'. Must be 'archetype' or 'operational'.",
    });

    const invalidLayer = await fetch(`${server.baseUrl}/api/prompts/archetype/manager?layer=global`);
    expect(invalidLayer.status).toBe(400);
    await expect(invalidLayer.json()).resolves.toEqual({
      error: "Invalid layer 'global'. Must be 'profile', 'repo', or 'builtin'.",
    });

    const unknownPrompt = await fetch(`${server.baseUrl}/api/prompts/archetype/does-not-exist`);
    expect(unknownPrompt.status).toBe(404);
    await expect(unknownPrompt.json()).resolves.toEqual({
      error: "Unknown prompt 'archetype/does-not-exist'.",
    });
  });

  it("saves prompt overrides and broadcasts prompt_changed events", async () => {
    const save = vi.fn(async () => undefined);
    const broadcastEvent = vi.fn<(event: ServerEvent) => void>();
    const promptRegistry = createPromptRegistryStub({ save });
    const server = await createPromptRouteTestServer({ promptRegistry, broadcastEvent });

    const response = await fetch(`${server.baseUrl}/api/prompts/archetype/manager`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "alpha", content: "Updated prompt" }),
    });

    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith("archetype", "manager", "Updated prompt", "alpha");
    await expect(response.json()).resolves.toEqual({ saved: true });
    expect(broadcastEvent).toHaveBeenCalledWith({
      type: "prompt_changed",
      category: "archetype",
      promptId: "manager",
      layer: "profile",
      action: "saved",
    });
  });

  it("deletes prompt overrides, requires profileId, and returns 404 when no override exists", async () => {
    const deleteOverride = vi.fn(async () => undefined);
    const hasOverride = vi.fn(async (_category: string, _promptId: string, profileId: string) => profileId === "alpha");
    const broadcastEvent = vi.fn<(event: ServerEvent) => void>();
    const promptRegistry = createPromptRegistryStub({ hasOverride, deleteOverride });
    const server = await createPromptRouteTestServer({ promptRegistry, broadcastEvent });

    const missingProfile = await fetch(`${server.baseUrl}/api/prompts/archetype/manager`, { method: "DELETE" });
    expect(missingProfile.status).toBe(400);
    await expect(missingProfile.json()).resolves.toEqual({ error: "profileId query parameter is required." });

    const missingOverride = await fetch(`${server.baseUrl}/api/prompts/archetype/manager?profileId=beta`, {
      method: "DELETE",
    });
    expect(missingOverride.status).toBe(404);
    await expect(missingOverride.json()).resolves.toEqual({
      error: "No profile override exists for archetype/manager.",
    });

    const response = await fetch(`${server.baseUrl}/api/prompts/archetype/manager?profileId=alpha`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(deleteOverride).toHaveBeenCalledWith("archetype", "manager", "alpha");
    expect(broadcastEvent).toHaveBeenCalledWith({
      type: "prompt_changed",
      category: "archetype",
      promptId: "manager",
      layer: "profile",
      action: "deleted",
    });
    await expect(response.json()).resolves.toEqual({ deleted: true });
  });

  it("handles cortex surface list/get/save/reset routes and disabled-mode behavior", async () => {
    cortexPromptSurfaceState.listCortexPromptSurfaces.mockResolvedValueOnce({
      enabled: true,
      surfaces: [{ surfaceId: "worker-prompts", label: "Worker Prompts" }],
    });
    cortexPromptSurfaceState.readCortexPromptSurface.mockResolvedValueOnce({
      surfaceId: "worker-prompts",
      profileId: "cortex",
      content: "surface-content",
    });

    const promptRegistry = createPromptRegistryStub();
    const broadcastEvent = vi.fn<(event: ServerEvent) => void>();
    const server = await createPromptRouteTestServer({ promptRegistry, broadcastEvent });

    const listResponse = await fetch(`${server.baseUrl}/api/prompts/cortex-surfaces?profileId=cortex`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      enabled: true,
      surfaces: [{ surfaceId: "worker-prompts", label: "Worker Prompts" }],
    });

    const getResponse = await fetch(`${server.baseUrl}/api/prompts/cortex-surfaces/worker-prompts?profileId=cortex`);
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      surfaceId: "worker-prompts",
      profileId: "cortex",
      content: "surface-content",
    });

    const saveResponse = await fetch(`${server.baseUrl}/api/prompts/cortex-surfaces/worker-prompts`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "cortex", content: "updated" }),
    });
    expect(saveResponse.status).toBe(200);
    expect(cortexPromptSurfaceState.saveCortexPromptSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: "/tmp/data",
        profileId: "cortex",
        surfaceId: "worker-prompts",
        content: "updated",
        promptRegistry,
        broadcastEvent,
      }),
    );

    const resetResponse = await fetch(`${server.baseUrl}/api/prompts/cortex-surfaces/worker-prompts/reset?profileId=cortex`, {
      method: "POST",
    });
    expect(resetResponse.status).toBe(200);
    await expect(resetResponse.json()).resolves.toEqual({ reset: true });

    const disabledServer = await createPromptRouteTestServer({
      promptRegistry,
      cortexEnabled: false,
    });
    const disabledResponse = await fetch(`${disabledServer.baseUrl}/api/prompts/cortex-surfaces/worker-prompts?profileId=cortex`);
    expect(disabledResponse.status).toBe(404);
    await expect(disabledResponse.json()).resolves.toEqual({
      error: "Cortex prompt surfaces are unavailable because Cortex is disabled.",
    });
  });
});

function createPromptRegistryStub(overrides?: Partial<PromptRegistryForRoutes>): PromptRegistryForRoutes {
  return {
    resolve: vi.fn(async () => ""),
    resolveEntry: vi.fn(async () => undefined),
    resolveAtLayer: vi.fn(async () => undefined),
    listAll: vi.fn(async () => []),
    save: vi.fn(async () => undefined),
    deleteOverride: vi.fn(async () => undefined),
    hasOverride: vi.fn(async () => false),
    ...overrides,
  };
}

async function createPromptRouteTestServer(options: {
  promptRegistry: PromptRegistryForRoutes;
  broadcastEvent?: (event: ServerEvent) => void;
  promptPreviewProvider?: { previewManagerSystemPrompt: (profileId: string) => Promise<unknown> };
  cortexEnabled?: boolean;
}): Promise<TestServer> {
  const routes = createPromptRoutes({
    promptRegistry: options.promptRegistry,
    dataDir: "/tmp/data",
    broadcastEvent: options.broadcastEvent ?? vi.fn(),
    promptPreviewProvider: options.promptPreviewProvider,
    cortexEnabled: options.cortexEnabled,
  });

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
  routes: ReturnType<typeof createPromptRoutes>,
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
