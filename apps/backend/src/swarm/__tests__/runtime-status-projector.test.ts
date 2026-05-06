import { describe, expect, it, vi } from "vitest";
import { RuntimeStatusProjector, type RuntimeStatusProjectorDeps } from "../runtime/runtime-status-projector.js";
import type { WorkerActivityStateLike, WorkerStallStateLike, WorkerWatchdogStateLike } from "../swarm-runtime-controller.js";
import type { AgentDescriptor, AgentStatus } from "../types.js";

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
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    ...overrides
  };
}

function watchdogState(overrides: Partial<WorkerWatchdogStateLike> = {}): WorkerWatchdogStateLike {
  return {
    turnSeq: 0,
    reportedThisTurn: false,
    pendingReportTurnSeq: null,
    deferredFinalizeTurnSeq: null,
    hadStreamingThisTurn: false,
    lastFinalizedTurnSeq: null,
    ...overrides
  };
}

function createHarness(): {
  projector: RuntimeStatusProjector;
  deps: RuntimeStatusProjectorDeps;
  descriptors: Map<string, AgentDescriptor>;
  workerWatchdogState: Map<string, WorkerWatchdogStateLike>;
  workerStallState: Map<string, WorkerStallStateLike>;
  workerActivityState: Map<string, WorkerActivityStateLike>;
  watchdogTimerTokens: Map<string, number>;
} {
  const descriptors = new Map<string, AgentDescriptor>();
  const workerWatchdogState = new Map<string, WorkerWatchdogStateLike>();
  const workerStallState = new Map<string, WorkerStallStateLike>();
  const workerActivityState = new Map<string, WorkerActivityStateLike>();
  const watchdogTimerTokens = new Map<string, number>();

  const deps: RuntimeStatusProjectorDeps = {
    descriptors,
    workerWatchdogState,
    workerStallState,
    workerActivityState,
    watchdogTimerTokens,
    now: vi.fn(() => "2026-05-06T00:00:01.000Z"),
    patchDescriptorFromRuntimeStatus: vi.fn(async (agentId: string, patch: Partial<AgentDescriptor>) => {
      const descriptor = descriptors.get(agentId);
      if (!descriptor) return undefined;
      const updated = { ...descriptor, ...patch };
      descriptors.set(agentId, updated);
      return updated;
    }),
    updateSessionMetaForWorkerDescriptor: vi.fn(async () => undefined),
    refreshSessionMetaStatsBySessionId: vi.fn(async () => undefined),
    refreshSessionMetaStats: vi.fn(async () => undefined),
    saveStore: vi.fn(async () => undefined),
    emitStatus: vi.fn(),
    emitAgentsSnapshot: vi.fn(),
    logDebug: vi.fn(),
    getOrCreateWorkerWatchdogState: vi.fn((agentId: string) => workerWatchdogState.get(agentId) ?? watchdogState()),
    clearWatchdogTimer: vi.fn(),
    removeWorkerFromWatchdogBatchQueues: vi.fn(),
    finalizeWorkerIdleTurn: vi.fn(async () => undefined),
    shouldSuppressWorkerIdleFinalization: vi.fn(() => false),
    handleManagerStatusTransition: vi.fn(async () => undefined),
    applyManagerRuntimeRecyclePolicy: vi.fn(async () => "none")
  };

  return {
    projector: new RuntimeStatusProjector(deps),
    deps,
    descriptors,
    workerWatchdogState,
    workerStallState,
    workerActivityState,
    watchdogTimerTokens
  };
}

describe("RuntimeStatusProjector", () => {
  it("preserves manager streaming-to-idle ordering including recycle second save and snapshot", async () => {
    const { projector, deps, descriptors } = createHarness();
    const manager = baseDescriptor({
      agentId: "manager-1",
      role: "manager",
      managerId: "manager-1",
      profileId: "profile-1",
      status: "streaming"
    });
    descriptors.set(manager.agentId, manager);
    vi.mocked(deps.applyManagerRuntimeRecyclePolicy).mockResolvedValue("recycled");

    await projector.projectStatus({ agentId: manager.agentId, status: "idle", pendingCount: 0 });

    expect(deps.patchDescriptorFromRuntimeStatus).toHaveBeenCalledWith(
      manager.agentId,
      expect.objectContaining({ status: "idle", updatedAt: "2026-05-06T00:00:01.000Z" })
    );
    expect(deps.refreshSessionMetaStats).toHaveBeenCalledWith(expect.objectContaining({ agentId: manager.agentId }));
    expect(deps.saveStore).toHaveBeenCalledTimes(2);
    expect(deps.emitStatus).toHaveBeenCalledWith(manager.agentId, "idle", 0, undefined);
    expect(deps.handleManagerStatusTransition).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: manager.agentId }),
      "idle",
      0
    );
    expect(deps.applyManagerRuntimeRecyclePolicy).toHaveBeenCalledWith(manager.agentId, "idle_transition");
    expect(deps.emitAgentsSnapshot).toHaveBeenCalledTimes(1);

    const patchOrder = vi.mocked(deps.patchDescriptorFromRuntimeStatus).mock.invocationCallOrder[0];
    const statsOrder = vi.mocked(deps.refreshSessionMetaStats).mock.invocationCallOrder[0];
    const firstSaveOrder = vi.mocked(deps.saveStore).mock.invocationCallOrder[0];
    const emitOrder = vi.mocked(deps.emitStatus).mock.invocationCallOrder[0];
    const cortexOrder = vi.mocked(deps.handleManagerStatusTransition).mock.invocationCallOrder[0];
    const recycleOrder = vi.mocked(deps.applyManagerRuntimeRecyclePolicy).mock.invocationCallOrder[0];
    const secondSaveOrder = vi.mocked(deps.saveStore).mock.invocationCallOrder[1];
    const snapshotOrder = vi.mocked(deps.emitAgentsSnapshot).mock.invocationCallOrder[0];

    expect(patchOrder).toBeLessThan(statsOrder);
    expect(statsOrder).toBeLessThan(firstSaveOrder);
    expect(firstSaveOrder).toBeLessThan(emitOrder);
    expect(emitOrder).toBeLessThan(cortexOrder);
    expect(cortexOrder).toBeLessThan(recycleOrder);
    expect(recycleOrder).toBeLessThan(secondSaveOrder);
    expect(secondSaveOrder).toBeLessThan(snapshotOrder);
  });

  it("projects worker idle-to-streaming with normalized context usage before meta/stats, save, emit, and watchdog cleanup", async () => {
    const { projector, deps, descriptors, workerStallState, watchdogTimerTokens } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-1", role: "worker", managerId: "manager-1", status: "idle" });
    descriptors.set(worker.agentId, worker);
    watchdogTimerTokens.set(worker.agentId, 2);

    await projector.projectStatus({
      agentId: worker.agentId,
      status: "streaming",
      pendingCount: 1,
      contextUsage: { tokens: 1.7, contextWindow: 100.2, percent: 101 }
    });

    expect(deps.patchDescriptorFromRuntimeStatus).toHaveBeenCalledWith(
      worker.agentId,
      expect.objectContaining({
        status: "streaming",
        contextUsage: { tokens: 2, contextWindow: 100, percent: 100 },
        streamingStartedAt: expect.any(Number)
      })
    );
    expect(workerStallState.has(worker.agentId)).toBe(true);
    expect(deps.updateSessionMetaForWorkerDescriptor).toHaveBeenCalledWith(
      expect.objectContaining({ contextUsage: { tokens: 2, contextWindow: 100, percent: 100 } })
    );
    expect(deps.refreshSessionMetaStatsBySessionId).toHaveBeenCalledWith(worker.managerId);
    expect(deps.saveStore).toHaveBeenCalledTimes(1);
    expect(deps.emitStatus).toHaveBeenCalledWith(worker.agentId, "streaming", 1, { tokens: 2, contextWindow: 100, percent: 100 });
    expect(deps.getOrCreateWorkerWatchdogState).toHaveBeenCalledWith(worker.agentId);
    expect(deps.clearWatchdogTimer).toHaveBeenCalledWith(worker.agentId);
    expect(deps.removeWorkerFromWatchdogBatchQueues).toHaveBeenCalledWith(worker.agentId);
    expect(watchdogTimerTokens.get(worker.agentId)).toBe(3);

    const patchOrder = vi.mocked(deps.patchDescriptorFromRuntimeStatus).mock.invocationCallOrder[0];
    const metaOrder = vi.mocked(deps.updateSessionMetaForWorkerDescriptor).mock.invocationCallOrder[0];
    const statsOrder = vi.mocked(deps.refreshSessionMetaStatsBySessionId).mock.invocationCallOrder[0];
    const saveOrder = vi.mocked(deps.saveStore).mock.invocationCallOrder[0];
    const emitOrder = vi.mocked(deps.emitStatus).mock.invocationCallOrder[0];
    const watchdogOrder = vi.mocked(deps.clearWatchdogTimer).mock.invocationCallOrder[0];
    expect(patchOrder).toBeLessThan(metaOrder);
    expect(metaOrder).toBeLessThan(statsOrder);
    expect(statsOrder).toBeLessThan(saveOrder);
    expect(saveOrder).toBeLessThan(emitOrder);
    expect(emitOrder).toBeLessThan(watchdogOrder);
  });

  it("refreshes worker meta/stats for context-usage-only updates without saving", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-context", role: "worker", managerId: "manager-1", status: "idle" });
    descriptors.set(worker.agentId, worker);

    await projector.projectStatus({
      agentId: worker.agentId,
      status: "idle",
      pendingCount: 0,
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 }
    });

    expect(deps.patchDescriptorFromRuntimeStatus).toHaveBeenCalledWith(
      worker.agentId,
      { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } }
    );
    expect(deps.updateSessionMetaForWorkerDescriptor).toHaveBeenCalledTimes(1);
    expect(deps.refreshSessionMetaStatsBySessionId).toHaveBeenCalledWith(worker.managerId);
    expect(deps.saveStore).not.toHaveBeenCalled();
    expect(deps.emitStatus).toHaveBeenCalledWith(worker.agentId, "idle", 0, { tokens: 10, contextWindow: 100, percent: 10 });
  });

  it("clears context usage and persists for non-running statuses", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({
      agentId: "worker-stopped",
      role: "worker",
      managerId: "manager-1",
      status: "idle",
      contextUsage: { tokens: 9, contextWindow: 100, percent: 9 }
    });
    descriptors.set(worker.agentId, worker);

    await projector.projectStatus({ agentId: worker.agentId, status: "stopped", pendingCount: 0 });

    expect(deps.patchDescriptorFromRuntimeStatus).toHaveBeenCalledWith(
      worker.agentId,
      expect.objectContaining({ status: "stopped", contextUsage: undefined })
    );
    expect(deps.saveStore).toHaveBeenCalledTimes(1);
    expect(deps.emitStatus).toHaveBeenCalledWith(worker.agentId, "stopped", 0, undefined);
  });

  it("finalizes worker streaming-to-idle only when pending count is zero, prior streaming occurred, and finalization is not suppressed", async () => {
    const { projector, deps, descriptors, workerWatchdogState, workerStallState, workerActivityState } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-finish", role: "worker", managerId: "manager-1", status: "streaming" });
    descriptors.set(worker.agentId, worker);
    workerWatchdogState.set(worker.agentId, watchdogState({ hadStreamingThisTurn: true }));
    workerStallState.set(worker.agentId, { lastProgressAt: 1 } as WorkerStallStateLike);
    workerActivityState.set(worker.agentId, { lastProgressAt: 1 } as WorkerActivityStateLike);

    await projector.projectStatus({ agentId: worker.agentId, status: "idle", pendingCount: 0 });

    expect(workerStallState.has(worker.agentId)).toBe(false);
    expect(workerActivityState.has(worker.agentId)).toBe(false);
    expect(deps.finalizeWorkerIdleTurn).toHaveBeenCalledWith(
      worker.agentId,
      expect.objectContaining({ status: "idle" }),
      "status_idle"
    );
  });

  it("does not finalize worker idle turns for pending work, no prior streaming, or suppression", async () => {
    for (const [agentId, pendingCount, hadStreaming, suppress] of [
      ["pending", 1, true, false],
      ["no-prior", 0, false, false],
      ["suppressed", 0, true, true]
    ] as const) {
      const { projector, deps, descriptors, workerWatchdogState } = createHarness();
      const worker = baseDescriptor({ agentId, role: "worker", managerId: "manager-1", status: "streaming" });
      descriptors.set(worker.agentId, worker);
      workerWatchdogState.set(worker.agentId, watchdogState({ hadStreamingThisTurn: hadStreaming }));
      vi.mocked(deps.shouldSuppressWorkerIdleFinalization).mockReturnValue(suppress);

      await projector.projectStatus({ agentId: worker.agentId, status: "idle", pendingCount });

      expect(deps.finalizeWorkerIdleTurn).not.toHaveBeenCalled();
    }
  });

  it("no-ops when descriptor is missing", async () => {
    const { projector, deps } = createHarness();

    await projector.projectStatus({ agentId: "missing", status: "idle", pendingCount: 0 });

    expect(deps.patchDescriptorFromRuntimeStatus).not.toHaveBeenCalled();
    expect(deps.emitStatus).not.toHaveBeenCalled();
    expect(deps.saveStore).not.toHaveBeenCalled();
  });

  it("propagates invalid status transitions without patching or emitting", async () => {
    const { projector, deps, descriptors } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-invalid", role: "worker", managerId: "manager-1", status: "error" });
    descriptors.set(worker.agentId, worker);

    await expect(
      projector.projectStatus({ agentId: worker.agentId, status: "streaming" as AgentStatus, pendingCount: 0 })
    ).rejects.toThrow("Invalid agent status transition: error -> streaming");

    expect(deps.patchDescriptorFromRuntimeStatus).not.toHaveBeenCalled();
    expect(deps.emitStatus).not.toHaveBeenCalled();
    expect(deps.saveStore).not.toHaveBeenCalled();
  });
});
