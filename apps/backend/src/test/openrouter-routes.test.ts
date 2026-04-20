import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModels } from "@mariozechner/pi-ai";
import type { SwarmConfig } from "../swarm/types.js";
import { getOpenRouterModelsPath } from "../swarm/data-paths.js";
import { getPiModelsProjectionPath } from "../swarm/model-catalog-projection.js";
import { resetLiveOpenRouterModelsCacheForTests } from "../ws/routes/openrouter-routes.js";
import { SwarmWebSocketServer } from "../ws/server.js";
import { TestSwarmManager, bootWithDefaultManager, createTempConfig, getAvailablePort } from "../test-support/index.js";

const tempRoots: string[] = [];
const TEST_OPENROUTER_MODEL_ID =
  getModels("openrouter").find((model) => model.id === "anthropic/claude-3.7-sonnet")?.id ??
  "anthropic/claude-3.7-sonnet";

afterEach(async () => {
  resetLiveOpenRouterModelsCacheForTests();
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => removeTempRoot(root)));
  delete process.env.OPENROUTER_API_KEY;
});

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  await rm(root, { recursive: true, force: true });
}

async function makeTempConfig(port: number): Promise<SwarmConfig> {
  const handle = await createTempConfig({ prefix: "forge-openrouter-routes-", port });
  tempRoots.push(handle.tempRootDir);
  return handle.config;
}

async function startServer(): Promise<{
  config: SwarmConfig;
  manager: TestSwarmManager;
  server: SwarmWebSocketServer;
}> {
  const port = await getAvailablePort();
  const config = await makeTempConfig(port);
  const manager = new TestSwarmManager(config);
  await bootWithDefaultManager(manager, config, { clearBootstrapSendCalls: false });

  const server = new SwarmWebSocketServer({
    swarmManager: manager,
    host: config.host,
    port: config.port,
    allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
  });
  await server.start();

  return { config, manager, server };
}

describe("openrouter-routes", () => {
  it("lists available OpenRouter models from Pi's built-in catalog", async () => {
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://openrouter.ai/api/v1/models") {
        throw new Error("network unavailable in test");
      }

      return originalFetch(input as Parameters<typeof fetch>[0], init);
    });

    const { config, server } = await startServer();

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/available-models`);
      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        models: Array<{
          modelId: string;
          displayName: string;
          upstreamProvider: string;
          contextWindow: number;
          maxOutputTokens: number;
          supportsReasoning: boolean;
          supportsTools: boolean;
          inputModes: string[];
          pricing: { inputPerMillion: number; outputPerMillion: number } | null;
        }>;
      };

      expect(payload.models.length).toBeGreaterThan(0);
      const claude = payload.models.find((model) => model.modelId === TEST_OPENROUTER_MODEL_ID);
      expect(claude).toMatchObject({
        modelId: TEST_OPENROUTER_MODEL_ID,
        upstreamProvider: "anthropic",
      });
      expect(claude?.displayName.length ?? 0).toBeGreaterThan(0);
      expect(claude?.contextWindow ?? 0).toBeGreaterThan(0);
      expect(claude?.maxOutputTokens ?? 0).toBeGreaterThan(0);
      expect(typeof claude?.supportsReasoning).toBe("boolean");
      expect(typeof claude?.supportsTools).toBe("boolean");
      expect(Array.isArray(claude?.inputModes)).toBe(true);
      if (claude?.pricing) {
        expect(claude.pricing.inputPerMillion).toBeGreaterThanOrEqual(0);
        expect(claude.pricing.outputPerMillion).toBeGreaterThanOrEqual(0);
        expect(claude.pricing.inputPerMillion).toBeLessThan(1_000);
      }
    } finally {
      await server.stop();
    }
  });

  it("merges live OpenRouter API models into the available catalog and caches the live response", async () => {
    const originalFetch = globalThis.fetch;
    const liveModel = {
      id: "z-ai/glm-5.1",
      name: "Z.ai: GLM 5.1",
      context_length: 202_752,
      max_completion_tokens: 202_752,
      pricing: {
        prompt: 0.000001,
        completion: 0.0000032,
      },
      supported_parameters: ["reasoning", "tools"],
      architecture: {
        modality: "text->text",
      },
      top_provider: {
        max_completion_tokens: 202_752,
      },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://openrouter.ai/api/v1/models") {
        return new Response(JSON.stringify({ data: [liveModel] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return originalFetch(input as Parameters<typeof fetch>[0], init);
    });

    const { config, server } = await startServer();

    try {
      const firstResponse = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/available-models`);
      expect(firstResponse.status).toBe(200);
      const firstPayload = (await firstResponse.json()) as {
        models: Array<{ modelId: string; displayName: string; supportsReasoning: boolean; supportsTools: boolean }>;
      };

      expect(firstPayload.models).toContainEqual(
        expect.objectContaining({
          modelId: TEST_OPENROUTER_MODEL_ID,
        }),
      );
      expect(firstPayload.models).toContainEqual(
        expect.objectContaining({
          modelId: "z-ai/glm-5.1",
          displayName: "Z.ai: GLM 5.1",
          supportsReasoning: true,
          supportsTools: true,
        }),
      );

      const secondResponse = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/available-models`);
      expect(secondResponse.status).toBe(200);
      await secondResponse.json();

      expect(fetchSpy.mock.calls.filter(([input]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return url === "https://openrouter.ai/api/v1/models";
      })).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("adds live-only OpenRouter models from request metadata", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { config, manager, server } = await startServer();
    const modelId = "z-ai/glm-5.1";
    const projectionPath = getPiModelsProjectionPath(config.paths.dataDir);
    const reloadSpy = vi.spyOn(manager, "reloadOpenRouterModelsAndProjection");

    try {
      const addResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: {
              modelId,
              displayName: "Z.ai: GLM 5.1",
              upstreamProvider: "z-ai",
              contextWindow: 202_752,
              maxOutputTokens: 202_752,
              supportsReasoning: true,
              supportsTools: true,
              inputModes: ["text"],
              pricing: {
                inputPerMillion: 1,
                outputPerMillion: 3.2,
              },
            },
          }),
        },
      );
      expect(addResponse.status).toBe(200);
      const added = (await addResponse.json()) as {
        modelId: string;
        displayName: string;
        supportedReasoningLevels: string[];
        inputModes: string[];
      };
      expect(added).toMatchObject({
        modelId,
        displayName: "Z.ai: GLM 5.1",
        supportedReasoningLevels: ["none", "low", "medium", "high"],
        inputModes: ["text"],
      });
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      const storedFile = JSON.parse(await readFile(getOpenRouterModelsPath(config.paths.dataDir), "utf8")) as {
        models: Record<string, { modelId: string; displayName: string }>;
      };
      expect(storedFile.models[modelId]).toMatchObject({
        modelId,
        displayName: "Z.ai: GLM 5.1",
      });

      const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, { models?: Array<{ id: string }> }>;
      };
      expect(projection.providers.openrouter?.models).toEqual([
        expect.objectContaining({ id: modelId }),
      ]);
    } finally {
      reloadSpy.mockRestore();
      await server.stop();
    }
  });

  it("returns stored OpenRouter models with isConfigured=false when no credential is present", async () => {
    const { config, server } = await startServer();

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        models: unknown[];
        isConfigured: boolean;
      };

      expect(payload.models).toEqual([]);
      expect(payload.isConfigured).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("returns stored OpenRouter models with credential availability", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { config, server } = await startServer();

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        models: unknown[];
        isConfigured: boolean;
      };

      expect(payload.models).toEqual([]);
      expect(payload.isConfigured).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("adds and removes URL-encoded model ids, regenerates the projection, and exposes OpenRouter selector entries", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { config, manager, server } = await startServer();
    const modelId = TEST_OPENROUTER_MODEL_ID;
    const projectionPath = getPiModelsProjectionPath(config.paths.dataDir);
    const reloadSpy = vi.spyOn(manager, "reloadOpenRouterModelsAndProjection");

    try {
      const initialProjection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(initialProjection.providers.openrouter).toBeUndefined();

      const addResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "PUT" },
      );
      expect(addResponse.status).toBe(200);
      const added = (await addResponse.json()) as {
        modelId: string;
        displayName: string;
        supportedReasoningLevels: string[];
        inputModes: string[];
        addedAt: string;
      };
      expect(added.modelId).toBe(modelId);
      expect(added.displayName.length).toBeGreaterThan(0);
      expect(added.supportedReasoningLevels.length).toBeGreaterThan(0);
      expect(added.inputModes.length).toBeGreaterThan(0);
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      const duplicateAddResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "PUT" },
      );
      expect(duplicateAddResponse.status).toBe(200);
      const duplicateAdded = (await duplicateAddResponse.json()) as { modelId: string; addedAt: string };
      expect(duplicateAdded.modelId).toBe(modelId);
      expect(duplicateAdded.addedAt).toBe(added.addedAt);
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      const storedFile = JSON.parse(await readFile(getOpenRouterModelsPath(config.paths.dataDir), "utf8")) as {
        models: Record<string, { modelId: string; addedAt: string }>;
      };
      expect(storedFile.models[modelId]?.modelId).toBe(modelId);
      expect(storedFile.models[modelId]?.addedAt).toBe(added.addedAt);

      const afterAddProjection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, { models?: Array<{ id: string }> }>;
      };
      expect(afterAddProjection.providers.openrouter?.models).toEqual([
        expect.objectContaining({ id: modelId }),
      ]);

      const openRouterModelsResponse = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(openRouterModelsResponse.status).toBe(200);
      const openRouterModelsPayload = (await openRouterModelsResponse.json()) as {
        models: Array<{ modelId: string }>;
        isConfigured: boolean;
      };
      expect(openRouterModelsPayload.isConfigured).toBe(true);
      expect(openRouterModelsPayload.models.map((model) => model.modelId)).toEqual([modelId]);

      const selectableResponse = await fetch(`http://${config.host}:${config.port}/api/settings/models`);
      expect(selectableResponse.status).toBe(200);
      const selectablePayload = (await selectableResponse.json()) as {
        models: Array<{ provider: string; modelId: string; presetId: string }>;
      };
      expect(selectablePayload.models).toContainEqual(
        expect.objectContaining({
          provider: "openrouter",
          modelId,
          presetId: `openrouter:${modelId}`,
        }),
      );

      const deleteResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(200);
      expect(reloadSpy).toHaveBeenCalledTimes(2);

      const afterDeleteProjection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(afterDeleteProjection.providers.openrouter).toBeUndefined();

      const afterDeleteModelsResponse = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(afterDeleteModelsResponse.status).toBe(200);
      const afterDeleteModelsPayload = (await afterDeleteModelsResponse.json()) as {
        models: Array<{ modelId: string }>;
      };
      expect(afterDeleteModelsPayload.models).toEqual([]);

      const afterDeleteSelectableResponse = await fetch(`http://${config.host}:${config.port}/api/settings/models`);
      expect(afterDeleteSelectableResponse.status).toBe(200);
      const afterDeleteSelectablePayload = (await afterDeleteSelectableResponse.json()) as {
        models: Array<{ provider: string; modelId: string; presetId: string }>;
      };
      expect(afterDeleteSelectablePayload.models).not.toContainEqual(
        expect.objectContaining({
          provider: "openrouter",
          modelId,
          presetId: `openrouter:${modelId}`,
        }),
      );
    } finally {
      reloadSpy.mockRestore();
      await server.stop();
    }
  });

  it("rolls back the stored model file when projection regeneration fails", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { config, manager, server } = await startServer();
    const modelId = TEST_OPENROUTER_MODEL_ID;
    const projectionPath = getPiModelsProjectionPath(config.paths.dataDir);
    const reloadSpy = vi
      .spyOn(manager, "reloadOpenRouterModelsAndProjection")
      .mockRejectedValueOnce(new Error("projection failed"));

    try {
      const addResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent(modelId)}`,
        { method: "PUT" },
      );
      expect(addResponse.status).toBe(500);
      await expect(addResponse.json()).resolves.toMatchObject({ error: "projection failed" });

      const openRouterModelsResponse = await fetch(`http://${config.host}:${config.port}/api/settings/openrouter/models`);
      expect(openRouterModelsResponse.status).toBe(200);
      const openRouterModelsPayload = (await openRouterModelsResponse.json()) as {
        models: Array<{ modelId: string }>;
      };
      expect(openRouterModelsPayload.models).toEqual([]);

      const storedFile = JSON.parse(await readFile(getOpenRouterModelsPath(config.paths.dataDir), "utf8")) as {
        models: Record<string, { modelId: string }>;
      };
      expect(storedFile.models[modelId]).toBeUndefined();

      const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(projection.providers.openrouter).toBeUndefined();
      expect(reloadSpy).toHaveBeenCalledTimes(2);
    } finally {
      reloadSpy.mockRestore();
      await server.stop();
    }
  });

  it("rejects unknown catalog additions and missing deletions", async () => {
    const { config, server } = await startServer();

    try {
      const unknownAddResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent("does/not-exist")}`,
        { method: "PUT" },
      );
      expect(unknownAddResponse.status).toBe(404);
      await expect(unknownAddResponse.json()).resolves.toMatchObject({
        error: "Unknown OpenRouter modelId: does/not-exist",
      });

      const unknownDeleteResponse = await fetch(
        `http://${config.host}:${config.port}/api/settings/openrouter/models/${encodeURIComponent("anthropic/claude-3.5-sonnet")}`,
        { method: "DELETE" },
      );
      expect(unknownDeleteResponse.status).toBe(404);
      await expect(unknownDeleteResponse.json()).resolves.toMatchObject({
        error: "Unknown OpenRouter modelId: anthropic/claude-3.5-sonnet",
      });
    } finally {
      await server.stop();
    }
  });
});
