import { describe, expect, it } from "vitest";
import { mapForgeReasoningToPiThinkingLevel } from "../pi-thinking-level.js";

describe("mapForgeReasoningToPiThinkingLevel", () => {
  it("preserves distinct Extra High and Max efforts while mapping Ultra to Pi Max", () => {
    expect(mapForgeReasoningToPiThinkingLevel("xhigh")).toBe("xhigh");
    expect(mapForgeReasoningToPiThinkingLevel("max")).toBe("max");
    expect(mapForgeReasoningToPiThinkingLevel("ultra")).toBe("max");
  });
});
