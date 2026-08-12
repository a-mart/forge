import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveModelDescriptorFromPreset } from "../model-presets.js";
import { modelCatalogService } from "../model-catalog-service.js";
import { writeModelOverrides } from "../model-overrides.js";
import { resolveExactManagerModelSelection } from "../catalog/manager-model-selection.js";
import { parseXaiOAuthModelCatalog } from "../catalog/xai-oauth-model-discovery.js";

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
  modelCatalogService.setXaiOAuthDiscoveredModels(null);
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("manager model selection", () => {
  it("resolves exact native Anthropic Opus 4.6/4.7 selections", async () => {
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
  });

  it("rejects every new Claude SDK exact selection with remediation", async () => {
    const dataDir = await makeTempDataDir();
    await modelCatalogService.loadOverrides(dataDir);

    expect(() => resolveExactManagerModelSelection(
      { provider: "claude-sdk", modelId: "claude-opus-4-7" },
      { surface: "change", providerAvailability: new Map([["claude-sdk", true]]) },
    )).toThrow("Choose a native Anthropic model");
  });

  it("preserves supported exact GPT-5.6 Terra/Luna reasoning and clamps Luna Ultra to Max", async () => {
    const dataDir = await makeTempDataDir();
    await modelCatalogService.loadOverrides(dataDir);

    expect(
      resolveExactManagerModelSelection(
        { provider: "openai-codex", modelId: "gpt-5.6-terra" },
        { surface: "create", providerAvailability: new Map([["openai-codex", true]]), reasoningLevel: "ultra" },
      ),
    ).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "ultra",
    });

    expect(
      resolveExactManagerModelSelection(
        { provider: "openai-codex", modelId: "gpt-5.6-luna" },
        { surface: "create", providerAvailability: new Map([["openai-codex", true]]), reasoningLevel: "max" },
      ),
    ).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "max",
    });

    expect(
      resolveExactManagerModelSelection(
        { provider: "openai-codex", modelId: "gpt-5.6-luna" },
        { surface: "create", providerAvailability: new Map([["openai-codex", true]]), reasoningLevel: "ultra" },
      ),
    ).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "max",
    });
  });

  it.each(["grok-4.6", "grok-4.5"])(
    "resolves native xAI %s for every API-supported reasoning level",
    async (modelId) => {
      const dataDir = await makeTempDataDir();
      await modelCatalogService.loadOverrides(dataDir);

      for (const reasoningLevel of ["low", "medium", "high", "xhigh"] as const) {
        expect(resolveExactManagerModelSelection(
          { provider: "xai", modelId },
          { surface: "change", providerAvailability: new Map([["xai", true]]), reasoningLevel },
        )).toEqual({ provider: "xai", modelId, thinkingLevel: reasoningLevel });
      }
    },
  );

  it("uses OAuth-advertised Grok 4.5 reasoning levels while keeping dynamic models worker-only", async () => {
    const dataDir = await makeTempDataDir();
    await modelCatalogService.loadOverrides(dataDir);
    modelCatalogService.setXaiOAuthDiscoveredModels(parseXaiOAuthModelCatalog({
      data: [
        { id: "grok-4.6", supported_reasoning_levels: ["low", "medium", "high", "xhigh"], default_reasoning_level: "high" },
        { id: "grok-4.5", supported_reasoning_levels: ["low", "medium"], default_reasoning_level: "medium" },
        { id: "grok-build", context_window: 400_000, max_output_tokens: 40_000, supported_reasoning_levels: ["low", "medium"] },
      ],
    }));

    expect(resolveExactManagerModelSelection(
      { provider: "xai", modelId: "grok-4.6" },
      { surface: "create", providerAvailability: new Map([["xai", true]]), reasoningLevel: "xhigh" },
    )).toEqual({ provider: "xai", modelId: "grok-4.6", thinkingLevel: "xhigh" });
    expect(resolveExactManagerModelSelection(
      { provider: "xai", modelId: "grok-4.5" },
      { surface: "create", providerAvailability: new Map([["xai", true]]), reasoningLevel: "medium" },
    )).toEqual({ provider: "xai", modelId: "grok-4.5", thinkingLevel: "medium" });
    expect(resolveExactManagerModelSelection(
      { provider: "xai", modelId: "grok-4.5" },
      { surface: "create", providerAvailability: new Map([["xai", true]]), reasoningLevel: "xhigh" },
    )).toEqual({ provider: "xai", modelId: "grok-4.5", thinkingLevel: "medium" });
    expect(() => resolveExactManagerModelSelection(
      { provider: "xai", modelId: "grok-build" },
      { surface: "create", providerAvailability: new Map([["xai", true]]) },
    )).toThrow("Unknown manager model selection: xai/grok-build");
    modelCatalogService.setXaiOAuthDiscoveredModels(null);
  });

  it("rejects exact manager selection when provider availability is explicitly false", async () => {
    const dataDir = await makeTempDataDir();
    await modelCatalogService.loadOverrides(dataDir);

    expect(() =>
      resolveExactManagerModelSelection(
        { provider: "anthropic", modelId: "claude-opus-4-7" },
        { surface: "change", providerAvailability: new Map([["anthropic", false]]) },
      )
    ).toThrow("Provider anthropic is not configured for manager model selection");

    expect(() =>
      resolveExactManagerModelSelection(
        { provider: "xai", modelId: "grok-4.5" },
        { surface: "change", providerAvailability: new Map([["xai", false]]) },
      )
    ).toThrow("Provider xai is not configured for manager model selection");
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

  it.each([
    ["openai-codex", "gpt-5.3-codex-spark", "pi-5.5"],
    ["anthropic", "claude-sonnet-4-5-20250929", "pi-sonnet"],
    ["anthropic", "claude-haiku-4.5", "pi-sonnet"],
    ["openrouter", "openai/gpt-5.3-codex-spark", "pi-5.5"],
  ])("rejects retired exact manager selection %s/%s", async (provider, modelId, replacementPreset) => {
    const dataDir = await makeTempDataDir();
    await modelCatalogService.loadOverrides(dataDir);

    expect(() =>
      resolveExactManagerModelSelection(
        { provider, modelId },
        { surface: "change", providerAvailability: new Map([[provider, true]]) },
      )
    ).toThrow(`use ${replacementPreset} instead`);
  });

  it("keeps pi-opus preset resolution on the Opus 5 catalog default", async () => {
    expect(resolveModelDescriptorFromPreset("pi-opus")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5",
      thinkingLevel: "high",
    });
  });

  it("selects Claude Fable 5 exactly with its extended reasoning levels", async () => {
    const dataDir = await makeTempDataDir();
    await modelCatalogService.loadOverrides(dataDir);

    expect(resolveModelDescriptorFromPreset("pi-fable")).toEqual({
      provider: "anthropic",
      modelId: "claude-fable-5",
      thinkingLevel: "high",
    });
    expect(
      resolveExactManagerModelSelection(
        { provider: "anthropic", modelId: "claude-fable-5" },
        { surface: "create", providerAvailability: new Map([["anthropic", true]]), reasoningLevel: "max" },
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-fable-5",
      thinkingLevel: "max",
    });
  });

  it("keeps pi-sonnet preset resolution on Sonnet 5 instead of Opus", async () => {
    expect(resolveModelDescriptorFromPreset("pi-sonnet")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      thinkingLevel: "medium",
    });

    expect(
      resolveExactManagerModelSelection(
        { provider: "anthropic", modelId: "claude-sonnet-5" },
        { surface: "create", providerAvailability: new Map([["anthropic", true]]) },
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      thinkingLevel: "medium",
    });
  });
});
