import { describe, expect, it } from "vitest";
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
