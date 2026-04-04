import { readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRuntime,
  buildHandoffFilePath,
  buildHandoffPrompt,
  buildResumePrompt,
  computeGuardThresholds,
  isAlreadyCompactedError
} from "../agent-runtime.js";
import type { AgentDescriptor } from "../types.js";

const resizeImageIfNeededMock = vi.hoisted(() =>
  vi.fn(async (data: string, mimeType: string) => ({
    data,
    mimeType
  }))
);

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  rm: vi.fn(() => Promise.resolve())
}));

vi.mock("../image-utils.js", () => ({
  resizeImageIfNeeded: (...args: any[]) => resizeImageIfNeededMock(...args)
}));

class FakeSession {
  isStreaming = true;
  promptCalls: string[] = [];
  steerCalls: string[] = [];
  abortCalls = 0;
  abortCompactionCalls = 0;
  compactCalls = 0;
  disposeCalls = 0;
  listener: ((event: any) => void) | undefined;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  promptImpl: ((message: string) => Promise<void>) | undefined;
  abortImpl: (() => Promise<void>) | undefined;
  compactImpl: (() => Promise<unknown>) | undefined;
  abortCompactionImpl: (() => void) | undefined;

  readonly sessionManager = {
    getEntries: () => [],
    buildSessionContext: () => ({ messages: [] as unknown[] }),
    resetLeaf: () => {},
    appendModelChange: () => {},
    appendThinkingLevelChange: () => {},
    appendMessage: () => {},
    appendCustomEntry: () => "custom-id"
  };

  readonly model = { provider: "openai-codex", id: "gpt-5.3-codex" };
  readonly thinkingLevel = "medium";
  readonly state = { messages: [] as Array<{ role?: string; stopReason?: string }> };
  readonly agent = {
    replaceMessages: () => {},
    continue: async () => {}
  };

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
    if (this.promptImpl) {
      await this.promptImpl(message);
    }
  }

  async steer(message: string): Promise<void> {
    this.steerCalls.push(message);
  }

  async sendUserMessage(): Promise<void> {}

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.abortImpl) {
      await this.abortImpl();
    }
  }

  abortCompaction(): void {
    this.abortCompactionCalls += 1;
    this.abortCompactionImpl?.();
  }

  async compact(): Promise<unknown> {
    this.compactCalls += 1;
    if (this.compactImpl) {
      return this.compactImpl();
    }
    return { ok: true };
  }

  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
    return this.contextUsage;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  subscribe(listener: (event: any) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: any): void {
    this.listener?.(event);
  }
}

function makeDescriptor(): AgentDescriptor {
  return {
    agentId: "guard-worker",
    displayName: "Guard Worker",
    role: "worker",
    managerId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    sessionFile: "/tmp/project/session.jsonl"
  };
}

function createRuntime(options?: {
  session?: FakeSession;
  onRuntimeError?: (error: { phase: string; message: string; details?: Record<string, unknown> }) => void;
  onSessionEvent?: (event: any) => void;
}): { runtime: AgentRuntime; session: FakeSession; runtimeErrors: Array<{ phase: string; message: string; details?: Record<string, unknown> }> } {
  const session = options?.session ?? new FakeSession();
  const runtimeErrors: Array<{ phase: string; message: string; details?: Record<string, unknown> }> = [];

  const runtime = new AgentRuntime({
    descriptor: makeDescriptor(),
    session: session as any,
    callbacks: {
      onStatusChange: () => {},
      onSessionEvent: (_agentId, event) => {
        options?.onSessionEvent?.(event);
      },
      onRuntimeError: (_agentId, error) => {
        const payload = {
          phase: error.phase,
          message: error.message,
          details: error.details
        };
        runtimeErrors.push(payload);
        options?.onRuntimeError?.(payload);
      }
    }
  });

  return { runtime, session, runtimeErrors };
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

const readFileMock = vi.mocked(readFile);
const rmMock = vi.mocked(rm);

describe("mid-turn context guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resizeImageIfNeededMock.mockImplementation(async (data: string, mimeType: string) => ({
      data,
      mimeType
    }));
    readFileMock.mockResolvedValue("## Current Task\nKeep going\n");
    rmMock.mockResolvedValue(undefined as any);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("computeGuardThresholds returns expected thresholds for normal and small context windows", () => {
    expect(computeGuardThresholds(200_000)).toEqual({
      softThresholdTokens: 171_568,
      hardThresholdTokens: 183_616
    });

    expect(computeGuardThresholds(128_000)).toEqual({
      softThresholdTokens: 103_168,
      hardThresholdTokens: 111_616
    });

    const small = computeGuardThresholds(32_000);
    expect(small).toEqual({
      softThresholdTokens: 9_472,
      hardThresholdTokens: 15_616
    });
    expect(small.softThresholdTokens).toBeLessThan(small.hardThresholdTokens);

    expect(computeGuardThresholds(16_000)).toEqual({
      softThresholdTokens: 12_000,
      hardThresholdTokens: 13_600
    });

    expect(computeGuardThresholds(8_000)).toEqual({
      softThresholdTokens: 6_000,
      hardThresholdTokens: 6_800
    });
  });

  it("checkContextBudget guard clauses skip recovery in disallowed states", async () => {
    const { runtime, session } = createRuntime();
    const runGuardSpy = vi.spyOn(runtime as any, "runContextGuard").mockResolvedValue(undefined);

    session.contextUsage = {
      tokens: 180_000,
      contextWindow: 200_000,
      percent: 90
    };

    (runtime as any).contextRecoveryInProgress = true;
    (runtime as any).checkContextBudget();

    (runtime as any).contextRecoveryInProgress = false;
    (runtime as any).status = "terminated";
    (runtime as any).checkContextBudget();

    (runtime as any).status = "idle";
    session.isStreaming = false;
    (runtime as any).checkContextBudget();

    session.isStreaming = true;
    session.contextUsage.tokens = 80_000;
    (runtime as any).checkContextBudget();

    expect(runGuardSpy).not.toHaveBeenCalled();
  });

  it("checkContextBudget throttles repeated checks", () => {
    const { runtime, session } = createRuntime();
    const runGuardSpy = vi.spyOn(runtime as any, "runContextGuard").mockResolvedValue(undefined);

    session.contextUsage = {
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    };

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(11_000)
      .mockReturnValueOnce(11_000)
      .mockReturnValueOnce(14_100)
      .mockReturnValueOnce(14_100);
    (runtime as any).checkContextBudget();
    (runtime as any).checkContextBudget();
    (runtime as any).checkContextBudget();

    expect(runGuardSpy).toHaveBeenCalledTimes(2);
  });

  it("handleEvent invokes checkContextBudget on message_end", async () => {
    const { runtime, session } = createRuntime();
    const checkSpy = vi.spyOn(runtime as any, "checkContextBudget");

    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }]
      }
    });

    await Promise.resolve();
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });

  it("normalizes Pi auto-compaction events before forwarding them to callbacks", async () => {
    const forwardedEvents: any[] = [];
    const { session } = createRuntime({
      onSessionEvent: (event) => {
        forwardedEvents.push(event);
      }
    });

    session.emit({
      type: "compaction_start",
      reason: "threshold"
    });
    session.emit({
      type: "compaction_end",
      reason: "overflow",
      result: { ok: true },
      aborted: false,
      willRetry: true,
      errorMessage: "retrying"
    });

    await Promise.resolve();

    expect(forwardedEvents).toEqual([
      {
        type: "auto_compaction_start",
        reason: "threshold"
      },
      {
        type: "auto_compaction_end",
        result: { ok: true },
        aborted: false,
        willRetry: true,
        errorMessage: "retrying"
      }
    ]);
  });

  it("does not forward manual compaction events to runtime callbacks", async () => {
    const forwardedEvents: any[] = [];
    const { session } = createRuntime({
      onSessionEvent: (event) => {
        forwardedEvents.push(event);
      }
    });

    session.emit({
      type: "compaction_start",
      reason: "manual"
    });
    session.emit({
      type: "compaction_end",
      reason: "manual",
      result: { ok: true },
      aborted: false,
      willRetry: false
    });

    await Promise.resolve();

    expect(forwardedEvents).toEqual([]);
  });

  it("prepareForSpecialistFallbackReplay includes queued follow-up turns", async () => {
    const { runtime, session } = createRuntime();
    session.isStreaming = false;

    const dispatchDeferred = createDeferred<void>();
    session.promptImpl = async () => {
      await dispatchDeferred.promise;
    };

    const promptReceipt = await runtime.sendMessage("primary prompt");
    const followUpReceipt = await runtime.sendMessage("queued follow-up");
    const replaySnapshot = await runtime.prepareForSpecialistFallbackReplay();

    dispatchDeferred.resolve(undefined);
    await Promise.resolve();

    expect(promptReceipt.acceptedMode).toBe("prompt");
    expect(followUpReceipt.acceptedMode).toBe("steer");
    expect(replaySnapshot).toEqual({
      messages: [
        {
          text: "primary prompt",
          images: []
        },
        {
          text: "queued follow-up",
          images: []
        }
      ]
    });
  });

  it("normalized image steers are consumed before fallback replay snapshots are built", async () => {
    const { runtime, session } = createRuntime();
    session.isStreaming = false;
    resizeImageIfNeededMock.mockImplementation(async (data: string) => ({
      data: `resized:${data}`,
      mimeType: "image/png"
    }));

    const dispatchDeferred = createDeferred<void>();
    session.promptImpl = async () => {
      await dispatchDeferred.promise;
    };

    await runtime.sendMessage("primary prompt");
    await runtime.sendMessage({
      text: "queued image follow-up",
      images: [{ mimeType: "image/png", data: "raw-image-data" }]
    });

    session.emit({
      type: "message_start",
      message: {
        role: "user",
        content: [
          { type: "text", text: "queued image follow-up" },
          { type: "image", mimeType: "image/png", data: "resized:raw-image-data" }
        ]
      }
    });

    await Promise.resolve();

    const replaySnapshot = await runtime.prepareForSpecialistFallbackReplay();
    dispatchDeferred.resolve(undefined);
    await Promise.resolve();

    expect(runtime.getPendingCount()).toBe(0);
    expect(replaySnapshot).toEqual({
      messages: [
        {
          text: "primary prompt",
          images: []
        },
        {
          text: "queued image follow-up",
          images: [{ mimeType: "image/png", data: "resized:raw-image-data" }]
        }
      ]
    });
  });

  it("prepareForSpecialistFallbackReplay replays consumed steers exactly once and prunes the failed turn suffix", async () => {
    const { runtime, session } = createRuntime();
    session.isStreaming = false;
    const replaceMessagesSpy = vi.spyOn(session.agent, "replaceMessages");

    const dispatchDeferred = createDeferred<void>();
    session.promptImpl = async () => {
      await dispatchDeferred.promise;
    };

    await runtime.sendMessage("primary prompt");
    await runtime.sendMessage("consumed follow-up");

    session.emit({
      type: "message_start",
      message: {
        role: "user",
        content: "consumed follow-up"
      }
    });
    await Promise.resolve();

    session.state.messages = [
      { role: "user", content: "primary prompt" },
      { role: "user", content: "consumed follow-up" },
      { role: "assistant", stopReason: "error", content: [] }
    ] as any

    const replaySnapshot = await runtime.prepareForSpecialistFallbackReplay();
    dispatchDeferred.resolve(undefined);
    await Promise.resolve();

    expect(replaySnapshot).toEqual({
      messages: [
        {
          text: "primary prompt",
          images: []
        },
        {
          text: "consumed follow-up",
          images: []
        }
      ]
    });
    expect(replaceMessagesSpy).toHaveBeenCalledWith([]);
  });

  it("sendMessage buffers deliveries while context recovery is actively in progress", async () => {
    const { runtime, session } = createRuntime();
    (runtime as any).contextRecoveryInProgress = true;
    session.isStreaming = false;

    const receipt = await runtime.sendMessage("hold until recovery completes");

    expect(receipt.acceptedMode).toBe("steer");
    expect(session.promptCalls).toEqual([]);
    expect(session.steerCalls).toEqual([]);
    expect(runtime.getPendingCount()).toBe(1);
    expect((runtime as any).recoveryBufferedMessages).toHaveLength(1);
    expect((runtime as any).pendingDeliveries[0]?.mode).toBe("recovery_buffer");
  });

  it("flushRecoveryBufferedMessages replays buffered deliveries after recovery ends", async () => {
    const { runtime, session } = createRuntime();
    session.isStreaming = false;
    (runtime as any).contextRecoveryInProgress = true;

    await runtime.sendMessage("buffer-1");
    await runtime.sendMessage("buffer-2");

    expect(session.steerCalls).toEqual([]);
    expect((runtime as any).recoveryBufferedMessages).toHaveLength(2);

    (runtime as any).contextRecoveryInProgress = false;
    await (runtime as any).flushRecoveryBufferedMessages();

    expect(session.steerCalls).toEqual(["buffer-1", "buffer-2"]);
    expect((runtime as any).recoveryBufferedMessages).toHaveLength(0);
    expect(runtime.getPendingCount()).toBe(2);
  });

  it("recovery buffer applies a hard cap and drops oldest buffered deliveries", async () => {
    const { runtime, session } = createRuntime();
    session.isStreaming = false;
    (runtime as any).contextRecoveryInProgress = true;

    for (let index = 1; index <= 30; index += 1) {
      await runtime.sendMessage(`buffer-${index}`);
    }

    expect((runtime as any).recoveryBufferedMessages).toHaveLength(25);
    expect((runtime as any).recoveryBufferedMessages[0]?.message.text).toBe("buffer-6");
    expect(runtime.getPendingCount()).toBe(25);

    (runtime as any).contextRecoveryInProgress = false;
    await (runtime as any).flushRecoveryBufferedMessages();

    expect(session.steerCalls).toHaveLength(25);
    expect(session.steerCalls[0]).toBe("buffer-6");
    expect(session.steerCalls[24]).toBe("buffer-30");
  });

  it("flushRecoveryBufferedMessages preserves new deliveries that arrive during flush", async () => {
    const { runtime, session } = createRuntime();
    session.isStreaming = false;
    (runtime as any).contextRecoveryInProgress = true;

    await runtime.sendMessage("buffer-1");
    await runtime.sendMessage("buffer-2");

    (runtime as any).contextRecoveryInProgress = false;
    (runtime as any).contextRecoveryGraceUntilMs = Date.now() + 5_000;

    const firstSteerDeferred = createDeferred<void>();
    let blockedFirstFlushSteer = false;
    vi.spyOn(session, "steer").mockImplementation(async (message: string) => {
      session.steerCalls.push(message);
      if (message === "buffer-1" && !blockedFirstFlushSteer) {
        blockedFirstFlushSteer = true;
        await firstSteerDeferred.promise;
      }
    });

    const flushPromise = (runtime as any).flushRecoveryBufferedMessages();
    await Promise.resolve();

    const receipt = await runtime.sendMessage("during-flush");
    expect(receipt.acceptedMode).toBe("steer");

    firstSteerDeferred.resolve(undefined);
    await flushPromise;

    expect(session.steerCalls).toEqual(["buffer-1", "during-flush", "buffer-2"]);
    expect((runtime as any).recoveryBufferedMessages).toHaveLength(0);
    expect(runtime.getPendingCount()).toBe(3);
  });

  it("runContextGuard happy path runs abort -> handoff -> compact -> resume -> cleanup", async () => {
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: 175_000,
      contextWindow: 200_000,
      percent: 87.5
    };

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    const handoffPath = buildHandoffFilePath(runtime.descriptor);
    expect(session.abortCalls).toBe(1);
    expect(session.compactCalls).toBe(1);
    expect(readFileMock).toHaveBeenCalledWith(handoffPath, "utf8");
    expect(session.promptCalls[0]).toBe(buildHandoffPrompt(handoffPath));
    expect(session.promptCalls[1]).toBe(buildResumePrompt("## Current Task\nKeep going"));
    expect(rmMock).toHaveBeenCalledWith(handoffPath, { force: true });
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect((runtime as any).guardAbortController).toBeUndefined();
  });

  it("runContextGuard skips handoff when triggering usage is above hard threshold", async () => {
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: 190_000,
      contextWindow: 200_000,
      percent: 95
    };

    await (runtime as any).runContextGuard({
      tokens: 184_000,
      contextWindow: 200_000,
      percent: 92
    });

    expect(session.promptCalls).toHaveLength(1);
    expect(session.compactCalls).toBe(1);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("runContextGuard awaits handoff file cleanup before completing", async () => {
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: 175_000,
      contextWindow: 200_000,
      percent: 87.5
    };

    const rmDeferred = createDeferred<void>();
    rmMock.mockImplementationOnce(() => rmDeferred.promise as any);

    let settled = false;
    const guardPromise = (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });
    void guardPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    rmDeferred.resolve(undefined);
    await guardPromise;
    expect(settled).toBe(true);
  });

  it("runContextGuard abort failure exits early and clears state", async () => {
    const { runtime, session, runtimeErrors } = createRuntime();
    session.abortImpl = async () => {
      throw new Error("abort failed");
    };

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    expect(session.promptCalls).toEqual([]);
    expect(session.compactCalls).toBe(0);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect(runtimeErrors.some((entry) => entry.phase === "context_guard")).toBe(true);
  });

  it("runContextGuard abort timeout fails fast and releases recovery lock", async () => {
    vi.useFakeTimers();
    const { runtime, session, runtimeErrors } = createRuntime();

    session.abortImpl = async () => {
      await new Promise<void>(() => {});
    };

    const guardPromise = (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await guardPromise;

    expect(session.promptCalls).toEqual([]);
    expect(session.compactCalls).toBe(0);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect(runtimeErrors.some((entry) => entry.details?.stage === "abort_failed")).toBe(true);
    expect(runtimeErrors.some((entry) => entry.message.includes("context_guard_abort timed out"))).toBe(true);
  });

  it("runContextGuard compact timeout reports error and still resumes", async () => {
    vi.useFakeTimers();
    const { runtime, session, runtimeErrors } = createRuntime();
    session.contextUsage = {
      tokens: 176_000,
      contextWindow: 200_000,
      percent: 88
    };
    session.compactImpl = async () => {
      await new Promise<void>(() => {});
    };

    const guardPromise = (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    await vi.advanceTimersByTimeAsync(180_000);
    await guardPromise;

    expect(session.compactCalls).toBe(1);
    expect(session.abortCompactionCalls).toBe(1);
    expect(session.promptCalls).toHaveLength(2);
    expect(runtimeErrors.some((entry) => entry.details?.stage === "compaction_failed")).toBe(true);
    expect(runtimeErrors.some((entry) => entry.message.includes("context_guard_compact timed out"))).toBe(true);
  });

  it("runContextGuard does not abort compaction when compact resolves just before timeout", async () => {
    vi.useFakeTimers();
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: 176_000,
      contextWindow: 200_000,
      percent: 88
    };
    session.compactImpl = async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 179_999);
      });
      return { ok: true };
    };

    const guardPromise = (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    await vi.advanceTimersByTimeAsync(179_999);
    await guardPromise;

    // Ensure the timeout callback never fires after compaction has already completed.
    await vi.advanceTimersByTimeAsync(5);

    expect(session.compactCalls).toBe(1);
    expect(session.abortCompactionCalls).toBe(0);
    expect(session.promptCalls).toHaveLength(2);
  });

  it("runContextGuard handoff timeout aborts handoff turn and still compacts", async () => {
    vi.useFakeTimers();
    const { runtime, session } = createRuntime();

    session.contextUsage = {
      tokens: 175_000,
      contextWindow: 200_000,
      percent: 87.5
    };

    session.promptImpl = async (message: string) => {
      if (message.startsWith("URGENT — CONTEXT LIMIT")) {
        // This promise intentionally never resolves. Promise.race in runHandoffTurn resolves
        // with "timeout" when the timer fires, and the orphaned prompt promise is abandoned.
        // In the real runtime, session.abort() would unblock session.prompt() via waitForIdle,
        // but this unit-test mock does not model that internal behavior.
        await new Promise<void>(() => {});
      }
    };

    const guardPromise = (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    await vi.advanceTimersByTimeAsync(45_000);
    await guardPromise;

    expect(session.abortCalls).toBe(2);
    expect(session.compactCalls).toBe(1);
    expect(session.promptCalls).toHaveLength(2);
  });

  it("runContextGuard uses no-handoff resume variant when handoff file is missing", async () => {
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: 175_000,
      contextWindow: 200_000,
      percent: 87.5
    };
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    expect(session.compactCalls).toBe(1);
    expect(session.promptCalls[1]).toBe(buildResumePrompt(undefined));
  });

  it("runContextGuard skips compaction when post-handoff usage is already below threshold", async () => {
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: 40_000,
      contextWindow: 200_000,
      percent: 20
    };

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    expect(session.compactCalls).toBe(0);
    expect(session.promptCalls).toHaveLength(2);
  });

  it("runContextGuard skips compaction when post-handoff usage is unknown", async () => {
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: null,
      contextWindow: 200_000,
      percent: null
    };

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    expect(session.compactCalls).toBe(0);
    expect(session.promptCalls).toHaveLength(2);
  });

  it("runContextGuard logs compaction failure but still sends resume prompt", async () => {
    const { runtime, session, runtimeErrors } = createRuntime();
    session.contextUsage = {
      tokens: 176_000,
      contextWindow: 200_000,
      percent: 88
    };
    session.compactImpl = async () => {
      throw new Error("compact exploded");
    };

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    expect(session.promptCalls).toHaveLength(2);
    expect(runtimeErrors.some((entry) => entry.details?.stage === "compaction_failed")).toBe(true);
  });

  it("runContextGuard treats already-compacted errors as non-fatal", async () => {
    const { runtime, session, runtimeErrors } = createRuntime();
    session.contextUsage = {
      tokens: 176_000,
      contextWindow: 200_000,
      percent: 88
    };
    session.compactImpl = async () => {
      throw new Error("Session is already compacted");
    };

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    expect(session.promptCalls).toHaveLength(2);
    expect(runtimeErrors.some((entry) => entry.details?.stage === "compaction_failed")).toBe(false);
  });

  it("reactive compaction retry times out and reports failure", async () => {
    vi.useFakeTimers();
    const { runtime, session } = createRuntime();
    session.compactImpl = async () => {
      await new Promise<void>(() => {});
    };

    const retryPromise = (runtime as any).retryCompactionOnceAfterAutoFailure("auto fail", {
      source: "test"
    });

    await vi.advanceTimersByTimeAsync(180_000);
    const result = await retryPromise;

    expect(result.recovered).toBe(false);
    expect(result.errorMessage).toContain("reactive_compaction_retry timed out");
    expect(session.abortCompactionCalls).toBe(1);
  });

  it("runContextGuard cancellation returns early when aborted immediately after session abort", async () => {
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: 176_000,
      contextWindow: 200_000,
      percent: 88
    };

    session.abortImpl = async () => {
      (runtime as any).guardAbortController?.abort();
    };

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    expect(session.promptCalls).toEqual([]);
    expect(session.compactCalls).toBe(0);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
  });

  it("runContextGuard cancellation during handoff exits before compaction", async () => {
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: 176_000,
      contextWindow: 200_000,
      percent: 88
    };

    session.promptImpl = async (message: string) => {
      if (message.startsWith("URGENT — CONTEXT LIMIT")) {
        (runtime as any).guardAbortController?.abort();
      }
    };

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    expect(session.promptCalls).toHaveLength(1);
    expect(session.compactCalls).toBe(0);
  });

  it("recovery lock serializes guard and reactive auto-compaction recovery", async () => {
    const { runtime, session } = createRuntime();

    (runtime as any).contextRecoveryInProgress = true;
    const retrySpy = vi.spyOn(runtime as any, "retryCompactionOnceAfterAutoFailure");

    await (runtime as any).handleAutoCompactionEndEvent({
      type: "auto_compaction_end",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "compact failed"
    });

    expect(retrySpy).not.toHaveBeenCalled();

    session.contextUsage = {
      tokens: 180_000,
      contextWindow: 200_000,
      percent: 90
    };
    const guardSpy = vi.spyOn(runtime as any, "runContextGuard").mockResolvedValue(undefined);
    (runtime as any).checkContextBudget();
    expect(guardSpy).not.toHaveBeenCalled();
  });

  it("handleAutoCompactionEndEvent skips late errors during recovery grace period", async () => {
    const { runtime } = createRuntime();
    const retrySpy = vi.spyOn(runtime as any, "retryCompactionOnceAfterAutoFailure");

    (runtime as any).contextRecoveryInProgress = false;
    (runtime as any).contextRecoveryGraceUntilMs = Date.now() + 1_500;
    (runtime as any).latestAutoCompactionReason = "overflow";

    await (runtime as any).handleAutoCompactionEndEvent({
      type: "auto_compaction_end",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "compact failed"
    });

    expect(retrySpy).not.toHaveBeenCalled();
    expect((runtime as any).latestAutoCompactionReason).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        recoveryStage: "auto_compaction_skipped",
        reason: "recovery_grace_period"
      })
    );
  });

  it("handleAutoCompactionEndEvent processes errors normally after grace expires", async () => {
    const { runtime } = createRuntime();
    const retrySpy = vi
      .spyOn(runtime as any, "retryCompactionOnceAfterAutoFailure")
      .mockResolvedValue({ recovered: true });

    (runtime as any).contextRecoveryInProgress = false;
    (runtime as any).contextRecoveryGraceUntilMs = Date.now() - 1;
    (runtime as any).latestAutoCompactionReason = "overflow";

    await (runtime as any).handleAutoCompactionEndEvent({
      type: "auto_compaction_end",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "compact failed"
    });

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect((runtime as any).contextRecoveryGraceUntilMs).toBeGreaterThan(Date.now());
  });

  it("allows a new guard cycle after late auto-compaction events are suppressed", async () => {
    const { runtime, session } = createRuntime();
    session.contextUsage = {
      tokens: 176_000,
      contextWindow: 200_000,
      percent: 88
    };

    await (runtime as any).runContextGuard({
      tokens: 172_000,
      contextWindow: 200_000,
      percent: 86
    });

    (runtime as any).latestAutoCompactionReason = "overflow";
    const retrySpy = vi.spyOn(runtime as any, "retryCompactionOnceAfterAutoFailure");

    await (runtime as any).handleAutoCompactionEndEvent({
      type: "auto_compaction_end",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "late compact failed"
    });

    expect(retrySpy).not.toHaveBeenCalled();

    (runtime as any).contextRecoveryGraceUntilMs = Date.now() - 1;
    const guardSpy = vi.spyOn(runtime as any, "runContextGuard").mockResolvedValue(undefined);
    session.contextUsage = {
      tokens: 180_000,
      contextWindow: 200_000,
      percent: 90
    };

    (runtime as any).checkContextBudget();

    expect(guardSpy).toHaveBeenCalledTimes(1);
  });

  it("overflow recovery cleanup does not schedule duplicate agent.continue", async () => {
    vi.useFakeTimers();
    const { runtime, session } = createRuntime();
    const retrySpy = vi
      .spyOn(runtime as any, "retryCompactionOnceAfterAutoFailure")
      .mockResolvedValue({ recovered: true });
    const continueSpy = vi.spyOn(session.agent, "continue");
    const replaceSpy = vi.spyOn(session.agent, "replaceMessages");

    session.state.messages.push({ role: "assistant", stopReason: "error" });
    (runtime as any).latestAutoCompactionReason = "overflow";

    await (runtime as any).handleAutoCompactionEndEvent({
      type: "auto_compaction_end",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "compact failed"
    });

    await vi.runAllTimersAsync();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(continueSpy).not.toHaveBeenCalled();
  });

  it("stopInFlight and terminate abort active guard controller and clear guard state", async () => {
    const { runtime, session } = createRuntime();

    const stopController = new AbortController();
    (runtime as any).guardAbortController = stopController;
    (runtime as any).contextRecoveryInProgress = true;
    (runtime as any).contextRecoveryGraceUntilMs = Date.now() + 5_000;
    (runtime as any).lastContextBudgetCheckAtMs = 123;

    await runtime.stopInFlight({ abort: false });

    expect(stopController.signal.aborted).toBe(true);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect((runtime as any).contextRecoveryGraceUntilMs).toBe(0);
    expect((runtime as any).guardAbortController).toBeUndefined();
    expect((runtime as any).lastContextBudgetCheckAtMs).toBe(0);

    const terminateController = new AbortController();
    (runtime as any).guardAbortController = terminateController;
    (runtime as any).contextRecoveryInProgress = true;
    (runtime as any).contextRecoveryGraceUntilMs = Date.now() + 5_000;
    (runtime as any).lastContextBudgetCheckAtMs = 456;

    await runtime.terminate({ abort: false });

    expect(terminateController.signal.aborted).toBe(true);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect((runtime as any).contextRecoveryGraceUntilMs).toBe(0);
    expect((runtime as any).guardAbortController).toBeUndefined();
    expect((runtime as any).lastContextBudgetCheckAtMs).toBe(0);
    expect(session.disposeCalls).toBe(1);
  });

  it("stopInFlight and terminate still clear guard state when abort throws", async () => {
    const { runtime, session } = createRuntime();

    session.abortImpl = async () => {
      throw new Error("abort rejected");
    };

    const stopController = new AbortController();
    (runtime as any).guardAbortController = stopController;
    (runtime as any).contextRecoveryInProgress = true;
    (runtime as any).contextRecoveryGraceUntilMs = Date.now() + 5_000;
    (runtime as any).lastContextBudgetCheckAtMs = 999;

    await expect(runtime.stopInFlight({ abort: true })).resolves.toBeUndefined();
    expect(stopController.signal.aborted).toBe(true);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect((runtime as any).contextRecoveryGraceUntilMs).toBe(0);
    expect((runtime as any).guardAbortController).toBeUndefined();
    expect((runtime as any).lastContextBudgetCheckAtMs).toBe(0);

    const terminateController = new AbortController();
    (runtime as any).guardAbortController = terminateController;
    (runtime as any).contextRecoveryInProgress = true;
    (runtime as any).contextRecoveryGraceUntilMs = Date.now() + 5_000;
    (runtime as any).lastContextBudgetCheckAtMs = 1000;

    await expect(runtime.terminate({ abort: true })).resolves.toBeUndefined();
    expect(terminateController.signal.aborted).toBe(true);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect((runtime as any).contextRecoveryGraceUntilMs).toBe(0);
    expect((runtime as any).guardAbortController).toBeUndefined();
    expect((runtime as any).lastContextBudgetCheckAtMs).toBe(0);
    expect(runtime.getStatus()).toBe("terminated");
  });

  it("buildHandoffPrompt and buildResumePrompt produce expected templates", () => {
    const handoffPath = buildHandoffFilePath({ agentId: "guard-worker", cwd: "/tmp/project" });
    const handoffPrompt = buildHandoffPrompt(handoffPath);
    expect(handoffPrompt).toContain("URGENT — CONTEXT LIMIT");
    expect(handoffPrompt).toContain(`Use the write tool to create this file: \`${handoffPath}\``);
    expect(handoffPrompt).toContain("## Current Task");
    expect(handoffPrompt).toContain("Do not use bash, read, or edit tools — ONLY the write tool");
    expect(handoffPrompt).toContain("Write the file immediately with a single write tool call");

    const withHandoff = buildResumePrompt("## Current Task\n- keep moving");
    expect(withHandoff).toContain("Before compaction, you wrote a handoff document");
    expect(withHandoff).toContain("## Current Task");
    expect(withHandoff).toContain("Verify the workspace is consistent");

    const withoutHandoff = buildResumePrompt(undefined);
    expect(withoutHandoff).toContain("Some earlier conversation details have been summarized");
    expect(withoutHandoff).toContain("git status");
  });

  it("buildHandoffFilePath falls back to current directory when cwd is undefined", () => {
    const path = buildHandoffFilePath({
      agentId: "guard-worker",
      cwd: undefined
    });

    expect(path).toBe(".forge-handoff-guard-worker.md");
  });

  it("isAlreadyCompactedError matches already-compacted and nothing-to-compact strings", () => {
    expect(isAlreadyCompactedError("Session already compacted; skipping")).toBe(true);
    expect(isAlreadyCompactedError("There is nothing to compact")).toBe(true);
    expect(isAlreadyCompactedError("context window overflow")).toBe(false);
  });
});
