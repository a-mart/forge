import { describe, expect, it, vi } from "vitest";
import { RuntimeStatusProjector, type RuntimeStatusProjectorDeps } from "../runtime/runtime-status-projector.js";
import type { WorkerActivityStateLike, WorkerStallStateLike } from "../runtime/worker-health-types.js";
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
      modelId: "gpt-5.5",
      thinkingLevel: "medium"
    },
    ...overrides
  };
}

function createHarness(): {
  projector: RuntimeStatusProjector;
  deps: RuntimeStatusProjectorDeps;
  descriptors: Map<string, AgentDescriptor>;
  workerStallState: Map<string, WorkerStallStateLike>;
  workerActivityState: Map<string, WorkerActivityStateLike>;
} {
  const descriptors = new Map<string, AgentDescriptor>();
  const workerStallState = new Map<string, WorkerStallStateLike>();
  const workerActivityState = new Map<string, WorkerActivityStateLike>();

  const deps: RuntimeStatusProjectorDeps = {
    descriptors,
    workerStallState,
    workerActivityState,
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
    handleManagerStatusTransition: vi.fn(async () => undefined),
    applyManagerRuntimeRecyclePolicy: vi.fn(async () => "none")
  };

  return {
    projector: new RuntimeStatusProjector(deps),
    deps,
    descriptors,
    workerStallState,
    workerActivityState,
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

  it("projects worker idle-to-streaming with normalized context usage before meta/stats, save, and emit", async () => {
    const { projector, deps, descriptors, workerStallState } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-1", role: "worker", managerId: "manager-1", status: "idle" });
    descriptors.set(worker.agentId, worker);

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

    const patchOrder = vi.mocked(deps.patchDescriptorFromRuntimeStatus).mock.invocationCallOrder[0];
    const metaOrder = vi.mocked(deps.updateSessionMetaForWorkerDescriptor).mock.invocationCallOrder[0];
    const statsOrder = vi.mocked(deps.refreshSessionMetaStatsBySessionId).mock.invocationCallOrder[0];
    const saveOrder = vi.mocked(deps.saveStore).mock.invocationCallOrder[0];
    const emitOrder = vi.mocked(deps.emitStatus).mock.invocationCallOrder[0];
    expect(patchOrder).toBeLessThan(metaOrder);
    expect(metaOrder).toBeLessThan(statsOrder);
    expect(statsOrder).toBeLessThan(saveOrder);
    expect(saveOrder).toBeLessThan(emitOrder);
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

  it("clears worker activity on streaming-to-idle without owning result delivery", async () => {
    const { projector, descriptors, workerStallState, workerActivityState } = createHarness();
    const worker = baseDescriptor({ agentId: "worker-finish", role: "worker", managerId: "manager-1", status: "streaming" });
    descriptors.set(worker.agentId, worker);
    workerStallState.set(worker.agentId, { lastProgressAt: 1 } as WorkerStallStateLike);
    workerActivityState.set(worker.agentId, { lastProgressAt: 1 } as WorkerActivityStateLike);

    await projector.projectStatus({ agentId: worker.agentId, status: "idle", pendingCount: 0 });

    expect(workerStallState.has(worker.agentId)).toBe(false);
    expect(workerActivityState.has(worker.agentId)).toBe(false);
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
