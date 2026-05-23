import { describe, expect, it } from "vitest";
import { normalizeCursorThinkingLevel, toCursorSdkModelSelection } from "../runtime/cursor-sdk/cursor-sdk-model-selection.js";

describe("cursor-sdk-model-selection", () => {
  it("maps Composer 2.5 and supported thinking levels to Cursor model params", () => {
    expect(toCursorSdkModelSelection({ provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "high" })).toEqual({
      id: "composer-2.5",
      params: [{ id: "thinking", value: "high" }]
    });
  });

  it("normalizes unsupported Forge reasoning aliases conservatively", () => {
    expect(normalizeCursorThinkingLevel(undefined)).toBe("medium");
    expect(normalizeCursorThinkingLevel("none")).toBe("low");
    expect(normalizeCursorThinkingLevel("xhigh")).toBe("high");
  });

  it("rejects unsupported providers, models, and reasoning levels", () => {
    expect(() => toCursorSdkModelSelection({ provider: "openai-codex", modelId: "composer-2.5" })).toThrow(
      "Cursor SDK model selection requires provider cursor-sdk"
    );
    expect(() => toCursorSdkModelSelection({ provider: "cursor-sdk", modelId: "composer-2.5-fast" })).toThrow(
      "Unsupported Cursor SDK model: composer-2.5-fast."
    );
    expect(() => normalizeCursorThinkingLevel("max")).toThrow("Unsupported Cursor SDK reasoning level: max.");
  });
});
