import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentDescriptor, createWorkerDescriptor } from "../../test-support/index.js";
import type { PromptCategory } from "../prompt-registry.js";
import {
  SwarmWorkerHealthService,
  TRANSIENT_WORKER_TERMINATED_GRACE_MS,
  WATCHDOG_CIRCUIT_MAX_MS,
  type SwarmWorkerHealthServiceOptions
} from "../swarm-worker-health-service.js";
import type { SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentDescriptor, ConversationEntryEvent } from "../types.js";

const STALL_NUDGE_THRESHOLD_MS = 5 * 60 * 1000;
const IDLE_GRACE_MS = 3_000;
const BATCH_WINDOW_MS = 750;

function baseHealthOptions(
  overrides: Partial<SwarmWorkerHealthServiceOptions> & {
    descriptors?: Map<string, AgentDescriptor>;
    runtimes?: Map<string, SwarmAgentRuntime>;
  } = {}
): SwarmWorkerHealthServiceOptions {
  const descriptors = overrides.descriptors ?? new Map<string, AgentDescriptor>();
  const runtimes = overrides.runtimes ?? new Map<string, SwarmAgentRuntime>();
  const { descriptors: _d, runtimes: _r, ...restOverrides } = overrides;

  return {
    getConversationHistory: overrides.getConversationHistory ?? ((_agentId?: string) => [] as ConversationEntryEvent[]),
    sendMessage: overrides.sendMessage ?? vi.fn(async () => ({})),
    publishToUser: overrides.publishToUser ?? vi.fn(async () => {}),
    terminateDescriptor: overrides.terminateDescriptor ?? vi.fn(async () => {}),
    saveStore: overrides.saveStore ?? vi.fn(async () => {}),
    emitAgentsSnapshot: overrides.emitAgentsSnapshot ?? vi.fn(),
    resolvePromptWithFallback:
      overrides.resolvePromptWithFallback ??
      vi.fn(async (_c: PromptCategory, _id: string, _profile: string, fallback: string) => fallback),
    isRuntimeInContextRecovery: overrides.isRuntimeInContextRecovery ?? vi.fn(() => false),
    logDebug: overrides.logDebug ?? vi.fn(),
    ...restOverrides,
    descriptors,
    runtimes
  };
}

describe("SwarmWorkerHealthService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("getWorkerReportDispatchTurnSeq returns the worker turn seq for an in-flight worker report to its manager", () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);

    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors }));
    const state = svc.getOrCreateWorkerWatchdogState("w1");
    state.turnSeq = 4;

    const seq = svc.getWorkerReportDispatchTurnSeq(worker, manager);
    expect(seq).toBe(4);
  });

  it("force-clears an expired idle-watchdog circuit suppression with a receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "idle" });
    const logDebug = vi.fn();
    const svc = new SwarmWorkerHealthService(baseHealthOptions({
      descriptors: new Map([[worker.agentId, worker]]),
      logDebug,
    }));
    const state = svc.getOrCreateWorkerWatchdogState("w1");
    state.circuitOpen = true;
    state.suppressedUntilMs = Date.now() + WATCHDOG_CIRCUIT_MAX_MS;

    vi.advanceTimersByTime(WATCHDOG_CIRCUIT_MAX_MS + 1);
    await svc.checkForStalledWorkers();

    expect(svc.workerWatchdogState.get("w1")?.circuitOpen).toBe(false);
    expect(logDebug).toHaveBeenCalledWith("watchdog:suppression_expired", {
      workerAgentId: "w1",
      receipt: "watchdog_suppression_force_cleared",
    });
  });

  it("handleRuntimeAgentEnd skips idle watchdog finalization while context recovery is in progress", async () => {
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([[worker.agentId, worker]]);
    const isRuntimeInContextRecovery = vi.fn((id: string) => id === "w1");

    const svc = new SwarmWorkerHealthService(
      baseHealthOptions({ descriptors, isRuntimeInContextRecovery })
    );
    svc.getOrCreateWorkerWatchdogState("w1");

    await svc.handleRuntimeAgentEnd("w1", worker as AgentDescriptor & { role: "worker" });

    expect(isRuntimeInContextRecovery).toHaveBeenCalledWith("w1");
    expect(svc.workerWatchdogState.get("w1")?.lastFinalizedTurnSeq).toBe(1);
    expect(svc.watchdogTimers.has("w1")).toBe(false);
  });

  it("auto-reports on agent_end even if the worker runtime has not flipped idle yet", async () => {
    vi.useFakeTimers();

    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "streaming"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const managerRuntime = {
      getStatus: () => "streaming",
      getPendingCount: () => 0
    } as SwarmAgentRuntime;
    const workerRuntime = {
      getStatus: () => "streaming",
      getPendingCount: () => 1
    } as SwarmAgentRuntime;
    const runtimes = new Map([
      [manager.agentId, managerRuntime],
      [worker.agentId, workerRuntime]
    ]);
    const sendMessage = vi.fn(async () => ({}));
    const getConversationHistory = vi.fn(
      () =>
        [
          {
            type: "conversation_message",
            agentId: worker.agentId,
            role: "assistant",
            text: "Done.",
            timestamp: "2026-05-28T19:20:37.688Z",
            source: "system"
          }
        ] satisfies ConversationEntryEvent[]
    );

    const svc = new SwarmWorkerHealthService(
      baseHealthOptions({ descriptors, runtimes, sendMessage, getConversationHistory })
    );

    await svc.handleRuntimeStatus("w1", worker as AgentDescriptor & { role: "worker" }, "streaming", 0);
    await svc.handleRuntimeAgentEnd("w1", worker as AgentDescriptor & { role: "worker" });
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS + BATCH_WINDOW_MS);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[2] ?? "")).toContain("WORKER REPORT: status: done");
    expect(String(sendMessage.mock.calls[0]?.[2] ?? "")).toContain("summary: Auto-generated report because worker w1 completed its turn without an explicit callback.");
    expect(String(sendMessage.mock.calls[0]?.[2] ?? "")).toContain("Last assistant message:\nDone.");
    expect(svc.watchdogTimers.has("w1")).toBe(false);
  });

  it("checkForStalledWorkers does not nudge while the worker runtime is in context recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));

    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);

    const sendMessage = vi.fn();
    const isRuntimeInContextRecovery = vi.fn(() => true);

    const svc = new SwarmWorkerHealthService(
      baseHealthOptions({ descriptors, sendMessage, isRuntimeInContextRecovery })
    );

    svc.workerStallState.set("w1", {
      lastProgressAt: Date.now() - STALL_NUDGE_THRESHOLD_MS - 60_000,
      nudgeSent: false,
      nudgeSentAt: null,
      lastToolName: null,
      lastToolInput: null,
      lastToolOutput: null,
      lastDetailedReportAt: null
    });

    await svc.checkForStalledWorkers();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("checkForStalledWorkers honors recovery-active grace even after strict recovery clears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));

    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);

    const sendMessage = vi.fn();
    const isRuntimeInContextRecovery = vi.fn(() => false);
    const isRuntimeRecoveryActive = vi.fn((agentId: string) => agentId === "w1");
    const svc = new SwarmWorkerHealthService(
      baseHealthOptions({ descriptors, sendMessage, isRuntimeInContextRecovery, isRuntimeRecoveryActive })
    );

    svc.workerStallState.set("w1", {
      lastProgressAt: Date.now() - STALL_NUDGE_THRESHOLD_MS - 60_000,
      nudgeSent: false,
      nudgeSentAt: null,
      lastToolName: null,
      lastToolInput: null,
      lastToolOutput: null,
      lastDetailedReportAt: null
    });

    await svc.checkForStalledWorkers();

    expect(isRuntimeInContextRecovery).not.toHaveBeenCalled();
    expect(isRuntimeRecoveryActive).toHaveBeenCalledWith("w1");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("checkForStalledWorkers does not nudge while the parent manager runtime is in recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));

    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "streaming"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);

    const sendMessage = vi.fn();
    const isRuntimeRecoveryActive = vi.fn((agentId: string) => agentId === manager.agentId);
    const svc = new SwarmWorkerHealthService(
      baseHealthOptions({ descriptors, sendMessage, isRuntimeRecoveryActive })
    );

    svc.workerStallState.set("w1", {
      lastProgressAt: Date.now() - STALL_NUDGE_THRESHOLD_MS - 60_000,
      nudgeSent: true,
      nudgeSentAt: Date.now() - 26 * 60_000,
      lastToolName: "bash",
      lastToolInput: null,
      lastToolOutput: null,
      lastDetailedReportAt: null
    });

    await svc.checkForStalledWorkers();

    expect(isRuntimeRecoveryActive).toHaveBeenCalledWith(manager.agentId);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(svc.workerStallState.get("w1")?.nudgeSent).toBe(false);
    expect(svc.workerStallState.get("w1")?.nudgeSentAt).toBeNull();
  });

  it("checkForStalledWorkers sends a nudge when the worker exceeds the stall threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));

    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);

    const sendMessage = vi.fn();
    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors, sendMessage }));

    svc.workerStallState.set("w1", {
      lastProgressAt: Date.now() - STALL_NUDGE_THRESHOLD_MS - 1_000,
      nudgeSent: false,
      nudgeSentAt: null,
      lastToolName: "bash",
      lastToolInput: null,
      lastToolOutput: null,
      lastDetailedReportAt: null
    });

    await svc.checkForStalledWorkers();
    expect(sendMessage).toHaveBeenCalled();
    expect(svc.workerStallState.get("w1")?.nudgeSent).toBe(true);
  });

  it("handleSuccessfulWorkerReportDispatch marks the turn reported and clears notification pressure", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);

    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors }));
    const state = svc.getOrCreateWorkerWatchdogState("w1");
    const turn = 2;
    state.turnSeq = turn;
    state.pendingReportTurnSeq = turn;
    state.reportedThisTurn = false;
    state.consecutiveNotifications = 2;
    state.circuitOpen = true;
    state.suppressedUntilMs = Date.now() + 60_000;

    await svc.handleSuccessfulWorkerReportDispatch("w1", turn);

    const updated = svc.workerWatchdogState.get("w1");
    expect(updated?.reportedThisTurn).toBe(true);
    expect(updated?.consecutiveNotifications).toBe(0);
    expect(updated?.circuitOpen).toBe(false);
    expect(updated?.suppressedUntilMs).toBe(0);
  });

  it("successful worker self-report records current-turn state and cancels pending transient terminated errors", async () => {
    vi.useFakeTimers();

    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const saveStore = vi.fn(async () => {});
    const expire = vi.fn();
    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors, saveStore }));
    const state = svc.getOrCreateWorkerWatchdogState("w1");
    state.turnSeq = 3;
    state.pendingReportTurnSeq = 3;
    svc.beginPendingTransientWorkerTerminatedError(
      "w1",
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated" } },
      expire
    );

    await svc.handleSuccessfulWorkerReportDispatch("w1", 3);
    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS + 1);

    expect(expire).not.toHaveBeenCalled();
    expect(svc.hasPendingTransientWorkerTerminatedError("w1")).toBe(false);
    expect(svc.workerWatchdogState.get("w1")?.reportedThisTurn).toBe(true);
    expect(saveStore).not.toHaveBeenCalled();
  });

  it("does not arm a stale transient terminated error after the worker already self-reported this turn", async () => {
    vi.useFakeTimers();
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const expire = vi.fn();
    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors }));
    const state = svc.getOrCreateWorkerWatchdogState("w1");
    state.turnSeq = 5;
    state.pendingReportTurnSeq = 5;

    await svc.handleSuccessfulWorkerReportDispatch("w1", 5);
    const handled = svc.beginPendingTransientWorkerTerminatedError(
      "w1",
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated" } },
      expire
    );
    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS + 1);

    expect(handled).toBe(true);
    expect(svc.hasPendingTransientWorkerTerminatedError("w1")).toBe(false);
    expect(expire).not.toHaveBeenCalled();
  });

  it("ignores stale bare terminated callbacks after a successful self-report for the same turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));

    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const saveStore = vi.fn(async () => {});
    const expire = vi.fn();
    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors, saveStore }));
    const state = svc.getOrCreateWorkerWatchdogState("w1");
    state.turnSeq = 5;
    state.pendingReportTurnSeq = 5;

    await svc.handleSuccessfulWorkerReportDispatch("w1", 5);
    const handled = svc.beginPendingTransientWorkerTerminatedError(
      "w1",
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated" } },
      expire
    );
    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS + 1);

    expect(handled).toBe(true);
    expect(svc.hasPendingTransientWorkerTerminatedError("w1")).toBe(false);
    expect(expire).not.toHaveBeenCalled();
    expect(saveStore).not.toHaveBeenCalled();
  });

  it("does not let a stale persisted self-report marker suppress a fresh bare terminated callback after watchdog reset", async () => {
    vi.useFakeTimers();
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    (worker as typeof worker & { workerLastSelfReportAt?: string; workerLastSelfReportTurnSeq?: number }).workerLastSelfReportAt =
      "2026-05-27T12:00:00.000Z";
    (worker as typeof worker & { workerLastSelfReportAt?: string; workerLastSelfReportTurnSeq?: number }).workerLastSelfReportTurnSeq = 0;
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const expire = vi.fn();
    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors }));

    const handled = svc.beginPendingTransientWorkerTerminatedError(
      "w1",
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated" } },
      expire
    );

    expect(handled).toBe(true);
    expect(svc.hasPendingTransientWorkerTerminatedError("w1")).toBe(true);
    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS + 1);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("defers idle finalization while transient terminated error is pending, then expires and reports once", async () => {
    vi.useFakeTimers();
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "idle" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const sendMessage = vi.fn();
    const expire = vi.fn(async () => {});
    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors, sendMessage }));
    const state = svc.getOrCreateWorkerWatchdogState("w1");
    state.hadStreamingThisTurn = true;
    svc.beginPendingTransientWorkerTerminatedError(
      "w1",
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated" } },
      expire
    );

    await svc.finalizeWorkerIdleTurn("w1", worker, "agent_end");
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS + BATCH_WINDOW_MS);

    expect(expire).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(svc.workerWatchdogState.get("w1")?.deferredFinalizeTurnSeq).toBe(0);

    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS - IDLE_GRACE_MS - BATCH_WINDOW_MS + 1);
    expect(expire).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS + BATCH_WINDOW_MS);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("finalizeWorkerIdleTurn batches multiple workers after grace and batch windows", async () => {
    vi.useFakeTimers();

    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const w1 = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "idle" });
    const w2 = createWorkerDescriptor("/p", "m1", { agentId: "w2", status: "idle" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [w1.agentId, w1],
      [w2.agentId, w2]
    ]);

    const sendMessage = vi.fn();
    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors, sendMessage }));

    await svc.finalizeWorkerIdleTurn("w1", w1, "agent_end");
    await svc.finalizeWorkerIdleTurn("w2", w2, "agent_end");

    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = String(sendMessage.mock.calls[0]?.[2] ?? "");
    expect(text).toContain("w1");
    expect(text).toContain("w2");
  });

  it("flush applies exponential backoff after idle watchdog notifications", async () => {
    vi.useFakeTimers();
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "idle" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);

    const sendMessage = vi.fn();
    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors, sendMessage }));

    const runWatchdogCycle = async () => {
      await svc.handleRuntimeStatus("w1", worker as AgentDescriptor & { role: "worker" }, "streaming", 0);
      await svc.finalizeWorkerIdleTurn("w1", worker, "agent_end");
      await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS);
      await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    };

    await runWatchdogCycle();
    const afterFirst = svc.workerWatchdogState.get("w1")?.suppressedUntilMs ?? 0;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(afterFirst).toBeGreaterThan(Date.now());

    vi.setSystemTime(afterFirst + 1);
    sendMessage.mockClear();

    await runWatchdogCycle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const afterSecond = svc.workerWatchdogState.get("w1")?.suppressedUntilMs ?? 0;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  it("parent recovery alone does not suppress a normal worker completion report", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "streaming"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const runtimeStub = {
      getStatus: () => "idle",
      getPendingCount: () => 0
    } as SwarmAgentRuntime;
    const runtimes = new Map([
      [manager.agentId, runtimeStub],
      [worker.agentId, runtimeStub]
    ]);
    const sendMessage = vi.fn(async () => ({}));
    const isRuntimeRecoveryActive = vi.fn((agentId: string) => agentId === manager.agentId);
    const svc = new SwarmWorkerHealthService(
      baseHealthOptions({ descriptors, runtimes, sendMessage, isRuntimeRecoveryActive })
    );

    await svc.handleRuntimeStatus("w1", worker as AgentDescriptor & { role: "worker" }, "streaming", 0);
    worker.status = "idle";
    await svc.handleRuntimeStatus("w1", worker as AgentDescriptor & { role: "worker" }, "idle", 0);
    await svc.handleRuntimeAgentEnd("w1", worker as AgentDescriptor & { role: "worker" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[2] ?? "")).toBe([
      "WORKER REPORT: status: done",
      "summary: Auto-generated report because worker w1 completed its turn without an explicit callback."
    ].join("\n"));
    expect(svc.watchdogTimers.has("w1")).toBe(false);
    expect(svc.workerWatchdogState.get("w1")).toEqual(
      expect.objectContaining({
        turnSeq: 1,
        hadStreamingThisTurn: false,
        lastFinalizedTurnSeq: 1
      })
    );
  });

  it("handleRuntimeStatus idle transition finalizes the worker idle turn after streaming", async () => {
    vi.useFakeTimers();
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);

    const sendMessage = vi.fn();
    const svc = new SwarmWorkerHealthService(baseHealthOptions({ descriptors, sendMessage }));

    await svc.handleRuntimeStatus("w1", worker as AgentDescriptor & { role: "worker" }, "streaming", 0);
    expect(svc.workerWatchdogState.get("w1")?.hadStreamingThisTurn).toBe(true);

    await svc.handleRuntimeStatus("w1", worker as AgentDescriptor & { role: "worker" }, "idle", 0);
    expect(svc.workerWatchdogState.get("w1")?.turnSeq).toBeGreaterThanOrEqual(0);

    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS + BATCH_WINDOW_MS);
  });

  it("idle watchdog batch flush still reports while only the manager is in context recovery", async () => {
    vi.useFakeTimers();

    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "idle" });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);

    const sendMessage = vi.fn();
    let recovery = false;
    const isRuntimeInContextRecovery = vi.fn((id: string) => (id === "m1" ? recovery : false));

    const svc = new SwarmWorkerHealthService(
      baseHealthOptions({ descriptors, sendMessage, isRuntimeInContextRecovery })
    );

    await svc.finalizeWorkerIdleTurn("w1", worker, "agent_end");
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS);

    recovery = true;
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
