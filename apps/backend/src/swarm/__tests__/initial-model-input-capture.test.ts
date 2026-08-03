import { describe, expect, it } from "vitest";
import {
  findPiInitialModelInputTokenUsageInSessionEntries,
} from "../runtime/initial-model-input-capture.js";

const capture = {
  version: 1,
  runtime: "pi",
  capturedAt: "2026-01-01T00:00:00.000Z",
  fidelity: {
    capturePoint: "pi_stream_fn",
    context: "exact_provider_independent",
    images: "byte_summary",
    requestMetadata: "safe_projection",
  },
  systemPrompt: "First prompt",
  messages: [],
  tools: [],
  model: { provider: "openai-codex", id: "gpt-5.4" },
  requestMetadata: {},
};

function captureEntry() {
  return {
    type: "custom",
    customType: "swarm_pi_initial_model_input",
    data: capture,
  };
}

function assistantEntry(usage: unknown, stopReason = "stop") {
  return {
    type: "message",
    message: {
      role: "assistant",
      stopReason,
      usage,
    },
  };
}

function userEntry() {
  return {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "Try again" }],
    },
  };
}

describe("initial model input provider usage", () => {
  it("sums Pi's normalized uncached, cache-read, and cache-write input", () => {
    expect(findPiInitialModelInputTokenUsageInSessionEntries([
      assistantEntry({ input: 999, cacheRead: 0, cacheWrite: 0 }),
      captureEntry(),
      { type: "custom", customType: "unrelated", data: {} },
      assistantEntry({ input: 12, output: 3, cacheRead: 5, cacheWrite: 2, totalTokens: 22 }, "toolUse"),
    ])).toEqual({
      source: "provider_reported",
      inputTokens: 19,
      uncachedInputTokens: 12,
      cacheReadInputTokens: 5,
      cacheWriteInputTokens: 2,
    });
  });

  it("does not associate a later response when the first response has no usable usage", () => {
    expect(findPiInitialModelInputTokenUsageInSessionEntries([
      captureEntry(),
      assistantEntry({ input: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
      assistantEntry({ input: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 55 }),
    ])).toBeUndefined();
  });

  it("does not associate a later request after the captured attempt ended without a response", () => {
    expect(findPiInitialModelInputTokenUsageInSessionEntries([
      captureEntry(),
      userEntry(),
      assistantEntry({ input: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 55 }),
    ])).toBeUndefined();
  });

  it.each(["error", "aborted"])(
    "does not associate usage from a %s first response or a later retry",
    (stopReason) => {
      expect(findPiInitialModelInputTokenUsageInSessionEntries([
        captureEntry(),
        assistantEntry({ input: 8, cacheRead: 3, cacheWrite: 0, totalTokens: 11 }, stopReason),
        assistantEntry({ input: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 55 }),
      ])).toBeUndefined();
    },
  );

  it("returns no usage when the session has no valid capture entry", () => {
    expect(findPiInitialModelInputTokenUsageInSessionEntries([
      assistantEntry({ input: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 55 }),
    ])).toBeUndefined();
  });
});
