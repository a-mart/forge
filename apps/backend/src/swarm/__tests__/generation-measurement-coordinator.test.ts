import { describe, expect, it, vi } from "vitest";
import { GENERATION_MEASUREMENT_ENTRY_TYPE } from "../../utils/generation-measurement-records.js";
import { GenerationMeasurementCoordinator } from "../generation-throughput/generation-measurement-coordinator.js";
import type { RuntimeGenerationEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

function descriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "manager-1",
    displayName: "Manager",
    role: "manager",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "streaming",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/project",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" },
    sessionFile: "/project/session.jsonl",
    ...overrides,
  };
}

function event(
  phase: RuntimeGenerationEvent["phase"],
  measurementId: string,
  monotonicTimeMs: number,
  overrides: Record<string, unknown> = {},
): RuntimeGenerationEvent {
  const base = { phase, measurementId, wallTimeMs: 1_000 + monotonicTimeMs, monotonicTimeMs };
  switch (phase) {
    case "request_started":
      return {
        ...base,
        requestedProvider: "openai-codex",
        requestedModelId: "gpt-5.5",
        reasoningLevel: "high",
        ...overrides,
      } as RuntimeGenerationEvent;
    case "response_stream_started":
      return { ...base, ...overrides } as RuntimeGenerationEvent;
    case "output_delta":
      return {
        ...base,
        deltaKind: "text",
        deltaUtf16CodeUnits: 8,
        deltaUtf8Bytes: 8,
        ...overrides,
      } as RuntimeGenerationEvent;
    case "completed":
      return {
        ...base,
        outcome: "completed",
        ...overrides,
      } as RuntimeGenerationEvent;
  }
}

function createCoordinator(descriptors: AgentDescriptor[]) {
  const records: unknown[] = [];
  const appendCustomEntry = vi.fn((_type: string, data: unknown) => {
    records.push(data);
    return `entry-${records.length}`;
  });
  const runtime = { appendCustomEntry } as unknown as SwarmAgentRuntime;
  const coordinator = new GenerationMeasurementCoordinator({
    descriptors: new Map(descriptors.map((entry) => [entry.agentId, entry])),
    getRuntime: () => runtime,
    getActiveTurnId: () => "turn-1",
  });
  return { coordinator, records, appendCustomEntry };
}

describe("GenerationMeasurementCoordinator", () => {
  it("persists started and terminal manager records with a strict count-only generation span", async () => {
    const { coordinator, records, appendCustomEntry } = createCoordinator([descriptor()]);

    await coordinator.handleRuntimeGenerationEvent(7, "manager-1", event("request_started", "call-1", 0));
    await coordinator.handleRuntimeGenerationEvent(7, "manager-1", event("response_stream_started", "call-1", 400));
    await coordinator.handleRuntimeGenerationEvent(7, "manager-1", event("output_delta", "call-1", 1_000, {
      deltaUtf16CodeUnits: 12,
      deltaUtf8Bytes: 12,
    }));
    await coordinator.handleRuntimeGenerationEvent(7, "manager-1", event("completed", "call-1", 3_000, {
      meta: {
        provider: "openai-codex",
        responseModelId: "gpt-5.5-2026-07-01",
        api: "openai-codex-responses",
        usage: { output: 100, reasoning: 20 },
      },
    }));

    expect(appendCustomEntry).toHaveBeenCalledTimes(2);
    expect(appendCustomEntry).toHaveBeenNthCalledWith(
      1,
      GENERATION_MEASUREMENT_ENTRY_TYPE,
      expect.objectContaining({ recordState: "started", recordSequence: 1 }),
    );
    expect(records[1]).toMatchObject({
      version: 1,
      measurementId: "call-1",
      recordState: "terminal",
      recordSequence: 2,
      identity: {
        profileId: "profile-1",
        sessionId: "manager-1",
        agentId: "manager-1",
        managerId: "manager-1",
        role: "manager",
        specialistId: null,
        specialistAttributionKnown: null,
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
        requestWallMs: 3_000,
        timeToFirstOutputMs: 1_000,
        responseStreamOpenMs: 2_600,
        generationDurationMs: 2_000,
        interOutputSpanMs: 0,
        boundarySource: "content_delta_to_stream_end",
      },
      usage: {
        outputTokens: 100,
        reasoningTokens: 20,
        tokenSource: "provider_final",
      },
      reasoningBoundaryCoverage: "hidden_or_unobserved",
      estimator: { method: "characters_div_4_v1", estimatedOutputTokens: 3 },
    });
  });

  it("captures worker ownership and known specialist provenance at generation start", async () => {
    const worker = descriptor({
      agentId: "worker-1",
      displayName: "Worker",
      role: "worker",
      managerId: "manager-1",
      specialistId: "deep:reviewer",
      specialistAttributionKnown: true,
    });
    const { coordinator, records } = createCoordinator([worker]);

    await coordinator.handleRuntimeGenerationEvent(8, worker.agentId, event("request_started", "worker-call", 0));
    await coordinator.handleRuntimeGenerationEvent(8, worker.agentId, event("completed", "worker-call", 10, {
      meta: { usage: { output: 0 } },
    }));

    expect(records[1]).toMatchObject({
      identity: {
        profileId: "profile-1",
        sessionId: "manager-1",
        agentId: "worker-1",
        managerId: "manager-1",
        role: "worker",
        specialistId: "deep:reviewer",
        specialistAttributionKnown: true,
      },
    });
  });

  it("keeps tool-gap calls independent and never folds a ten-second gap into either duration", async () => {
    const { coordinator, records } = createCoordinator([descriptor()]);

    for (const [measurementId, startedAt] of [["before-tool", 0], ["after-tool", 11_000]] as const) {
      await coordinator.handleRuntimeGenerationEvent(3, "manager-1", event("request_started", measurementId, startedAt));
      await coordinator.handleRuntimeGenerationEvent(3, "manager-1", event("output_delta", measurementId, startedAt + 100));
      await coordinator.handleRuntimeGenerationEvent(3, "manager-1", event("completed", measurementId, startedAt + 1_100, {
        meta: { usage: { output: 50 } },
      }));
    }

    expect(records.filter((record) => (record as { recordState: string }).recordState === "terminal"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ measurementId: "before-tool", timing: expect.objectContaining({ generationDurationMs: 1_000 }) }),
        expect.objectContaining({ measurementId: "after-tool", timing: expect.objectContaining({ generationDurationMs: 1_000 }) }),
      ]));
  });

  it("marks final-only, zero-duration, and malformed final usage unmeasurable without manufacturing a rate", async () => {
    const { coordinator, records } = createCoordinator([descriptor()]);

    await coordinator.handleRuntimeGenerationEvent(1, "manager-1", event("request_started", "final-only", 0));
    await coordinator.handleRuntimeGenerationEvent(1, "manager-1", event("response_stream_started", "final-only", 1));
    await coordinator.handleRuntimeGenerationEvent(1, "manager-1", event("completed", "final-only", 2, {
      meta: { usage: { output: -1, reasoning: Number.NaN } },
    }));

    await coordinator.handleRuntimeGenerationEvent(1, "manager-1", event("request_started", "zero", 10));
    await coordinator.handleRuntimeGenerationEvent(1, "manager-1", event("output_delta", "zero", 20));
    await coordinator.handleRuntimeGenerationEvent(1, "manager-1", event("completed", "zero", 20, {
      meta: { usage: { output: 10 } },
    }));

    expect(records[1]).toMatchObject({
      measurementId: "final-only",
      timing: expect.objectContaining({
        boundarySource: "response_stream_proxy",
        generationDurationMs: null,
      }),
      usage: { outputTokens: null, reasoningTokens: null, tokenSource: "unavailable" },
    });
    expect(records[3]).toMatchObject({
      measurementId: "zero",
      timing: expect.objectContaining({ generationDurationMs: 0 }),
      usage: expect.objectContaining({ outputTokens: 10, tokenSource: "provider_final" }),
    });
  });
});
