import { describe, expect, it } from "vitest";
import {
  inferProviderFromModelId,
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor
} from "../model-presets.js";

describe("model-presets", () => {
  it("infers the xAI provider for Grok model IDs", () => {
    expect(inferProviderFromModelId("grok-4")).toBe("xai");
    expect(inferProviderFromModelId("grok-4-fast")).toBe("xai");
    expect(inferProviderFromModelId("grok-3")).toBe("xai");
  });

  it("maps Grok variants back to the pi-grok preset", () => {
    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "xai",
        modelId: "grok-4-fast"
      })
    ).toBe("pi-grok");

    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "xai",
        modelId: "grok-3"
      })
    ).toBe("pi-grok");
  });

  it("normalizes Grok variants to the pi-grok default descriptor instead of falling back to pi-codex", () => {
    expect(
      normalizeSwarmModelDescriptor(
        {
          provider: "xai",
          modelId: "grok-4-fast"
        },
        "pi-codex"
      )
    ).toEqual({
      provider: "xai",
      modelId: "grok-4",
      thinkingLevel: "high"
    });
  });
});
