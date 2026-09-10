import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenRouterModelEntry } from "@forge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as openRouterStorage from "../catalog/openrouter-models.js";
import { getOpenRouterModelsPath } from "../data-paths.js";
import { ModelCatalogService } from "../model-catalog-service.js";
import {
  addOpenRouterModel,
  getOpenRouterModels,
  readOpenRouterModels,
  removeOpenRouterModel,
  writeOpenRouterModels,
  mutateOpenRouterModelsFile,
  getOpenRouterRoutingRevision,
} from "../openrouter-models.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-openrouter-models-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("openrouter-models", () => {
  it("returns an empty model file when none exists", async () => {
    const dataDir = await makeTempDataDir();

    await expect(readOpenRouterModels(dataDir)).resolves.toEqual({
      version: 1,
      models: {},
    });
    await expect(getOpenRouterModels(dataDir)).resolves.toEqual([]);
  });

  it("preserves persisted retired entries while hiding and rejecting them", async () => {
    const dataDir = await makeTempDataDir();
    const adjacentModel = {
      modelId: "anthropic/claude-3.5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"],
      inputModes: ["text", "image"],
      addedAt: "2026-04-03T00:00:00.000Z",
    } satisfies OpenRouterModelEntry;
    const retiredModels = [
      {
        modelId: "anthropic/claude-haiku-4.5",
        displayName: "Claude Haiku 4.5",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsReasoning: true,
        supportedReasoningLevels: ["low", "medium", "high"],
        inputModes: ["text", "image"],
        addedAt: "2026-07-26T00:00:00.000Z",
      },
      {
        modelId: "openai/gpt-5.3-codex-spark",
        displayName: "GPT-5.3 Codex Spark",
        contextWindow: 128_000,
        maxOutputTokens: 128_000,
        supportsReasoning: true,
        supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
        inputModes: ["text"],
        addedAt: "2026-07-26T00:00:00.000Z",
      },
    ] satisfies OpenRouterModelEntry[];

    await writeOpenRouterModels(dataDir, {
      version: 1,
      models: {
        [adjacentModel.modelId]: adjacentModel,
        ...Object.fromEntries(retiredModels.map((model) => [model.modelId, model])),
      },
    });

    const persisted = await readOpenRouterModels(dataDir);
    for (const retiredModel of retiredModels) {
      expect(persisted.models).toHaveProperty(retiredModel.modelId);
      await expect(addOpenRouterModel(dataDir, retiredModel)).rejects.toThrow(
        "Retired OpenRouter model cannot be added",
      );
    }

    await expect(getOpenRouterModels(dataDir)).resolves.toEqual([adjacentModel]);

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);
    expect(service.getOpenRouterModels()).toEqual([adjacentModel]);
    expect(service.isKnownModelId(adjacentModel.modelId, "openrouter")).toBe(true);
    expect(service.inferProvider(adjacentModel.modelId)).toBe("openrouter");
    expect(service.isModelEnabled(adjacentModel.modelId, "openrouter")).toBe(true);
    expect(service.getAllModelIds()).toContain(adjacentModel.modelId);

    for (const retiredModel of retiredModels) {
      expect(service.isKnownModelId(retiredModel.modelId, "openrouter")).toBe(false);
      expect(service.inferProvider(retiredModel.modelId)).toBeNull();
      expect(service.isModelEnabled(retiredModel.modelId, "openrouter")).toBe(false);
      expect(service.getAllModelIds()).not.toContain(retiredModel.modelId);
    }
  });

  it("supports add/list/remove CRUD operations and catalog service reloads", async () => {
    const dataDir = await makeTempDataDir();

    await addOpenRouterModel(dataDir, {
      modelId: "anthropic/claude-3.5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"],
      inputModes: ["text", "image"],
      addedAt: "2026-04-03T00:00:00.000Z",
    });

    expect(await getOpenRouterModels(dataDir)).toEqual([
      {
        modelId: "anthropic/claude-3.5-sonnet",
        displayName: "Claude 3.5 Sonnet",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsReasoning: true,
        supportedReasoningLevels: ["none", "low", "medium", "high"],
        inputModes: ["text", "image"],
        addedAt: "2026-04-03T00:00:00.000Z",
      },
    ]);

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);

    expect(service.isKnownModelId("anthropic/claude-3.5-sonnet")).toBe(true);
    expect(service.inferProvider("anthropic/claude-3.5-sonnet")).toBe("openrouter");
    expect(service.getOpenRouterModels()).toEqual([
      {
        modelId: "anthropic/claude-3.5-sonnet",
        displayName: "Claude 3.5 Sonnet",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsReasoning: true,
        supportedReasoningLevels: ["none", "low", "medium", "high"],
        inputModes: ["text", "image"],
        addedAt: "2026-04-03T00:00:00.000Z",
      },
    ]);

    await addOpenRouterModel(dataDir, {
      modelId: "google/gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      supportsReasoning: false,
      supportedReasoningLevels: ["none"],
      inputModes: ["text", "image"],
      addedAt: "2026-04-03T00:05:00.000Z",
    });
    await service.reloadOpenRouterModels();

    expect(service.getOpenRouterModels().map((model) => model.modelId)).toEqual([
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash",
    ]);

    await removeOpenRouterModel(dataDir, "anthropic/claude-3.5-sonnet");
    await service.reloadOpenRouterModels();

    expect(service.isKnownModelId("anthropic/claude-3.5-sonnet")).toBe(false);
    expect(service.getOpenRouterModels().map((model) => model.modelId)).toEqual([
      "google/gemini-2.0-flash",
    ]);
  });

  it("writes atomically via temp-file rename", async () => {
    const dataDir = await makeTempDataDir();
    const filePath = getOpenRouterModelsPath(dataDir);
    const fileDir = dirname(filePath);

    await addOpenRouterModel(dataDir, {
      modelId: "qwen/qwen3-coder:free",
      displayName: "Qwen3 Coder Free",
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"],
      inputModes: ["text"],
      addedAt: "2026-04-03T00:10:00.000Z",
    });

    const storedAfterAdd = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      models: Record<string, { modelId: string }>;
    };

    expect(storedAfterAdd.version).toBe(1);
    expect(storedAfterAdd.models["qwen/qwen3-coder:free"]?.modelId).toBe("qwen/qwen3-coder:free");
    expect((await readdir(fileDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    await removeOpenRouterModel(dataDir, "qwen/qwen3-coder:free");

    const storedAfterRemove = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      models: Record<string, unknown>;
    };

    expect(storedAfterRemove).toEqual({ version: 1, models: {} });
    expect((await readdir(fileDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects malformed JSON while preserving legacy metadata sanitization", async () => {
    const dataDir = await makeTempDataDir();
    const filePath = getOpenRouterModelsPath(dataDir);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "", "utf8");
    await expect(readOpenRouterModels(dataDir)).rejects.toThrow();

    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        models: {
          "gpt-5": {
            modelId: "gpt-5",
            displayName: "Invalid no-slash model",
            contextWindow: 128_000,
            maxOutputTokens: 8_192,
            supportsReasoning: true,
            supportedReasoningLevels: ["none", "low"],
            inputModes: ["text"],
            addedAt: "2026-04-03T00:00:00.000Z",
          },
          "anthropic/claude-3.5-sonnet": {
            modelId: "anthropic/claude-3.5-sonnet",
            displayName: "Claude 3.5 Sonnet",
            contextWindow: 200_000,
            maxOutputTokens: 8_192,
            supportsReasoning: false,
            supportedReasoningLevels: ["low"],
            inputModes: ["text", "audio"],
            addedAt: "not-a-date",
          },
        },
      }),
      "utf8",
    );

    await expect(readOpenRouterModels(dataDir)).resolves.toEqual({
      version: 1,
      models: {},
    });
  });

  it("preserves missing, true, and false supportsTools while dropping non-boolean values",
    async () => {
      const dataDir = await makeTempDataDir();
      const filePath = getOpenRouterModelsPath(dataDir);
      const legacy = {
        modelId: "anthropic/claude-3.5-sonnet",
        displayName: "Claude 3.5 Sonnet",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsReasoning: true,
        supportedReasoningLevels: ["none", "low", "medium", "high"],
        inputModes: ["text", "image"],
        addedAt: "2026-04-03T00:00:00.000Z",
      } satisfies OpenRouterModelEntry;
      const toolCapable = {
        ...legacy,
        modelId: "z-ai/glm-5.1",
        displayName: "GLM 5.1",
        supportsTools: true,
      } satisfies OpenRouterModelEntry;
      const noTools = {
        ...legacy,
        modelId: "google/gemini-2.0-flash",
        displayName: "Gemini 2.0 Flash",
        supportsReasoning: false,
        supportedReasoningLevels: ["none"],
        supportsTools: false,
      } satisfies OpenRouterModelEntry;

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          models: {
            [legacy.modelId]: legacy,
            [toolCapable.modelId]: toolCapable,
            [noTools.modelId]: noTools,
            "invalid/tools": {
              ...legacy,
              modelId: "invalid/tools",
              supportsTools: "yes",
            },
          },
        }),
        "utf8",
      );

      await expect(readOpenRouterModels(dataDir)).resolves.toEqual({
        version: 1,
        models: {
          [legacy.modelId]: legacy,
          [toolCapable.modelId]: toolCapable,
          [noTools.modelId]: noTools,
        },
      });

      await addOpenRouterModel(dataDir, toolCapable);
      const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
        models: Record<string, OpenRouterModelEntry>;
      };
      expect(persisted.models[toolCapable.modelId]?.supportsTools).toBe(true);
      expect(persisted.models[legacy.modelId]?.supportsTools).toBeUndefined();
    },
  );
});


describe("OpenRouter routing persistence", () => {
  it("fails closed until initialized, while initialized legacy absence stays unrestricted", async () => {
    const service = new ModelCatalogService();
    expect(() => service.getEffectiveOpenRouterRouting("test/model")).toThrow("not initialized");
    await service.loadOverrides(await makeTempDataDir());
    expect(service.getEffectiveOpenRouterRouting("test/model")).toEqual({});
  });

  it("does not let an obsolete failed load poison a newer policy snapshot", async () => {
    const dataDir = await makeTempDataDir();
    await writeOpenRouterModels(dataDir, { version: 1, models: {}, routingDefaults: { zdr: true } });
    let rejectOld!: (error: Error) => void;
    const oldRead = new Promise<never>((_, reject) => { rejectOld = reject; });
    const spy = vi.spyOn(openRouterStorage, "readOpenRouterModels").mockImplementationOnce(() => oldRead);
    try {
      const service = new ModelCatalogService();
      const obsoleteLoad = service.loadOverrides(dataDir);
      await service.loadOverrides(dataDir);
      rejectOld(new Error("obsolete read failed"));
      await obsoleteLoad;
      expect(service.getEffectiveOpenRouterRouting("test/model")).toEqual({ zdr: true });
    } finally {
      spy.mockRestore();
    }
  });

  const model: OpenRouterModelEntry = { modelId: "test/model", displayName: "Test", contextWindow: 1000, maxOutputTokens: 100, supportsReasoning: false, supportedReasoningLevels: ["none"], inputModes: ["text"], addedAt: "2026-09-10T00:00:00Z", routing: { only: ["azure/eu"], order: null } };
  it("round trips all routing, resolves defaults for unadded ids, and survives metadata changes", async () => {
    const dataDir = await makeTempDataDir();
    const file = { version: 1 as const, routingDefaults: { zdr: true, data_collection: "deny" as const, order: ["azure"], require_parameters: true, allow_fallbacks: false, max_price: { prompt: 1, completion: 2 }, quantizations: ["fp8" as const] }, models: { [model.modelId]: model } };
    await writeOpenRouterModels(dataDir, file);
    expect(await readOpenRouterModels(dataDir)).toEqual(file);
    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);
    expect(service.getEffectiveOpenRouterRouting("not-added/model")).toEqual(file.routingDefaults);
    expect(service.getEffectiveOpenRouterRouting(model.modelId)).toMatchObject({ zdr: true, only: ["azure/eu"] });
    expect(service.getEffectiveOpenRouterRouting(model.modelId).order).toBeUndefined();
    await mutateOpenRouterModelsFile(dataDir, (current) => ({ ...current, models: { ...current.models, [model.modelId]: { ...current.models[model.modelId], supportsTools: true } } }));
    await service.reloadOpenRouterModels();
    expect(service.getOpenRouterModel(model.modelId)?.routing).toEqual(model.routing);
  });
  it("serializes mutation plus apply/rollback, preserving the later write", async () => {
    const dataDir = await makeTempDataDir();
    await writeOpenRouterModels(dataDir, { version: 1, models: {}, routingDefaults: { zdr: true } });
    const before = await readOpenRouterModels(dataDir);
    let calls = 0;
    const first = mutateOpenRouterModelsFile(dataDir, (file) => ({ ...file, routingDefaults: { zdr: false } }), async () => { if (++calls === 1) throw new Error("apply failed"); });
    const second = mutateOpenRouterModelsFile(dataDir, (file) => ({ ...file, routingDefaults: { ...file.routingDefaults, require_parameters: true } }));
    await expect(first).rejects.toThrow("apply failed");
    await second;
    const after = await readOpenRouterModels(dataDir);
    expect(after.routingDefaults).toEqual({ zdr: true, require_parameters: true });
    expect(getOpenRouterRoutingRevision(after)).not.toBe(getOpenRouterRoutingRevision(before));
  });
  it("rejects invalid persisted policy and mismatched identities without breaking non-OpenRouter boot", async () => {
    const dataDir = await makeTempDataDir();
    const path = getOpenRouterModelsPath(dataDir);
    await mkdir(dirname(path), { recursive: true });
    for (const value of ["{bad", JSON.stringify({ version: 1, models: {}, routingDefaults: { zdr: "true" } }), JSON.stringify({ version: 1, models: { wrong: model, [model.modelId]: { ...model, routing: {} } } })]) {
      await writeFile(path, value);
      await expect(readOpenRouterModels(dataDir)).rejects.toThrow();
      const service = new ModelCatalogService();
      await expect(service.loadOverrides(dataDir)).resolves.toBeUndefined();
      expect(() => service.getEffectiveOpenRouterRouting("unadded/model")).toThrow("unreadable");
      expect(service.getModel("gpt-5.5", "openai-codex")).toBeDefined();
    }
  });
  it("rejects invalid updates without changing durable configuration", async () => {
    const dataDir = await makeTempDataDir();
    await writeOpenRouterModels(dataDir, { version: 1, models: {}, routingDefaults: { zdr: true } });
    const before = await readFile(getOpenRouterModelsPath(dataDir), "utf8");
    await expect(mutateOpenRouterModelsFile(dataDir, (current) => ({ ...current, routingDefaults: { only: [] } }))).rejects.toThrow();
    expect(await readFile(getOpenRouterModelsPath(dataDir), "utf8")).toBe(before);
  });
});
