import { describe, expect, it } from "vitest";
import {
  getModelPresetInfoList,
  inferProviderFromModelId,
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor,
} from "../model-presets.js";
import { modelCatalogService } from "../model-catalog-service.js";

describe("model-presets", () => {
  it("infers the xAI provider for Grok model IDs", () => {
    expect(inferProviderFromModelId("grok-4")).toBe("xai");
    expect(inferProviderFromModelId("grok-4-fast")).toBe("xai");
    expect(inferProviderFromModelId("grok-3")).toBe("xai");
  });

  it("infers the OpenRouter provider for slash-scoped model IDs", () => {
    expect(inferProviderFromModelId("anthropic/claude-3.5-sonnet")).toBe("openrouter");
    expect(inferProviderFromModelId("qwen/qwen3-coder:free")).toBe("openrouter");
  });

  it("does not treat malformed slash model IDs as OpenRouter models", () => {
    expect(inferProviderFromModelId("")).toBeNull();
    expect(inferProviderFromModelId("/")).toBeNull();
    expect(inferProviderFromModelId("anthropic/")).toBeNull();
    expect(inferProviderFromModelId("/claude-3.5-sonnet")).toBeNull();
  });

  it("maps Grok variants back to the pi-grok preset", () => {
    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "xai",
        modelId: "grok-4-fast",
      }),
    ).toBe("pi-grok");

    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "xai",
        modelId: "grok-4.20-0309-reasoning",
      }),
    ).toBe("pi-grok");

    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "xai",
        modelId: "grok-4.20-0309-non-reasoning",
      }),
    ).toBe("pi-grok");

    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "xai",
        modelId: "grok-3",
      }),
    ).toBe("pi-grok");
  });

  it("normalizes Grok variants to the pi-grok default descriptor instead of falling back to pi-codex", () => {
    expect(
      normalizeSwarmModelDescriptor(
        {
          provider: "xai",
          modelId: "grok-4-fast",
        },
        "pi-codex",
      ),
    ).toEqual({
      provider: "xai",
      modelId: "grok-4",
      thinkingLevel: "high",
    });

    expect(
      normalizeSwarmModelDescriptor(
        {
          provider: "xai",
          modelId: "grok-4.20-0309-reasoning",
        },
        "pi-codex",
      ),
    ).toEqual({
      provider: "xai",
      modelId: "grok-4",
      thinkingLevel: "high",
    });
  });

  it("includes webSearch capability metadata for the pi-grok preset", () => {
    const grokPreset = getModelPresetInfoList().find((preset) => preset.presetId === "pi-grok");
    expect(grokPreset?.webSearch).toBe(true);
    expect(grokPreset?.variants?.map((variant) => variant.modelId)).toEqual([
      "grok-4-fast",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
    ]);
  });

  it("does not expose webSearch capability metadata for other presets", () => {
    const presets = getModelPresetInfoList();
    for (const presetId of ["pi-codex", "pi-5.4", "pi-opus", "codex-app"] as const) {
      expect(presets.find((preset) => preset.presetId === presetId)?.webSearch).toBeUndefined();
    }
  });

  it("uses the catalog-backed known model list", () => {
    expect(modelCatalogService.isKnownModelId("gpt-5.4-mini")).toBe(true);
    expect(modelCatalogService.isKnownModelId("gpt-5.4-nano")).toBe(false);
  });

  it("returns catalog-backed context window metadata", () => {
    expect(modelCatalogService.getContextWindow("gpt-5.3-codex")).toBe(272_000);
    expect(modelCatalogService.getContextWindow("grok-4-fast")).toBe(2_000_000);
  });

  it("omits deprecated variants that are not present in the catalog", () => {
    const fiveFourPreset = getModelPresetInfoList().find((preset) => preset.presetId === "pi-5.4");
    expect(fiveFourPreset?.variants?.map((variant) => variant.modelId)).toEqual(["gpt-5.4-mini"]);
  });
});
