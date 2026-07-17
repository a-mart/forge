import { describe, expect, it, vi } from "vitest";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import {
  TestSwarmManager,
  bootWithDefaultManager,
  makeTempConfig as buildTempConfig,
} from "../../test-support/index.js";

async function makeTempConfig(port = 8790): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: "swarm-manager-worker-result-",
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  });
}

async function beginManagerTurn(manager: TestSwarmManager, text: string): Promise<void> {
  await manager.handleUserMessage(text, { sourceContext: { channel: "web" } });
  const runtime = manager.runtimeByAgentId.get("manager");
  const dispatched = runtime?.sendCalls.at(-1)?.message;
  if (!dispatched) throw new Error("Manager user input was not dispatched");
  await manager.handleRuntimeSessionEvent("manager", {
    type: "message_start",
    message: {
      role: "user",
      content: typeof dispatched === "string" ? dispatched : dispatched.text,
    },
  });
}

async function spawnAssignedWorker(
  manager: TestSwarmManager,
  agentId: string,
  initialMessage = "Do the delegated task and return a concise final result.",
): Promise<AgentDescriptor> {
  await beginManagerTurn(manager, `Delegate ${agentId}.`);
  return manager.spawnAgent("manager", { agentId, initialMessage });
}

function internalWorker(manager: TestSwarmManager, agentId: string): AgentDescriptor {
  const descriptor = manager
    .listAgentsForInternalUse()
    .find((candidate) => candidate.agentId === agentId);
  if (!descriptor) throw new Error(`Missing worker ${agentId}`);
  return descriptor;
}

describe("SwarmManager worker results", () => {
  it("automatically returns the terminal worker final to its owning manager", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    const worker = await spawnAssignedWorker(manager, "summary-worker");
    const managerRuntime = manager.runtimeByAgentId.get("manager");
    if (!managerRuntime) throw new Error("Missing manager runtime");

    expect(internalWorker(manager, worker.agentId).workerParentContext).toMatchObject({
      managerId: "manager",
      outputTarget: { kind: "session_transcript", channel: "web" },
    });

    await manager.handleRuntimeSessionEvent(worker.agentId, {
      type: "message_end",
      message: {
        role: "assistant",
        content: "Implemented the completion hook and verified the flow.",
        stopReason: "stop",
      },
    });
    managerRuntime.sendCalls = [];

    await manager.handleRuntimeAgentEnd(worker.agentId);

    expect(managerRuntime.sendCalls).toHaveLength(1);
    const message = String(managerRuntime.sendCalls[0]?.message);
    expect(message).toContain(`[workerResult] {"workerAgentId":"${worker.agentId}"`);
    expect(message).toContain("status: done");
    expect(message).toContain("Implemented the completion hook and verified the flow.");
    expect(internalWorker(manager, worker.agentId).workerParentContext).toBeUndefined();
  });

  it("defers a pending manager recycle until a settled worker result reaches the runtime boundary", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    const worker = await spawnAssignedWorker(manager, "recycle-boundary-worker");
    const managerRuntime = manager.runtimeByAgentId.get("manager");
    const managerDescriptor = manager.getAgent("manager");
    const state = manager as unknown as {
      runtimeController: { allocateRuntimeToken(agentId: string): number };
      runtimeRecoveryState: {
        setPendingManagerRuntimeRecycle(agentId: string, reason: "project_agent_directory_change"): void;
        hasPendingManagerRuntimeRecycle(agentId: string): boolean;
      };
      handleRuntimeStatus(
        runtimeToken: number,
        agentId: string,
        status: AgentDescriptor["status"],
        pendingCount: number,
      ): Promise<void>;
    };
    if (!managerRuntime || !managerDescriptor) {
      throw new Error("Missing manager runtime state");
    }
    const runtimeToken = manager.runtimeTokensByAgentId.get("manager")
      ?? state.runtimeController.allocateRuntimeToken("manager");

    managerRuntime.busy = false;
    managerDescriptor.status = "streaming";
    state.runtimeRecoveryState.setPendingManagerRuntimeRecycle(
      managerDescriptor.agentId,
      "project_agent_directory_change",
    );

    await state.handleRuntimeStatus(runtimeToken, managerDescriptor.agentId, "idle", 0);
    managerRuntime.descriptor.status = "idle";

    expect(managerRuntime.recycleCalls).toBe(0);
    expect(state.runtimeRecoveryState.hasPendingManagerRuntimeRecycle(managerDescriptor.agentId)).toBe(true);

    await manager.handleRuntimeSessionEvent(worker.agentId, {
      type: "message_end",
      message: {
        role: "assistant",
        content: "Completed after the manager became idle.",
        stopReason: "stop",
      },
    });
    await manager.handleRuntimeAgentEnd(worker.agentId);

    const replacementRuntime = manager.runtimeByAgentId.get(managerDescriptor.agentId);
    expect(managerRuntime.recycleCalls).toBe(1);
    expect(state.runtimeRecoveryState.hasPendingManagerRuntimeRecycle(managerDescriptor.agentId)).toBe(false);
    expect(replacementRuntime).toBeDefined();
    expect(replacementRuntime).not.toBe(managerRuntime);
    expect(String(replacementRuntime?.sendCalls.at(-1)?.message)).toContain("[workerResult]");
    expect(String(replacementRuntime?.sendCalls.at(-1)?.message)).toContain(
      "Completed after the manager became idle.",
    );
  });

  it("shares deferred replacement across a concurrent worker result and user turn", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    const worker = await spawnAssignedWorker(manager, "concurrent-recycle-worker");
    const managerRuntime = manager.runtimeByAgentId.get("manager");
    const managerDescriptor = manager.getAgent("manager");
    const state = manager as unknown as {
      runtimeController: { allocateRuntimeToken(agentId: string): number };
      runtimeRecoveryState: {
        setPendingManagerRuntimeRecycle(agentId: string, reason: "project_agent_directory_change"): void;
      };
      projectExecutableTrustCoordinator: {
        applyPendingManagerRuntimeRecycleBeforeRuntimeUse(descriptor: AgentDescriptor): Promise<void>;
      };
      handleRuntimeStatus(
        runtimeToken: number,
        agentId: string,
        status: AgentDescriptor["status"],
        pendingCount: number,
      ): Promise<void>;
    };
    if (!managerRuntime || !managerDescriptor) {
      throw new Error("Missing manager runtime state");
    }

    await manager.handleRuntimeSessionEvent(worker.agentId, {
      type: "message_end",
      message: {
        role: "assistant",
        content: "Worker result delivered across the replacement barrier.",
        stopReason: "stop",
      },
    });

    const runtimeToken = manager.runtimeTokensByAgentId.get(managerDescriptor.agentId)
      ?? state.runtimeController.allocateRuntimeToken(managerDescriptor.agentId);
    managerDescriptor.status = "streaming";
    managerRuntime.busy = false;
    state.runtimeRecoveryState.setPendingManagerRuntimeRecycle(
      managerDescriptor.agentId,
      "project_agent_directory_change",
    );
    await state.handleRuntimeStatus(runtimeToken, managerDescriptor.agentId, "idle", 0);
    managerRuntime.descriptor.status = "idle";
    managerRuntime.sendCalls = [];

    let markRecycleStarted!: () => void;
    let releaseRecycle!: () => void;
    const recycleStarted = new Promise<void>((resolve) => {
      markRecycleStarted = resolve;
    });
    const recycleGate = new Promise<void>((resolve) => {
      releaseRecycle = resolve;
    });
    const recycle = managerRuntime.recycle.bind(managerRuntime);
    managerRuntime.recycle = async () => {
      markRecycleStarted();
      await recycleGate;
      await recycle();
    };

    let boundaryCalls = 0;
    let markConcurrentBoundaryEntered!: () => void;
    const concurrentBoundaryEntered = new Promise<void>((resolve) => {
      markConcurrentBoundaryEntered = resolve;
    });
    const applyPendingRecycle = state.projectExecutableTrustCoordinator
      .applyPendingManagerRuntimeRecycleBeforeRuntimeUse
      .bind(state.projectExecutableTrustCoordinator);
    vi.spyOn(
      state.projectExecutableTrustCoordinator,
      "applyPendingManagerRuntimeRecycleBeforeRuntimeUse",
    ).mockImplementation(async (descriptor) => {
      boundaryCalls += 1;
      if (boundaryCalls === 2) {
        markConcurrentBoundaryEntered();
      }
      await applyPendingRecycle(descriptor);
    });

    const workerResult = manager.handleRuntimeAgentEnd(worker.agentId);
    await recycleStarted;
    let userTurnResolved = false;
    const userTurn = manager.handleUserMessage(
      "User input delivered across the same replacement barrier.",
      { sourceContext: { channel: "web" } },
    ).then(() => {
      userTurnResolved = true;
    });
    await concurrentBoundaryEntered;

    expect(userTurnResolved).toBe(false);
    expect(managerRuntime.sendCalls).toHaveLength(0);

    releaseRecycle();
    await Promise.all([workerResult, userTurn]);

    const replacementRuntime = manager.runtimeByAgentId.get(managerDescriptor.agentId);
    const replacementMessages = replacementRuntime?.sendCalls.map((call) =>
      typeof call.message === "string" ? call.message : call.message.text) ?? [];
    expect(managerRuntime.recycleCalls).toBe(1);
    expect(replacementRuntime).toBeDefined();
    expect(replacementRuntime).not.toBe(managerRuntime);
    expect(replacementMessages.some((message) => message.includes("[workerResult]"))).toBe(true);
    expect(replacementMessages.some((message) =>
      message.includes("User input delivered across the same replacement barrier."))).toBe(true);
  });

  it("keeps the manager available for a newer user message while the worker runs", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    const worker = await spawnAssignedWorker(manager, "concurrent-worker");
    const managerRuntime = manager.runtimeByAgentId.get("manager");
    if (!managerRuntime) throw new Error("Missing manager runtime");
    managerRuntime.sendCalls = [];
    managerRuntime.busy = true;

    await manager.handleUserMessage(
      "While that worker runs, answer this separate question.",
      { sourceContext: { channel: "web" } },
    );

    await manager.handleRuntimeSessionEvent(worker.agentId, {
      type: "message_end",
      message: { role: "assistant", content: "Concurrent worker finished.", stopReason: "stop" },
    });
    await manager.handleRuntimeAgentEnd(worker.agentId);

    expect(managerRuntime.sendCalls).toHaveLength(2);
    expect(String(managerRuntime.sendCalls[0]?.message)).toContain(
      "While that worker runs, answer this separate question.",
    );
    expect(String(managerRuntime.sendCalls[1]?.message)).toContain("[workerResult]");
    expect(String(managerRuntime.sendCalls[1]?.message)).toContain("Concurrent worker finished.");
    expect(managerRuntime.sendCalls[1]?.delivery).toBe("auto");
  });

  it("does not deliver a second result for a duplicate agent_end callback", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    const worker = await spawnAssignedWorker(manager, "single-result-worker");
    const managerRuntime = manager.runtimeByAgentId.get("manager");
    if (!managerRuntime) throw new Error("Missing manager runtime");

    await manager.handleRuntimeSessionEvent(worker.agentId, {
      type: "message_end",
      message: { role: "assistant", content: "One result only.", stopReason: "stop" },
    });
    managerRuntime.sendCalls = [];
    await manager.handleRuntimeAgentEnd(worker.agentId);
    await manager.handleRuntimeAgentEnd(worker.agentId);

    expect(managerRuntime.sendCalls).toHaveLength(1);
  });

  it("delivers once when context recovery releases a settled worker", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    const managerDescriptor = await bootWithDefaultManager(manager, config);
    await beginManagerTurn(manager, "Delegate recovered-result-worker.");
    const worker = await manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "recovered-result-worker",
    });
    await manager.sendMessage(
      managerDescriptor.agentId,
      worker.agentId,
      "Do the delegated task and return a concise final result.",
    );
    const managerRuntime = manager.runtimeByAgentId.get("manager");
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId);
    if (!managerRuntime || !workerRuntime) throw new Error("Missing runtime");

    const state = manager as unknown as {
      runtimeController: { allocateRuntimeToken(agentId: string): number };
      handleRuntimeStatus(
        runtimeToken: number,
        agentId: string,
        status: AgentDescriptor["status"],
        pendingCount: number,
      ): Promise<void>;
    };
    const runtimeToken = state.runtimeController.allocateRuntimeToken(worker.agentId);

    let recoveryInProgress = true;
    workerRuntime.isContextRecoveryInProgress = () => recoveryInProgress;
    workerRuntime.isContextRecoveryActive = () => recoveryInProgress;
    await state.handleRuntimeStatus(runtimeToken, worker.agentId, "streaming", 0);
    await manager.handleRuntimeSessionEvent(worker.agentId, {
      type: "message_end",
      message: {
        role: "assistant",
        content: "Resumed after compaction and completed the assignment.",
        stopReason: "stop",
      },
    });
    managerRuntime.sendCalls = [];

    await state.handleRuntimeStatus(runtimeToken, worker.agentId, "idle", 0);
    await manager.handleRuntimeAgentEnd(worker.agentId);
    expect(managerRuntime.sendCalls).toHaveLength(0);

    recoveryInProgress = false;
    await state.handleRuntimeStatus(runtimeToken, worker.agentId, "idle", 0);
    await manager.handleRuntimeAgentEnd(worker.agentId);

    expect(managerRuntime.sendCalls).toHaveLength(1);
    expect(String(managerRuntime.sendCalls[0]?.message)).toContain("[workerResult]");
    expect(String(managerRuntime.sendCalls[0]?.message)).toContain(
      "Resumed after compaction and completed the assignment.",
    );
    expect(internalWorker(manager, worker.agentId).workerParentContext).toBeUndefined();
  });

  it("returns a blocked result from the worker's terminal error context", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    const worker = await spawnAssignedWorker(manager, "errored-worker");
    const managerRuntime = manager.runtimeByAgentId.get("manager");
    if (!managerRuntime) throw new Error("Missing manager runtime");

    await manager.handleRuntimeSessionEvent(worker.agentId, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Request failed because the provider rate limit was reached.",
      },
    });
    managerRuntime.sendCalls = [];
    await manager.handleRuntimeAgentEnd(worker.agentId);

    expect(managerRuntime.sendCalls).toHaveLength(1);
    const message = String(managerRuntime.sendCalls[0]?.message);
    expect(message).toContain("status: blocked");
    expect(message).toContain("provider rate limit was reached");
  });

  it("does not recreate worker activity state after a worker stops streaming", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    const worker = await manager.spawnAgent("manager", { agentId: "late-event-worker" });

    const state = manager as unknown as {
      workerStallState: Map<string, unknown>;
      workerActivityState: Map<string, unknown>;
      updateWorkerActivity(agentId: string, event: unknown): void;
    };
    state.updateWorkerActivity(worker.agentId, { type: "turn_end", toolResults: [] });

    expect(state.workerStallState.has(worker.agentId)).toBe(false);
    expect(state.workerActivityState.has(worker.agentId)).toBe(false);
    expect(manager.getWorkerActivity(worker.agentId)).toBeUndefined();
  });
});
