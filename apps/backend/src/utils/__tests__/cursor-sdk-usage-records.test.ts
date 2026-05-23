import { describe, expect, it } from "vitest";
import {
  CURSOR_SDK_USAGE_ENTRY_TYPE,
  extractCursorSdkUsageFromDelta,
  normalizeCursorSdkUsageComponents,
  parseCursorSdkUsageCustomEntry
} from "../cursor-sdk-usage-records.js";

describe("cursor-sdk usage records", () => {
  it("extracts camelCase live probe usage from turn-ended delta", () => {
    expect(extractCursorSdkUsageFromDelta({
      type: "turn-ended",
      usage: { inputTokens: 10.4, outputTokens: 4.5, cacheReadTokens: 2, cacheWriteTokens: 1 }
    })).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 });
  });

  it("extracts snake_case usage aliases", () => {
    expect(extractCursorSdkUsageFromDelta({
      type: "turn-ended",
      usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2, cache_write_tokens: 1 }
    })).toEqual({ input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17 });
  });

  it("ignores non-turn-ended deltas", () => {
    expect(extractCursorSdkUsageFromDelta({ type: "text-delta", text: "duplicate" })).toBeNull();
    expect(extractCursorSdkUsageFromDelta({ type: "tool-call-started", usage: { inputTokens: 1 } })).toBeNull();
  });

  it("normalizes non-finite negative and non-number values to zero", () => {
    expect(normalizeCursorSdkUsageComponents({
      inputTokens: Number.NaN,
      outputTokens: -1,
      cacheReadTokens: Number.POSITIVE_INFINITY,
      cacheWriteTokens: 3.6,
      input_tokens: "12"
    })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 4, total: 4 });
  });

  it("returns null for all-zero or malformed usage", () => {
    expect(extractCursorSdkUsageFromDelta({ type: "turn-ended", usage: {} })).toBeNull();
    expect(extractCursorSdkUsageFromDelta({ type: "turn-ended", usage: { inputTokens: 0 } })).toBeNull();
    expect(extractCursorSdkUsageFromDelta({ type: "turn-ended", usage: null })).toBeNull();
  });

  it("parses custom records and recomputes persisted total", () => {
    expect(parseCursorSdkUsageCustomEntry({
      type: "custom",
      customType: CURSOR_SDK_USAGE_ENTRY_TYPE,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        provider: "cursor-sdk",
        modelId: "composer-2.5",
        reasoningLevel: "medium",
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 999 },
        providerStatus: "FINISHED",
        runStatus: "finished",
        waitStatus: "finished",
        terminalStatus: "FINISHED",
        outcome: "completed",
        capturedAt: "2026-01-01T00:00:00.000Z"
      }
    })).toEqual(expect.objectContaining({
      modelId: "composer-2.5",
      reasoningLevel: "medium",
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17 },
      outcome: "completed"
    }));
  });
});
