import { describe, expect, it, vi } from "vitest";
import {
  isActionableWorkerCallbackMessage,
  isManagerActionToolName,
  isManagerNoOpRecoveryNudgeMessage,
  isRuntimeAssistantMessageEndError,
  isWorkerWatchdogAutoReportMessage,
  ManagerNoOpGuard,
  MANAGER_NOOP_DIAGNOSTIC_FINAL,
  MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
  shouldBeginManagerNoOpGuardForDelivery,
  shouldQueueManagerNoOpGuardForDelivery,
  shouldTrackInboundManagerTurn,
} from "../manager-noop-guard.js";

describe("manager-noop-guard classification", () => {
  it("treats only first-line worker status callbacks as actionable", () => {
    expect(isActionableWorkerCallbackMessage("status: done\nsummary: shipped fix")).toBe(true);
    expect(isActionableWorkerCallbackMessage("\nSTATUS: PARTIAL\nsummary: still validating")).toBe(true);
    expect(isActionableWorkerCallbackMessage("still working on the grep pass")).toBe(false);
    expect(isActionableWorkerCallbackMessage("deployment status: done\nsummary: incidental prose")).toBe(false);
  });

  it("recognizes watchdog auto-reports separately from actionable callbacks", () => {
    expect(isWorkerWatchdogAutoReportMessage("SYSTEM: Worker worker-1 completed its turn.")).toBe(true);
    expect(isActionableWorkerCallbackMessage("SYSTEM: Worker worker-1 completed its turn.")).toBe(false);
  });

  it("does not track watchdog auto-reports for Phase 1 guard turns", () => {
    expect(
      shouldTrackInboundManagerTurn({
        targetRole: "manager",
        senderRole: "worker",
        origin: "internal",
        message: "SYSTEM: Worker worker-1 completed its turn.",
      }),
    ).toBeNull();
  });

  it("begins guard turns only for prompt delivery and queues follow-up delivery", () => {
    expect(shouldBeginManagerNoOpGuardForDelivery("prompt")).toBe(true);
    expect(shouldBeginManagerNoOpGuardForDelivery("steer")).toBe(false);
    expect(shouldBeginManagerNoOpGuardForDelivery("followUp")).toBe(false);
    expect(shouldQueueManagerNoOpGuardForDelivery("prompt")).toBe(false);
    expect(shouldQueueManagerNoOpGuardForDelivery("steer")).toBe(false);
    expect(shouldQueueManagerNoOpGuardForDelivery("followUp")).toBe(true);
  });

  it("tracks only actionable worker callbacks and recovery nudges", () => {
    expect(
      shouldTrackInboundManagerTurn({
        targetRole: "manager",
        senderRole: "worker",
        origin: "internal",
        message: "status: blocked\nsummary: needs credentials",
      }),
    ).toBe("worker_callback");

    expect(
      shouldTrackInboundManagerTurn({
        targetRole: "manager",
        senderRole: "worker",
        origin: "internal",
        message: "STATUS: DONE\nsummary: scheduled workflow worker callback finished",
      }),
    ).toBe("worker_callback");

    expect(
      shouldTrackInboundManagerTurn({
        targetRole: "manager",
        senderRole: "manager",
        origin: "internal",
        message: "SYSTEM: [Forge manager recovery] close the callback",
      }),
    ).toBe("recovery_nudge");

    expect(
      shouldTrackInboundManagerTurn({
        targetRole: "manager",
        senderRole: "worker",
        origin: "internal",
        message: "deployment status: done\nsummary: incidental prose",
      }),
    ).toBeNull();

    expect(
      shouldTrackInboundManagerTurn({
        targetRole: "manager",
        senderRole: "worker",
        origin: "user",
        message: "status: done",
      }),
    ).toBeNull();

    expect(
      shouldTrackInboundManagerTurn({
        targetRole: "manager",
        senderRole: "manager",
        origin: "internal",
        message: "status: done\nsummary: internal self-delivery closeout",
      }),
    ).toBeNull();

    expect(
      shouldTrackInboundManagerTurn({
        targetRole: "manager",
        senderRole: "worker",
        origin: "internal",
        internalDeliveryKind: "codex_plugin_bootstrap",
        message: "status: done\nsummary: bootstrap handoff",
      }),
    ).toBeNull();
  });

  it("recognizes recovery nudge messages", () => {
    expect(isManagerNoOpRecoveryNudgeMessage("SYSTEM: [Forge manager recovery] retry")).toBe(true);
    expect(isManagerNoOpRecoveryNudgeMessage("SYSTEM: routine bootstrap")).toBe(false);
  });

  it("recognizes MCP-namespaced manager action tool names by suffix", () => {
    expect(isManagerActionToolName("send_message_to_agent")).toBe(true);
    expect(isManagerActionToolName("mcp__forge-swarm-manager__send_message_to_agent")).toBe(true);
    expect(isManagerActionToolName("mcp__forge-swarm__task")).toBe(true);
    expect(isManagerActionToolName("mcp__custom-swarm__present_choices")).toBe(true);
    expect(isManagerActionToolName("mcp:forge-swarm-manager:send_message_to_agent")).toBe(true);
    expect(isManagerActionToolName("mcp:forge-swarm:task")).toBe(true);
    expect(isManagerActionToolName("mcp:custom-swarm:present_choices")).toBe(true);
    expect(isManagerActionToolName("mcp__forge-swarm__list_agents")).toBe(false);
    expect(isManagerActionToolName("not_mcp__forge-swarm__task")).toBe(false);
    expect(isManagerActionToolName("mcp____task")).toBe(false);
  });

  it("recognizes assistant message_end runtime errors", () => {
    expect(
      isRuntimeAssistantMessageEndError({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "terminated" },
      }),
    ).toBe(true);
    expect(
      isRuntimeAssistantMessageEndError({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      }),
    ).toBe(false);
    expect(
      isRuntimeAssistantMessageEndError({
        type: "tool_execution_start",
        toolName: "task",
        toolCallId: "task-1",
        args: {},
      }),
    ).toBe(false);
  });
});

describe("ManagerNoOpGuard", () => {
  it("emits one diagnostic and one internal nudge for worker callback no-ops", async () => {
    const emitConversationMessage = vi.fn();
    const sendInternalManagerMessage = vi.fn(async () => undefined);
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage,
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.beginTurn("manager", "worker_callback", {
      fromWorkerAgentId: "worker-1",
      triggerPreview: "status: done\nsummary: finished",
    });

    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).toHaveBeenCalledTimes(1);
    expect(emitConversationMessage.mock.calls[0]?.[0]).toMatchObject({
      role: "system",
      source: "system",
      text: MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
    });
    expect(sendInternalManagerMessage).toHaveBeenCalledTimes(1);
    expect(String(sendInternalManagerMessage.mock.calls[0]?.[1])).toContain("SYSTEM: [Forge manager recovery]");
  });

  it("does not fire when a manager action tool completes successfully", async () => {
    const emitConversationMessage = vi.fn();
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage: vi.fn(async () => undefined),
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.beginTurn("manager", "worker_callback");
    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "speak_to_user",
      toolCallId: "tc-1",
      args: { text: "Done." },
    });
    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "speak_to_user",
      toolCallId: "tc-1",
      result: { ok: true },
      isError: false,
    });

    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).not.toHaveBeenCalled();
  });

  it("does not fire when some Forge action tool completes successfully, including MCP-namespaced action tools", async () => {
    const emitConversationMessage = vi.fn();
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage: vi.fn(async () => undefined),
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.beginTurn("manager", "worker_callback");
    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "task",
      toolCallId: "task-1",
      args: { action: "get" },
    });
    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "task",
      toolCallId: "task-1",
      result: { ok: true },
      isError: false,
    });
    await guard.tryFinalize("manager", "agent_end");

    guard.beginTurn("manager", "worker_callback");
    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "mcp__forge-swarm__task",
      toolCallId: "task-2",
      args: { action: "get" },
    });
    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "mcp__forge-swarm__task",
      toolCallId: "task-2",
      result: { ok: true },
      isError: false,
    });

    await guard.tryFinalize("manager", "agent_end");

    for (const [toolCallId, toolName] of [
      ["msg-1", "mcp:forge-swarm-manager:send_message_to_agent"],
      ["task-3", "mcp:forge-swarm-manager:task"],
      ["choice-1", "mcp:forge-swarm-manager:present_choices"],
    ] as const) {
      guard.beginTurn("manager", "worker_callback");
      guard.noteRuntimeSessionEvent("manager", {
        type: "tool_execution_start",
        toolName,
        toolCallId,
        args: {},
      });
      guard.noteRuntimeSessionEvent("manager", {
        type: "tool_execution_end",
        toolName,
        toolCallId,
        result: { ok: true },
        isError: false,
      });
      await guard.tryFinalize("manager", "agent_end");
    }

    expect(emitConversationMessage).not.toHaveBeenCalled();
  });

  it("fires when an attempted manager action tool fails", async () => {
    const emitConversationMessage = vi.fn();
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage: vi.fn(async () => undefined),
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.beginTurn("manager", "worker_callback");
    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "send_message_to_agent",
      toolCallId: "msg-1",
      args: { targetAgentId: "worker-2", message: "follow up" },
    });
    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "send_message_to_agent",
      toolCallId: "msg-1",
      result: { error: "target unavailable" },
      isError: true,
    });

    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
    }));
  });

  it("activates delivery-less queued follow-up guard only when the matching queued user message starts", async () => {
    const emitConversationMessage = vi.fn();
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage: vi.fn(async () => undefined),
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.queuePendingTurn("manager", {
      triggerKind: "worker_callback",
      fromWorkerAgentId: "worker-1",
      triggerPreview: "status: done\nsummary: queued callback",
      runtimeMessageText: "SYSTEM: status: done\nsummary: queued callback",
      acceptedMode: "followUp",
      requestedDelivery: "auto",
    });

    guard.noteRuntimeSessionEvent("manager", {
      type: "message_start",
      message: { role: "user", content: "unrelated active user turn" },
    });
    await guard.tryFinalize("manager", "agent_end");
    expect(emitConversationMessage).not.toHaveBeenCalled();

    guard.noteRuntimeSessionEvent("manager", {
      type: "message_start",
      message: { role: "user", content: "SYSTEM: status: done\nsummary: queued callback" },
    });
    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
    }));
  });

  it("does not activate a delivery-scoped queued follow-up from unrelated same-text prompt events", async () => {
    const emitConversationMessage = vi.fn();
    const sendInternalManagerMessage = vi.fn(async () => undefined);
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage,
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    const callbackText = "SYSTEM: status: done\nsummary: duplicate callback text";
    guard.queuePendingTurn("manager", {
      triggerKind: "worker_callback",
      fromWorkerAgentId: "worker-1",
      triggerPreview: "status: done\nsummary: duplicate callback text",
      runtimeMessageText: callbackText,
      deliveryId: "delivery-follow-up",
      acceptedMode: "followUp",
      requestedDelivery: "auto",
    });

    guard.noteRuntimeSessionEvent("manager", {
      type: "queued_input_start",
      deliveryId: "delivery-current-prompt",
      message: { text: callbackText },
      acceptedMode: "prompt",
      requestedMode: "auto",
    });
    await guard.tryFinalize("manager", "agent_end");
    expect(emitConversationMessage).not.toHaveBeenCalled();

    guard.noteRuntimeSessionEvent("manager", {
      type: "message_start",
      message: { role: "user", content: callbackText },
    });
    await guard.tryFinalize("manager", "agent_end");
    expect(emitConversationMessage).not.toHaveBeenCalled();

    guard.noteRuntimeSessionEvent("manager", {
      type: "queued_input_start",
      deliveryId: "delivery-follow-up",
      message: { text: callbackText },
      acceptedMode: "followUp",
      requestedMode: "auto",
    });
    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
    }));
    expect(sendInternalManagerMessage).toHaveBeenCalledTimes(1);
  });

  it("requires compatible acceptedMode for delivery-less queued input text fallback", async () => {
    const emitConversationMessage = vi.fn();
    const sendInternalManagerMessage = vi.fn(async () => undefined);
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage,
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    const callbackText = "SYSTEM: status: done\nsummary: legacy queued callback";
    guard.queuePendingTurn("manager", {
      triggerKind: "worker_callback",
      fromWorkerAgentId: "worker-1",
      triggerPreview: "status: done\nsummary: legacy queued callback",
      runtimeMessageText: callbackText,
      acceptedMode: "followUp",
      requestedDelivery: "auto",
    });

    guard.noteRuntimeSessionEvent("manager", {
      type: "queued_input_start",
      deliveryId: "delivery-current-prompt",
      message: { text: callbackText },
      acceptedMode: "prompt",
      requestedMode: "auto",
    });
    await guard.tryFinalize("manager", "agent_end");
    expect(emitConversationMessage).not.toHaveBeenCalled();

    guard.noteRuntimeSessionEvent("manager", {
      type: "queued_input_start",
      deliveryId: "delivery-follow-up",
      message: { text: callbackText },
      acceptedMode: "followUp",
      requestedMode: "auto",
    });
    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
    }));
    expect(sendInternalManagerMessage).toHaveBeenCalledTimes(1);
  });

  it("activates queued follow-up guard on provider-independent queued input start", async () => {
    const emitConversationMessage = vi.fn();
    const sendInternalManagerMessage = vi.fn(async () => undefined);
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage,
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.queuePendingTurn("manager", {
      triggerKind: "worker_callback",
      fromWorkerAgentId: "worker-1",
      triggerPreview: "status: done\nsummary: queued callback",
      runtimeMessageText: "",
      deliveryId: "delivery-queued",
      acceptedMode: "followUp",
      requestedDelivery: "auto",
    });

    guard.noteRuntimeSessionEvent("manager", { type: "agent_start" });
    guard.noteRuntimeSessionEvent("manager", { type: "turn_start" });
    await guard.tryFinalize("manager", "agent_end");
    expect(emitConversationMessage).not.toHaveBeenCalled();

    guard.noteRuntimeSessionEvent("manager", {
      type: "queued_input_start",
      deliveryId: "other-delivery",
      message: { text: "unrelated active user turn" },
      acceptedMode: "prompt",
      requestedMode: "auto",
    });
    await guard.tryFinalize("manager", "agent_end");
    expect(emitConversationMessage).not.toHaveBeenCalled();

    guard.noteRuntimeSessionEvent("manager", {
      type: "queued_input_start",
      deliveryId: "delivery-queued",
      message: { text: "" },
      acceptedMode: "followUp",
      requestedMode: "auto",
    });
    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE,
    }));
    expect(sendInternalManagerMessage).toHaveBeenCalledTimes(1);
  });

  it("activates queued recovery nudges on provider-independent queued input start", async () => {
    const emitConversationMessage = vi.fn();
    const sendInternalManagerMessage = vi.fn(async () => undefined);
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage,
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.queuePendingTurn("manager", {
      triggerKind: "recovery_nudge",
      triggerPreview: "SYSTEM: [Forge manager recovery] retry",
      runtimeMessageText: "SYSTEM: [Forge manager recovery] retry",
      deliveryId: "delivery-recovery",
      acceptedMode: "followUp",
      requestedDelivery: "auto",
    });

    guard.noteRuntimeSessionEvent("manager", {
      type: "queued_input_start",
      deliveryId: "delivery-recovery",
      message: { text: "SYSTEM: [Forge manager recovery] retry" },
      acceptedMode: "followUp",
      requestedMode: "auto",
    });
    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: MANAGER_NOOP_DIAGNOSTIC_FINAL,
    }));
    expect(sendInternalManagerMessage).not.toHaveBeenCalled();
  });

  it("emits a final diagnostic without another nudge when recovery nudge no-ops", async () => {
    const emitConversationMessage = vi.fn();
    const sendInternalManagerMessage = vi.fn(async () => undefined);
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage,
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.beginTurn("manager", "worker_callback");
    await guard.tryFinalize("manager", "agent_end");
    expect(sendInternalManagerMessage).toHaveBeenCalledTimes(1);

    guard.beginTurn("manager", "recovery_nudge");
    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).toHaveBeenCalledTimes(2);
    expect(emitConversationMessage.mock.calls[1]?.[0]).toMatchObject({
      text: MANAGER_NOOP_DIAGNOSTIC_FINAL,
    });
    expect(sendInternalManagerMessage).toHaveBeenCalledTimes(1);
  });

  it("does not emit duplicate diagnostics when agent_end and idle finalizers both run", async () => {
    const emitConversationMessage = vi.fn();
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage: vi.fn(async () => undefined),
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.beginTurn("manager", "worker_callback");
    await guard.tryFinalize("manager", "agent_end");
    await guard.tryFinalize("manager", "idle");

    expect(emitConversationMessage).toHaveBeenCalledTimes(1);
  });

  it("waits while queued input is pending before judging the current turn", async () => {
    const emitConversationMessage = vi.fn();
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage: vi.fn(async () => undefined),
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.beginTurn("manager", "worker_callback");
    await guard.tryFinalize("manager", "idle", { pendingCount: 1 });
    expect(emitConversationMessage).not.toHaveBeenCalled();

    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_start",
      toolName: "send_message_to_agent",
      toolCallId: "msg-1",
      args: { targetAgentId: "worker-2", message: "follow up" },
    });
    guard.noteRuntimeSessionEvent("manager", {
      type: "tool_execution_end",
      toolName: "send_message_to_agent",
      toolCallId: "msg-1",
      result: { ok: true },
      isError: false,
    });
    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).not.toHaveBeenCalled();
  });

  it("suppresses finalize while manual stop is pending", async () => {
    const emitConversationMessage = vi.fn();
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage: vi.fn(async () => undefined),
      isManualStopPending: () => true,
      isRuntimeRecoveryActive: () => false,
    });

    guard.beginTurn("manager", "worker_callback");
    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).not.toHaveBeenCalled();
  });

  it("suppresses finalize after assistant message_end runtime error", async () => {
    const emitConversationMessage = vi.fn();
    const guard = new ManagerNoOpGuard({
      now: () => "2026-06-03T00:00:00.000Z",
      logDebug: () => undefined,
      emitConversationMessage,
      sendInternalManagerMessage: vi.fn(async () => undefined),
      isManualStopPending: () => false,
      isRuntimeRecoveryActive: () => false,
    });

    guard.beginTurn("manager", "worker_callback");
    guard.noteRuntimeSessionEvent("manager", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "provider failed",
      },
    });

    await guard.tryFinalize("manager", "agent_end");

    expect(emitConversationMessage).not.toHaveBeenCalled();
  });
});
