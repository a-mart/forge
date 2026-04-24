import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveModelDescriptorFromPreset } from "../model-presets.js";
import { modelCatalogService } from "../model-catalog-service.js";
import { writeModelOverrides } from "../model-overrides.js";
import { resolveExactManagerModelSelection } from "../catalog/manager-model-selection.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-manager-model-selection-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  const cleanDirectory = await mkdtemp(join(tmpdir(), "forge-manager-model-selection-clean-"));
  tempDirs.push(cleanDirectory);
  await modelCatalogService.loadOverrides(cleanDirectory);
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("manager model selection", () => {
  it("resolves exact Anthropic and Claude SDK Opus 4.6/4.7 selections distinctly", async () => {
    const dataDir = await makeTempDataDir();
    await modelCatalogService.loadOverrides(dataDir);

    expect(
      resolveExactManagerModelSelection(
        { provider: "anthropic", modelId: "claude-opus-4-6" },
        { surface: "change", providerAvailability: new Map([["anthropic", true]]) },
      )
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      thinkingLevel: "high",
    });

    expect(
      resolveExactManagerModelSelection(
        { provider: "anthropic", modelId: "claude-opus-4-7" },
        { surface: "change", providerAvailability: new Map([["anthropic", true]]) },
      )
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      thinkingLevel: "high",
    });

    expect(
      resolveExactManagerModelSelection(
        { provider: "claude-sdk", modelId: "claude-opus-4-7" },
        { surface: "change", providerAvailability: new Map([["claude-sdk", true]]) },
      )
    ).toEqual({
      provider: "claude-sdk",
      modelId: "claude-opus-4-7",
      thinkingLevel: "high",
    });
  });

  it("rejects exact manager selection when managerEnabled is false", async () => {
    const dataDir = await makeTempDataDir();
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "claude-opus-4-7": {
          managerEnabled: false,
        },
      },
    });
    await modelCatalogService.loadOverrides(dataDir);

    expect(() =>
      resolveExactManagerModelSelection(
        { provider: "anthropic", modelId: "claude-opus-4-7" },
        { surface: "change", providerAvailability: new Map([["anthropic", true]]) },
      )
    ).toThrow("Model Claude Opus 4.7 is disabled for manager agents");
  });

  it("keeps legacy pi-opus preset resolution unchanged", async () => {
    expect(resolveModelDescriptorFromPreset("pi-opus")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      thinkingLevel: "high",
    });
  });
});
