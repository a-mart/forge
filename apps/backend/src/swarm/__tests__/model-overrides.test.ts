import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSharedModelOverridesPath } from "../data-paths.js";
import { ModelCatalogService } from "../model-catalog-service.js";
import * as modelOverrides from "../catalog/model-overrides.js";
import * as openRouterModels from "../catalog/openrouter-models.js";
import { readModelOverrides, writeModelOverrides } from "../model-overrides.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-model-overrides-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("model-overrides", () => {
  it("returns an empty override file when none exists", async () => {
    const dataDir = await makeTempDataDir();
    await expect(readModelOverrides(dataDir)).resolves.toEqual({
      version: 1,
      overrides: {},
    });
  });

  it("ignores malformed override files", async () => {
    const dataDir = await makeTempDataDir();
    const filePath = getSharedModelOverridesPath(dataDir);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not-json", "utf8");

    await expect(readModelOverrides(dataDir)).resolves.toEqual({
      version: 1,
      overrides: {},
    });
  });

  it("applies override caps and disabled defaults through the catalog service", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "claude-opus-4-6": {
          enabled: false,
          contextWindowCap: 300_000,
        },
        "claude-opus-4-7": {
          enabled: false,
        },
      },
    });

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);

    expect(service.getEffectiveContextWindow("claude-opus-4-6")).toBe(300_000);
    expect(service.isModelEnabled("claude-opus-4-6")).toBe(false);
    const opusPreset = service.getModelPresetInfoList().find((preset) => preset.presetId === "pi-opus");
    expect(opusPreset?.modelId).toBe("claude-opus-5");
    expect(service.resolveModelDescriptorFromFamily("pi-opus")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5",
      thinkingLevel: "high",
    });
  });

  it("maps persisted Claude SDK overrides in memory with deterministic collision rules", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "claude-sdk/claude-opus-4-6": {
          enabled: true,
          managerEnabled: false,
          contextWindowCap: 250_000,
          modelSpecificInstructions: "Legacy SDK instructions",
        },
        "claude-opus-4-6": {
          enabled: false,
          managerEnabled: true,
          contextWindowCap: 300_000,
          modelSpecificInstructions: "Canonical Anthropic instructions",
        },
        "claude-sdk/unknown-future-model": {
          enabled: true,
        },
      },
    });

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);

    expect(service.getOverrides()).toEqual({
      "claude-opus-4-6": {
        enabled: false,
        managerEnabled: false,
        contextWindowCap: 250_000,
        modelSpecificInstructions: "Canonical Anthropic instructions",
      },
    });
    expect(service.getEffectiveContextWindow("claude-opus-4-6", "anthropic")).toBe(250_000);
    expect(service.getEffectiveModelSpecificInstructions("claude-opus-4-6", "anthropic")).toBe(
      "Canonical Anthropic instructions",
    );
    await expect(readModelOverrides(dataDir)).resolves.toHaveProperty(
      "overrides.claude-sdk/claude-opus-4-6",
    );
  });

  it("preserves managerEnabled alongside other override fields", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "claude-opus-4-7": {
          enabled: true,
          managerEnabled: false,
          contextWindowCap: 500_000,
        },
        invalid: {
          managerEnabled: "nope" as never,
        },
      },
    });

    await expect(readModelOverrides(dataDir)).resolves.toEqual({
      version: 1,
      overrides: {
        "claude-opus-4-7": {
          enabled: true,
          managerEnabled: false,
          contextWindowCap: 500_000,
        },
      },
    });
  });

  it("preserves non-empty model-specific instructions and omits empty overrides on write", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "gpt-5.5": {
          modelSpecificInstructions: "Line one\r\nLine two",
        },
        "claude-opus-4-6": {
          modelSpecificInstructions: "",
        },
        "claude-sdk/claude-opus-4-6": {
          modelSpecificInstructions: "   \r\n\t  ",
        },
        empty: {},
      },
    });

    await expect(readModelOverrides(dataDir)).resolves.toEqual({
      version: 1,
      overrides: {
        "gpt-5.5": {
          modelSpecificInstructions: "Line one\nLine two",
        },
      },
    });
  });

  it("ignores empty model-specific instructions in an existing legacy override file", async () => {
    const dataDir = await makeTempDataDir();
    const filePath = getSharedModelOverridesPath(dataDir);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      version: 1,
      overrides: {
        "gpt-5.5": {
          modelSpecificInstructions: "",
        },
        "claude-opus-4-6": {
          enabled: false,
          modelSpecificInstructions: "   \r\n\t  ",
        },
      },
    }), "utf8");

    await expect(readModelOverrides(dataDir)).resolves.toEqual({
      version: 1,
      overrides: {
        "claude-opus-4-6": {
          enabled: false,
        },
      },
    });
  });

  it("resolves only user-authored model-specific instructions", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "gpt-5.5": {
          modelSpecificInstructions: "Custom GPT instructions",
        },
        "claude-opus-4-6": {
          modelSpecificInstructions: "",
        },
      },
    });

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);

    expect(service.getEffectiveModelSpecificInstructions("gpt-5.4")).toBeUndefined();
    expect(service.getEffectiveModelSpecificInstructions("claude-haiku-4-5-20251001")).toBeUndefined();
    expect(service.getEffectiveModelSpecificInstructions("claude-opus-4-6", "claude-sdk")).toBeUndefined();
    expect(service.getEffectiveModelSpecificInstructions("grok-4")).toBeUndefined();
    expect(service.getEffectiveModelSpecificInstructions("gpt-5.5")).toBe("Custom GPT instructions");
    expect(service.getEffectiveModelSpecificInstructions("claude-opus-4-6")).toBeUndefined();
  });

  it("does not let an older overlapping loadOverrides replace a newer mutation", async () => {
    const dataDir = await makeTempDataDir();
    let releaseStale!: () => void;
    let resolveStaleStarted!: () => void;
    const staleStarted = new Promise<void>((resolve) => {
      resolveStaleStarted = resolve;
    });
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let overrideReads = 0;

    vi.spyOn(modelOverrides, "readModelOverrides").mockImplementation(async () => {
      overrideReads += 1;
      if (overrideReads === 1) {
        resolveStaleStarted();
        await staleGate;
        return { version: 1, overrides: { "claude-fable-5-1": { managerEnabled: false } } };
      }
      return { version: 1, overrides: { "claude-fable-5-1": { managerEnabled: true } } };
    });
    vi.spyOn(openRouterModels, "readOpenRouterModels").mockResolvedValue({
      version: 1,
      models: {},
    });

    const service = new ModelCatalogService();
    const staleLoad = service.loadOverrides(dataDir);
    await staleStarted.promise;
    await service.loadOverrides(dataDir);
    releaseStale();
    await staleLoad;

    expect(service.getOverrides()["claude-fable-5-1"]).toEqual({ managerEnabled: true });
  });
});
