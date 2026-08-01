import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import { PiGenerationTelemetryAdapter } from "../runtime/generation-telemetry.js";
import type { RuntimeGenerationEvent } from "../runtime-contracts.js";

const tempDirs: string[] = [];
const fauxRegistrations: Array<{ unregister: () => void }> = [];

const STREAM_RESULT = { stream: "sentinel" };

afterEach(async () => {
  while (fauxRegistrations.length > 0) fauxRegistrations.pop()?.unregister();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createSession(options: {
  streamFn?: (model: unknown, context: unknown, options: unknown) => unknown | Promise<unknown>;
  onResponse?: (response: unknown, model: unknown) => unknown | Promise<unknown>;
} = {}) {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    retryAttempt: 0,
    isStreaming: true,
    agent: {
      streamFn: options.streamFn ?? (async () => STREAM_RESULT),
      prompt: async () => undefined,
      continue: async () => undefined,
      onResponse: options.onResponse,
    },
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => undefined;
    },
    emit(event: unknown) {
      for (const listener of listeners) listener(event);
    },
  };
  return session;
}

function assistantMessage(stopReason = "stop") {
  return {
    role: "assistant",
    content: [],
    provider: "openai-codex",
    model: "gpt-5.5-2026-07-01",
    responseModel: "gpt-5.5-2026-07-01",
    api: "openai-codex-responses",
    stopReason,
    usage: { output: 100, reasoning: 25 },
    requestMessages: [{ content: "hidden prompt" }],
    invocationParameters: { apiKey: "invocation secret" },
    metadata: { rawResponse: "provider secret" },
  };
}

function createAdapter(
  session: ReturnType<typeof createSession>,
  events: RuntimeGenerationEvent[],
  options: { readCodexRequests?: () => number | undefined } = {},
) {
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
    readOpenAICodexWebSocketRequestCount: options.readCodexRequests,
  });

  return {
    adapter,
    advance(milliseconds: number) {
      wallTimeMs += milliseconds;
      monotonicTimeMs += milliseconds;
    },
  };
}

async function drain(adapter: PiGenerationTelemetryAdapter): Promise<void> {
  // message_end closes the active measurement before this queued no-op abort.
  await adapter.abortActive();
}

describe("Pi generation telemetry adapter", () => {
  it.each([
    ["openai responses", "openai", "openai-responses"],
    ["openai codex responses", "openai-codex", "openai-codex-responses"],
    ["anthropic messages", "anthropic", "anthropic-messages"],
  ])("records one count-only lifecycle across %s streams", async (_family, provider, api) => {
    const events: RuntimeGenerationEvent[] = [];
    const session = createSession();
    const { adapter, advance } = createAdapter(session, events);
    adapter.install();
    session.emit({ type: "agent_start" });

    await expect(session.agent.streamFn(
      { provider, id: "model-a", api },
      { messages: [{ content: "must not be retained" }] },
      { transport: "sse" },
    )).resolves.toBe(STREAM_RESULT);
    advance(10);
    await session.agent.onResponse?.({ status: 200 }, { provider, id: "model-a" });
    advance(10);
    session.emit({ type: "message_start", message: assistantMessage() });
    advance(10);
    session.emit({
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "text_delta", delta: "visible output" },
    });
    advance(10);
    session.emit({
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
    });
    advance(10);
    session.emit({
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "toolcall_delta", delta: "{\"path\":\"secret\"}" },
    });
    advance(10);
    session.emit({ type: "message_end", message: assistantMessage() });
    await drain(adapter);

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
      measurementScope: "agent_model_call",
      agentRetryAttempt: 0,
      providerAttemptScope: "unavailable",
    });
    expect(events.filter((event) => event.phase === "output_delta")).toEqual([
      expect.objectContaining({ deltaKind: "text", deltaUtf16CodeUnits: 14 }),
      expect.objectContaining({ deltaKind: "thinking", deltaUtf16CodeUnits: 17 }),
      expect.objectContaining({ deltaKind: "tool_call", deltaUtf16CodeUnits: 17 }),
    ]);
    expect(events.at(-1)).toMatchObject({
      phase: "completed",
      outcome: "completed",
      observedProviderAttemptCount: null,
      meta: expect.objectContaining({ usage: { output: 100, reasoning: 25 } }),
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("visible output");
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain('"path"');
    expect(serialized).not.toContain("hidden prompt");
    expect(serialized).not.toContain("invocation secret");
    expect(serialized).not.toContain("provider secret");
  });

  it("does not classify idle compaction or summary streamFn calls as agent generations", async () => {
    const events: RuntimeGenerationEvent[] = [];
    const session = createSession();
    session.isStreaming = false;
    const originalStreamFn = session.agent.streamFn;
    const { adapter } = createAdapter(session, events);
    adapter.install();

    expect(session.agent.streamFn).toBe(originalStreamFn);
    session.emit({ type: "agent_start" });
    expect(session.agent.streamFn).not.toBe(originalStreamFn);
    session.emit({ type: "agent_end", messages: [] });
    expect(session.agent.streamFn).toBe(originalStreamFn);
    await expect(session.agent.streamFn({ provider: "anthropic", id: "summary-model" }, {}, {}))
      .resolves.toBe(STREAM_RESULT);
    await drain(adapter);
    expect(events).toEqual([]);
  });

  it("chains the public streamFn and response hook while preserving return values and errors", async () => {
    const events: RuntimeGenerationEvent[] = [];
    const calls: string[] = [];
    const session = createSession({
      streamFn: async () => {
        calls.push("previous-stream");
        return STREAM_RESULT;
      },
      onResponse: async () => {
        calls.push("previous-response");
      },
    });
    const { adapter } = createAdapter(session, events);
    adapter.install();
    session.emit({ type: "agent_start" });

    await expect(session.agent.streamFn({ provider: "x", id: "m" }, {}, {})).resolves.toBe(STREAM_RESULT);
    await session.agent.onResponse?.({ status: 200 }, { provider: "x", id: "m" });

    expect(calls).toEqual(["previous-stream", "previous-response"]);
    expect(events.map((event) => event.phase)).toEqual(["request_started", "response_stream_started"]);

    const failingStream = vi.fn(async () => {
      throw new Error("stream dispatch failed");
    });
    const failingSession = createSession({ streamFn: failingStream });
    const failingEvents: RuntimeGenerationEvent[] = [];
    const failing = createAdapter(failingSession, failingEvents);
    failing.adapter.install();
    failingSession.emit({ type: "agent_start" });

    await expect(failingSession.agent.streamFn({ provider: "x", id: "m" }, {}, {}))
      .rejects.toThrow("stream dispatch failed");
    expect(failingEvents.map((event) => event.phase)).toEqual(["request_started", "completed"]);
    expect(failingEvents.at(-1)).toMatchObject({ outcome: "error", observedProviderAttemptCount: null });
  });

  it("labels Codex WebSocket replay as multiple observed request frames inside one model-call rate span", async () => {
    const events: RuntimeGenerationEvent[] = [];
    const session = createSession();
    let sentRequestFrames = 11;
    const { adapter } = createAdapter(session, events, { readCodexRequests: () => sentRequestFrames });
    adapter.install();
    session.emit({ type: "agent_start" });

    await session.agent.streamFn(
      { provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" },
      {},
      { transport: "websocket" },
    );
    // Simulates a safe connection-limit replay: two response.create frames,
    // but Pi exposes no independent timing/output boundary for each frame.
    sentRequestFrames += 2;
    session.emit({ type: "message_start", message: assistantMessage() });
    session.emit({ type: "message_end", message: assistantMessage() });
    await drain(adapter);

    expect(events.filter((event) => event.phase === "request_started")).toHaveLength(1);
    expect(events[0]).toMatchObject({
      measurementScope: "agent_model_call",
      providerAttemptScope: "openai_codex_websocket_request",
    });
    expect(events.at(-1)).toMatchObject({
      phase: "completed",
      observedProviderAttemptCount: 2,
    });
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
      session.emit({ type: "agent_start" });
      await session.agent.streamFn({ provider: "openai-codex", id: "model-a" }, {}, {});
      session.emit({ type: "message_start", message: assistantMessage(stopReason) });
      session.emit({ type: "message_end", message: assistantMessage(stopReason) });
      await drain(adapter);

      expect(events.map((event) => event.phase)).toEqual([
        "request_started",
        "response_stream_started",
        "completed",
      ]);
      expect(events.at(-1)).toMatchObject({ phase: "completed", outcome: expectedOutcome });
    }
  });

  it("observes each real Pi agent retry as an independent streamFn lifecycle and preserves provider retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-generation-retry-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const faux = registerFauxProvider({
      api: "forge-telemetry-retry-api",
      provider: "forge-telemetry-retry",
      models: [{ id: "retry-model", name: "Retry", contextWindow: 32_000, maxTokens: 1_024 }],
      tokensPerSecond: 100_000,
    });
    fauxRegistrations.push(faux);
    faux.setResponses([
      () => ({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "429 rate limit exceeded",
      }) as never,
      () => ({
        role: "assistant",
        content: [{ type: "text", text: "retry succeeded" }],
        stopReason: "stop",
      }) as never,
    ]);

    const settingsManager = SettingsManager.inMemory({
      retry: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 1,
        provider: { maxRetries: 4, timeoutMs: 123, maxRetryDelayMs: 456 },
      },
    });
    const authStorage = AuthStorage.inMemory({});
    authStorage.setRuntimeApiKey("forge-telemetry-retry", "faux-test-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      authStorage,
      modelRegistry,
      model: faux.getModel(),
      thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(root),
      resourceLoader,
      settingsManager,
      noTools: "all",
      customTools: [],
    });
    const originalStreamFn = session.agent.streamFn;
    const events: RuntimeGenerationEvent[] = [];
    const adapter = new PiGenerationTelemetryAdapter({
      session,
      reasoningLevel: null,
      createMeasurementId: () => `real-attempt-${events.filter((event) => event.phase === "request_started").length + 1}`,
      onGenerationEvent: (event) => events.push(event),
    });
    adapter.install();
    expect(session.agent.streamFn).toBe(originalStreamFn);

    await session.prompt("exercise retry ordering");
    await session.waitForIdle();
    await adapter.abortActive();

    expect(session.agent.streamFn).toBe(originalStreamFn);
    expect(faux.state.callCount).toBe(2);
    expect(settingsManager.getProviderRetrySettings()).toMatchObject({
      maxRetries: 4,
      timeoutMs: 123,
      maxRetryDelayMs: 456,
    });
    const starts = events.filter((event) => event.phase === "request_started");
    const terminals = events.filter((event) => event.phase === "completed");
    expect(starts).toMatchObject([
      { measurementId: "real-attempt-1", agentRetryAttempt: 0, providerAttemptScope: "unavailable" },
      { measurementId: "real-attempt-2", agentRetryAttempt: 1, providerAttemptScope: "unavailable" },
    ]);
    expect(terminals).toMatchObject([
      { measurementId: "real-attempt-1", outcome: "error" },
      { measurementId: "real-attempt-2", outcome: "completed" },
    ]);
    expect(events.findIndex((event) => event.measurementId === "real-attempt-1" && event.phase === "completed"))
      .toBeLessThan(events.findIndex((event) => event.measurementId === "real-attempt-2" && event.phase === "request_started"));

    session.dispose();
  });
});
