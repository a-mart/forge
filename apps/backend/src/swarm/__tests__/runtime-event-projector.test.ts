import { describe, expect, it, vi } from "vitest";
import { RuntimeEventProjector, type RuntimeEventProjectorDeps } from "../runtime/runtime-event-projector.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { WorkerActivityStateLike, WorkerStallStateLike } from "../runtime/worker-health-types.js";
import { RuntimeRecoveryState } from "../runtime/runtime-recovery-state.js";
import type { AgentDescriptor } from "../types.js";

function baseDescriptor(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId" | "role" | "managerId">): AgentDescriptor {
  const now = "2026-05-06T00:00:00.000Z";
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: overrides.role,
    managerId: overrides.managerId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    cwd: overrides.cwd ?? "/tmp",
    sessionFile: overrides.sessionFile ?? "/tmp/session.jsonl",
    model: overrides.model ?? {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium"
    },
    ...overrides
  };
}

function assistantEnd(content: string, extras: Record<string, unknown> = {}): RuntimeSessionEvent {
  return { type: "message_end", message: { role: "assistant", content, ...extras } };
}

function createHarness(debug = false): {
  projector: RuntimeEventProjector;
  deps: RuntimeEventProjectorDeps;
  descriptors: Map<string, AgentDescriptor>;
  workerStallState: Map<string, WorkerStallStateLike>;
  workerActivityState: Map<string, WorkerActivityStateLike>;
  runtimeRecoveryState: RuntimeRecoveryState;
} {
  const descriptors = new Map<string, AgentDescriptor>();
  const workerStallState = new Map<string, WorkerStallStateLike>();
  const workerActivityState = new Map<string, WorkerActivityStateLike>();
  const runtimeRecoveryState = new RuntimeRecoveryState();
  const deps: RuntimeEventProjectorDeps = {
    config: { debug },
    descriptors,
    workerStallState,
    workerActivityState,
    runtimeRecoveryState,
    now: vi.fn(() => "2026-05-06T00:00:01.000Z"),
    conversationProjector: {
      captureConversationEventFromRuntime: vi.fn(),
      emitConversationMessage: vi.fn()
    },
    maybeRecordModelCapacityBlock: vi.fn(),
    maybeRecoverWorkerWithSpecialistFallback: vi.fn(async () => false),
    consumePendingManualManagerStopNoticeIfApplicable: vi.fn(() => false),
    stripManagerAbortErrorFromEvent: vi.fn((event: RuntimeSessionEvent) => event),
    isRuntimeRecoveryActive: vi.fn(() => false),
    beginPendingTransientWorkerTerminatedError: vi.fn(() => true),
    cancelPendingTransientWorkerTerminatedError: vi.fn(),
    hasPendingTransientWorkerTerminatedError: vi.fn(() => false),
    queueVersionedToolMutation: vi.fn(async () => undefined),
    logDebug: vi.fn()
  };

  return { projector: new RuntimeEventProjector(deps), deps, descriptors, workerStallState, workerActivityState, runtimeRecoveryState };
}

function stallState(overrides: Partial<WorkerStallStateLike> = {}): WorkerStallStateLike {
  return {
    lastProgressAt: 1,
    nudgeSent: false,
    nudgeSentAt: null,
    lastToolName: null,
    lastToolInput: null,
    lastToolOutput: null,
    lastDetailedReportAt: null,
    ...overrides
  };
}

describe("RuntimeEventProjector", () => {
  it("forwards missing-descriptor events to conversation capture and skips descriptor-dependent side effects", async () => {
    const { projector, deps } = createHarness();
    const event: RuntimeSessionEvent = { type: "tool_execution_start", toolName: "write", toolCallId: "t1", args: { path: "/tmp/a" } };

    await projector.projectEvent({ agentId: "missing", event });

    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledWith("missing", event);
    expect(deps.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();
    expect(deps.queueVersionedToolMutation).not.toHaveBeenCalled();
    expect(deps.logDebug).not.toHaveBeenCalled();
  });

  it("records worker assistant message_end capacity before specialist fallback, and fallback success suppresses downstream projection", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-1", role: "worker", managerId: "manager-1" });
    descriptors.set(worker.agentId, worker);
    vi.mocked(deps.maybeRecoverWorkerWithSpecialistFallback).mockResolvedValue(true);
    const event = assistantEnd("capacity failed", { stopReason: "error" });

    await projector.projectEvent({ agentId: worker.agentId, runtimeToken: 7, event });

    expect(deps.maybeRecordModelCapacityBlock).toHaveBeenCalledWith(worker.agentId, worker, {
      phase: "prompt_start",
      message: "capacity failed"
    });
    expect(deps.maybeRecoverWorkerWithSpecialistFallback).toHaveBeenCalledWith(worker.agentId, "capacity failed", "prompt_start", 7);
    expect(vi.mocked(deps.maybeRecordModelCapacityBlock).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.maybeRecoverWorkerWithSpecialistFallback).mock.invocationCallOrder[0]
    );
    expect(deps.conversationProjector.captureConversationEventFromRuntime).not.toHaveBeenCalled();
  });

  it("drops exact local shutdown-shaped worker message_end during own or parent recovery and suppresses idle finalization until agent_end cleanup", async () => {
    const { projector, deps, descriptors, runtimeRecoveryState } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-abort", role: "worker", managerId: "manager-1" });
    descriptors.set(worker.agentId, worker);
    vi.mocked(deps.isRuntimeRecoveryActive).mockImplementation((agentId) => agentId === "manager-1");

    await projector.projectEvent({ agentId: worker.agentId, event: assistantEnd("Request was aborted", { stopReason: "error" }) });

    expect(deps.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();
    expect(deps.maybeRecoverWorkerWithSpecialistFallback).not.toHaveBeenCalled();
    expect(deps.conversationProjector.captureConversationEventFromRuntime).not.toHaveBeenCalled();
    expect(runtimeRecoveryState.hasRecoveryAbortedWorkerTurn(worker.agentId)).toBe(true);
    expect(projector.shouldSuppressWorkerIdleFinalization(worker)).toBe(true);

    projector.clearRecoveryAbortedWorkerTurn(worker.agentId);
    expect(runtimeRecoveryState.hasRecoveryAbortedWorkerTurn(worker.agentId)).toBe(false);
    vi.mocked(deps.isRuntimeRecoveryActive).mockReturnValue(false);
    expect(projector.shouldSuppressWorkerIdleFinalization(worker)).toBe(false);
  });

  it("does not suppress provider-flavored worker errors during parent recovery", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-provider-error", role: "worker", managerId: "manager-1" });
    descriptors.set(worker.agentId, worker);
    vi.mocked(deps.isRuntimeRecoveryActive).mockImplementation((agentId) => agentId === "manager-1");
    const event = assistantEnd("provider failed", {
      stopReason: "error",
      errorMessage: "Request was aborted by provider transport"
    });

    await projector.projectEvent({ agentId: worker.agentId, event });

    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledWith(worker.agentId, event);
    expect(deps.maybeRecordModelCapacityBlock).toHaveBeenCalledWith(worker.agentId, worker, {
      phase: "prompt_start",
      message: "Request was aborted by provider transport"
    });
    expect(projector.shouldSuppressWorkerIdleFinalization(worker)).toBe(false);
  });

  it("drops exact local terminated worker message_end during intended shutdown", async () => {
    const { projector, deps, descriptors, runtimeRecoveryState } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-terminated", role: "worker", managerId: "manager-1", status: "terminated" });
    descriptors.set(worker.agentId, worker);
    const event = assistantEnd("", {
      stopReason: "error",
      errorMessage: "Agent worker-terminated is terminated"
    });

    await projector.projectEvent({ agentId: worker.agentId, event });

    expect(deps.conversationProjector.captureConversationEventFromRuntime).not.toHaveBeenCalled();
    expect(deps.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();
    expect(runtimeRecoveryState.hasRecoveryAbortedWorkerTurn(worker.agentId)).toBe(true);
  });

  it("defers bare worker terminated errors and cancels them on later positive progress", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-transient", role: "worker", managerId: "manager-1", status: "streaming" });
    descriptors.set(worker.agentId, worker);
    const first = assistantEnd("", { stopReason: "error", errorMessage: "terminated" });
    const second = assistantEnd("", { stopReason: "error", errorMessage: "terminated." });
    const progressEvents: RuntimeSessionEvent[] = [
      { type: "turn_start" },
      { type: "message_start", message: { role: "assistant" } },
      { type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: { command: "echo ok" } }
    ];

    await projector.projectEvent({ agentId: worker.agentId, runtimeToken: 7, event: first });
    await projector.projectEvent({ agentId: worker.agentId, runtimeToken: 7, event: second });
    for (const progress of progressEvents) {
      await projector.projectEvent({ agentId: worker.agentId, runtimeToken: 7, event: progress });
    }

    expect(deps.beginPendingTransientWorkerTerminatedError).toHaveBeenCalledTimes(2);
    expect(deps.beginPendingTransientWorkerTerminatedError).toHaveBeenNthCalledWith(
      1,
      worker.agentId,
      first,
      expect.any(Function)
    );
    expect(deps.beginPendingTransientWorkerTerminatedError).toHaveBeenNthCalledWith(
      2,
      worker.agentId,
      second,
      expect.any(Function)
    );
    expect(deps.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();
    expect(deps.maybeRecoverWorkerWithSpecialistFallback).not.toHaveBeenCalled();
    expect(deps.cancelPendingTransientWorkerTerminatedError).toHaveBeenCalledTimes(progressEvents.length);
    for (const progress of progressEvents) {
      expect(deps.cancelPendingTransientWorkerTerminatedError).toHaveBeenCalledWith(worker.agentId, "runtime_progress");
      expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledWith(worker.agentId, progress);
    }
    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledTimes(progressEvents.length);
  });

  it.each([
    ["turn_start", { type: "turn_start" }],
    ["message_start", { type: "message_start", message: { role: "assistant", content: "" } }]
  ] satisfies Array<[string, RuntimeSessionEvent]>)("cancels pending transient terminated errors on %s progress", async (_label, progress) => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-start-progress", role: "worker", managerId: "manager-1", status: "streaming" });
    descriptors.set(worker.agentId, worker);

    await projector.projectEvent({ agentId: worker.agentId, event: progress });

    expect(deps.cancelPendingTransientWorkerTerminatedError).toHaveBeenCalledWith(worker.agentId, "runtime_progress");
    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledWith(worker.agentId, progress);
  });

  it("projects an expired bare worker terminated error exactly once without capacity/fallback recovery", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-expired", role: "worker", managerId: "manager-1", status: "streaming" });
    descriptors.set(worker.agentId, worker);
    const event = assistantEnd("", { stopReason: "error", errorMessage: "terminated" });

    await projector.projectEvent({ agentId: worker.agentId, runtimeToken: 9, event, transientTerminatedExpired: true });

    expect(deps.beginPendingTransientWorkerTerminatedError).not.toHaveBeenCalled();
    expect(deps.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();
    expect(deps.maybeRecoverWorkerWithSpecialistFallback).not.toHaveBeenCalled();
    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledTimes(1);
    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledWith(worker.agentId, event);
  });

  it("does not suppress normal worker completion during parent recovery", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-normal", role: "worker", managerId: "manager-1" });
    descriptors.set(worker.agentId, worker);
    vi.mocked(deps.isRuntimeRecoveryActive).mockImplementation((agentId) => agentId === "manager-1");
    const event = assistantEnd("done");

    await projector.projectEvent({ agentId: worker.agentId, event });

    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledWith(worker.agentId, event);
    expect(projector.shouldSuppressWorkerIdleFinalization(worker)).toBe(false);
  });

  it("manager manual stop consumes pending notice, strips abort-shaped error, captures stripped event, and emits exact stop message", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-stop", role: "manager", managerId: "manager-stop" });
    descriptors.set(manager.agentId, manager);
    const original = assistantEnd("Request was aborted", { stopReason: "error", errorMessage: "Request was aborted" });
    const stripped = assistantEnd("", { stopReason: "stop" });
    vi.mocked(deps.consumePendingManualManagerStopNoticeIfApplicable).mockReturnValue(true);
    vi.mocked(deps.stripManagerAbortErrorFromEvent).mockReturnValue(stripped);

    await projector.projectEvent({ agentId: manager.agentId, event: original });

    expect(deps.consumePendingManualManagerStopNoticeIfApplicable).toHaveBeenCalledWith(manager.agentId, original);
    expect(deps.stripManagerAbortErrorFromEvent).toHaveBeenCalledWith(original);
    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledWith(manager.agentId, stripped);
    expect(deps.conversationProjector.emitConversationMessage).toHaveBeenCalledWith({
      type: "conversation_message",
      agentId: manager.agentId,
      role: "system",
      text: "Session stopped.",
      timestamp: "2026-05-06T00:00:01.000Z",
      source: "system"
    });
  });

  it("manager context-recovery abort strips and captures without stop message", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-recovery", role: "manager", managerId: "manager-recovery" });
    descriptors.set(manager.agentId, manager);
    const original = assistantEnd("", { stopReason: "error", errorMessage: "AbortError" });
    const stripped = assistantEnd("");
    vi.mocked(deps.isRuntimeRecoveryActive).mockImplementation((agentId) => agentId === manager.agentId);
    vi.mocked(deps.stripManagerAbortErrorFromEvent).mockReturnValue(stripped);

    await projector.projectEvent({ agentId: manager.agentId, event: original });

    expect(deps.stripManagerAbortErrorFromEvent).toHaveBeenCalledWith(original);
    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledWith(manager.agentId, stripped);
    expect(deps.conversationProjector.emitConversationMessage).not.toHaveBeenCalled();
  });

  it("preserves versioned write/edit mutation tracking, fallback path extraction, errors, missing descriptors, and fire-and-forget behavior", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-tools", role: "manager", managerId: "manager-tools", profileId: "profile-1" });
    descriptors.set(manager.agentId, manager);

    await projector.projectEvent({ agentId: manager.agentId, event: { type: "tool_execution_start", toolName: "edit", toolCallId: "edit-1", args: { path: "/tmp/a.ts" } } });
    await projector.projectEvent({ agentId: manager.agentId, event: { type: "tool_execution_end", toolName: "edit", toolCallId: "edit-1", result: {}, isError: false } });
    await projector.projectEvent({ agentId: manager.agentId, event: { type: "tool_execution_end", toolName: "write", toolCallId: "write-1", result: { path: "/tmp/b.ts" }, isError: false } });
    await projector.projectEvent({ agentId: manager.agentId, event: { type: "tool_execution_start", toolName: "write", toolCallId: "err-1", args: { path: "/tmp/c.ts" } } });
    await projector.projectEvent({ agentId: manager.agentId, event: { type: "tool_execution_end", toolName: "write", toolCallId: "err-1", result: { path: "/tmp/c.ts" }, isError: true } });
    projector.clearTrackedToolPaths(manager.agentId);
    await projector.projectEvent({ agentId: "missing", event: { type: "tool_execution_end", toolName: "write", toolCallId: "missing-1", result: { path: "/tmp/d.ts" }, isError: false } });

    expect(deps.queueVersionedToolMutation).toHaveBeenNthCalledWith(1, manager, expect.objectContaining({
      path: "/tmp/a.ts",
      source: "agent-edit-tool",
      profileId: "profile-1",
      sessionId: manager.agentId,
      agentId: manager.agentId
    }));
    expect(deps.queueVersionedToolMutation).toHaveBeenNthCalledWith(2, manager, expect.objectContaining({
      path: "/tmp/b.ts",
      source: "agent-write-tool"
    }));
    expect(deps.queueVersionedToolMutation).toHaveBeenCalledTimes(2);
  });

  it("preserves worker stall/activity truncation, progress reset, counts, error counts, and stale activity deletion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const { projector, descriptors, workerStallState, workerActivityState } = createHarness();
      const worker = baseDescriptor({ agentId: "worker-health", role: "worker", managerId: "manager-1" });
      descriptors.set(worker.agentId, worker);
      workerStallState.set(worker.agentId, stallState({ nudgeSent: true, nudgeSentAt: 10, lastDetailedReportAt: 20 }));

      await projector.projectEvent({ agentId: worker.agentId, event: { type: "tool_execution_start", toolName: "shell", toolCallId: "t1", args: { command: "x".repeat(700) } } });
      expect(workerStallState.get(worker.agentId)?.lastToolInput?.length).toBeLessThanOrEqual(500);
      expect(workerActivityState.get(worker.agentId)).toEqual(expect.objectContaining({ currentToolName: "shell", toolCallCount: 1 }));

      await projector.projectEvent({ agentId: worker.agentId, event: { type: "tool_execution_update", toolName: "shell", toolCallId: "t1", partialResult: "y".repeat(700) } });
      expect(workerStallState.get(worker.agentId)?.lastToolOutput?.length).toBeLessThanOrEqual(500);

      vi.setSystemTime(2_000);
      await projector.projectEvent({ agentId: worker.agentId, event: { type: "tool_execution_end", toolName: "shell", toolCallId: "t1", result: "bad", isError: true } });
      expect(workerStallState.get(worker.agentId)).toEqual(expect.objectContaining({
        lastProgressAt: 2_000,
        lastDetailedReportAt: null,
        lastToolName: null,
        lastToolInput: null,
        lastToolOutput: null,
        nudgeSent: false,
        nudgeSentAt: null
      }));
      expect(workerActivityState.get(worker.agentId)).toEqual(expect.objectContaining({ currentToolName: null, errorCount: 1 }));

      await projector.projectEvent({ agentId: worker.agentId, event: { type: "turn_end", toolResults: [] } });
      expect(workerActivityState.get(worker.agentId)?.turnCount).toBe(1);
      workerStallState.delete(worker.agentId);
      projector.updateWorkerActivity(worker.agentId, { type: "message_update", message: { role: "assistant", content: "stale" } });
      expect(workerActivityState.has(worker.agentId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps debug logging manager-only and debug-gated", async () => {
    const disabled = createHarness(false);
    const manager = baseDescriptor({ agentId: "manager-debug", role: "manager", managerId: "manager-debug" });
    disabled.descriptors.set(manager.agentId, manager);
    await disabled.projector.projectEvent({ agentId: manager.agentId, event: { type: "tool_execution_start", toolName: "shell", toolCallId: "t1", args: { command: "echo hi" } } });
    expect(disabled.deps.logDebug).not.toHaveBeenCalled();

    const enabled = createHarness(true);
    enabled.descriptors.set(manager.agentId, manager);
    const worker = baseDescriptor({ agentId: "worker-debug", role: "worker", managerId: manager.agentId });
    enabled.descriptors.set(worker.agentId, worker);
    await enabled.projector.projectEvent({ agentId: worker.agentId, event: { type: "tool_execution_start", toolName: "shell", toolCallId: "w1", args: {} } });
    expect(enabled.deps.logDebug).not.toHaveBeenCalled();

    await enabled.projector.projectEvent({ agentId: manager.agentId, event: { type: "tool_execution_start", toolName: "shell", toolCallId: "m1", args: { command: "echo hi" } } });
    expect(enabled.deps.logDebug).toHaveBeenCalledWith("manager:tool:start", expect.objectContaining({ toolName: "shell", toolCallId: "m1" }));
  });
});
