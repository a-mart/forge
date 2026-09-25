import { describe, expect, it } from "vitest";
import { NativeUsageAccumulator, normalizeCodexUsage, normalizeClaudeUsage, parseNativeUsageEntry } from "../utils/native-usage-records.js";
import { projectStatsEntry } from "../stats/stats-entry-projection.js";

const sample = (input = 10, overrides = {}) => ({ version: 1 as const, provider: "claude-native" as const,
  nativeSessionId: "thread", counterId: "claude-fable-5-1", modelId: "claude-fable-5-1", reasoningLevel: "high",
  capturedAt: "2026-09-25T10:00:00Z", usage: { input, output: 5, cacheRead: 20, cacheWrite: 2, total: input + 27 }, ...overrides });

describe("native accounting counters", () => {
  it("treats Codex cached input and reasoning output as subsets", () => {
    expect(normalizeCodexUsage({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 30, reasoningOutputTokens: 20, totalTokens: 130 }))
      .toEqual({ input: 20, cacheRead: 80, output: 30, cacheWrite: 0, total: 130 });
    expect(normalizeClaudeUsage({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 20, cacheCreationInputTokens: 2, thinkingTokens: 3 }))
      .toEqual(sample().usage);
    expect(normalizeCodexUsage({ inputTokens: -2, outputTokens: Number.NaN })).toBeNull();
  });
  it("accounts only increases through duplicates, resume, fork copies, and model changes", () => {
    const a = new NativeUsageAccumulator();
    expect(a.consume(sample())?.total).toBe(37);
    expect(a.consume(sample())).toBeNull();
    expect(a.consume(sample(15))?.total).toBe(5);
    expect(a.consume(sample(0))).toBeNull(); // stale / failed report, never subtract
    expect(a.consume(sample(15, { nativeSessionId: "new-thread" }))?.total).toBe(42);
    expect(a.consume(sample(17, { modelId: "claude-opus-5-5" }))?.total).toBe(2); // same counter
  });
  it("keeps projections count-only and rejects missing identity/timestamp", () => {
    const entry = { type: "custom", customType: "swarm_native_usage", data: { ...sample(), text: "PRIVATE_CANARY", commands: ["PRIVATE_CANARY"] } };
    expect(parseNativeUsageEntry(entry)).toEqual(sample());
    const projected = projectStatsEntry(entry);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_CANARY");
    expect(projectStatsEntry(projected, true)).toEqual(projected);
    expect(parseNativeUsageEntry({ ...entry, data: { ...sample(), capturedAt: "no-date" } })).toBeNull();
    expect(parseNativeUsageEntry({ ...entry, data: { ...sample(), nativeSessionId: "" } })).toBeNull();
  });
});
