import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { getCatalogModelKey, getOpenRouterModelOverrideKey } from "@forge/protocol";
import { modelCatalogService } from "../swarm/model-catalog-service.js";
import { addOpenRouterModel } from "../swarm/openrouter-models.js";
import { readModelOverrides, writeModelOverrides } from "../swarm/model-overrides.js";
import { createModelConfigRoutes } from "../ws/http/routes/model-config-routes.js";
import { createTempConfig } from "../test-support/index.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

interface ModelConfigRouteHarness {
  readonly server: TestServer;
  readonly dataDir: string;
  readonly broadcastEvent: ReturnType<typeof vi.fn>;
  readonly swarmManager: {
    getConfig: () => { paths: { dataDir: string } };
    getCredentialPoolService: ReturnType<typeof vi.fn>;
    reloadModelCatalogOverridesAndProjection: ReturnType<typeof vi.fn>;
    notifyModelSpecificInstructionsChanged: ReturnType<typeof vi.fn>;
  };
}

const activeServers: TestServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("model config routes", () => {
  it("recycles affected managers when modelSpecificInstructions change", async () => {
    const harness = await createModelConfigRouteHarness();
    const catalogModel = modelCatalogService.getModel("gpt-5.4");
    expect(catalogModel).toBeDefined();

    if (!catalogModel) {
      throw new Error("Expected gpt-5.4 to exist in the model catalog");
    }

    const response = await fetch(`${harness.server.baseUrl}/api/settings/model-overrides/gpt-5.4`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelSpecificInstructions: "Always output compact JSON." }),
    });

    expect(response.status).toBe(200);
    expect(harness.swarmManager.reloadModelCatalogOverridesAndProjection).toHaveBeenCalledTimes(1);
    expect(harness.swarmManager.notifyModelSpecificInstructionsChanged).toHaveBeenCalledWith([
      getCatalogModelKey(catalogModel),
    ]);
    expect(harness.broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "model_config_changed" }),
    );

    await expect(readModelOverrides(harness.dataDir)).resolves.toMatchObject({
      overrides: {
        [getCatalogModelKey(catalogModel)]: {
          modelSpecificInstructions: "Always output compact JSON.",
        },
      },
    });
  });

  it("accepts managerEnabled patches without triggering prompt-specific recycling", async () => {
    const harness = await createModelConfigRouteHarness();

    const response = await fetch(`${harness.server.baseUrl}/api/settings/model-overrides/claude-opus-4-7`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ managerEnabled: false }),
    });

    expect(response.status).toBe(200);
    expect(harness.swarmManager.reloadModelCatalogOverridesAndProjection).toHaveBeenCalledTimes(1);
    expect(harness.swarmManager.notifyModelSpecificInstructionsChanged).not.toHaveBeenCalled();
    expect(harness.broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "model_config_changed" }),
    );

    await expect(readModelOverrides(harness.dataDir)).resolves.toMatchObject({
      overrides: {
        "claude-opus-4-7": {
          managerEnabled: false,
        },
      },
    });
  });

  it("does not recycle managers when only non-prompt model override fields change", async () => {
    const harness = await createModelConfigRouteHarness();

    const response = await fetch(`${harness.server.baseUrl}/api/settings/model-overrides/gpt-5.4`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    expect(harness.swarmManager.reloadModelCatalogOverridesAndProjection).toHaveBeenCalledTimes(1);
    expect(harness.swarmManager.notifyModelSpecificInstructionsChanged).not.toHaveBeenCalled();
    expect(harness.broadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "model_config_changed" }),
    );
  });

  it("reports pooled-only OpenAI Codex credentials as provider-available", async () => {
    const harness = await createModelConfigRouteHarness({
      credentialPoolService: {
        listPool: vi.fn(async (provider: string) => ({
          provider,
          strategy: "fill_first",
          credentials: [
            {
              id: "oauth-primary",
              provider,
              label: "OAuth Primary",
              addedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              health: "healthy",
            },
          ],
        })),
      },
    });

    const response = await fetch(`${harness.server.baseUrl}/api/settings/model-overrides`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      providerAvailability: {
        "openai-codex": true,
      },
      providerCredentials: {
        "openai-codex": {
          configured: true,
        },
      },
    });
  });

  it("omits the retired Claude SDK provider from availability", async () => {
    const harness = await createModelConfigRouteHarness();

    const response = await fetch(`${harness.server.baseUrl}/api/settings/model-overrides`);
    const body = await response.json() as { providerAvailability: Record<string, boolean> };

    expect(response.status).toBe(200);
    expect(body.providerAvailability.anthropic).toBe(false);
    expect(body.providerAvailability).not.toHaveProperty("claude-sdk");
  });

  it("includes added OpenRouter models and persists managerEnabled on the openrouter override key",
    async () => {
      const harness = await createModelConfigRouteHarness();
      const openRouterModel = {
        modelId: "z-ai/glm-5.1",
        displayName: "Z.ai: GLM 5.1",
        contextWindow: 202_752,
        maxOutputTokens: 202_752,
        supportsReasoning: true,
        supportedReasoningLevels: ["none", "low", "medium", "high"] as const,
        inputModes: ["text"] as const,
        addedAt: "2026-04-03T00:00:00.000Z",
        supportsTools: true,
      };
      await addOpenRouterModel(harness.dataDir, openRouterModel);
      await modelCatalogService.loadOverrides(harness.dataDir);

      const listResponse = await fetch(`${harness.server.baseUrl}/api/settings/model-overrides`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toMatchObject({
        openRouterModels: [
          expect.objectContaining({
            modelId: openRouterModel.modelId,
            supportsTools: true,
          }),
        ],
      });

      const overrideKey = getOpenRouterModelOverrideKey(openRouterModel.modelId);
      const putResponse = await fetch(
        `${harness.server.baseUrl}/api/settings/model-overrides/${encodeURIComponent(overrideKey)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ managerEnabled: true }),
        },
      );
      expect(putResponse.status).toBe(200);
      await expect(putResponse.json()).resolves.toMatchObject({
        ok: true,
        modelId: overrideKey,
        override: { managerEnabled: true },
      });
      await expect(readModelOverrides(harness.dataDir)).resolves.toMatchObject({
        overrides: {
          [overrideKey]: { managerEnabled: true },
        },
      });

      const resetResponse = await fetch(
        `${harness.server.baseUrl}/api/settings/model-overrides/${encodeURIComponent(overrideKey)}`,
        { method: "DELETE" },
      );
      expect(resetResponse.status).toBe(200);
      await expect(readModelOverrides(harness.dataDir)).resolves.toEqual({
        version: 1,
        overrides: {},
      });
    },
  );

  it("rejects OpenRouter override writes that are not a prefixed managerEnabled-only patch", async () => {
    const harness = await createModelConfigRouteHarness();
    const toolCapable = {
      modelId: "z-ai/glm-5.1",
      displayName: "Z.ai: GLM 5.1",
      contextWindow: 202_752,
      maxOutputTokens: 202_752,
      supportsReasoning: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"] as const,
      inputModes: ["text"] as const,
      addedAt: "2026-04-03T00:00:00.000Z",
      supportsTools: true,
    };
    const unverified = {
      ...toolCapable,
      modelId: "google/gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
      supportsReasoning: false,
      supportedReasoningLevels: ["none"] as const,
    };
    delete (unverified as { supportsTools?: boolean }).supportsTools;
    await addOpenRouterModel(harness.dataDir, toolCapable);
    await addOpenRouterModel(harness.dataDir, unverified);
    await modelCatalogService.loadOverrides(harness.dataDir);

    const rawIdResponse = await fetch(
      `${harness.server.baseUrl}/api/settings/model-overrides/${encodeURIComponent(toolCapable.modelId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerEnabled: true }),
      },
    );
    expect(rawIdResponse.status).toBe(404);

    const extraFieldResponse = await fetch(
      `${harness.server.baseUrl}/api/settings/model-overrides/${encodeURIComponent(getOpenRouterModelOverrideKey(toolCapable.modelId))}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerEnabled: true, enabled: false }),
      },
    );
    expect(extraFieldResponse.status).toBe(400);
    await expect(extraFieldResponse.json()).resolves.toMatchObject({
      error: "OpenRouter model overrides only accept managerEnabled",
    });

    const unverifiedResponse = await fetch(
      `${harness.server.baseUrl}/api/settings/model-overrides/${encodeURIComponent(getOpenRouterModelOverrideKey(unverified.modelId))}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerEnabled: true }),
      },
    );
    expect(unverifiedResponse.status).toBe(400);
    await expect(unverifiedResponse.json()).resolves.toMatchObject({
      error: "Model Gemini 2.0 Flash is not verified for manager agents",
    });

    const disableUnverifiedResponse = await fetch(
      `${harness.server.baseUrl}/api/settings/model-overrides/${encodeURIComponent(getOpenRouterModelOverrideKey(unverified.modelId))}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerEnabled: false }),
      },
    );
    expect(disableUnverifiedResponse.status).toBe(200);
    await expect(readModelOverrides(harness.dataDir)).resolves.toMatchObject({
      overrides: {
        [getOpenRouterModelOverrideKey(unverified.modelId)]: { managerEnabled: false },
      },
    });
    expect(harness.swarmManager.notifyModelSpecificInstructionsChanged).not.toHaveBeenCalled();

    const leftoverKey = getOpenRouterModelOverrideKey(toolCapable.modelId);
    await writeModelOverrides(harness.dataDir, {
      version: 1,
      overrides: {
        [leftoverKey]: {
          enabled: false,
          managerEnabled: false,
          contextWindowCap: 8_192,
          modelSpecificInstructions: "do not persist this",
        },
      },
    });
    const leftoverResponse = await fetch(
      `${harness.server.baseUrl}/api/settings/model-overrides/${encodeURIComponent(leftoverKey)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          managerEnabled: true,
          enabled: true,
          contextWindowCap: 1_000,
          modelSpecificInstructions: "should not write",
        }),
      },
    );
    expect(leftoverResponse.status).toBe(400);
    await expect(readModelOverrides(harness.dataDir)).resolves.toMatchObject({
      overrides: {
        [leftoverKey]: {
          enabled: false,
          managerEnabled: false,
          contextWindowCap: 8_192,
          modelSpecificInstructions: "do not persist this",
        },
      },
    });
    const leftoverToggleResponse = await fetch(
      `${harness.server.baseUrl}/api/settings/model-overrides/${encodeURIComponent(leftoverKey)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerEnabled: true }),
      },
    );
    expect(leftoverToggleResponse.status).toBe(200);
    await expect(readModelOverrides(harness.dataDir)).resolves.toMatchObject({
      overrides: {
        [leftoverKey]: {
          enabled: false,
          managerEnabled: true,
          contextWindowCap: 8_192,
          modelSpecificInstructions: "do not persist this",
        },
      },
    });
    const nullResponse = await fetch(
      `${harness.server.baseUrl}/api/settings/model-overrides/${encodeURIComponent(leftoverKey)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerEnabled: null }),
      },
    );
    expect(nullResponse.status).toBe(200);
    await expect(readModelOverrides(harness.dataDir)).resolves.toMatchObject({
      overrides: {
        [leftoverKey]: {
          enabled: false,
          contextWindowCap: 8_192,
          modelSpecificInstructions: "do not persist this",
        },
      },
    });
    expect(harness.swarmManager.notifyModelSpecificInstructionsChanged).not.toHaveBeenCalled();
  });
});

async function createModelConfigRouteHarness(options: { credentialPoolService?: unknown } = {}): Promise<ModelConfigRouteHarness> {
  const tempConfig = await createTempConfig({ prefix: "forge-model-config-routes-" });
  const dataDir = tempConfig.config.paths.dataDir;
  tempRoots.push(tempConfig.tempRootDir);
  await modelCatalogService.loadOverrides(dataDir);

  const swarmManager = {
    getConfig: () => tempConfig.config,
    getCredentialPoolService: vi.fn(() => options.credentialPoolService),
    reloadModelCatalogOverridesAndProjection: vi.fn(async () => {
      await modelCatalogService.loadOverrides(dataDir);
    }),
    notifyModelSpecificInstructionsChanged: vi.fn(async () => undefined),
  };
  const broadcastEvent = vi.fn();
  const routes = createModelConfigRoutes({
    swarmManager: swarmManager as never,
    broadcastEvent,
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
  return {
    server: testServer,
    dataDir,
    broadcastEvent,
    swarmManager,
  };
}

async function handleRouteRequest(
  routes: ReturnType<typeof createModelConfigRoutes>,
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

  await route.handle(request, response, requestUrl);
}
