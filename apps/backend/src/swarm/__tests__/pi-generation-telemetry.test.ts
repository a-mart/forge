import { describe, expect, it, vi } from "vitest";
import { PiGenerationTelemetryAdapter } from "../runtime/generation-telemetry.js";
import type { RuntimeGenerationEvent } from "../runtime-contracts.js";

function createSession(options: {
  onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
  onResponse?: (response: unknown, model: unknown) => unknown | Promise<unknown>;
} = {}) {
  return {
    agent: {
      onPayload: options.onPayload,
      onResponse: options.onResponse,
    },
  };
}

function message(role: "assistant" | "user" = "assistant") {
  return { role, content: [] };
}

function assistantMeta(stopReason = "stop") {
  return {
    provider: "openai-codex",
    modelId: "gpt-5.5",
    responseModelId: "gpt-5.5-2026-07-01",
    api: "openai-codex-responses",
    stopReason,
    usage: { output: 100, reasoning: 25 },
    requestMessages: [{ content: "hidden prompt" }],
    invocationParameters: { apiKey: "invocation secret" },
    metadata: { rawResponse: "provider secret" },
  };
}

function createAdapter(session: ReturnType<typeof createSession>, events: RuntimeGenerationEvent[]) {
  let wallTimeMs = 1_000;
  let monotonicTimeMs = 10;
  let nextId = 1;
  const adapter = new PiGenerationTelemetryAdapter({
    session: session as never,
    reasoningLevel: "high",
    createMeasurementId: () => `measurement-${nextId++}`,
    clock: {
      wallTimeMs: () => wallTimeMs,
      monotonicTimeMs: () => monotonicTimeMs,
    },
    onGenerationEvent: async (event) => events.push(event),
  });

  return {
    adapter,
    advance(milliseconds: number) {
      wallTimeMs += milliseconds;
      monotonicTimeMs += milliseconds;
    },
  };
}

describe("Pi generation telemetry adapter (WP0)", () => {
  it.each([
    ["openai responses", "openai", "openai-responses"],
    ["openai codex responses", "openai-codex", "openai-codex-responses"],
    ["anthropic messages", "anthropic", "anthropic-messages"],
  ])("records one count-only lifecycle across %s streams", async (_family, provider, api) => {
    const events: RuntimeGenerationEvent[] = [];
    const session = createSession();
    const { adapter, advance } = createAdapter(session, events);
    adapter.install();

    await session.agent.onPayload?.({ prompt: "must not be retained" }, { provider, id: "model-a", api });
    advance(10);
    await session.agent.onResponse?.({ status: 200 }, { provider, id: "model-a" });
    advance(10);
    await adapter.handleSessionEvent({ type: "message_start", message: message() } as never);
    advance(10);
    await adapter.handleSessionEvent({
      type: "message_update",
      message: message(),
      assistantMessageEvent: { type: "text_delta", delta: "visible output" },
    } as never);
    advance(10);
    await adapter.handleSessionEvent({
      type: "message_update",
      message: message(),
      assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
    } as never);
    advance(10);
    await adapter.handleSessionEvent({
      type: "message_update",
      message: message(),
      assistantMessageEvent: { type: "toolcall_delta", delta: "{\"path\":\"secret\"}" },
    } as never);
    advance(10);
    await adapter.handleSessionEvent(
      { type: "message_end", message: message() } as never,
      assistantMeta(),
    );

    expect(events.map((event) => event.phase)).toEqual([
      "request_started",
      "response_stream_started",
      "output_delta",
      "output_delta",
      "output_delta",
      "completed",
    ]);
    expect(events[0]).toMatchObject({
      phase: "request_started",
      requestedProvider: provider,
      requestedModelId: "model-a",
      reasoningLevel: "high",
    });
    expect(events.filter((event) => event.phase === "output_delta")).toEqual([
      expect.objectContaining({ deltaKind: "text", deltaUtf16CodeUnits: 14 }),
      expect.objectContaining({ deltaKind: "thinking", deltaUtf16CodeUnits: 17 }),
      expect.objectContaining({ deltaKind: "tool_call", deltaUtf16CodeUnits: 17 }),
    ]);
    expect(events.at(-1)).toMatchObject({
      phase: "completed",
      outcome: "completed",
      meta: expect.objectContaining({ usage: { output: 100, reasoning: 25 } }),
    });
    expect(JSON.stringify(events)).not.toContain("visible output");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(JSON.stringify(events)).not.toContain('"path"');
    expect(JSON.stringify(events)).not.toContain("hidden prompt");
    expect(JSON.stringify(events)).not.toContain("invocation secret");
    expect(JSON.stringify(events)).not.toContain("provider secret");
  });

  it("chains prior hooks after payload transforms while preserving their return values and errors", async () => {
    const events: RuntimeGenerationEvent[] = [];
    const calls: string[] = [];
    const payloadResult = { transformed: true };
    const session = createSession({
      onPayload: async () => {
        calls.push("previous-payload");
        return payloadResult;
      },
      onResponse: async () => {
        calls.push("previous-response");
      },
    });
    const { adapter } = createAdapter(session, events);
    adapter.install();

    await expect(session.agent.onPayload?.({ value: "raw" }, { provider: "x", id: "m" }))
      .resolves.toBe(payloadResult);
    await session.agent.onResponse?.({ status: 200 }, { provider: "x", id: "m" });

    expect(calls).toEqual(["previous-payload", "previous-response"]);
    expect(events.map((event) => event.phase)).toEqual(["request_started", "response_stream_started"]);

    const failingPayload = vi.fn(async () => {
      throw new Error("payload transform failed");
    });
    const failingSession = createSession({ onPayload: failingPayload });
    const failingEvents: RuntimeGenerationEvent[] = [];
    const failing = createAdapter(failingSession, failingEvents);
    failing.adapter.install();

    await expect(failingSession.agent.onPayload?.({}, { provider: "x", id: "m" }))
      .rejects.toThrow("payload transform failed");
    expect(failingEvents).toEqual([]);
  });

  it("allocates separate attempts for retries and closes an orphan before the replacement request", async () => {
    const events: RuntimeGenerationEvent[] = [];
    const session = createSession();
    const { adapter, advance } = createAdapter(session, events);
    adapter.install();

    await session.agent.onPayload?.({}, { provider: "openai-codex", id: "model-a" });
    advance(5_000); // Retry delay must not enter the next attempt's duration.
    await session.agent.onPayload?.({}, { provider: "openai-codex", id: "model-a" });
    advance(100);
    await adapter.handleSessionEvent({ type: "message_start", message: message() } as never);
    advance(100);
    await adapter.handleSessionEvent({
      type: "message_update",
      message: message(),
      assistantMessageEvent: { type: "text_delta", delta: "ok" },
    } as never);
    advance(100);
    await adapter.handleSessionEvent(
      { type: "message_end", message: message() } as never,
      assistantMeta("length"),
    );

    expect(events.map((event) => `${event.phase}:${event.measurementId}`)).toEqual([
      "request_started:measurement-1",
      "completed:measurement-1",
      "request_started:measurement-2",
      "response_stream_started:measurement-2",
      "output_delta:measurement-2",
      "completed:measurement-2",
    ]);
    expect(events[1]).toMatchObject({ phase: "completed", outcome: "aborted" });
    expect(events.at(-1)).toMatchObject({ phase: "completed", outcome: "length" });
  });

  it("handles error, abort, tool-use, and final-only lifecycle outcomes without inventing a delta", async () => {
    for (const [stopReason, expectedOutcome] of [
      ["error", "error"],
      ["aborted", "aborted"],
      ["toolUse", "tool_use"],
      ["tool_use", "tool_use"],
    ] as const) {
      const events: RuntimeGenerationEvent[] = [];
      const session = createSession();
      const { adapter } = createAdapter(session, events);
      adapter.install();
      await session.agent.onPayload?.({}, { provider: "openai-codex", id: "model-a" });
      await adapter.handleSessionEvent({ type: "message_start", message: message() } as never);
      await adapter.handleSessionEvent(
        { type: "message_end", message: message() } as never,
        assistantMeta(stopReason),
      );

      expect(events.map((event) => event.phase)).toEqual([
        "request_started",
        "response_stream_started",
        "completed",
      ]);
      expect(events.at(-1)).toMatchObject({ phase: "completed", outcome: expectedOutcome });
    }
  });
});
