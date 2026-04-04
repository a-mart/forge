import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSharedModelOverridesPath } from "../data-paths.js";
import { ModelCatalogService } from "../model-catalog-service.js";
import { readModelOverrides, writeModelOverrides } from "../model-overrides.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-model-overrides-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
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
        "claude-sdk/claude-opus-4-6": {
          enabled: true,
          contextWindowCap: 250_000,
        },
      },
    });

    const service = new ModelCatalogService();
    await service.loadOverrides(dataDir);

    expect(service.getEffectiveContextWindow("claude-opus-4-6")).toBe(300_000);
    expect(service.isModelEnabled("claude-opus-4-6")).toBe(false);
    expect(service.getEffectiveContextWindow("claude-opus-4-6", "claude-sdk")).toBe(250_000);
    expect(service.isModelEnabled("claude-opus-4-6", "claude-sdk")).toBe(true);

    const opusPreset = service.getModelPresetInfoList().find((preset) => preset.presetId === "pi-opus");
    expect(opusPreset?.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(service.resolveModelDescriptorFromFamily("pi-opus")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
      thinkingLevel: "medium",
    });
  });
});
