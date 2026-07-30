import { describe, expect, it } from "vitest";
import {
  assertSwarmModelIdNotRetired,
  getModelPresetInfoList,
  inferProviderFromModelId,
  inferSwarmModelPresetFromDescriptor,
  normalizePersistedSwarmModelDescriptor,
  normalizePersistedSwarmModelPresetValue,
  normalizeSwarmModelDescriptor,
  normalizeThinkingLevelForModelDescriptor,
  parseSwarmModelPreset,
  resolveModelDescriptorFromPreset,
  resolveRemovedSwarmModelPresetAlias,
} from "../model-presets.js";
import { modelCatalogService } from "../model-catalog-service.js";
import { mapLegacyClaudeSdkModel } from "../catalog/legacy-claude-sdk-model.js";

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

  it("infers the Claude SDK provider for provider-scoped Claude model IDs", () => {
    expect(inferProviderFromModelId("claude-sdk/claude-opus-4-6")).toBe("claude-sdk");
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

  it("preserves selected Grok variants instead of collapsing them to a stale family default", () => {
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
      modelId: "grok-4-fast",
      thinkingLevel: "medium",
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
      modelId: "grok-4.20-0309-reasoning",
      thinkingLevel: "high",
    });
  });

  it("includes webSearch capability metadata for the pi-grok preset", () => {
    const grokPreset = getModelPresetInfoList().find((preset) => preset.presetId === "pi-grok");
    expect(grokPreset).toMatchObject({
      modelId: "grok-4.5",
      defaultReasoningLevel: "high",
      supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
      webSearch: true,
    });
    expect(grokPreset?.variants?.map((variant) => variant.modelId)).toEqual([
      "grok-4",
      "grok-4-fast",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
    ]);
  });

  it("does not expose webSearch capability metadata for other presets", () => {
    const presets = getModelPresetInfoList();
    for (const presetId of ["pi-5.6", "pi-5.4", "pi-5.5", "pi-opus", "pi-sonnet", "pi-fable", "cursor-composer", "cursor-grok-45"] as const) {
      expect(presets.find((preset) => preset.presetId === presetId)?.webSearch).toBeUndefined();
    }
  });

  it("exposes GPT-5.6 Sol/Terra/Luna as visible Codex presets and variants", () => {
    const presets = getModelPresetInfoList();
    const preset = presets.find((entry) => entry.presetId === "pi-5.6");

    expect(preset).toMatchObject({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningLevel: "max",
      supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(preset?.variants?.map((variant) => variant.modelId)).toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(resolveModelDescriptorFromPreset("pi-5.6")).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "max",
    });
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
    })).toBe("xhigh");
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "ultra",
    })).toBe("ultra");
    for (const level of ["low", "medium", "high", "xhigh", "max", "ultra"] as const) {
      expect(normalizeThinkingLevelForModelDescriptor({
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
        thinkingLevel: level,
      })).toBe(level);
    }
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(normalizeThinkingLevelForModelDescriptor({
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        thinkingLevel: level,
      })).toBe(level);
    }
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "ultra",
    })).toBe("max");
    expect(inferSwarmModelPresetFromDescriptor({ provider: "openai-codex", modelId: "gpt-5.6-luna" })).toBe("pi-5.6");
    expect(modelCatalogService.isKnownModelId("gpt-5.6-sol", "openai-codex")).toBe(true);
  });

  it("exposes Claude Fable 5 and preserves its catalog-supported reasoning levels", () => {
    const preset = getModelPresetInfoList().find((entry) => entry.presetId === "pi-fable");

    expect(preset).toMatchObject({
      provider: "anthropic",
      modelId: "claude-fable-5",
      displayName: "Claude Fable 5",
      defaultReasoningLevel: "high",
      supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(resolveModelDescriptorFromPreset("pi-fable")).toEqual({
      provider: "anthropic",
      modelId: "claude-fable-5",
      thinkingLevel: "high",
    });
    expect(inferSwarmModelPresetFromDescriptor({
      provider: "anthropic",
      modelId: "claude-fable-5",
    })).toBe("pi-fable");

    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(normalizeThinkingLevelForModelDescriptor({
        provider: "anthropic",
        modelId: "claude-fable-5",
        thinkingLevel: level,
      })).toBe(level);
    }
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "anthropic",
      modelId: "claude-fable-5",
      thinkingLevel: "none",
    })).toBe("low");
  });

  it("exposes Opus 5 with its full adaptive-thinking reasoning scale", () => {
    for (const level of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(normalizeThinkingLevelForModelDescriptor({
        provider: "anthropic",
        modelId: "claude-opus-5",
        thinkingLevel: level,
      })).toBe(level);
    }
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "anthropic",
      modelId: "claude-opus-5",
      thinkingLevel: "none",
    })).toBe("none");
  });

  it("keeps legacy Opus and Sonnet reasoning constrained to low, medium, and high", () => {
    for (const modelId of ["claude-opus-4-8", "claude-sonnet-5"] as const) {
      for (const level of ["low", "medium", "high"] as const) {
        expect(normalizeThinkingLevelForModelDescriptor({
          provider: "anthropic",
          modelId,
          thinkingLevel: level,
        })).toBe(level);
      }
      expect(normalizeThinkingLevelForModelDescriptor({
        provider: "anthropic",
        modelId,
        thinkingLevel: "xhigh",
      })).toBe("high");
      expect(normalizeThinkingLevelForModelDescriptor({
        provider: "anthropic",
        modelId,
        thinkingLevel: "max",
      })).toBe("high");
      expect(normalizeThinkingLevelForModelDescriptor({
        provider: "anthropic",
        modelId,
        thinkingLevel: "none",
      })).toBe("low");
    }
  });

  it("retains the legacy Anthropic clamp for unknown descriptors", () => {
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "anthropic",
      modelId: "claude-future-unknown",
      thinkingLevel: "xhigh",
    })).toBe("high");
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "anthropic",
      modelId: "claude-future-unknown",
      thinkingLevel: "none",
    })).toBe("low");
  });

  it("removes sunset models and aliases from new selections while deterministically migrating persisted descriptors", () => {
    const presets = getModelPresetInfoList();
    expect(presets.find((preset) => preset.presetId === "pi-codex")).toBeUndefined();
    expect(presets.find((preset) => preset.presetId === "pi-codex-spark")).toBeUndefined();
    expect(presets.find((preset) => preset.presetId === "pi-5.5")).toMatchObject({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      displayName: "GPT-5.5",
      defaultReasoningLevel: "xhigh",
    });
    expect(() => parseSwarmModelPreset("pi-codex-spark", "model")).toThrow("model must be one of");
    expect(normalizePersistedSwarmModelPresetValue("pi-codex-spark")).toBe("pi-5.5");

    expect([
      normalizePersistedSwarmModelDescriptor({
        provider: "openai-codex",
        modelId: "gpt-5.3-codex-spark",
        thinkingLevel: "high",
      }),
      normalizePersistedSwarmModelDescriptor({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5-20250929",
        thinkingLevel: "medium",
      }),
      normalizePersistedSwarmModelDescriptor({
        provider: "anthropic",
        modelId: "claude-haiku-4.5",
        thinkingLevel: "low",
      }),
      normalizePersistedSwarmModelDescriptor({
        provider: "claude-sdk",
        modelId: "claude-sonnet-4-5-20250929",
        thinkingLevel: "medium",
      }),
      normalizePersistedSwarmModelDescriptor({
        provider: "claude-sdk",
        modelId: "claude-sdk/claude-haiku-4-5-20251001",
        thinkingLevel: "low",
      }),
    ]).toEqual([
      { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" },
      { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "medium" },
      { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "low" },
      { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "medium" },
      { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "low" },
    ]);

    expect(normalizePersistedSwarmModelDescriptor({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
      thinkingLevel: "medium",
    })).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
      thinkingLevel: "medium",
    });

    for (const [provider, modelId] of [
      ["openai-codex", "gpt-5.3-codex-spark"],
      ["anthropic", "claude-sonnet-4-5-20250929"],
      ["anthropic", "claude-haiku-4-5-20251001"],
      ["openrouter", "anthropic/claude-sonnet-4.5"],
      ["openrouter", "~anthropic/claude-haiku-latest"],
      ["openrouter", "openai/gpt-5.3-codex-spark"],
    ] as const) {
      expect(modelCatalogService.isKnownModelId(modelId, provider)).toBe(false);
      expect(() => assertSwarmModelIdNotRetired(provider, modelId, "modelId")).toThrow("retired model");
    }

    for (const modelId of ["claude-sonnet-4.5", "claude-haiku-4.5"]) {
      expect(() => assertSwarmModelIdNotRetired("claude-sdk", modelId, "modelId")).toThrow(
        "Claude SDK has been retired",
      );
    }

    expect(resolveModelDescriptorFromPreset("pi-codex")).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh",
    });
  });

  it("maps removed Cursor ACP descriptors and aliases to Cursor SDK Composer", () => {
    expect(resolveRemovedSwarmModelPresetAlias("cursor-acp")).toBe("cursor-composer");
    expect(parseSwarmModelPreset("cursor-acp", "model")).toBe("cursor-composer");
    expect(parseSwarmModelPreset(" Cursor-ACP ", "model")).toBe("cursor-composer");
    expect(normalizePersistedSwarmModelDescriptor({
      provider: "cursor-acp",
      modelId: "default",
      thinkingLevel: "xhigh",
    })).toEqual({
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      thinkingLevel: "none",
    });
    expect(normalizePersistedSwarmModelDescriptor({
      provider: " Cursor-ACP ",
      modelId: " DEFAULT ",
      thinkingLevel: "x-high",
    })).toEqual({
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      thinkingLevel: "none",
    });
    expect(normalizePersistedSwarmModelDescriptor({
      provider: "cursor-acp",
      modelId: "default",
      thinkingLevel: "none",
    })?.thinkingLevel).toBe("none");
  });

  it("exposes Cursor SDK Grok 4.5 with provider-scoped variants", () => {
    const presets = getModelPresetInfoList();
    const cursorGrok = presets.find((preset) => preset.presetId === "cursor-grok-45");

    expect(inferSwarmModelPresetFromDescriptor({ provider: "cursor-sdk", modelId: "grok-4.5" })).toBe("cursor-grok-45");
    expect(inferSwarmModelPresetFromDescriptor({ provider: "cursor-sdk", modelId: "grok-4.5-fast" })).toBe("cursor-grok-45");
    expect(resolveModelDescriptorFromPreset("cursor-grok-45")).toEqual({
      provider: "cursor-sdk",
      modelId: "grok-4.5",
      thinkingLevel: "high",
    });
    expect(cursorGrok).toMatchObject({
      provider: "cursor-sdk",
      modelId: "grok-4.5",
      defaultReasoningLevel: "high",
      supportedReasoningLevels: ["low", "medium", "high"],
    });
    expect(cursorGrok?.variants?.map((variant) => variant.modelId)).toEqual(["grok-4.5-fast"]);
    expect(modelCatalogService.isKnownModelId("grok-4.5", "cursor-sdk")).toBe(true);
    expect(inferProviderFromModelId("grok-4.5")).toBe("xai");
  });

  it("normalizes Cursor SDK reasoning levels against model-specific catalog support", () => {
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      thinkingLevel: "high",
    })).toBe("none");
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      thinkingLevel: "none",
    })).toBe("none");

    for (const level of ["low", "medium", "high"] as const) {
      expect(normalizeThinkingLevelForModelDescriptor({
        provider: "cursor-sdk",
        modelId: "grok-4.5",
        thinkingLevel: level,
      })).toBe(level);
    }
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "cursor-sdk",
      modelId: "grok-4.5",
      thinkingLevel: "none",
    })).toBe("low");
    expect(normalizeThinkingLevelForModelDescriptor({
      provider: "cursor-sdk",
      modelId: "grok-4.5-fast",
      thinkingLevel: "xhigh",
    })).toBe("high");
  });

  it("uses the catalog-backed known model list without Claude SDK duplicates", () => {
    expect(modelCatalogService.isKnownModelId("gpt-5.4-mini")).toBe(true);
    expect(modelCatalogService.isKnownModelId("claude-opus-4-6", "anthropic")).toBe(true);
    expect(modelCatalogService.isKnownModelId("claude-opus-4-6", "claude-sdk")).toBe(false);
    expect(modelCatalogService.isKnownModelId("gpt-5.4-nano")).toBe(false);
  });

  it("returns catalog-backed context window metadata", () => {
    expect(modelCatalogService.getContextWindow("gpt-5.5")).toBe(272_000);
    expect(modelCatalogService.getContextWindow("grok-4-fast")).toBe(2_000_000);
    expect(modelCatalogService.getContextWindow("claude-opus-4-6", "anthropic")).toBe(1_000_000);
  });

  it("maps known, retired, and unknown persisted Claude SDK models without guessing", () => {
    expect(mapLegacyClaudeSdkModel({ provider: "claude-sdk", modelId: "claude-opus-4-7" })).toEqual({
      kind: "mapped",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
    });
    expect(mapLegacyClaudeSdkModel({ provider: "claude-sdk", modelId: "claude-haiku-4.5" })).toEqual({
      kind: "mapped",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    expect(mapLegacyClaudeSdkModel({ provider: "claude-sdk", modelId: "claude-future-unknown" })).toMatchObject({
      kind: "unavailable",
      provider: "claude-sdk",
      modelId: "claude-future-unknown",
    });
    expect(normalizePersistedSwarmModelPresetValue("sdk-opus")).toBe("pi-opus");
    expect(normalizePersistedSwarmModelPresetValue("sdk-sonnet")).toBe("pi-sonnet");
    expect(() => parseSwarmModelPreset("sdk-opus", "model")).toThrow("Claude SDK has been retired");
  });

  it("exposes Anthropic Sonnet presets with the expected defaults", () => {
    const presets = getModelPresetInfoList();

    expect(inferSwarmModelPresetFromDescriptor({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    })).toBe("pi-sonnet");

    expect(resolveModelDescriptorFromPreset("pi-sonnet")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      thinkingLevel: "medium",
    });

    expect(presets.find((preset) => preset.presetId === "pi-sonnet")).toMatchObject({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    expect(presets.find((preset) => preset.presetId === "pi-sonnet")?.variants).toBeUndefined();
  });

  it("omits deprecated variants that are not present in the catalog", () => {
    const fiveFourPreset = getModelPresetInfoList().find((preset) => preset.presetId === "pi-5.4");
    const fiveFivePreset = getModelPresetInfoList().find((preset) => preset.presetId === "pi-5.5");

    expect(fiveFourPreset?.variants?.map((variant) => variant.modelId)).toEqual(["gpt-5.4-mini"]);
    expect(fiveFivePreset?.variants).toBeUndefined();
  });
});
