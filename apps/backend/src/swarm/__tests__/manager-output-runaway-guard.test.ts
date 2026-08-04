import { describe, expect, it } from "vitest";
import {
  MANAGER_OUTPUT_HARD_LIMIT_CHARS,
  detectManagerOutputRunaway,
} from "../runtime/pi/manager-output-runaway-guard.js";

describe("manager output runaway guard", () => {
  it("detects a short-line termination loop well before the hard limit", () => {
    const text = "Done.\n---\nStop.\nEnd.\nYield.\n".repeat(700);

    expect(text.length).toBeLessThan(MANAGER_OUTPUT_HARD_LIMIT_CHARS);
    expect(detectManagerOutputRunaway(text)).toEqual({
      reason: "repetitive_output",
      observedChars: text.length,
    });
  });

  it("allows large diverse output below the generous hard limit", () => {
    const text = Array.from(
      { length: 2_000 },
      (_, index) => `Result ${index}: distinct diagnostic detail ${index * 17}`,
    ).join("\n");

    expect(text.length).toBeLessThan(MANAGER_OUTPUT_HARD_LIMIT_CHARS);
    expect(detectManagerOutputRunaway(text)).toBeUndefined();
  });

  it("stops any manager response at the hard limit", () => {
    const text = "x".repeat(MANAGER_OUTPUT_HARD_LIMIT_CHARS);

    expect(detectManagerOutputRunaway(text)).toEqual({
      reason: "hard_limit",
      observedChars: text.length,
    });
  });
});
