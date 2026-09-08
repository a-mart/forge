import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentDescriptor, createWorkerDescriptor } from "../../test-support/index.js";
import type { WorkerResultCoordinator } from "../worker-result-coordinator.js";
import {
  SwarmWorkerHealthService,
  TRANSIENT_WORKER_TERMINATED_GRACE_MS,
  type SwarmWorkerHealthServiceOptions,
} from "../swarm-worker-health-service.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

const STALL_NUDGE_THRESHOLD_MS = 5 * 60 * 1000;

function createHarness(options: {
  descriptors?: Map<string, AgentDescriptor>;
  runtimes?: Map<string, SwarmAgentRuntime>;
  deliverCompletedWorker?: WorkerResultCoordinator["deliverCompletedWorker"];
  isRuntimeInContextRecovery?: (agentId: string) => boolean;
  isRuntimeRecoveryActive?: (agentId: string) => boolean;
  hasRecoveryAbortedWorkerTurn?: (agentId: string) => boolean;
  clearRecoveryAbortedWorkerTurn?: (agentId: string) => void;
  isRestartRecoveryDecisionPending?: () => boolean;
} = {}) {
  const deliverCompletedWorker = vi.fn(
    options.deliverCompletedWorker ?? (async () => "sent" as const),
  );
  const sendMessage = vi.fn(async () => ({}));
  const publishToUser = vi.fn(async () => ({}));
  const terminateDescriptor = vi.fn(async () => undefined);
  const saveStore = vi.fn(async () => undefined);
  const reportAttentionStatusTransition = vi.fn(async () => undefined);
  const serviceOptions: SwarmWorkerHealthServiceOptions = {
    descriptors: options.descriptors ?? new Map(),
    runtimes: options.runtimes ?? new Map<string, SwarmAgentRuntime>(),
    workerResults: { deliverCompletedWorker } as unknown as WorkerResultCoordinator,
    sendMessage,
    publishToUser,
    terminateDescriptor,
    saveStore,
    reportAttentionStatusTransition,
    emitAgentsSnapshot: vi.fn(),
    isRuntimeInContextRecovery: options.isRuntimeInContextRecovery ?? (() => false),
    isRuntimeRecoveryActive: options.isRuntimeRecoveryActive,
    hasRecoveryAbortedWorkerTurn: options.hasRecoveryAbortedWorkerTurn,
    clearRecoveryAbortedWorkerTurn: options.clearRecoveryAbortedWorkerTurn,
    isRestartRecoveryDecisionPending: options.isRestartRecoveryDecisionPending,
    now: () => "2026-07-16T12:00:00.000Z",
    logDebug: vi.fn(),
  };
  return {
    service: new SwarmWorkerHealthService(serviceOptions),
    deliverCompletedWorker,
    sendMessage,
    publishToUser,
    terminateDescriptor,
    saveStore,
    reportAttentionStatusTransition,
  };
}

function worker(agentId = "worker-1", status: AgentDescriptor["status"] = "streaming") {
  return {
    ...createWorkerDescriptor("/tmp/project", "manager-1", { agentId, status }),
    workerParentContext: {
      schemaVersion: 1 as const,
      assignmentId: `assignment:${agentId}`,
      managerId: "manager-1",
      assignedAt: "2026-07-16T11:59:00.000Z",
      outputTarget: { kind: "internal_only" as const },
    },
  };
}

function manager(status: AgentDescriptor["status"] = "streaming") {
  return createAgentDescriptor({
    agentId: "manager-1",
    displayName: "Manager",
    role: "manager",
    managerId: "manager-1",
    profileId: "profile-1",
    status,
  });
}

describe("SwarmWorkerHealthService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers one worker result at agent_end even while the manager is streaming", async () => {
    const managerDescriptor = manager("streaming");
    const workerDescriptor = worker("worker-1", "streaming");
    const descriptors = new Map([
      [managerDescriptor.agentId, managerDescriptor],
      [workerDescriptor.agentId, workerDescriptor],
    ]);
    const { service, deliverCompletedWorker } = createHarness({ descriptors });

    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);

    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
    expect(deliverCompletedWorker).toHaveBeenCalledWith(workerDescriptor);
    expect(workerDescriptor.workerParentContext.completedAt).toBe("2026-07-16T12:00:00.000Z");
  });

  it("waits for queued worker follow-ups before treating agent_end as assignment completion", async () => {
    const workerDescriptor = worker();
    let pendingCount = 2;
    const runtime = {
      getPendingCount: () => pendingCount,
    } as SwarmAgentRuntime;
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
      runtimes: new Map([[workerDescriptor.agentId, runtime]]),
    });

    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);
    pendingCount = 0;
    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);

    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
  });

  it("retains and retries a completed assignment after delivery fails", async () => {
    const workerDescriptor = worker();
    const { service, deliverCompletedWorker, publishToUser } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
      deliverCompletedWorker: async () => "failed",
    });

    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);
    await service.checkForStalledWorkers();

    expect(workerDescriptor.workerParentContext.completedAt).toBe("2026-07-16T12:00:00.000Z");
    expect(deliverCompletedWorker).toHaveBeenCalledTimes(2);
    expect(publishToUser).toHaveBeenCalledTimes(1);
    expect(publishToUser).toHaveBeenCalledWith(
      "manager-1",
      expect.stringContaining("Forge will retry automatically"),
      "system",
    );
  });

  it("delivers promptly when an observed streaming assignment settles idle", async () => {
    const workerDescriptor = worker();
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
    });

    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "streaming", 0);
    workerDescriptor.status = "idle";
    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "idle", 0);

    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
  });

  it("does not complete an idle assignment before observing that worker run", async () => {
    const workerDescriptor = worker("worker-1", "idle");
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
    });

    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "idle", 0);

    expect(deliverCompletedWorker).not.toHaveBeenCalled();
  });

  it("delivers a settlement immediately after context recovery releases it", async () => {
    const workerDescriptor = worker();
    let recoveryInProgress = true;
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
      isRuntimeInContextRecovery: (agentId) =>
        agentId === workerDescriptor.agentId && recoveryInProgress,
      isRuntimeRecoveryActive: () => false,
    });

    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "streaming", 0);
    workerDescriptor.status = "idle";
    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "idle", 0);
    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);
    expect(deliverCompletedWorker).not.toHaveBeenCalled();

    recoveryInProgress = false;
    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "idle", 0);

    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
  });

  it("defers a settlement through the post-recovery grace period", async () => {
    const workerDescriptor = worker();
    let recoveryGraceActive = true;
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
      isRuntimeInContextRecovery: () => false,
      isRuntimeRecoveryActive: () => recoveryGraceActive,
    });

    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "streaming", 0);
    workerDescriptor.status = "idle";
    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "idle", 0);
    expect(deliverCompletedWorker).not.toHaveBeenCalled();

    recoveryGraceActive = false;
    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "idle", 0);
    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
  });

  it("does not infer completion from a persisted idle assignment on the health sweep", async () => {
    const workerDescriptor = worker("worker-1", "idle");
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
      runtimes: new Map([[workerDescriptor.agentId, {
        getPendingCount: () => 0,
      } as SwarmAgentRuntime]]),
    });

    await service.checkForStalledWorkers();

    expect(deliverCompletedWorker).not.toHaveBeenCalled();
  });

  it("waits to reconcile an observed settlement until restart recovery resolves", async () => {
    const workerDescriptor = worker("worker-1", "streaming");
    let restartDecisionPending = true;
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
      isRestartRecoveryDecisionPending: () => restartDecisionPending,
    });

    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "streaming", 0);
    workerDescriptor.status = "idle";
    await service.checkForStalledWorkers();
    expect(deliverCompletedWorker).not.toHaveBeenCalled();

    restartDecisionPending = false;
    await service.checkForStalledWorkers();
    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
  });

  it("does not complete while a follow-up dispatch is entering the runtime", async () => {
    const workerDescriptor = worker();
    let inputDispatchPending = true;
    const runtime = {
      getPendingCount: () => 0,
      hasPendingInputDispatch: () => inputDispatchPending,
    } as SwarmAgentRuntime;
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
      runtimes: new Map([[workerDescriptor.agentId, runtime]]),
    });

    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "streaming", 0);
    workerDescriptor.status = "idle";
    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "idle", 0);
    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);
    expect(deliverCompletedWorker).not.toHaveBeenCalled();

    inputDispatchPending = false;
    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "idle", 0);
    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
  });

  it("discards a recovery-aborted run instead of delivering its partial output", async () => {
    const workerDescriptor = worker();
    let recoveryAborted = true;
    const clearRecoveryAbortedWorkerTurn = vi.fn(() => {
      recoveryAborted = false;
    });
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
      hasRecoveryAbortedWorkerTurn: () => recoveryAborted,
      clearRecoveryAbortedWorkerTurn,
    });

    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "streaming", 0);
    workerDescriptor.status = "idle";
    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);
    await service.checkForStalledWorkers();

    expect(clearRecoveryAbortedWorkerTurn).toHaveBeenCalledWith(workerDescriptor.agentId);
    expect(deliverCompletedWorker).not.toHaveBeenCalled();
  });

  it("defers a result until a pending transient termination is confirmed", async () => {
    vi.useFakeTimers();
    const workerDescriptor = worker();
    const descriptors = new Map([[workerDescriptor.agentId, workerDescriptor]]);
    const { service, deliverCompletedWorker } = createHarness({ descriptors });
    const expire = vi.fn(async () => undefined);
    const event = {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "terminated" },
    } as RuntimeSessionEvent;

    expect(service.beginPendingTransientWorkerTerminatedError(workerDescriptor.agentId, event, expire)).toBe(true);
    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);
    expect(deliverCompletedWorker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS + 1);

    expect(expire).toHaveBeenCalledTimes(1);
    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
  });

  it("cancels a transient termination and its deferred result when runtime progress resumes", async () => {
    vi.useFakeTimers();
    const workerDescriptor = worker();
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
    });
    const expire = vi.fn(async () => undefined);
    const event = {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "terminated" },
    } as RuntimeSessionEvent;

    service.beginPendingTransientWorkerTerminatedError(workerDescriptor.agentId, event, expire);
    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);
    service.cancelPendingTransientWorkerTerminatedError(workerDescriptor.agentId, "runtime_progress");
    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS + 1);

    expect(expire).not.toHaveBeenCalled();
    expect(deliverCompletedWorker).not.toHaveBeenCalled();
  });

  it("clears every owned worker-health state through one operation", async () => {
    vi.useFakeTimers();
    const workerDescriptor = worker();
    const descriptors = new Map([[workerDescriptor.agentId, workerDescriptor]]);
    const { service } = createHarness({ descriptors });
    const expire = vi.fn(async () => undefined);

    service.workerStallState.set(workerDescriptor.agentId, {
      lastProgressAt: Date.now(),
      nudgeSent: true,
      nudgeSentAt: Date.now(),
      lastToolName: "shell",
      lastToolInput: "input",
      lastToolOutput: "output",
      lastDetailedReportAt: Date.now(),
    });
    service.workerActivityState.set(workerDescriptor.agentId, {
      currentToolName: "shell",
      currentToolStartedAt: Date.now(),
      lastProgressAt: Date.now(),
      toolCallCount: 1,
      errorCount: 0,
      turnCount: 0,
    });
    expect(service.beginPendingTransientWorkerTerminatedError(
      workerDescriptor.agentId,
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "terminated",
        },
      },
      expire,
    )).toBe(true);

    service.clearWorkerHealthState(workerDescriptor.agentId);

    expect(service.workerStallState.has(workerDescriptor.agentId)).toBe(false);
    expect(service.workerActivityState.has(workerDescriptor.agentId)).toBe(false);
    expect(service.hasPendingTransientWorkerTerminatedError(workerDescriptor.agentId)).toBe(false);
    expect(service.getWorkerActivity(workerDescriptor.agentId)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS + 1);
    expect(expire).not.toHaveBeenCalled();
  });

  it("keeps stall detection separate from normal worker completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const managerDescriptor = manager("idle");
    const workerDescriptor = worker();
    const descriptors = new Map([
      [managerDescriptor.agentId, managerDescriptor],
      [workerDescriptor.agentId, workerDescriptor],
    ]);
    const { service, sendMessage, publishToUser, deliverCompletedWorker } = createHarness({ descriptors });
    service.workerStallState.set(workerDescriptor.agentId, {
      lastProgressAt: Date.now() - STALL_NUDGE_THRESHOLD_MS - 1,
      nudgeSent: false,
      nudgeSentAt: null,
      lastToolName: null,
      lastToolInput: null,
      lastToolOutput: null,
      lastDetailedReportAt: null,
    });

    await service.checkForStalledWorkers();

    expect(sendMessage).toHaveBeenCalledWith(
      managerDescriptor.agentId,
      managerDescriptor.agentId,
      expect.stringContaining("[WORKER STALL DETECTED]"),
      "auto",
      { origin: "internal" },
    );
    expect(publishToUser).toHaveBeenCalledTimes(1);
    expect(deliverCompletedWorker).not.toHaveBeenCalled();
  });

  it("queues an idle manager continuation before reporting the auto-terminated last worker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const managerDescriptor = manager("idle");
    const workerDescriptor = worker();
    const descriptors = new Map([
      [managerDescriptor.agentId, managerDescriptor],
      [workerDescriptor.agentId, workerDescriptor],
    ]);
    const harness = createHarness({ descriptors });
    // Mirror production auto-kill: the status must land on "terminated" or the
    // service treats the termination as unconfirmed and skips the continuation.
    harness.terminateDescriptor.mockImplementation(async (descriptor) => {
      descriptor.status = "terminated";
    });
    harness.service.workerStallState.set(workerDescriptor.agentId, {
      lastProgressAt: Date.now() - 31 * 60 * 1000,
      nudgeSent: true,
      nudgeSentAt: Date.now() - 26 * 60 * 1000,
      lastToolName: null,
      lastToolInput: null,
      lastToolOutput: null,
      lastDetailedReportAt: null,
    });

    await harness.service.checkForStalledWorkers();

    expect(harness.reportAttentionStatusTransition).toHaveBeenCalledWith({
      agentId: workerDescriptor.agentId,
      previousStatus: "streaming",
      nextStatus: "terminated",
      transitionedAt: workerDescriptor.updatedAt,
    });
    expect(harness.saveStore.mock.invocationCallOrder[0])
      .toBeLessThan(harness.reportAttentionStatusTransition.mock.invocationCallOrder[0]!);
    expect(harness.sendMessage.mock.invocationCallOrder[0])
      .toBeLessThan(harness.reportAttentionStatusTransition.mock.invocationCallOrder[0]!);
  });

  it("suppresses stall intervention while either worker or manager recovery is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const managerDescriptor = manager("streaming");
    const workerDescriptor = worker();
    const descriptors = new Map([
      [managerDescriptor.agentId, managerDescriptor],
      [workerDescriptor.agentId, workerDescriptor],
    ]);
    const { service, sendMessage } = createHarness({
      descriptors,
      isRuntimeRecoveryActive: (agentId) => agentId === managerDescriptor.agentId,
    });
    service.workerStallState.set(workerDescriptor.agentId, {
      lastProgressAt: Date.now() - STALL_NUDGE_THRESHOLD_MS - 1,
      nudgeSent: false,
      nudgeSentAt: null,
      lastToolName: null,
      lastToolInput: null,
      lastToolOutput: null,
      lastDetailedReportAt: null,
    });

    await service.checkForStalledWorkers();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(service.workerStallState.get(workerDescriptor.agentId)?.lastProgressAt).toBe(Date.now());
  });
});


describe("long-running assignment ownership review", () => {
  afterEach(() => vi.useRealTimers());

  function setup(extra: Parameters<typeof createHarness>[0] = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:09:00.000Z"));
    const owner = manager("idle");
    const running = worker(); // Assigned at 11:59, independent of recent activity.
    const harness = createHarness({
      descriptors: new Map([[owner.agentId, owner], [running.agentId, running]]),
      ...extra,
    });
    harness.service.workerStallState.set(running.agentId, {
      lastProgressAt: Date.now(), nudgeSent: false, nudgeSentAt: null,
      lastToolName: null, lastToolInput: null, lastToolOutput: null, lastDetailedReportAt: null,
    });
    harness.service.workerActivityState.set(running.agentId, {
      currentToolName: null, currentToolStartedAt: null, lastProgressAt: Date.now(),
      toolCallCount: 88, errorCount: 0, turnCount: 1,
    });
    return { ...harness, owner, running };
  }

  it("reviews a still-active assignment once, without publishing, stopping, or completing it", async () => {
    const { service, sendMessage, publishToUser, terminateDescriptor, deliverCompletedWorker, running } = setup();
    await Promise.all([service.checkForStalledWorkers(), service.checkForStalledWorkers()]);
    service.workerStallState.get(running.agentId)!.lastProgressAt = Date.now();
    await service.checkForStalledWorkers();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("manager-1", "manager-1",
      expect.stringContaining("[WORKER ASSIGNMENT REVIEW]"), "auto", { origin: "internal" });
    expect(sendMessage).toHaveBeenCalledWith("manager-1", "manager-1",
      expect.stringContaining("Observed 88 tool calls"), "auto", { origin: "internal" });
    expect(publishToUser).not.toHaveBeenCalled();
    expect(terminateDescriptor).not.toHaveBeenCalled();
    expect(deliverCompletedWorker).not.toHaveBeenCalled();
    expect(running.workerParentContext).not.toHaveProperty("completedAt");
  });

  it("waits ten minutes and allows a new assignment on the same worker its own review", async () => {
    const { service, running, sendMessage } = setup();
    running.workerParentContext.assignedAt = new Date(Date.now() - 9 * 60_000).toISOString();
    await service.checkForStalledWorkers();
    expect(sendMessage).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await service.checkForStalledWorkers();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    running.workerParentContext.assignmentId = "next-assignment";
    running.workerParentContext.assignedAt = new Date().toISOString();
    await service.checkForStalledWorkers();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
    service.workerStallState.get(running.agentId)!.lastProgressAt = Date.now();
    await service.checkForStalledWorkers();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("retries failed delivery on the next sweep without stopping the worker", async () => {
    const { service, sendMessage, terminateDescriptor } = setup();
    sendMessage.mockRejectedValueOnce(new Error("manager busy recovering"));
    await service.checkForStalledWorkers();
    await service.checkForStalledWorkers();
    await service.checkForStalledWorkers();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(terminateDescriptor).not.toHaveBeenCalled();
  });

  it.each(["manager", "worker"])("defers during %s context recovery", async (target) => {
    let recovering = true;
    const { service, sendMessage } = setup({
      isRuntimeInContextRecovery: (id) => recovering && id === `${target}-1`,
    });
    await service.checkForStalledWorkers();
    expect(sendMessage).not.toHaveBeenCalled();
    recovering = false;
    await service.checkForStalledWorkers();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("defers while restart recovery awaits the user", async () => {
    let pending = true;
    const { service, sendMessage } = setup({ isRestartRecoveryDecisionPending: () => pending });
    await service.checkForStalledWorkers();
    expect(sendMessage).not.toHaveBeenCalled();
    pending = false;
    await service.checkForStalledWorkers();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["stopped", "terminated", "error"] as const)("never wakes a %s manager", async (status) => {
    const { service, owner, sendMessage } = setup();
    owner.status = status;
    await service.checkForStalledWorkers();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not wake an archived manager even if its status has not settled", async () => {
    const { service, owner, sendMessage } = setup();
    owner.archivedAt = new Date().toISOString();
    await service.checkForStalledWorkers();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("skips completed, invalidly dated, and unowned assignments", async () => {
    const { service, running, sendMessage } = setup();
    running.workerParentContext.assignedAt = "invalid";
    await service.checkForStalledWorkers();
    running.workerParentContext.assignedAt = "2026-07-16T11:59:00.000Z";
    running.workerParentContext.managerId = "foreign-manager";
    await service.checkForStalledWorkers();
    running.workerParentContext.managerId = running.managerId;
    Object.assign(running.workerParentContext, { completedAt: "2026-07-16T12:08:00.000Z" });
    await service.checkForStalledWorkers();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("lets the existing stall warning handle an inactive worker without another review", async () => {
    const { service, running, sendMessage } = setup();
    service.workerStallState.get(running.agentId)!.lastProgressAt = Date.now() - 5 * 60_000;
    await service.checkForStalledWorkers();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("manager-1", "manager-1",
      expect.stringContaining("[WORKER STALL DETECTED]"), "auto", { origin: "internal" });
  });
});
