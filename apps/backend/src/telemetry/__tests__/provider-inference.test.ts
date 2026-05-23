import { describe, expect, it } from "vitest";
import { inferProviderFromModelId } from "../provider-inference.js";

describe("telemetry provider inference", () => {
  it("infers Cursor SDK before generic slash-scoped OpenRouter fallback", () => {
    expect(inferProviderFromModelId("cursor-sdk/composer-2.5")).toBe("cursor-sdk");
  });
});
