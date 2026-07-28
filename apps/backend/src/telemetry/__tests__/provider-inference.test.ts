import { describe, expect, it } from "vitest";
import { inferProviderFromModelId } from "../provider-inference.js";

describe("telemetry provider inference boundaries", () => {
  it.each([
    ["", null],
    ["  ", null],
    ["some-unknown-model", null],
    ["claude-3-7-sonnet", "anthropic"],
    ["anthropic-model", "anthropic"],
    ["grok-4", "xai"],
    ["xai-model", "xai"],
    ["gpt-5", "openai-codex"],
    ["gpt-5.4", "openai-codex"],
    ["o3-mini", "openai-codex"],
    ["openai-model", "openai-codex"],
    ["openrouter/provider/model", "openrouter"],
  ])("infers %j as %j", (modelId, expected) => {
    expect(inferProviderFromModelId(modelId)).toBe(expected);
  });

  it("uses catalog provider precedence over generic slash inference and Cursor fallback", () => {
    expect(inferProviderFromModelId("cursor-sdk/composer-2.5")).toBe("cursor-sdk");
    expect(inferProviderFromModelId("anthropic/claude-sonnet-4")).toBe("openrouter");
  });
});
