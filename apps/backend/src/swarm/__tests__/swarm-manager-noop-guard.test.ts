import { describe, expect, it, vi } from "vitest";
import {
  FakeRuntime,
  TestSwarmManager as TestSwarmManagerBase,
  bootWithDefaultManager,
  makeTempConfig as buildTempConfig,
} from "../../test-support/index.js";
import type { AgentDescriptor, RuntimeCreationOptions, SwarmAgentRuntime, SwarmConfig } from "../types.js";
import {
  MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
} from "../manager-noop-guard.js";

class TestSwarmManager extends TestSwarmManagerBase {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = await super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
    (runtime as FakeRuntime).terminateMutatesDescriptorStatus = false;
    return runtime;
  }
}

async function makeTempConfig(port = 8795): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: "swarm-manager-noop-guard-",
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  });
}

async function finalizeEmptyManagerTurn(manager: TestSwarmManager, managerId = "manager"): Promise<void> {
  await manager.handleRuntimeSessionEvent(managerId, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "   " }],
      stopReason: "stop",
    },
  });
  await manager.handleRuntimeAgentEnd(managerId);
}

function runtimeText(message: string | { text: string }): string {
  return typeof message === "string" ? message : message.text;
}

describe("SwarmManager manager no-op guard", () => {
  it("labels actionable worker callbacks in the manager runtime message", async () => {
    const config = await makeTempConfig(8794);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Callback Worker" });
    const managerRuntime = manager.runtimeByAgentId.get("manager") as FakeRuntime;
    managerRuntime.sendCalls = [];

    await manager.sendMessage(worker.agentId, "manager", "status: partial\nsummary: ready for review");

    const runtimeMessage = managerRuntime.sendCalls.at(-1)?.message;
    const runtimeText = typeof runtimeMessage === "string" ? runtimeMessage : runtimeMessage?.text;
    expect(runtimeText).toBe(
      `SYSTEM: [workerCallback] {"fromAgentId":"${worker.agentId}","intent":"partial"}\nstatus: partial\nsummary: ready for review`,
    );
  });

  it("keeps routine worker progress as a generic internal manager runtime message", async () => {
    const config = await makeTempConfig(8793);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Progress Worker" });
    const managerRuntime = manager.runtimeByAgentId.get("manager") as FakeRuntime;
    managerRuntime.sendCalls = [];

    await manager.sendMessage(worker.agentId, "manager", "still checking logs");

    expect(managerRuntime.sendCalls.at(-1)?.message).toBe("SYSTEM: still checking logs");
  });

  it("does not label incidental prose containing a status field", async () => {
    const config = await makeTempConfig(8792);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Incidental Status Worker" });
    const managerRuntime = manager.runtimeByAgentId.get("manager") as FakeRuntime;
    managerRuntime.sendCalls = [];

    await manager.sendMessage(worker.agentId, "manager", "deployment status: done\nsummary: not a closeout");

    expect(managerRuntime.sendCalls.at(-1)?.message).toBe("SYSTEM: deployment status: done\nsummary: not a closeout");
  });

  it("persists a system diagnostic and sends one recovery nudge after an empty manager worker-callback turn", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "No-op Worker" });
    const managerRuntime = manager.runtimeByAgentId.get("manager") as FakeRuntime;
    expect(managerRuntime).toBeDefined();
    managerRuntime.sendCalls = [];

    await manager.sendMessage(worker.agentId, "manager", "status: done\nsummary: finished with no manager action");

    managerRuntime.sendCalls = [];

    await finalizeEmptyManagerTurn(manager);

    const history = manager.getConversationHistory("manager");
    const diagnostic = history.find(
      (entry) =>
        entry.type === "conversation_message" &&
        entry.role === "system" &&
        entry.text === MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
    );
    expect(diagnostic).toBeDefined();
    expect(managerRuntime.sendCalls).toHaveLength(1);
    expect(String(managerRuntime.sendCalls[0]?.message)).toContain("SYSTEM: [Forge manager recovery]");
  });

  it("does not fire when the manager uses speak_to_user", async () => {
    const config = await makeTempConfig(8796);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Reporting Worker" });
    await manager.sendMessage(worker.agentId, "manager", "status: done\nsummary: ready for user update");

    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "speak_to_user",
      toolCallId: "speak-1",
      args: { text: "Worker finished." },
    });
    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "speak_to_user",
      toolCallId: "speak-1",
      result: { ok: true },
      isError: false,
    });
    await manager.handleRuntimeAgentEnd("manager");

    const history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text.includes("no visible action"),
      ),
    ).toBe(false);
  });

  it("does not fire when the manager closes out with send_message_to_agent", async () => {
    const config = await makeTempConfig(8801);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Peer Closeout Worker" });
    await manager.sendMessage(worker.agentId, "manager", "status: done\nsummary: hand off to a peer");

    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "send_message_to_agent",
      toolCallId: "msg-1",
      args: { targetAgentId: worker.agentId, message: "Thanks, archive your notes." },
    });
    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "send_message_to_agent",
      toolCallId: "msg-1",
      result: { ok: true },
      isError: false,
    });
    await manager.handleRuntimeAgentEnd("manager");

    const history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text.includes("no visible action"),
      ),
    ).toBe(false);
  });

  it("does not fire when the manager delegates to a Codex Plugin specialist", async () => {
    const config = await makeTempConfig(8802);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Codex Request Worker" });
    await manager.sendMessage(worker.agentId, "manager", "status: blocked\nsummary: needs Codex plugin lookup");

    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "spawn_agent",
      toolCallId: "spawn-codex-1",
      args: {
        specialist: "codex-plugin",
        agentId: "codex-plugin-worker",
        initialMessage: "Use the selected Codex plugin scope to inspect the app data.",
      },
    });
    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "spawn_agent",
      toolCallId: "spawn-codex-1",
      result: { ok: true },
      isError: false,
    });
    await manager.handleRuntimeAgentEnd("manager");

    const history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text.includes("no visible action"),
      ),
    ).toBe(false);
  });

  it("does not fire after a manager message_end runtime error", async () => {
    const config = await makeTempConfig(8799);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Erroring Manager Worker" });
    const managerRuntime = manager.runtimeByAgentId.get("manager") as FakeRuntime;
    managerRuntime.sendCalls = [];

    await manager.sendMessage(worker.agentId, "manager", "status: blocked\nsummary: provider failed");
    managerRuntime.sendCalls = [];

    await manager.handleRuntimeSessionEvent("manager", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "provider failed",
      },
    });
    await manager.handleRuntimeAgentEnd("manager");

    const history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text.includes("no visible action"),
      ),
    ).toBe(false);
    expect(managerRuntime.sendCalls).toHaveLength(0);
  });

  it("fires when a manager action tool fails and the manager otherwise returns no visible output", async () => {
    const config = await makeTempConfig(8803);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Failed Action Worker" });
    await manager.sendMessage(worker.agentId, "manager", "status: blocked\nsummary: attempted handoff failed");

    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "send_message_to_agent",
      toolCallId: "msg-failed-1",
      args: { targetAgentId: worker.agentId, message: "Please continue." },
    });
    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "send_message_to_agent",
      toolCallId: "msg-failed-1",
      result: { error: "delivery failed" },
      isError: true,
    });
    await manager.handleRuntimeAgentEnd("manager");

    const history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text === MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
      ),
    ).toBe(true);
  });

  it("does not begin a guard turn when a busy manager accepts worker callbacks as steer", async () => {
    const config = await makeTempConfig(8798);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Queued Worker" });
    const managerRuntime = manager.runtimeByAgentId.get("manager") as FakeRuntime;
    managerRuntime.busy = true;

    const receipt = await manager.sendMessage(
      worker.agentId,
      "manager",
      "status: done\nsummary: queued while manager busy",
    );
    expect(receipt.acceptedMode).toBe("steer");

    await finalizeEmptyManagerTurn(manager);

    const history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text.includes("no visible action"),
      ),
    ).toBe(false);
  });

  it("guards queued follow-up callbacks only when their queued manager turn starts", async () => {
    const config = await makeTempConfig(8804);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Follow-up Worker" });
    const managerRuntime = manager.runtimeByAgentId.get("manager") as FakeRuntime;
    managerRuntime.busy = true;
    managerRuntime.sendCalls = [];
    const sendMessageSpy = vi
      .spyOn(managerRuntime, "sendMessage")
      .mockImplementation(async (message, delivery = "auto") => {
        managerRuntime.sendCalls.push({ message, delivery });
        managerRuntime.nextDeliveryId += 1;
        return {
          targetAgentId: "manager",
          deliveryId: `delivery-${managerRuntime.nextDeliveryId}`,
          acceptedMode: managerRuntime.busy ? "followUp" : "prompt",
        };
      });

    const receipt = await manager.sendMessage(
      worker.agentId,
      "manager",
      "status: done\nsummary: queued while manager busy",
    );
    expect(receipt.acceptedMode).toBe("followUp");
    const queuedRuntimeText = runtimeText(managerRuntime.sendCalls.at(-1)!.message);

    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "task",
      toolCallId: "current-task",
      args: { action: "get" },
    });
    await manager.handleRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "task",
      toolCallId: "current-task",
      result: { ok: true },
      isError: false,
    });
    await finalizeEmptyManagerTurn(manager);

    let history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text.includes("no visible action"),
      ),
    ).toBe(false);

    managerRuntime.busy = false;
    await manager.handleRuntimeSessionEvent("manager", {
      type: "queued_input_start",
      deliveryId: "unrelated-delivery",
      message: { text: queuedRuntimeText },
      acceptedMode: "prompt",
      requestedMode: "auto",
    });
    await finalizeEmptyManagerTurn(manager);
    history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text === MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
      ),
    ).toBe(false);

    await manager.handleRuntimeSessionEvent("manager", {
      type: "queued_input_start",
      deliveryId: receipt.deliveryId,
      message: { text: queuedRuntimeText },
      acceptedMode: "followUp",
      requestedMode: "auto",
    });
    await finalizeEmptyManagerTurn(manager);

    history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text === MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
      ),
    ).toBe(true);

    sendMessageSpy.mockRestore();
  });

  it("does not fire after manual stop is pending", async () => {
    const config = await makeTempConfig(8797);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Stopped Worker" });
    await manager.sendMessage(worker.agentId, "manager", "status: done\nsummary: should be suppressed");

    (manager as any).markPendingManualManagerStopNotice("manager");
    await finalizeEmptyManagerTurn(manager);

    const history = manager.getConversationHistory("manager");
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.role === "system" &&
          entry.text.includes("no visible action"),
      ),
    ).toBe(false);
  });

  it("contains agent_end no-op finalization failures", async () => {
    const config = await makeTempConfig(8805);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Agent End Failure Worker" });
    await manager.sendMessage(worker.agentId, "manager", "status: done\nsummary: trigger agent_end finalization");

    const sendMessageSpy = vi
      .spyOn(manager, "sendMessage")
      .mockRejectedValueOnce(new Error("nudge delivery failed"));
    const logDebugSpy = vi.spyOn(manager as any, "logDebug");

    await expect(manager.handleRuntimeAgentEnd("manager")).resolves.toBeUndefined();

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(logDebugSpy).toHaveBeenCalledWith(
      "manager:noop_guard:agent_end_finalize_failed",
      expect.objectContaining({ managerId: "manager", error: "nudge delivery failed" }),
    );

    sendMessageSpy.mockRestore();
    logDebugSpy.mockRestore();
  });

  it("contains idle no-op finalization failures", async () => {
    const config = await makeTempConfig(8800);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const worker = await manager.spawnAgent("manager", { agentId: "Idle Failure Worker" });
    await manager.sendMessage(worker.agentId, "manager", "status: done\nsummary: trigger idle finalization");

    const sendMessageSpy = vi
      .spyOn(manager, "sendMessage")
      .mockRejectedValueOnce(new Error("nudge delivery failed"));
    const logDebugSpy = vi.spyOn(manager as any, "logDebug");
    const managerDescriptor = manager.getAgent("manager");
    expect(managerDescriptor).toBeDefined();

    await expect(
      manager.handleManagerStatusTransition(
        { ...managerDescriptor!, status: "idle" },
        "idle",
        0,
      ),
    ).resolves.toBeUndefined();

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(logDebugSpy).toHaveBeenCalledWith(
      "manager:noop_guard:idle_finalize_failed",
      expect.objectContaining({ managerId: "manager", error: "nudge delivery failed" }),
    );

    sendMessageSpy.mockRestore();
    logDebugSpy.mockRestore();
  });
});
