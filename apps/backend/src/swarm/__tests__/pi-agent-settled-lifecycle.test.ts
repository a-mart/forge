/**
 * WP-5: Pi 0.80.6 agent_settled is the Forge terminal boundary.
 * Raw agent_end/willRetry is observational only.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentDescriptor } from "../types.js";

class FakeSession {
  isStreaming = false;
  abortCalls = 0;
  waitForIdleCalls = 0;
  disposeCalls = 0;
  promptCalls: string[] = [];
  agent = { transport: "sse" };
  model = { provider: "openai-codex", api: "openai-codex-responses" };
  state: { messages: Array<Record<string, unknown>> } = { messages: [] };
  sessionId = "fake-session-id";
  sessionManager = { getEntries: () => [] };
  extensionRunner = {
    hasHandlers: vi.fn(() => false),
    emit: vi.fn(async () => undefined),
  };
  modelRegistry = {
    authStorage: { get: vi.fn(), set: vi.fn() },
  };
  private listener: ((event: unknown) => void) | undefined;
  waitForIdleImpl?: () => Promise<void>;
  abortImpl?: () => Promise<void>;

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
  }
  async followUp(): Promise<void> {}
  async steer(): Promise<void> {}
  async sendUserMessage(): Promise<void> {}
  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.abortImpl) {
      await this.abortImpl();
    }
  }
  async waitForIdle(): Promise<void> {
    this.waitForIdleCalls += 1;
    if (this.waitForIdleImpl) {
      await this.waitForIdleImpl();
    }
  }
  async compact(): Promise<{ ok: true }> {
    return { ok: true };
  }
  dispose(): void {
    this.disposeCalls += 1;
  }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  emit(event: unknown): void {
    this.listener?.(event);
  }
}

function makeDescriptor(): AgentDescriptor {
  return {
    agentId: "manager",
    displayName: "Manager",
    role: "manager",
    managerId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "low" },
    sessionFile: "/tmp/project/manager.jsonl",
  };
}

function makeRuntime() {
  const session = new FakeSession();
  const onAgentEnd = vi.fn(async () => undefined);
  const onSessionEvent = vi.fn(async () => undefined);
  const onStatusChange = vi.fn(async () => undefined);
  const onRuntimeError = vi.fn(async () => undefined);
  const reportSuccess = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);

  const runtime = new AgentRuntime({
    descriptor: makeDescriptor(),
    session: session as never,
    callbacks: {
      onStatusChange,
      onSessionEvent,
      onAgentEnd,
      onRuntimeError,
    },
  });

  (runtime as unknown as {
    openAIAuthBrokerController?: {
      reportSuccess: typeof reportSuccess;
      release: () => Promise<void>;
      hasLease: () => boolean;
      beforeDispatch: () => Promise<void>;
      shouldHandleErrorBeforeGenericRetry: () => boolean;
    };
  }).openAIAuthBrokerController = {
    reportSuccess,
    release,
    hasLease: () => false,
    beforeDispatch: async () => undefined,
    shouldHandleErrorBeforeGenericRetry: () => false,
  };

  return { runtime, session, onAgentEnd, onSessionEvent, onStatusChange, onRuntimeError, reportSuccess, release };
}

describe("Pi agent_settled lifecycle adapter (WP-5)", () => {
  it("does not finalize on intermediate agent_end with willRetry:true", async () => {
    const { runtime, onAgentEnd, onSessionEvent, onStatusChange, reportSuccess } = makeRuntime();

    await (runtime as any).handleEvent({ type: "agent_start" });
    await (runtime as any).handleEvent({
      type: "agent_end",
      willRetry: true,
      messages: [],
    });

    expect(onAgentEnd).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();
    expect(onSessionEvent).not.toHaveBeenCalledWith("manager", { type: "agent_end" });
    expect(onStatusChange.mock.calls.some((call) => call[1] === "streaming")).toBe(true);
    expect(onStatusChange.mock.calls.some((call) => call[1] === "idle")).toBe(false);
  });

  it("finalizes exactly once at agent_settled after willRetry:false cycle", async () => {
    const { runtime, onAgentEnd, onSessionEvent, onStatusChange, reportSuccess } = makeRuntime();

    await (runtime as any).handleEvent({ type: "agent_start" });
    await (runtime as any).handleEvent({
      type: "agent_end",
      willRetry: false,
      messages: [],
    });
    expect(onAgentEnd).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();

    await (runtime as any).handleEvent({ type: "agent_settled" });

    expect(onSessionEvent).toHaveBeenCalledWith("manager", { type: "agent_end" });
    expect(onStatusChange.mock.calls.some((call) => call[1] === "idle")).toBe(true);
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
    expect(reportSuccess).toHaveBeenCalledTimes(1);

    await (runtime as any).handleEvent({ type: "agent_settled" });
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
    expect(reportSuccess).toHaveBeenCalledTimes(1);
  });

  it("queued continuation with willRetry:false still waits for a single settlement", async () => {
    const { runtime, onAgentEnd, onSessionEvent, reportSuccess } = makeRuntime();

    await (runtime as any).handleEvent({ type: "agent_start" });
    await (runtime as any).handleEvent({
      type: "agent_end",
      willRetry: false,
      messages: [],
    });
    // Intermediate willRetry:false must not settle — continuation cycle may follow.
    expect(onAgentEnd).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();
    expect(onSessionEvent).not.toHaveBeenCalledWith("manager", { type: "agent_end" });

    await (runtime as any).handleEvent({ type: "agent_start" });
    await (runtime as any).handleEvent({
      type: "agent_end",
      willRetry: false,
      messages: [],
    });
    expect(onAgentEnd).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();

    await (runtime as any).handleEvent({ type: "agent_settled" });
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
    expect(reportSuccess).toHaveBeenCalledTimes(1);
    expect(onSessionEvent).toHaveBeenCalledWith("manager", { type: "agent_end" });
  });

  it("error outcomes invoke onAgentEnd without broker reportSuccess", async () => {
    const { runtime, session, onAgentEnd, onSessionEvent, reportSuccess } = makeRuntime();
    session.prompt = async () => {
      throw new Error("provider boom");
    };

    await (runtime as any).handleEvent({ type: "agent_start" });
    const result = await (runtime as any).dispatchPromptWithRetry({ text: "hello" });
    expect(result).toBe("failed");
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
    expect(reportSuccess).not.toHaveBeenCalled();
    expect(onSessionEvent).not.toHaveBeenCalledWith("manager", { type: "agent_end" });

    // A late agent_settled after error must not flip the outcome to broker success.
    await (runtime as any).handleEvent({ type: "agent_settled" });
    expect(reportSuccess).not.toHaveBeenCalled();
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
  });

  it("stop suppression clears only at agent_settled and never reports broker success", async () => {
    const { runtime, session, onAgentEnd, onSessionEvent, reportSuccess } = makeRuntime();
    session.abortImpl = async () => {
      throw new Error("abort failed");
    };

    await (runtime as any).handleEvent({ type: "agent_start" });
    await runtime.stopInFlight({ abort: true, shutdownTimeoutMs: 25 });

    expect((runtime as any).suppressSessionEventsUntilIdle).toEqual(
      expect.objectContaining({ active: true }),
    );

    // Intermediate events while suppressed must not finalize or clear suppression.
    await (runtime as any).handleEvent({ type: "agent_end", willRetry: false, messages: [] });
    await (runtime as any).handleEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "late" }] },
    });
    expect((runtime as any).suppressSessionEventsUntilIdle).toEqual(
      expect.objectContaining({ active: true }),
    );
    expect(onAgentEnd).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();
    expect(onSessionEvent).not.toHaveBeenCalledWith("manager", { type: "agent_end" });

    await (runtime as any).handleEvent({ type: "agent_settled" });
    expect((runtime as any).suppressSessionEventsUntilIdle).toBeNull();
    expect(reportSuccess).not.toHaveBeenCalled();
    expect(onAgentEnd).not.toHaveBeenCalled();
  });

  it("terminate drains queued settlement before dispose", async () => {
    const { runtime, session, onAgentEnd, reportSuccess } = makeRuntime();
    const order: string[] = [];
    onAgentEnd.mockImplementation(async () => {
      order.push("onAgentEnd");
    });
    const originalDispose = session.dispose.bind(session);
    session.dispose = () => {
      order.push("dispose");
      originalDispose();
    };

    await (runtime as any).handleEvent({ type: "agent_start" });
    session.waitForIdleImpl = async () => {
      session.emit({ type: "agent_end", willRetry: false, messages: [] });
      session.emit({ type: "agent_settled" });
    };

    await runtime.terminate({ abort: true, shutdownTimeoutMs: 1_000 });

    expect(session.abortCalls).toBe(1);
    expect(session.waitForIdleCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
    expect(reportSuccess).toHaveBeenCalledTimes(1);
    expect(order.indexOf("onAgentEnd")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("dispose")).toBeGreaterThan(order.indexOf("onAgentEnd"));
  });

  it("subscribe path settles once when agent_settled arrives after queued agent_end", async () => {
    const { runtime, session, onAgentEnd, reportSuccess } = makeRuntime();

    session.emit({ type: "agent_start" });
    session.emit({ type: "agent_end", willRetry: false, messages: [] });
    session.emit({ type: "agent_settled" });
    await runtime.flushSessionEventQueue();

    expect(onAgentEnd).toHaveBeenCalledTimes(1);
    expect(reportSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not publish idle when stop abort/waitForIdle fails before settlement", async () => {
    const { runtime, session, onStatusChange } = makeRuntime();
    session.waitForIdleImpl = async () => {
      throw new Error("never settled");
    };

    await (runtime as any).handleEvent({ type: "agent_start" });
    await runtime.stopInFlight({ abort: true, shutdownTimeoutMs: 25 });

    expect(session.abortCalls).toBe(1);
    expect(session.waitForIdleCalls).toBe(1);
    expect((runtime as any).suppressSessionEventsUntilIdle).toEqual(expect.objectContaining({ active: true }));
    const callsAfterStreaming = onStatusChange.mock.calls.slice(
      onStatusChange.mock.calls.findIndex((call) => call[1] === "streaming") + 1,
    );
    expect(callsAfterStreaming.some((call) => call[1] === "idle")).toBe(false);
  });

  it("propagates terminate waitForIdle failure and does not dispose active Pi session", async () => {
    const { runtime, session } = makeRuntime();
    session.waitForIdleImpl = async () => {
      throw new Error("still active");
    };

    await (runtime as any).handleEvent({ type: "agent_start" });
    await expect(runtime.terminate({ abort: true, shutdownTimeoutMs: 25 })).rejects.toThrow("still active");

    expect(session.abortCalls).toBe(1);
    expect(session.waitForIdleCalls).toBe(1);
    expect(session.disposeCalls).toBe(0);
  });

  it("concurrent terminate and replacement share exactly one shutdown, broker release, and dispose", async () => {
    const { runtime, session, release } = makeRuntime();
    session.extensionRunner.hasHandlers.mockReturnValue(true);
    release.mockImplementation(
      () => new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      }),
    );

    await Promise.all([
      runtime.terminate({ abort: false }),
      runtime.shutdownForReplacement(),
    ]);

    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(session.disposeCalls).toBe(1);
  });

  it("concurrent recycle calls share exactly one reload shutdown, broker release, and dispose", async () => {
    const { runtime, session, release } = makeRuntime();
    session.extensionRunner.hasHandlers.mockReturnValue(true);
    release.mockImplementation(
      () => new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      }),
    );

    await Promise.all([runtime.recycle(), runtime.recycle()]);

    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith(expect.objectContaining({ reason: "reload" }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(session.disposeCalls).toBe(1);
  });

  it("still unsubscribes, disposes, clears state, and releases broker when session_shutdown throws", async () => {
    const { runtime, session, release } = makeRuntime();
    session.extensionRunner.hasHandlers.mockReturnValue(true);
    session.extensionRunner.emit.mockRejectedValue(new Error("extension shutdown boom"));

    await expect(runtime.terminate({ abort: false })).rejects.toThrow("extension shutdown boom");

    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(session.disposeCalls).toBe(1);
    expect((runtime as any).unsubscribe).toBeUndefined();
    expect((runtime as any).pendingDeliveries).toEqual([]);
    expect((runtime as any).inFlightPrompts.size).toBe(0);
  });

  it("completes mandatory cleanup and aggregates when shutdown and broker release both throw", async () => {
    const { runtime, session, release } = makeRuntime();
    session.extensionRunner.hasHandlers.mockReturnValue(true);
    session.extensionRunner.emit.mockRejectedValue(new Error("extension shutdown boom"));
    release.mockRejectedValue(new Error("broker release boom"));

    await expect(runtime.terminate({ abort: false })).rejects.toThrow(/mandatory cleanup|extension shutdown boom|broker release boom/);

    expect(session.disposeCalls).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect((runtime as any).pendingDeliveries).toEqual([]);
  });
});
