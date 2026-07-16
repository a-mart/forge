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
} = {}) {
  const deliverCompletedWorker = vi.fn(
    options.deliverCompletedWorker ?? (async () => "sent" as const),
  );
  const sendMessage = vi.fn(async () => ({}));
  const publishToUser = vi.fn(async () => ({}));
  const serviceOptions: SwarmWorkerHealthServiceOptions = {
    descriptors: options.descriptors ?? new Map(),
    runtimes: options.runtimes ?? new Map<string, SwarmAgentRuntime>(),
    workerResults: { deliverCompletedWorker } as unknown as WorkerResultCoordinator,
    sendMessage,
    publishToUser,
    terminateDescriptor: vi.fn(async () => undefined),
    saveStore: vi.fn(async () => undefined),
    emitAgentsSnapshot: vi.fn(),
    isRuntimeInContextRecovery: options.isRuntimeInContextRecovery ?? (() => false),
    isRuntimeRecoveryActive: options.isRuntimeRecoveryActive,
    now: () => "2026-07-16T12:00:00.000Z",
    logDebug: vi.fn(),
  };
  return {
    service: new SwarmWorkerHealthService(serviceOptions),
    deliverCompletedWorker,
    sendMessage,
    publishToUser,
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

  it("does not use worker idle status as a second completion signal", async () => {
    const workerDescriptor = worker();
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
    });

    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "streaming", 0);
    workerDescriptor.status = "idle";
    await service.handleRuntimeStatus(workerDescriptor.agentId, workerDescriptor, "idle", 0);

    expect(deliverCompletedWorker).not.toHaveBeenCalled();
  });

  it("skips terminal delivery while the worker runtime is recovering", async () => {
    const workerDescriptor = worker();
    const { service, deliverCompletedWorker } = createHarness({
      descriptors: new Map([[workerDescriptor.agentId, workerDescriptor]]),
      isRuntimeRecoveryActive: (agentId) => agentId === workerDescriptor.agentId,
    });

    await service.handleRuntimeAgentEnd(workerDescriptor.agentId, workerDescriptor);

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
