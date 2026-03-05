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

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  rm: vi.fn(() => Promise.resolve())
}));

class FakeSession {
  isStreaming = true;
  promptCalls: string[] = [];
  steerCalls: string[] = [];
  abortCalls = 0;
  compactCalls = 0;
  disposeCalls = 0;
  listener: ((event: any) => void) | undefined;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  promptImpl: ((message: string) => Promise<void>) | undefined;
  abortImpl: (() => Promise<void>) | undefined;
  compactImpl: (() => Promise<unknown>) | undefined;

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
}): { runtime: AgentRuntime; session: FakeSession; runtimeErrors: Array<{ phase: string; message: string; details?: Record<string, unknown> }> } {
  const session = options?.session ?? new FakeSession();
  const runtimeErrors: Array<{ phase: string; message: string; details?: Record<string, unknown> }> = [];

  const runtime = new AgentRuntime({
    descriptor: makeDescriptor(),
    session: session as any,
    callbacks: {
      onStatusChange: () => {},
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
    nowSpy.mockReturnValueOnce(10_000);
    (runtime as any).checkContextBudget();

    nowSpy.mockReturnValueOnce(11_000);
    (runtime as any).checkContextBudget();

    nowSpy.mockReturnValueOnce(14_100);
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

  it("sendMessage queues steering deliveries while context recovery is in progress", async () => {
    const { runtime, session } = createRuntime();
    (runtime as any).contextRecoveryInProgress = true;
    session.isStreaming = false;

    const receipt = await runtime.sendMessage("hold until recovery completes");

    expect(receipt.acceptedMode).toBe("steer");
    expect(session.promptCalls).toEqual([]);
    expect(session.steerCalls).toEqual(["hold until recovery completes"]);
    expect(runtime.getPendingCount()).toBe(1);
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

    await vi.advanceTimersByTimeAsync(60_000);
    await guardPromise;

    expect(session.compactCalls).toBe(1);
    expect(session.promptCalls).toHaveLength(2);
    expect(runtimeErrors.some((entry) => entry.details?.stage === "compaction_failed")).toBe(true);
    expect(runtimeErrors.some((entry) => entry.message.includes("context_guard_compact timed out"))).toBe(true);
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

    await vi.advanceTimersByTimeAsync(60_000);
    const result = await retryPromise;

    expect(result.recovered).toBe(false);
    expect(result.errorMessage).toContain("reactive_compaction_retry timed out");
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

  it("stopInFlight and terminate abort active guard controller and clear guard state", async () => {
    const { runtime, session } = createRuntime();

    const stopController = new AbortController();
    (runtime as any).guardAbortController = stopController;
    (runtime as any).contextRecoveryInProgress = true;
    (runtime as any).lastContextBudgetCheckAtMs = 123;

    await runtime.stopInFlight({ abort: false });

    expect(stopController.signal.aborted).toBe(true);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect((runtime as any).guardAbortController).toBeUndefined();
    expect((runtime as any).lastContextBudgetCheckAtMs).toBe(0);

    const terminateController = new AbortController();
    (runtime as any).guardAbortController = terminateController;
    (runtime as any).contextRecoveryInProgress = true;
    (runtime as any).lastContextBudgetCheckAtMs = 456;

    await runtime.terminate({ abort: false });

    expect(terminateController.signal.aborted).toBe(true);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
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
    (runtime as any).lastContextBudgetCheckAtMs = 999;

    await expect(runtime.stopInFlight({ abort: true })).resolves.toBeUndefined();
    expect(stopController.signal.aborted).toBe(true);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect((runtime as any).guardAbortController).toBeUndefined();
    expect((runtime as any).lastContextBudgetCheckAtMs).toBe(0);

    const terminateController = new AbortController();
    (runtime as any).guardAbortController = terminateController;
    (runtime as any).contextRecoveryInProgress = true;
    (runtime as any).lastContextBudgetCheckAtMs = 1000;

    await expect(runtime.terminate({ abort: true })).resolves.toBeUndefined();
    expect(terminateController.signal.aborted).toBe(true);
    expect((runtime as any).contextRecoveryInProgress).toBe(false);
    expect((runtime as any).guardAbortController).toBeUndefined();
    expect((runtime as any).lastContextBudgetCheckAtMs).toBe(0);
    expect(runtime.getStatus()).toBe("terminated");
  });

  it("buildHandoffPrompt and buildResumePrompt produce expected templates", () => {
    const handoffPath = "/tmp/project/.middleman-handoff-guard-worker.md";
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
    expect(withoutHandoff).toContain("ls -lt");
  });

  it("buildHandoffFilePath falls back to current directory when cwd is undefined", () => {
    const path = buildHandoffFilePath({
      agentId: "guard-worker",
      cwd: undefined
    });

    expect(path).toBe(".middleman-handoff-guard-worker.md");
  });

  it("isAlreadyCompactedError matches already-compacted and nothing-to-compact strings", () => {
    expect(isAlreadyCompactedError("Session already compacted; skipping")).toBe(true);
    expect(isAlreadyCompactedError("There is nothing to compact")).toBe(true);
    expect(isAlreadyCompactedError("context window overflow")).toBe(false);
  });
});
