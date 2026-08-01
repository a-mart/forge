import type { GenerationMeasurementRecordV1 } from "@forge/protocol";
import { describe, expect, it } from "vitest";
import {
  foldGenerationMeasurementRecords,
  GENERATION_MEASUREMENT_ENTRY_TYPE,
  parseGenerationMeasurementCustomEntry,
} from "../generation-measurement-records.js";

function record(overrides: Partial<GenerationMeasurementRecordV1> = {}): GenerationMeasurementRecordV1 {
  return {
    version: 1,
    measurementId: "measurement-1",
    recordState: "terminal",
    recordSequence: 2,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:02.000Z",
    identity: {
      profileId: "profile-1",
      sessionId: "manager-1",
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      specialistId: "reviewer",
      specialistAttributionKnown: true,
    },
    model: {
      provider: "openai-codex",
      requestedModelId: "gpt-5.5",
      responseModelId: "gpt-5.5-2026-07-01",
      api: "openai-codex-responses",
      reasoningLevel: "high",
    },
    correlation: { turnId: "turn-1" },
    timing: {
      responseStreamStartedAt: "2026-01-01T00:00:00.100Z",
      firstOutputAt: "2026-01-01T00:00:00.500Z",
      lastOutputAt: "2026-01-01T00:00:01.800Z",
      requestWallMs: 2_000,
      timeToFirstOutputMs: 500,
      responseStreamOpenMs: 1_900,
      generationDurationMs: 1_500,
      interOutputSpanMs: 1_300,
      boundarySource: "content_delta_to_stream_end",
    },
    usage: {
      outputTokens: 100,
      reasoningTokens: 20,
      tokenSource: "provider_final",
    },
    outcome: "completed",
    reasoningBoundaryCoverage: "hidden_or_unobserved",
    estimator: { method: "characters_div_4_v1", estimatedOutputTokens: 90 },
    ...overrides,
  };
}

function wrapper(data: unknown) {
  return { type: "custom", customType: GENERATION_MEASUREMENT_ENTRY_TYPE, data };
}

describe("generation measurement records", () => {
  it("parses only valid compact lifecycle custom entries", () => {
    expect(parseGenerationMeasurementCustomEntry(wrapper(record()))).toEqual(record());
    expect(parseGenerationMeasurementCustomEntry({ type: "custom", customType: "other", data: record() })).toBeNull();
  });

  it("rejects malformed, negative, non-finite, and invalid lifecycle records without throwing", () => {
    const negativeDuration = record({
      timing: { ...record().timing, generationDurationMs: -1 },
    });
    const nonFiniteTokens = record({
      usage: { ...record().usage, outputTokens: Number.POSITIVE_INFINITY },
    });
    const invalidStart = record({
      recordState: "started",
      recordSequence: 1,
      completedAt: "2026-01-01T00:00:02.000Z",
    });
    const unknownReasoningCoverage = record({ reasoningBoundaryCoverage: "maybe" as never });

    expect(() => parseGenerationMeasurementCustomEntry(wrapper(negativeDuration))).not.toThrow();
    expect(parseGenerationMeasurementCustomEntry(wrapper(negativeDuration))).toBeNull();
    expect(parseGenerationMeasurementCustomEntry(wrapper(nonFiniteTokens))).toBeNull();
    expect(parseGenerationMeasurementCustomEntry(wrapper(invalidStart))).toBeNull();
    expect(parseGenerationMeasurementCustomEntry(wrapper(unknownReasoningCoverage))).toBeNull();
  });

  it("accepts a start-only lifecycle record as incomplete rather than a terminal measurement", () => {
    const started = record({
      recordState: "started",
      recordSequence: 1,
      completedAt: null,
      model: { ...record().model, responseModelId: null, api: null },
      timing: {
        responseStreamStartedAt: null,
        firstOutputAt: null,
        lastOutputAt: null,
        requestWallMs: null,
        timeToFirstOutputMs: null,
        responseStreamOpenMs: null,
        generationDurationMs: null,
        interOutputSpanMs: null,
        boundarySource: "unavailable",
      },
      usage: { outputTokens: null, reasoningTokens: null, tokenSource: "unavailable" },
      outcome: "unknown",
      reasoningBoundaryCoverage: "not_reported",
      estimator: undefined,
    });

    expect(parseGenerationMeasurementCustomEntry(wrapper(started))).toEqual(started);
  });

  it("globally deduplicates copied start/terminal records and lets terminal sequence win", () => {
    const started = record({
      recordState: "started",
      recordSequence: 1,
      completedAt: null,
      model: { ...record().model, responseModelId: null, api: null },
      timing: {
        responseStreamStartedAt: null,
        firstOutputAt: null,
        lastOutputAt: null,
        requestWallMs: null,
        timeToFirstOutputMs: null,
        responseStreamOpenMs: null,
        generationDurationMs: null,
        interOutputSpanMs: null,
        boundarySource: "unavailable",
      },
      usage: { outputTokens: null, reasoningTokens: null, tokenSource: "unavailable" },
      outcome: "unknown",
      reasoningBoundaryCoverage: "not_reported",
      estimator: undefined,
    });
    const terminal = record();

    const folded = foldGenerationMeasurementRecords([
      { record: started, sourcePath: "/sessions/manager.jsonl", byteOffset: 10 },
      { record: terminal, sourcePath: "/sessions/manager.jsonl", byteOffset: 20 },
      { record: terminal, sourcePath: "/forks/manager.jsonl", byteOffset: 20 },
    ]);

    expect(folded.records).toEqual([terminal]);
    expect(folded.diagnostics).toEqual({ duplicateCount: 1, conflictCount: 0 });
  });

  it("diagnoses equal-sequence copies as duplicates and only differing copies as conflicts", () => {
    const terminal = record();
    const conflicting = record({ model: { ...record().model, responseModelId: "other-model" } });

    const equivalent = foldGenerationMeasurementRecords([
      { record: terminal, sourcePath: "/a.jsonl", byteOffset: 1 },
      { record: terminal, sourcePath: "/b.jsonl", byteOffset: 1 },
    ]);
    const conflict = foldGenerationMeasurementRecords([
      { record: terminal, sourcePath: "/a.jsonl", byteOffset: 1 },
      { record: conflicting, sourcePath: "/b.jsonl", byteOffset: 1 },
    ]);

    expect(equivalent.diagnostics).toEqual({ duplicateCount: 1, conflictCount: 0 });
    expect(conflict.diagnostics).toEqual({ duplicateCount: 1, conflictCount: 1 });
  });

  it("uses terminal completeness then deterministic source ordering for conflicting fork copies", () => {
    const incomplete = record({
      model: { ...record().model, responseModelId: null },
      timing: { ...record().timing, generationDurationMs: null },
      usage: { ...record().usage, outputTokens: null, tokenSource: "unavailable" },
    });
    const complete = record({
      model: { ...record().model, responseModelId: "resolved-model" },
    });

    const folded = foldGenerationMeasurementRecords([
      { record: complete, sourcePath: "/z.jsonl", byteOffset: 1 },
      { record: incomplete, sourcePath: "/a.jsonl", byteOffset: 9 },
    ]);

    expect(folded.records).toEqual([complete]);
    expect(folded.diagnostics.conflictCount).toBe(1);
  });
});
