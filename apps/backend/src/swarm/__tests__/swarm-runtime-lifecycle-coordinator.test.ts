import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeErrorEvent, RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";
import { SwarmWorkerHealthService } from "../swarm-worker-health-service.js";
import {
  createRuntimeLifecycleControllerHostCallbacks,
  type RuntimeLifecycleController,
  SwarmRuntimeLifecycleCoordinator,
} from "../swarm-runtime-lifecycle-coordinator.js";
import { appendTurnLedgerRecord, replayTurnLedger } from "../turn-ledger.js";

function descriptor(
  overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId" | "role" | "managerId">,
): AgentDescriptor {
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: overrides.role,
    managerId: overrides.managerId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? "2026-07-13T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-13T10:00:00.000Z",
    cwd: overrides.cwd ?? "/tmp/project",
    sessionFile: overrides.sessionFile ?? `/tmp/${overrides.agentId}.jsonl`,
    model: overrides.model ?? {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    ...overrides,
  };
}

function runtime(value: AgentDescriptor): SwarmAgentRuntime {
  return {
    runtimeType: "pi",
    descriptor: value,
    getStatus: () => value.status,
    getPendingCount: () => 0,
    sendMessage: vi.fn(),
    compact: vi.fn(),
    smartCompact: vi.fn(),
    stopInFlight: vi.fn(),
    terminate: vi.fn(),
    shutdownForReplacement: vi.fn(),
    recycle: vi.fn(),
    getCustomEntries: () => [],
    appendCustomEntry: () => "entry-1",
  };
}

function createHarness(dataDir = "/tmp/data") {
  const calls: string[] = [];
  const descriptors = new Map<string, AgentDescriptor>();
  const runtimes = new Map<string, SwarmAgentRuntime>();
  const fallbackDescriptor = descriptor({ agentId: "runtime", role: "manager", managerId: "runtime" });
  const controller: RuntimeLifecycleController = {
    runtimes,
    createRuntimeForDescriptor: vi.fn(async () => runtime(fallbackDescriptor)),
    allocateRuntimeToken: vi.fn(() => 7),
    clearRuntimeToken: vi.fn(),
    getRuntimeToken: vi.fn(() => undefined),
    getRuntimeCreationPromise: vi.fn(() => undefined),
    detachRuntime: vi.fn(() => true),
    runRuntimeShutdown: vi.fn(async () => ({ timedOut: false, runtimeToken: 7 })),
    handleRuntimeStatus: vi.fn(async () => { calls.push("controller:status"); }),
    handleRuntimeSessionEvent: vi.fn(async () => { calls.push("controller:event"); }),
    handleRuntimeError: vi.fn(async () => { calls.push("controller:error"); }),
    handleRuntimeAgentEnd: vi.fn(async () => { calls.push("controller:end"); }),
    clearInvalidatedManualStopMessageEndAllowance: vi.fn(),
  };
  const workerHealth = new SwarmWorkerHealthService({
    descriptors,
    runtimes,
    getConversationHistory: () => [],
    sendMessage: vi.fn(async () => undefined),
    publishToUser: vi.fn(async () => undefined),
    terminateDescriptor: vi.fn(async () => undefined),
    saveStore: vi.fn(async () => undefined),
    emitAgentsSnapshot: vi.fn(),
    resolvePromptWithFallback: vi.fn(async (_category, _promptId, _profileId, fallback) => fallback),
    isRuntimeInContextRecovery: () => false,
    logDebug: vi.fn(),
  });
  const turnContext = {
    beforeRuntimeEventProjection: vi.fn(() => { calls.push("turn:before"); }),
    afterRuntimeEventProjection: vi.fn(() => { calls.push("turn:after"); }),
    getActiveTurnId: vi.fn(() => "turn-1"),
    handleRuntimeError: vi.fn(() => { calls.push("turn:error"); }),
    discard: vi.fn(() => { calls.push("turn:discard"); }),
    clearAgentState: vi.fn(() => { calls.push("turn:clear"); }),
    hasPendingSupersedingUserInput: vi.fn(() => false),
  };
  const codexScopes = {
    closeWorkerScope: vi.fn(() => { calls.push("codex:close"); }),
    recordManagerAgentEnd: vi.fn(() => { calls.push("codex:end"); }),
  };
  const plans = {
    finalizeUsage: vi.fn(async () => { calls.push("plans:finalize"); }),
  };
  const goals = {
    scheduleContinuation: vi.fn(() => { calls.push("goals:schedule"); }),
  };
  const choices = {
    hasPendingChoicesForSession: vi.fn(() => false),
  };
  const descriptorMutations = {
    patchDescriptor: vi.fn(async (agentId: string, patch: (value: AgentDescriptor) => AgentDescriptor) => {
      const current = descriptors.get(agentId);
      if (!current) throw new Error(`Unknown agent: ${agentId}`);
      const updated = patch(current);
      descriptors.set(agentId, updated);
      return updated;
    }),
  };
  const directory = {
    listWorkersForSession: vi.fn((managerId: string) =>
      [...descriptors.values()].filter(
        (value) => value.role === "worker" && value.managerId === managerId,
      )),
  };
  const events = {
    emitConversationMessage: vi.fn(),
    emitAgentToolCall: vi.fn(),
    emitSessionWorkersSnapshot: vi.fn(),
  };
  const coordinator = new SwarmRuntimeLifecycleCoordinator({
    dataDir,
    descriptors,
    controller,
    workerHealth,
    turnContext,
    codexScopes,
    plans,
    goals,
    choices,
    descriptorMutations,
    directory,
    events,
    now: () => "2026-07-13T10:01:00.000Z",
    logDebug: vi.fn(),
  });

  return {
    calls,
    descriptors,
    runtimes,
    controller,
    workerHealth,
    turnContext,
    codexScopes,
    plans,
    goals,
    descriptorMutations,
    directory,
    events,
    coordinator,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SwarmRuntimeLifecycleCoordinator", () => {
  it("reconciles an exact stopped manager turn once and skips while a runtime owner exists", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-runtime-stop-reconcile-"));
    try {
      const harness = createHarness(dataDir);
      const manager = descriptor({
        agentId: "manager",
        role: "manager",
        managerId: "manager",
        profileId: "profile-a",
        sessionFile: join(dataDir, "manager.jsonl"),
      });
      harness.descriptors.set(manager.agentId, manager);
      const target = harness.coordinator.getTurnLedgerSessionTarget(manager.agentId)!;
      await appendTurnLedgerRecord(target, {
        t: "turn_dispatched",
        turnId: "manager:7",
        agentId: manager.agentId,
        role: "manager",
        kind: "user",
        at: "2026-07-13T10:00:00.000Z",
      });

      await expect(harness.coordinator.reconcileStoppedManagerRuntime({
        agentId: manager.agentId,
        turnId: "manager:7",
      })).resolves.toBe(true);
      await expect(harness.coordinator.reconcileStoppedManagerRuntime({
        agentId: manager.agentId,
        turnId: "manager:7",
      })).resolves.toBe(true);

      const ledger = await replayTurnLedger(target);
      expect(ledger.records.filter((record) => record.t === "turn_terminal" && record.turnId === "manager:7"))
        .toHaveLength(1);
      expect(harness.turnContext.clearAgentState).toHaveBeenCalledTimes(2);

      harness.runtimes.set(manager.agentId, runtime(manager));
      await expect(harness.coordinator.reconcileStoppedManagerRuntime({
        agentId: manager.agentId,
        turnId: "manager:8",
      })).resolves.toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("resolves manager and worker ledger writes to the owning session", () => {
    const { coordinator, descriptors } = createHarness();
    descriptors.set("manager", descriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId: "profile-a",
    }));
    descriptors.set("worker", descriptor({ agentId: "worker", role: "worker", managerId: "manager" }));
    descriptors.set("orphan", descriptor({ agentId: "orphan", role: "worker", managerId: "missing" }));

    expect(coordinator.getTurnLedgerSessionTarget("manager")).toEqual({
      dataDir: "/tmp/data",
      profileId: "profile-a",
      sessionAgentId: "manager",
    });
    expect(coordinator.getTurnLedgerSessionTarget("worker")).toEqual({
      dataDir: "/tmp/data",
      profileId: "profile-a",
      sessionAgentId: "manager",
    });
    expect(coordinator.getTurnLedgerSessionTarget("orphan")).toBeNull();
    expect(coordinator.getTurnLedgerSessionTarget("missing")).toBeNull();
  });

  it("cleans turn and Codex state only after a successful runtime detach", () => {
    const { coordinator, controller, calls } = createHarness();

    expect(coordinator.detachRuntime("worker", 3)).toBe(true);
    expect(calls).toEqual(["turn:discard", "codex:close"]);

    calls.length = 0;
    vi.mocked(controller.detachRuntime).mockReturnValueOnce(false);
    expect(coordinator.detachRuntime("worker", 4)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("finalizes plan usage only after an accepted idle session status", async () => {
    const { coordinator, descriptors, calls } = createHarness();
    descriptors.set("manager", descriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId: "profile-a",
      status: "idle",
    }));

    await coordinator.handleRuntimeStatus(5, "manager", "idle", 0);
    expect(calls).toEqual(["controller:status", "plans:finalize", "goals:schedule"]);

    calls.length = 0;
    await coordinator.handleRuntimeStatus(5, "manager", "idle", 1);
    expect(calls).toEqual(["controller:status"]);
  });

  it("clears turn context before runtime error projection", async () => {
    const { coordinator, calls } = createHarness();
    const error: RuntimeErrorEvent = { phase: "session", message: "boom" };

    await coordinator.handleRuntimeError(8, "manager", error);

    expect(calls).toEqual(["turn:error", "controller:error"]);
  });

  it("preserves active turn context for recoverable compaction and output-guard errors", async () => {
    const { coordinator, calls } = createHarness();

    await coordinator.handleRuntimeError(8, "manager", {
      phase: "compaction",
      message: "recovery still in progress",
      details: { recoveryStage: "auto_compaction_timeout" },
    });
    expect(calls).toEqual(["controller:error"]);

    calls.length = 0;
    await coordinator.handleRuntimeError(8, "manager", {
      phase: "interrupt",
      message: "runaway output stopped",
      details: { preserveActiveTurn: true },
    });
    expect(calls).toEqual(["controller:error"]);

    calls.length = 0;
    await coordinator.handleRuntimeError(8, "manager", {
      phase: "compaction",
      message: "recovery exhausted",
      details: { recoveryStage: "recovery_failed" },
    });
    expect(calls).toEqual(["turn:error", "controller:error"]);

    calls.length = 0;
    await coordinator.handleRuntimeError(8, "manager", {
      phase: "compaction",
      message: "terminal prompt failure with no recovery lifecycle",
    });
    expect(calls).toEqual(["turn:error", "controller:error"]);
  });

  it("persists worker compaction counts and publishes the owning session snapshot", async () => {
    const { coordinator, descriptors, descriptorMutations, directory, events } = createHarness();
    descriptors.set("worker", descriptor({
      agentId: "worker",
      role: "worker",
      managerId: "manager",
      compactionCount: 2,
    }));

    await expect(
      coordinator.incrementWorkerCompactionCount("worker", "compaction-count-failed"),
    ).resolves.toBe(3);

    expect(descriptorMutations.patchDescriptor).toHaveBeenCalledOnce();
    expect(directory.listWorkersForSession).toHaveBeenCalledWith("manager");
    expect(events.emitSessionWorkersSnapshot).toHaveBeenCalledWith(
      "manager",
      [expect.objectContaining({ agentId: "worker", compactionCount: 3 })],
    );
  });

  it("records manager Codex completion before controller end and finalizes plans after", async () => {
    const { coordinator, descriptors, calls } = createHarness();
    descriptors.set("manager", descriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId: "profile-a",
    }));

    await coordinator.handleRuntimeAgentEnd(9, "manager");

    expect(calls).toEqual(["codex:end", "controller:end", "plans:finalize"]);
  });

  it("consumes only the pending assistant abort callback and cancels its timeout", () => {
    vi.useFakeTimers();
    const { coordinator, controller } = createHarness();
    const abortEvent: RuntimeSessionEvent = {
      type: "message_end",
      message: { role: "assistant", content: "aborted", stopReason: "error", errorMessage: "aborted" },
    };

    coordinator.markPendingManualManagerStopNotice("manager");
    expect(coordinator.consumePendingManualManagerStopNoticeIfApplicable("manager", abortEvent)).toBe(true);
    vi.runAllTimers();
    expect(controller.clearInvalidatedManualStopMessageEndAllowance).not.toHaveBeenCalled();
    expect(coordinator.consumePendingManualManagerStopNoticeIfApplicable("manager", abortEvent)).toBe(false);
  });

  it("expires manual-stop suppression and emits an immediate notice deterministically", () => {
    vi.useFakeTimers();
    const { coordinator, controller, events } = createHarness();

    coordinator.markPendingManualManagerStopNotice("manager");
    vi.runAllTimers();
    expect(controller.clearInvalidatedManualStopMessageEndAllowance).toHaveBeenCalledWith("manager");

    vi.mocked(controller.clearInvalidatedManualStopMessageEndAllowance).mockClear();
    coordinator.emitImmediateManualManagerStopNotice("manager");
    expect(controller.clearInvalidatedManualStopMessageEndAllowance).toHaveBeenCalledWith("manager");
    expect(events.emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "manager",
      role: "system",
      text: "Session stopped.",
    }));

    coordinator.emitImmediateManualManagerStopNotice("manager", "Restart required.");
    expect(events.emitConversationMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: "manager",
      role: "system",
      text: "Restart required.",
    }));
  });

  it("normalizes a swallowed manager abort event without mutating the source", () => {
    const { coordinator } = createHarness();
    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: { role: "assistant", content: "aborted", stopReason: "error", errorMessage: "aborted" },
    };

    const normalized = coordinator.stripManagerAbortErrorFromEvent(event);

    expect(normalized).not.toBe(event);
    expect(normalized.type === "message_end" && normalized.message).toMatchObject({
      role: "assistant",
      content: "aborted",
      stopReason: "stop",
    });
    expect(normalized.type === "message_end" && "errorMessage" in normalized.message).toBe(false);
    expect(event.type === "message_end" && event.message).toMatchObject({
      stopReason: "error",
      errorMessage: "aborted",
    });
  });

  it("builds lazy controller-host callbacks for constructor-order safety", () => {
    const state: { coordinator?: SwarmRuntimeLifecycleCoordinator } = {};
    const callbacks = createRuntimeLifecycleControllerHostCallbacks(() => {
      if (!state.coordinator) throw new Error("not initialized");
      return state.coordinator;
    });
    state.coordinator = createHarness().coordinator;
    const event: RuntimeSessionEvent = { type: "agent_start" };

    callbacks.beforeRuntimeEventProjection?.("manager", 1, event);
    expect(callbacks.getActiveTurnId?.("manager", 1)).toBe("turn-1");
  });
});
