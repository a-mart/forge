import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getOpenRouterModelsPath } from "../data-paths.js";
import { ModelCatalogService } from "../model-catalog-service.js";
import {
  addOpenRouterModel,
  getOpenRouterModels,
  readOpenRouterModels,
  removeOpenRouterModel,
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

  it("treats empty, invalid, and malformed files as empty storage", async () => {
    const dataDir = await makeTempDataDir();
    const filePath = getOpenRouterModelsPath(dataDir);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "", "utf8");
    await expect(readOpenRouterModels(dataDir)).resolves.toEqual({
      version: 1,
      models: {},
    });

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
});
