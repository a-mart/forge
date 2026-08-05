import { describe, expect, it, vi } from "vitest";
import type { AssistantOutputTarget } from "../runtime/manager-assistant-output-tracker.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import {
  TurnContextCoordinator,
  type CodexTurnActivation,
  type ManagerOutputTurnActivation,
  type ManagerOutputTurnEndContext,
  type TurnDispatchLedgerInput,
} from "../turn-context-coordinator.js";
import type { AgentDescriptor } from "../types.js";

type TestGate = { scope: string };
type TestDelegation = { id: string };
type TestRetry = { id: string };

const webTarget: AssistantOutputTarget = {
  kind: "session_transcript",
  channel: "web",
  sourceContext: { channel: "web" },
};

function descriptor(
  agentId: string,
  role: AgentDescriptor["role"] = "manager",
  managerId = agentId,
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role,
    managerId,
    profileId: role === "manager" ? "profile-1" : undefined,
    status: "idle",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    cwd: "/tmp",
    model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "none" },
    sessionFile: `/tmp/${agentId}.jsonl`,
  };
}

function runtimeMessageEvent(
  type: "message_start" | "message_end",
  role: "user" | "assistant" | "system",
  text: string,
): RuntimeSessionEvent {
  return { type, message: { role, content: text } };
}

function createHarness() {
  const descriptors = new Map<string, AgentDescriptor>();
  descriptors.set("manager-1", descriptor("manager-1"));
  descriptors.set("worker-1", descriptor("worker-1", "worker", "manager-1"));

  const runtimeTokens = new Map<string, number>([["manager-1", 41]]);
  const ledgerRecords: TurnDispatchLedgerInput[] = [];
  const debugEntries: Array<{ message: string; details?: unknown }> = [];
  const order: string[] = [];
  const outputActivations: ManagerOutputTurnActivation[] = [];
  const providerCycles: ManagerOutputTurnEndContext[] = [];
  const cleanFinals: ManagerOutputTurnEndContext[] = [];
  const codexActivations: Array<CodexTurnActivation<TestGate, TestDelegation, TestRetry>> = [];
  const activeRoots = new Map<string, { rootTurnId: string; parentRootTurnId?: string }>();
  const managerToolActivity: string[] = [];
  const attentionPendingCounts: number[] = [];
  const attentionReleaseCounts: number[] = [];
  let nextTurn = 0;
  const coordinator = new TurnContextCoordinator<TestGate, TestDelegation, TestRetry>({
    descriptors,
    attention: {
      observePendingQueueChange: async (agentId) => {
        attentionPendingCounts.push(coordinator.getPendingContextCount(agentId));
      },
      releaseContinuationBarrier: async (agentId) => {
        attentionReleaseCounts.push(coordinator.getPendingContextCount(agentId));
      },
    },
    getRuntimeToken: (agentId) => runtimeTokens.get(agentId),
    ledger: {
      mintTurnId: async () => `turn-${++nextTurn}`,
      recordTurnDispatched: async (input) => {
        ledgerRecords.push(input);
      },
    },
    output: {
      activateManagerTurn: (_agentId, activation) => {
        order.push("output:activate");
        outputActivations.push(activation);
      },
      completeProviderCycle: (_agentId, context) => {
        order.push("output:turn_end");
        providerCycles.push(context);
      },
      completeAgentTurn: () => {
        order.push("output:agent_end");
      },
      acceptCleanManagerFinal: (_agentId, context) => {
        order.push("output:clean_final");
        cleanFinals.push(context);
      },
      handleRuntimeError: () => {
        order.push("output:error");
      },
      clearForRuntimeReset: () => {
        order.push("output:reset");
      },
    },
    codex: {
      noteRuntimeUserMessageStarted: () => {
        order.push("codex:user_start");
      },
      activateManagerTurn: (_agentId, activation) => {
        order.push("codex:activate");
        codexActivations.push(activation);
      },
      completeProviderCycle: () => {
        order.push("codex:turn_end");
      },
      completeAgentTurn: () => {
        order.push("codex:agent_end");
      },
      handleRuntimeError: () => {
        order.push("codex:error");
      },
      clearForRuntimeReset: () => {
        order.push("codex:reset");
      },
    },
    managerToolActivity: {
      activateManagerTurn: (agentId, turnId) => managerToolActivity.push(`activate:${agentId}:${turnId}`),
      clearManagerTurn: (agentId) => managerToolActivity.push(`clear:${agentId}`),
    },
    observability: {
      activateRoot: (agentId, rootTurnId, parentRootTurnId) => {
        activeRoots.set(agentId, { rootTurnId, parentRootTurnId });
      },
      clearRoot: (agentId) => {
        activeRoots.delete(agentId);
      },
      getActiveRootTurnId: (agentId) => {
        const direct = activeRoots.get(agentId);
        if (direct) return direct.parentRootTurnId ?? direct.rootTurnId;
        const descriptor = descriptors.get(agentId);
        const managerRoot = descriptor?.role === "worker"
          ? activeRoots.get(descriptor.managerId)
          : undefined;
        return managerRoot?.parentRootTurnId ?? managerRoot?.rootTurnId;
      },
      recordRuntimeSessionEvent: () => {
        order.push("observability:event");
      },
    },
    logDebug: (message, details) => {
      debugEntries.push({ message, details });
    },
  });

  return {
    coordinator,
    descriptors,
    runtimeTokens,
    ledgerRecords,
    debugEntries,
    order,
    outputActivations,
    providerCycles,
    cleanFinals,
    codexActivations,
    managerToolActivity,
    attentionPendingCounts,
    attentionReleaseCounts,
  };
}

describe("TurnContextCoordinator", () => {
  it("mints and records a turn before queueing, preserves its runtime token, and rolls back by identity", async () => {
    const harness = createHarness();
    const handle = await harness.coordinator.enqueue("manager-1", {
      source: "user_input",
      runtimeMessageText: "hello",
      collaborationAuthor: {
        userId: "user-7",
        workspaceId: "workspace-1",
        role: "member",
      },
    });

    expect(harness.ledgerRecords).toEqual([{
      turnId: "turn-1",
      agentId: "manager-1",
      role: "manager",
      kind: "user",
      initiatedBy: "user-7",
    }]);
    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(1);
    expect(harness.attentionPendingCounts).toEqual([1]);
    expect(harness.coordinator.getActiveTurnId("manager-1", 41)).toBe("turn-1");
    expect(harness.coordinator.getActiveTurnId("manager-1", 99)).toBeUndefined();

    expect(handle.turnId).toBe("turn-1");
    handle.rollback();
    handle.rollback();

    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(0);
    expect(harness.attentionReleaseCounts).toEqual([0]);
    expect(harness.coordinator.getActiveTurnId("manager-1")).toBeUndefined();
  });

  it("keeps the accepted-turn barrier latched when provider dequeue precedes streaming", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "worker_result",
      runtimeMessageText: "[workerResult] result",
    });
    expect(harness.attentionPendingCounts).toEqual([1]);

    // The provider accepts/dequeues the result while the descriptor can still
    // read idle. This is continuation, not abandonment: releasing here would
    // let an aggregate count-to-zero manufacture a false Needs You row.
    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "[workerResult] result"),
    );
    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(0);
    expect(harness.attentionReleaseCounts).toEqual([]);
  });

  it("records typed worker results distinctly in the durable turn ledger", async () => {
    const harness = createHarness();

    await harness.coordinator.enqueue("manager-1", {
      source: "worker_result",
      routeOrigin: "worker_result",
      sourceWorkerId: "worker-1",
      runtimeMessageText: "[workerResult] result",
    });

    expect(harness.ledgerRecords).toEqual([{
      turnId: "turn-1",
      agentId: "manager-1",
      role: "manager",
      kind: "worker_report",
      initiatedBy: "local",
    }]);
  });

  it("promotes the next queued turn when the active enqueue rolls back", async () => {
    const harness = createHarness();
    const first = await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "first",
    });
    const second = await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "second",
    });

    expect(harness.coordinator.getActiveTurnId("manager-1", 41)).toBe(first.turnId);
    first.rollback();
    expect(harness.coordinator.getActiveTurnId("manager-1", 41)).toBe(second.turnId);

    second.rollback();
    second.rollback();
    expect(harness.coordinator.getActiveTurnId("manager-1")).toBeUndefined();
  });

  it("does not replace the active turn when a later queued enqueue rolls back", async () => {
    const harness = createHarness();
    const first = await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "first",
    });
    const second = await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "second",
    });

    second.rollback();
    expect(harness.coordinator.getActiveTurnId("manager-1", 41)).toBe(first.turnId);
  });

  it("reports only activated turns superseded by a different queued user input", async () => {
    const { coordinator } = createHarness();
    const first = await coordinator.enqueue("manager-1", {
      source: "user_input",
      runtimeMessageText: "first",
    });
    const newer = await coordinator.enqueue("manager-1", {
      source: "user_input",
      runtimeMessageText: "newer",
    });

    expect(coordinator.hasPendingSupersedingUserInput("manager-1", first.turnId)).toBe(false);
    coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "first"),
    );
    expect(coordinator.hasPendingSupersedingUserInput("manager-1", first.turnId)).toBe(true);

    newer.rollback();
    expect(coordinator.hasPendingSupersedingUserInput("manager-1", first.turnId)).toBe(false);
    await coordinator.enqueue("manager-1", { source: "agent_message" });
    expect(coordinator.hasPendingSupersedingUserInput("manager-1", first.turnId)).toBe(false);
  });

  it("keeps ledger failure fail-open and honors skipTurnLedger", async () => {
    const harness = createHarness();
    const record = vi.fn().mockRejectedValueOnce(new Error("disk full"));
    const coordinator = new TurnContextCoordinator<TestGate, TestDelegation, TestRetry>({
      descriptors: harness.descriptors,
      getRuntimeToken: () => undefined,
      attention: {
        observePendingQueueChange: async () => undefined,
        releaseContinuationBarrier: async () => undefined,
      },
      ledger: {
        mintTurnId: async () => "turn-fail-open",
        recordTurnDispatched: record,
      },
      output: {
        activateManagerTurn: vi.fn(),
        completeProviderCycle: vi.fn(),
        completeAgentTurn: vi.fn(),
        acceptCleanManagerFinal: vi.fn(),
        handleRuntimeError: vi.fn(),
        clearForRuntimeReset: vi.fn(),
      },
      codex: {
        noteRuntimeUserMessageStarted: vi.fn(),
        activateManagerTurn: vi.fn(),
        completeProviderCycle: vi.fn(),
        completeAgentTurn: vi.fn(),
        handleRuntimeError: vi.fn(),
        clearForRuntimeReset: vi.fn(),
      },
      observability: {
        activateRoot: vi.fn(),
        clearRoot: vi.fn(),
        getActiveRootTurnId: vi.fn(),
        recordRuntimeSessionEvent: vi.fn(),
      },
      logDebug: (message, details) => harness.debugEntries.push({ message, details }),
    });

    await coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "one",
    });
    await coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "two",
      skipTurnLedger: true,
    });

    expect(coordinator.getPendingContextCount("manager-1")).toBe(2);
    expect(record).toHaveBeenCalledTimes(1);
    expect(harness.debugEntries).toEqual([
      expect.objectContaining({ message: "turn_ledger:dispatch:error" }),
    ]);
  });

  it("matches provider-selected queued input by normalized text instead of FIFO order", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "first\nmessage",
      assistantOutputTarget: { kind: "internal_only", reason: "first" },
    });
    await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      routeOrigin: "worker_result",
      runtimeMessageText: "  second\r\nmessage  ",
      assistantOutputTarget: webTarget,
      sourceWorkerId: "worker-1",
    });

    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "second\nmessage"),
    );

    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(1);
    expect(harness.coordinator.getActiveTurnId("manager-1", 41)).toBe("turn-2");
    expect(harness.outputActivations.at(-1)).toEqual({
      target: webTarget,
      routeContext: {
        origin: "worker_result",
        sourceWorkerId: "worker-1",
        requiresVisibleResponse: false,
      },
      turnId: "turn-2",
      beginUserVisibleObligation: false,
    });
    expect(harness.order.slice(0, 3)).toEqual([
      "codex:user_start",
      "output:activate",
      "codex:activate",
    ]);
  });

  it("does not consume a second same-text context on the selected message_end", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "same text",
      assistantOutputTarget: { kind: "internal_only", reason: "first" },
    });
    await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "same text",
      assistantOutputTarget: webTarget,
    });

    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "same text"),
    );
    const activeTurnId = harness.coordinator.getActiveTurnId("manager-1", 41);
    const activationCount = harness.outputActivations.length;

    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_end", "user", "same text"),
    );

    expect(harness.coordinator.getActiveTurnId("manager-1", 41)).toBe(activeTurnId);
    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(1);
    expect(harness.outputActivations).toHaveLength(activationCount);
    expect(harness.outputActivations.at(-1)?.target).toEqual({
      kind: "internal_only",
      reason: "first",
    });
  });

  it("uses message_end as a fallback when message_start did not match a queued context", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "complete text",
      assistantOutputTarget: webTarget,
    });

    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "partial"),
    );
    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_end", "user", "complete text"),
    );

    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(0);
    expect(harness.coordinator.getActiveTurnId("manager-1", 41)).toBe("turn-1");
    expect(harness.outputActivations.at(-1)?.target).toEqual(webTarget);
  });

  it("activates external project-agent, observability, output, and Codex state without owning their policy", async () => {
    const harness = createHarness();
    const gate = { scope: "fireflies" };
    const delegation = { id: "delegation-1" };
    const retry = { id: "retry-1" };

    await harness.coordinator.enqueue("manager-1", {
      source: "project_agent_input",
      routeOrigin: "internal",
      runtimeMessageText: "external task",
      rootTurnId: "root-1",
      parentRootTurnId: "parent-root",
      projectAgentContext: {
        fromAgentId: "project-agent-1",
        fromDisplayName: "External specialist",
        external: true,
        fromProfileId: "external-profile",
        fromProjectName: "External project",
      },
      assistantOutputTarget: { kind: "peer_agent", fromAgentId: "project-agent-1" },
      assistantOutputProjectionTarget: webTarget,
      codexMcpToolGate: gate,
      codexPluginDelegationContext: delegation,
      codexPluginRetryAuthorizationContext: retry,
    });

    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_end", "user", "external task"),
    );

    expect(harness.coordinator.getActiveExternalProjectAgentTurn("manager-1")).toEqual({
      fromAgentId: "project-agent-1",
      fromDisplayName: "External specialist",
      fromProfileId: "external-profile",
      fromProjectName: "External project",
    });
    expect(harness.coordinator.getActiveObservabilityRootTurnId("manager-1")).toBe("parent-root");
    expect(harness.coordinator.getActiveObservabilityRootTurnId("worker-1")).toBe("parent-root");
    expect(harness.outputActivations.at(-1)?.target).toEqual(webTarget);
    expect(harness.codexActivations.at(-1)).toEqual({
      gate,
      delegation,
      retryAuthorization: retry,
    });
    expect(harness.order).toEqual(["output:activate", "codex:activate"]);
  });

  it("keeps id-only contexts as active turn carriers while clearing surface concerns", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "id only",
      activationEligible: false,
      rootTurnId: "ignored-root",
      assistantOutputTarget: webTarget,
      codexMcpToolGate: { scope: "ignored" },
    });

    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "id only"),
    );

    expect(harness.coordinator.getActiveTurnId("manager-1", 41)).toBe("turn-1");
    expect(harness.managerToolActivity).toEqual(["activate:manager-1:turn-1"]);
    expect(harness.coordinator.getActiveObservabilityRootTurnId("manager-1")).toBeUndefined();
    expect(harness.outputActivations.at(-1)).toEqual({
      beginUserVisibleObligation: false,
      target: undefined,
      turnId: undefined,
    });
    expect(harness.codexActivations.at(-1)).toEqual({
      gate: undefined,
      delegation: undefined,
      retryAuthorization: undefined,
    });
  });

  it("preserves no-echo fallback semantics and records observability after state callbacks", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "user_input",
      runtimeMessageText: "expected",
      assistantOutputTarget: webTarget,
    });

    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "different"),
    );

    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(1);
    expect(harness.coordinator.getActiveTurnId("manager-1")).toBeUndefined();
    expect(harness.outputActivations.at(-1)).toEqual({
      beginUserVisibleObligation: false,
      target: undefined,
      turnId: undefined,
    });

    harness.order.length = 0;
    harness.coordinator.afterRuntimeEventProjection(
      "manager-1",
      41,
      { type: "turn_end", toolResults: [] },
    );

    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(0);
    expect(harness.order).toEqual([
      "output:turn_end",
      "codex:turn_end",
      "observability:event",
    ]);
  });

  it("keeps a later queued input intact when the current provider turn ends", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "user_input",
      runtimeMessageText: "selected",
      assistantOutputTarget: webTarget,
    });
    await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "queued follow-up",
      assistantOutputTarget: { kind: "internal_only", reason: "follow-up" },
    });

    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "selected"),
    );
    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(1);

    harness.order.length = 0;
    harness.coordinator.afterRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_end", "assistant", "done"),
    );
    expect(harness.cleanFinals).toEqual([{
      pendingTargets: [{ kind: "internal_only", reason: "follow-up" }],
    }]);
    expect(harness.order).toEqual(["output:clean_final", "observability:event"]);

    harness.coordinator.afterRuntimeEventProjection(
      "manager-1",
      41,
      { type: "turn_end", toolResults: [] },
    );
    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(1);
  });

  it("does not consume queued input during repeated external provider cycles", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "agent_message",
      runtimeMessageText: "queued follow-up",
      assistantOutputTarget: { kind: "internal_only", reason: "follow-up" },
    });

    harness.coordinator.markProviderCycleActivated("manager-1");
    harness.coordinator.afterRuntimeEventProjection(
      "manager-1",
      41,
      { type: "turn_end", toolResults: [] },
    );
    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(1);

    harness.coordinator.afterRuntimeEventProjection(
      "manager-1",
      41,
      { type: "turn_end", toolResults: [] },
    );
    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(1);
  });

  it("resets manager tool activity on actual activation and terminal paths but not provider turn_end", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "user_input",
      runtimeMessageText: "task",
    });

    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "task"),
    );
    harness.coordinator.afterRuntimeEventProjection("manager-1", 41, { type: "turn_end", toolResults: [] });
    expect(harness.managerToolActivity).toEqual(["activate:manager-1:turn-1"]);

    harness.coordinator.afterRuntimeEventProjection("manager-1", 41, { type: "agent_end" });
    harness.coordinator.handleRuntimeError("manager-1");
    expect(harness.managerToolActivity).toEqual([
      "activate:manager-1:turn-1",
      "clear:manager-1",
      "clear:manager-1",
    ]);
  });

  it("applies agent-end cleanup before observability", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "project_agent_input",
      runtimeMessageText: "task",
      rootTurnId: "root-1",
      projectAgentContext: {
        fromAgentId: "project-agent-1",
        fromDisplayName: "Agent",
        external: true,
      },
      assistantOutputTarget: webTarget,
    });
    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "task"),
    );

    harness.order.length = 0;
    harness.coordinator.afterRuntimeEventProjection("manager-1", 41, { type: "agent_end" });

    expect(harness.coordinator.getActiveTurnId("manager-1")).toBeUndefined();
    expect(harness.coordinator.getActiveExternalProjectAgentTurn("manager-1")).toBeUndefined();
    expect(harness.coordinator.getActiveObservabilityRootTurnId("manager-1")).toBeUndefined();
    expect(harness.order).toEqual([
      "output:agent_end",
      "codex:agent_end",
      "observability:event",
    ]);

  });

  it("discards runtime-bound state while preserving external restrictions and trace ancestry until turn completion", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "project_agent_input",
      runtimeMessageText: "external task",
      rootTurnId: "root-1",
      parentRootTurnId: "parent-root",
      projectAgentContext: {
        fromAgentId: "project-agent-1",
        fromDisplayName: "External agent",
        external: true,
      },
      assistantOutputTarget: webTarget,
    });
    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "external task"),
    );

    harness.order.length = 0;
    harness.coordinator.discard("manager-1");

    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(0);
    expect(harness.coordinator.getActiveTurnId("manager-1")).toBeUndefined();
    expect(harness.coordinator.getActiveExternalProjectAgentTurn("manager-1")).toMatchObject({
      fromAgentId: "project-agent-1",
    });
    expect(harness.coordinator.getActiveObservabilityRootTurnId("manager-1")).toBe("parent-root");
    expect(harness.order).toEqual(["output:reset", "codex:reset"]);

    harness.coordinator.afterRuntimeEventProjection("manager-1", 41, { type: "agent_end" });
    expect(harness.coordinator.getActiveExternalProjectAgentTurn("manager-1")).toBeUndefined();
    expect(harness.coordinator.getActiveObservabilityRootTurnId("manager-1")).toBeUndefined();
  });

  it("fully clears retained external and observability state when an agent is permanently removed", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "project_agent_input",
      runtimeMessageText: "external task",
      rootTurnId: "root-1",
      projectAgentContext: {
        fromAgentId: "project-agent-1",
        fromDisplayName: "External agent",
        external: true,
      },
    });
    harness.coordinator.beforeRuntimeEventProjection(
      "manager-1",
      41,
      runtimeMessageEvent("message_start", "user", "external task"),
    );

    harness.coordinator.clearAgentState("manager-1");

    expect(harness.coordinator.getActiveExternalProjectAgentTurn("manager-1")).toBeUndefined();
    expect(harness.coordinator.getActiveObservabilityRootTurnId("manager-1")).toBeUndefined();
    expect(harness.coordinator.getActiveTurnId("manager-1")).toBeUndefined();
  });

  it("clears manager queue identity on runtime error before delegating concern-specific cleanup", async () => {
    const harness = createHarness();
    await harness.coordinator.enqueue("manager-1", {
      source: "user_input",
      runtimeMessageText: "in flight",
      assistantOutputTarget: webTarget,
    });
    harness.order.length = 0;

    harness.coordinator.handleRuntimeError("manager-1");

    expect(harness.coordinator.getPendingContextCount("manager-1")).toBe(0);
    expect(harness.coordinator.getActiveTurnId("manager-1")).toBeUndefined();
    expect(harness.order).toEqual(["output:error", "codex:error"]);
  });

  it("rejects enqueue for an unknown descriptor before minting a turn", async () => {
    const harness = createHarness();
    await expect(harness.coordinator.enqueue("missing", {
      source: "user_input",
    })).rejects.toThrow("Cannot mint turn id for unknown agent: missing");
    expect(harness.ledgerRecords).toEqual([]);
  });
});
