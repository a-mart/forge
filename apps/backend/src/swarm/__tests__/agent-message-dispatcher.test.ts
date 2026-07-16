import { describe, expect, it, vi } from "vitest";
import {
  AgentMessageDispatcher,
  type AgentMessageDispatcherOptions,
} from "../agent-message-dispatcher.js";
import { AssistantOutputRouter } from "../assistant-output-router.js";
import type { InboundTurnContextInput } from "../turn-context-coordinator.js";
import type {
  AgentDescriptor,
  AssistantOutputTarget,
  ManagerProfile,
  SendMessageReceipt,
  WorkerParentContext,
} from "../types.js";
import type { RuntimeUserMessage, SwarmAgentRuntime } from "../runtime-contracts.js";

type TestGate = { allowed: boolean };

const webTarget: AssistantOutputTarget = {
  kind: "session_transcript",
  channel: "web",
  sourceContext: { channel: "web", messageId: "user-a" },
};

function descriptor(
  agentId: string,
  role: AgentDescriptor["role"] = "manager",
  managerId = agentId,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role,
    managerId,
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    cwd: "/tmp",
    model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "none" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  };
}

function profile(): ManagerProfile {
  return {
    profileId: "profile-1",
    displayName: "Project",
    defaultSessionAgentId: "manager-1",
    defaultModel: { provider: "openai", modelId: "gpt-5", thinkingLevel: "none" },
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    profileType: "user",
  };
}

function parentContext(assignmentId = "assignment-1"): WorkerParentContext {
  return {
    schemaVersion: 1,
    assignmentId,
    managerId: "manager-1",
    assignedAt: "2026-07-16T01:00:00.000Z",
    outputTarget: webTarget,
    rootTurnId: "root-user-a",
  };
}

function createHarness() {
  const manager = descriptor("manager-1");
  const worker = descriptor("worker-1", "worker", manager.agentId);
  const descriptors = new Map<string, AgentDescriptor>([
    [manager.agentId, manager],
    [worker.agentId, worker],
  ]);
  const profiles = new Map<string, ManagerProfile>([["profile-1", profile()]]);
  const order: string[] = [];
  const runtimeInputs: Array<{
    targetAgentId: string;
    input: string | RuntimeUserMessage;
  }> = [];
  const queuedTurns: Array<{
    agentId: string;
    context: InboundTurnContextInput<TestGate>;
    turnId: string;
  }> = [];
  const ledgerPending: Array<Record<string, unknown>> = [];
  const ledgerAcked: Array<Record<string, unknown>> = [];
  let turnCounter = 0;
  let nonce = 0;
  let saveError: Error | undefined;
  let runtimeError: Error | undefined;
  let activeParent: ReturnType<
    AgentMessageDispatcherOptions<TestGate>["turns"]["getActiveWorkerParentContext"]
  > = {
    outputTarget: webTarget,
    rootTurnId: "root-user-a",
  };

  const output = new AssistantOutputRouter({
    descriptors,
    profiles,
    projection: {
      activateManagerAssistantOutputTurn: () => undefined,
      clearManagerAssistantOutputTurn: () => undefined,
    },
    markTurnActivatedExternally: () => undefined,
    emitConversationMessage: () => undefined,
    markSessionActivity: () => undefined,
    now: () => "2026-07-16T01:00:00.000Z",
    logDebug: () => undefined,
  });

  const options: AgentMessageDispatcherOptions<TestGate> = {
    descriptors,
    profiles,
    assertMutable: (value) => {
      if (value.archivedAt) throw new Error(`archived:${value.agentId}`);
    },
    attachments: {
      normalize: (attachments) => attachments ?? [],
      prepareRuntime: async () => ({ images: [], attachmentMessage: "" }),
    },
    turns: {
      enqueue: async (agentId, context) => {
        const turnId = `turn-${++turnCounter}`;
        order.push(`turn:${turnId}`);
        queuedTurns.push({ agentId, context, turnId });
        return {
          turnId,
          rollback: () => order.push(`rollback:${turnId}`),
        };
      },
      getActiveTurnId: () => "active-user-b",
      getActiveWorkerParentContext: () => activeParent,
      getActiveExternalProjectAgentTurn: () => undefined,
    },
    output,
    ledger: {
      hasSessionTarget: () => true,
      recordDeliveryPending: async (input) => {
        order.push("ledger:pending");
        ledgerPending.push(input);
      },
      recordDeliveryAcked: async (input) => {
        order.push("ledger:acked");
        ledgerAcked.push(input);
      },
    },
    observability: {
      getActiveRootTurnId: () => "root-user-a",
      beginRuntimeInput: (input) => ({ rootTurnId: `root-${input.target.agentId}`, targetAgentId: input.target.agentId }),
      completeRuntimeInput: () => undefined,
      cancelRuntimeInput: () => undefined,
      resolveParentTool: (input) => input,
      recordAgentDelivery: () => undefined,
    },
    plans: {
      resolveAssignment: async () => ({ planRunId: "plan-1", stepKey: "step-1", step: "Step" }),
      appendToManagerInput: async (_owner, text) => text,
      recordWorkerAssignment: async () => undefined,
    },
    goals: {
      appendToManagerInput: async (_owner, text) => text,
    },
    projectAgents: {
      authorizeExternalDelivery: async () => null,
      recordExternalContact: async () => undefined,
      assertRepoSourceAvailable: async () => undefined,
      rateLimitBuckets: new Map(),
    },
    codex: {
      assertWorkerDeliveryAllowed: () => undefined,
      buildProjectAgentTurnGate: () => ({ allowed: true }),
    },
    getOrCreateRuntime: async (target) => ({
      descriptor: target,
      sendMessage: vi.fn(async (input: string | RuntimeUserMessage) => {
        order.push("runtime:send");
        runtimeInputs.push({ targetAgentId: target.agentId, input });
        if (runtimeError) throw runtimeError;
        return {
          targetAgentId: target.agentId,
          deliveryId: `runtime-${runtimeInputs.length}`,
          acceptedMode: target.status === "streaming" ? "steer" : "prompt",
        } satisfies SendMessageReceipt;
      }),
    } as unknown as SwarmAgentRuntime),
    appendProjectAgentConversation: async () => undefined,
    emitAgentMessage: () => undefined,
    saveStore: async () => {
      order.push("store:save");
      if (saveError) throw saveError;
    },
    now: () => "2026-07-16T01:00:00.000Z",
    createDeliveryNonce: () => `nonce-${++nonce}`,
    logDebug: () => undefined,
  };

  return {
    dispatcher: new AgentMessageDispatcher(options),
    manager,
    worker,
    order,
    runtimeInputs,
    queuedTurns,
    ledgerPending,
    ledgerAcked,
    setActiveParent: (value: typeof activeParent) => { activeParent = value; },
    setRuntimeError: (value: Error | undefined) => { runtimeError = value; },
    setSaveError: (value: Error | undefined) => { saveError = value; },
  };
}

describe("AgentMessageDispatcher worker assignments and results", () => {
  it("persists a manager assignment with its parent route before starting the worker", async () => {
    const harness = createHarness();

    await harness.dispatcher.sendMessage("manager-1", "worker-1", "Do the work");

    expect(harness.worker.workerParentContext).toEqual({
      schemaVersion: 1,
      assignmentId: "assignment:worker-1:nonce-1",
      managerId: "manager-1",
      assignedAt: "2026-07-16T01:00:00.000Z",
      outputTarget: webTarget,
      rootTurnId: "root-user-a",
    });
    expect(harness.runtimeInputs).toEqual([{
      targetAgentId: "worker-1",
      input: "SYSTEM: Do the work",
    }]);
    expect(harness.order.indexOf("store:save")).toBeLessThan(harness.order.indexOf("runtime:send"));
    expect(harness.ledgerPending[0]).toMatchObject({ turnId: "turn-1" });
  });

  it("rolls back the durable parent context when worker dispatch fails", async () => {
    const harness = createHarness();
    harness.setRuntimeError(new Error("runtime rejected"));

    await expect(
      harness.dispatcher.sendMessage("manager-1", "worker-1", "Do the work"),
    ).rejects.toThrow("runtime rejected");

    expect(harness.worker.workerParentContext).toBeUndefined();
    expect(harness.order).toContain("rollback:turn-1");
    expect(harness.order.filter((entry) => entry === "store:save")).toHaveLength(2);
  });

  it("does not start a worker when its parent context cannot be persisted", async () => {
    const harness = createHarness();
    harness.setSaveError(new Error("disk unavailable"));

    await expect(
      harness.dispatcher.sendMessage("manager-1", "worker-1", "Do the work"),
    ).rejects.toThrow("disk unavailable");

    expect(harness.runtimeInputs).toHaveLength(0);
    expect(harness.worker.workerParentContext).toBeUndefined();
    expect(harness.order).toContain("rollback:turn-1");
  });

  it("preserves one parent context across steering messages in the same worker run", async () => {
    const harness = createHarness();
    const original = parentContext("assignment-original");
    harness.worker.workerParentContext = original;
    harness.worker.status = "streaming";

    await harness.dispatcher.sendMessage("manager-1", "worker-1", "Also check tests");

    expect(harness.worker.workerParentContext).toEqual(original);
    expect(harness.order).not.toContain("store:save");
    expect(harness.runtimeInputs).toHaveLength(1);
  });

  it("does not replace an undelivered parent when idle arrives before agent_end", async () => {
    const harness = createHarness();
    const original = parentContext("assignment-awaiting-agent-end");
    harness.worker.workerParentContext = original;
    harness.worker.status = "idle";

    await harness.dispatcher.sendMessage("manager-1", "worker-1", "Check one final detail");

    expect(harness.worker.workerParentContext).toEqual(original);
    expect(harness.order).not.toContain("store:save");
    expect(harness.runtimeInputs).toHaveLength(1);
  });

  it("returns one typed worker result, records its own queued turn, and clears the parent", async () => {
    const harness = createHarness();
    harness.worker.workerParentContext = parentContext();

    await harness.dispatcher.sendWorkerResult("worker-1", "status: done\nsummary: finished");

    const resultInput = harness.runtimeInputs[0]?.input;
    expect(resultInput).toBeTypeOf("string");
    expect(String(resultInput)).toContain('[workerResult] {"workerAgentId":"worker-1","assignmentId":"assignment-1"}');
    expect(String(resultInput)).toContain("status: done\nsummary: finished");
    expect(String(resultInput)).toContain('[assistantOutputTarget] {"kind":"session_transcript"');
    expect(harness.queuedTurns[0]).toMatchObject({
      agentId: "manager-1",
      turnId: "turn-1",
      context: {
        source: "worker_result",
        routeOrigin: "worker_result",
        sourceWorkerId: "worker-1",
        requiresVisibleResponse: false,
        assistantOutputTarget: webTarget,
      },
    });
    expect(harness.ledgerPending[0]).toMatchObject({
      turnId: "turn-1",
      message: "status: done\nsummary: finished",
    });
    expect(harness.ledgerPending[0]?.turnId).not.toBe("active-user-b");
    expect(harness.worker.workerParentContext).toBeUndefined();
  });

  it("can return a blocked result after the worker entered an error status", async () => {
    const harness = createHarness();
    harness.worker.status = "error";
    harness.worker.workerParentContext = parentContext();

    await expect(
      harness.dispatcher.sendWorkerResult("worker-1", "status: blocked\nsummary: failed"),
    ).resolves.toMatchObject({ targetAgentId: "manager-1" });
  });

  it("does not let workers recreate the old callback protocol", async () => {
    const harness = createHarness();

    await expect(
      harness.dispatcher.sendMessage("worker-1", "manager-1", "status: done"),
    ).rejects.toThrow("Workers return results through their final assistant output");
  });
});
