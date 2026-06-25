import { describe, expect, it, vi } from "vitest";
import { RuntimeEventProjector, type RuntimeEventProjectorDeps } from "../runtime/runtime-event-projector.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
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

function eligibleCacheAssistantEnd(extras: Record<string, unknown> = {}): RuntimeSessionEvent {
  return assistantEnd("", {
    provider: "openai-codex",
    modelId: "gpt-5.5",
    usage: { input_tokens: 3000, cache_read_input_tokens: 2500, output_tokens: 120 },
    ...extras
  });
}

function piRuntime(descriptor: AgentDescriptor): SwarmAgentRuntime {
  return {
    runtimeType: "pi",
    descriptor,
    getStatus: () => descriptor.status,
    getPendingCount: () => 0,
    sendMessage: vi.fn(),
    compact: vi.fn(),
    smartCompact: vi.fn(),
    stopInFlight: vi.fn(),
    terminate: vi.fn(),
    shutdownForReplacement: vi.fn(),
    recycle: vi.fn(),
    getCustomEntries: () => [],
    appendCustomEntry: () => "entry-1"
  };
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
    markSessionActivity: vi.fn(),
    maybeRecordModelCapacityBlock: vi.fn(),
    maybeRecoverWorkerWithSpecialistFallback: vi.fn(async () => false),
    consumePendingManualManagerStopNoticeIfApplicable: vi.fn(() => false),
    stripManagerAbortErrorFromEvent: vi.fn((event: RuntimeSessionEvent) => event),
    isRuntimeRecoveryActive: vi.fn(() => false),
    beginPendingTransientWorkerTerminatedError: vi.fn(() => true),
    cancelPendingTransientWorkerTerminatedError: vi.fn(),
    hasPendingTransientWorkerTerminatedError: vi.fn(() => false),
    queueVersionedToolMutation: vi.fn(async () => undefined),
    logDebug: vi.fn(),
    getRuntime: vi.fn(() => undefined),
    isModelCacheVisualizationEnabled: vi.fn(() => false),
    emitModelCacheObservation: vi.fn()
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
  it("projects activated manager assistant output after conversation capture at turn end", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-1", role: "manager", managerId: "manager-1" });
    descriptors.set(manager.agentId, manager);
    projector.activateManagerAssistantOutputTurn(manager.agentId, { kind: "session_transcript", channel: "web" });

    await projector.projectEvent({
      agentId: manager.agentId,
      event: { type: "message_end", message: { role: "assistant", content: "Final answer", stopReason: "stop" } },
    });
    expect(deps.conversationProjector.emitConversationMessage).not.toHaveBeenCalled();

    await projector.projectEvent({ agentId: manager.agentId, event: { type: "turn_end", toolResults: [] } });

    expect(deps.conversationProjector.captureConversationEventFromRuntime).toHaveBeenCalledTimes(2);
    expect(deps.conversationProjector.emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation_message",
      agentId: manager.agentId,
      role: "assistant",
      source: "assistant_output",
      text: "Final answer",
      sourceContext: { channel: "web" },
    }));
    expect(deps.markSessionActivity).toHaveBeenCalledWith(manager.agentId, "2026-05-06T00:00:01.000Z");
  });

  it("can project preserved manager assistant output when a present_choices card is opened", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-1", role: "manager", managerId: "manager-1" });
    descriptors.set(manager.agentId, manager);
    projector.activateManagerAssistantOutputTurn(manager.agentId, { kind: "session_transcript", channel: "web" });

    await projector.projectEvent({
      agentId: manager.agentId,
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Pick an option." },
            { type: "toolCall", name: "present_choices", id: "choice-1", arguments: { questions: [] } },
          ],
        },
      },
    });
    await projector.projectEvent({
      agentId: manager.agentId,
      event: { type: "tool_execution_start", toolName: "present_choices", toolCallId: "choice-1", args: {} },
    });

    expect(projector.flushPreservedManagerAssistantOutputForTool(manager.agentId, "present_choices")).toBe(true);

    expect(deps.conversationProjector.emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation_message",
      agentId: manager.agentId,
      role: "assistant",
      source: "assistant_output",
      text: "Pick an option.",
    }));
  });

  it("does not project routed-required or internal-only manager assistant output turns", async () => {
    for (const target of [
      { kind: "explicit_tool_required" as const, reason: "agent_message" },
      { kind: "internal_only" as const },
    ]) {
      const { projector, deps, descriptors } = createHarness();
      const manager = baseDescriptor({ agentId: "manager-1", role: "manager", managerId: "manager-1" });
      descriptors.set(manager.agentId, manager);
      projector.activateManagerAssistantOutputTurn(manager.agentId, target);

      await projector.projectEvent({
        agentId: manager.agentId,
        event: { type: "message_end", message: { role: "assistant", content: "Hidden text", stopReason: "stop" } },
      });
      await projector.projectEvent({ agentId: manager.agentId, event: { type: "turn_end", toolResults: [] } });

      expect(deps.conversationProjector.emitConversationMessage).not.toHaveBeenCalled();
    }
  });

  it("does not project manager assistant output after post-projection cleanup clears the turn", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({ agentId: "manager-1", role: "manager", managerId: "manager-1" });
    descriptors.set(manager.agentId, manager);
    projector.activateManagerAssistantOutputTurn(manager.agentId, { kind: "session_transcript", channel: "web" });

    await projector.projectEvent({ agentId: manager.agentId, event: { type: "turn_end", toolResults: [] } });
    await projector.projectEvent({
      agentId: manager.agentId,
      event: { type: "message_end", message: { role: "assistant", content: "Too late", stopReason: "stop" } },
    });

    expect(deps.conversationProjector.emitConversationMessage).not.toHaveBeenCalled();
  });

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

  describe("model cache observation capture", () => {
    it("does not emit when visualization is disabled", async () => {
      const { projector, deps, descriptors } = createHarness();
      const manager = baseDescriptor({ agentId: "manager-cache-off", role: "manager", managerId: "manager-cache-off" });
      descriptors.set(manager.agentId, manager);
      vi.mocked(deps.isModelCacheVisualizationEnabled).mockReturnValue(false);
      vi.mocked(deps.getRuntime).mockReturnValue(piRuntime(manager));

      await projector.projectEvent({ agentId: manager.agentId, event: eligibleCacheAssistantEnd() });

      expect(deps.getRuntime).not.toHaveBeenCalled();
      expect(deps.emitModelCacheObservation).not.toHaveBeenCalled();
    });

    it("emits exactly one eligible manager Pi assistant message_end observation when enabled", async () => {
      const { projector, deps, descriptors } = createHarness();
      const manager = baseDescriptor({ agentId: "manager-cache-on", role: "manager", managerId: "manager-cache-on" });
      descriptors.set(manager.agentId, manager);
      vi.mocked(deps.isModelCacheVisualizationEnabled).mockReturnValue(true);
      vi.mocked(deps.getRuntime).mockReturnValue(piRuntime(manager));

      await projector.projectEvent({ agentId: manager.agentId, event: eligibleCacheAssistantEnd({ turnId: "turn-42" }) });

      expect(deps.emitModelCacheObservation).toHaveBeenCalledTimes(1);
      expect(deps.emitModelCacheObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "model_cache_observation",
          agentId: manager.agentId,
          runtimeType: "pi",
          provider: "openai-codex",
          turnId: "turn-42",
          id: "turn-42"
        })
      );
    });

    it.each(["toolUse", "tool_use", "ToolUse"])("does not emit for intermediate tool-use assistant ends (%s)", async (stopReason) => {
      const { projector, deps, descriptors } = createHarness();
      const manager = baseDescriptor({ agentId: "manager-cache-tool-use", role: "manager", managerId: "manager-cache-tool-use" });
      descriptors.set(manager.agentId, manager);
      vi.mocked(deps.isModelCacheVisualizationEnabled).mockReturnValue(true);
      vi.mocked(deps.getRuntime).mockReturnValue(piRuntime(manager));

      await projector.projectEvent({
        agentId: manager.agentId,
        event: eligibleCacheAssistantEnd({ stopReason })
      });

      expect(deps.emitModelCacheObservation).not.toHaveBeenCalled();
    });

    it.each([
      ["worker role", baseDescriptor({ agentId: "worker-cache", role: "worker", managerId: "manager-1" })],
      ["non-assistant message_end", baseDescriptor({ agentId: "manager-user", role: "manager", managerId: "manager-user" })]
    ])("does not emit for %s", async (_label, descriptor) => {
      const { projector, deps, descriptors } = createHarness();
      descriptors.set(descriptor.agentId, descriptor);
      vi.mocked(deps.isModelCacheVisualizationEnabled).mockReturnValue(true);
      vi.mocked(deps.getRuntime).mockReturnValue(piRuntime(descriptor));

      const event =
        descriptor.role === "worker"
          ? eligibleCacheAssistantEnd()
          : ({ type: "message_end", message: { role: "user", content: "hi" } } as RuntimeSessionEvent);

      await projector.projectEvent({ agentId: descriptor.agentId, event });

      expect(deps.emitModelCacheObservation).not.toHaveBeenCalled();
    });

    it("does not emit for non-Pi runtime, missing runtime, or ineligible usage", async () => {
      const { projector, deps, descriptors } = createHarness();
      const manager = baseDescriptor({ agentId: "manager-cache-guards", role: "manager", managerId: "manager-cache-guards" });
      descriptors.set(manager.agentId, manager);
      vi.mocked(deps.isModelCacheVisualizationEnabled).mockReturnValue(true);

      vi.mocked(deps.getRuntime).mockReturnValue({
        ...piRuntime(manager),
        runtimeType: "claude"
      } as SwarmAgentRuntime);
      await projector.projectEvent({ agentId: manager.agentId, event: eligibleCacheAssistantEnd() });
      expect(deps.emitModelCacheObservation).not.toHaveBeenCalled();

      vi.mocked(deps.getRuntime).mockReturnValue(undefined);
      await projector.projectEvent({ agentId: manager.agentId, event: eligibleCacheAssistantEnd() });
      expect(deps.emitModelCacheObservation).not.toHaveBeenCalled();

      vi.mocked(deps.getRuntime).mockReturnValue(piRuntime(manager));
      await projector.projectEvent({
        agentId: manager.agentId,
        event: eligibleCacheAssistantEnd({ usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } })
      });
      expect(deps.emitModelCacheObservation).not.toHaveBeenCalled();
    });

    it("does not emit for error, aborted, or manual-stop normalized assistant ends", async () => {
      const { projector, deps, descriptors } = createHarness();
      const manager = baseDescriptor({ agentId: "manager-cache-stop", role: "manager", managerId: "manager-cache-stop" });
      descriptors.set(manager.agentId, manager);
      vi.mocked(deps.isModelCacheVisualizationEnabled).mockReturnValue(true);
      vi.mocked(deps.getRuntime).mockReturnValue(piRuntime(manager));

      await projector.projectEvent({
        agentId: manager.agentId,
        event: eligibleCacheAssistantEnd({ stopReason: "error", errorMessage: "provider failed" })
      });
      await projector.projectEvent({
        agentId: manager.agentId,
        event: eligibleCacheAssistantEnd({ stopReason: "aborted" })
      });

      const stripped = eligibleCacheAssistantEnd({ stopReason: "stop" });
      vi.mocked(deps.consumePendingManualManagerStopNoticeIfApplicable).mockReturnValue(true);
      vi.mocked(deps.stripManagerAbortErrorFromEvent).mockReturnValue(stripped);
      await projector.projectEvent({
        agentId: manager.agentId,
        event: eligibleCacheAssistantEnd({ stopReason: "error", errorMessage: "Request was aborted" })
      });

      expect(deps.emitModelCacheObservation).not.toHaveBeenCalled();
    });

    it("does not emit for unsupported providers", async () => {
      const { projector, deps, descriptors } = createHarness();
      const manager = baseDescriptor({
        agentId: "manager-cache-provider",
        role: "manager",
        managerId: "manager-cache-provider",
        model: { provider: "anthropic", modelId: "claude-sonnet", thinkingLevel: "medium" }
      });
      descriptors.set(manager.agentId, manager);
      vi.mocked(deps.isModelCacheVisualizationEnabled).mockReturnValue(true);
      vi.mocked(deps.getRuntime).mockReturnValue(piRuntime(manager));

      await projector.projectEvent({
        agentId: manager.agentId,
        event: eligibleCacheAssistantEnd({ provider: "anthropic", modelId: "claude-sonnet" })
      });

      expect(deps.emitModelCacheObservation).not.toHaveBeenCalled();
    });
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
