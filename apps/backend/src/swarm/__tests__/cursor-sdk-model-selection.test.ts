import { describe, expect, it } from "vitest";
import { normalizeCursorThinkingLevel, toCursorSdkModelSelection } from "../runtime/cursor-sdk/cursor-sdk-model-selection.js";

describe("cursor-sdk-model-selection", () => {
  it("maps Composer 2.5 to Cursor's discovered fast variant without unsupported reasoning params", () => {
    expect(toCursorSdkModelSelection({ provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "high" })).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }]
    });
  });

  it("maps Grok 4.5 reasoning levels to Cursor effort and fast params", () => {
    expect(toCursorSdkModelSelection({ provider: "cursor-sdk", modelId: "grok-4.5", thinkingLevel: "medium" })).toEqual({
      id: "grok-4.5",
      params: [
        { id: "effort", value: "medium" },
        { id: "fast", value: "false" }
      ]
    });

    expect(toCursorSdkModelSelection({ provider: "cursor-sdk", modelId: "grok-4.5-fast", thinkingLevel: "xhigh" })).toEqual({
      id: "grok-4.5",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" }
      ]
    });
  });

  it("defaults missing Cursor reasoning using the model-specific catalog default", () => {
    expect(normalizeCursorThinkingLevel(undefined, "grok-4.5")).toBe("high");
    expect(normalizeCursorThinkingLevel(undefined, "grok-4.5-fast")).toBe("high");
    expect(normalizeCursorThinkingLevel("none", "grok-4.5")).toBe("low");
    expect(normalizeCursorThinkingLevel("xhigh", "grok-4.5")).toBe("high");
  });

  it("rejects unsupported providers, models, and reasoning levels", () => {
    expect(() => toCursorSdkModelSelection({ provider: "openai-codex", modelId: "composer-2.5" })).toThrow(
      "Cursor SDK model selection requires provider cursor-sdk"
    );
    expect(() => toCursorSdkModelSelection({ provider: "cursor-sdk", modelId: "not-grok" })).toThrow(
      "Unsupported Cursor SDK model: not-grok."
    );
    expect(() => normalizeCursorThinkingLevel("max", "grok-4.5")).toThrow("Unsupported Cursor SDK reasoning level: max.");
  });
});
