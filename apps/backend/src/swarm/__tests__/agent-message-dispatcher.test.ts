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
import type {
  RuntimeAcquisitionRequirements,
  RuntimeUserMessage,
  SwarmAgentRuntime,
} from "../runtime-contracts.js";
import { SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE } from "../secure-sessions/runtime/secure-runtime-binding.js";

type TestGate = { allowed: boolean };

const webTarget: AssistantOutputTarget = {
  kind: "session_transcript",
  channel: "web",
  sourceContext: { channel: "web", messageId: "user-a" },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
  const runtimeCreationOptions: Array<RuntimeAcquisitionRequirements | undefined> = [];
  const queuedTurns: Array<{
    agentId: string;
    context: InboundTurnContextInput<TestGate>;
    turnId: string;
  }> = [];
  const ledgerPending: Array<Record<string, unknown>> = [];
  const ledgerAcked: Array<Record<string, unknown>> = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const agentMessages: Array<Record<string, unknown>> = [];
  const observability: Array<Record<string, unknown>> = [];
  const debugLogs: Array<{ message: string; details?: unknown }> = [];
  const secureWorkerCalls: Array<{
    operation: string;
    workerAgentId: string;
    assignmentId?: string;
  }> = [];
  let turnCounter = 0;
  let nonce = 0;
  let saveError: Error | undefined;
  let runtimeError: Error | undefined;
  let runtimeCreationError: Error | undefined;
  let runtimeSendGate: Promise<void> | undefined;
  let runtimeCreationGate: Promise<void> | undefined;
  let ledgerPendingGate: Promise<void> | undefined;
  let secureWorkerPrepared = false;
  let secureRuntimeAvailable = true;
  let secureAssignmentAdvanceHook: (() => void) | undefined;
  let secureAssignmentAdvanceError: Error | undefined;
  let secureAssignmentAbortError: Error | undefined;
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
    emitConversationMessage: (event) => diagnostics.push(event),
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
        await ledgerPendingGate;
      },
      recordDeliveryAcked: async (input) => {
        order.push("ledger:acked");
        ledgerAcked.push(input);
      },
    },
    observability: {
      getActiveRootTurnId: () => "root-user-a",
      beginRuntimeInput: (input) => {
        observability.push({ kind: "begin", ...input });
        return { rootTurnId: `root-${input.target.agentId}`, targetAgentId: input.target.agentId };
      },
      completeRuntimeInput: (_handle, _receipt, metadata) => {
        observability.push({ kind: "complete", metadata });
      },
      cancelRuntimeInput: (_handle, reason) => {
        observability.push({ kind: "cancel", reason });
      },
      resolveParentTool: (input) => input,
      recordAgentDelivery: (input) => {
        observability.push({ kind: "delivery", ...input });
      },
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
    secureWorkers: {
      isTeamSecureMode: () => secureWorkerPrepared,
      prepareWorkerForSecureTeam: async (workerAgentId) => {
        if (secureWorkerPrepared) {
          order.push("secure:prepare");
        }
        secureWorkerCalls.push({
          operation: "prepare",
          workerAgentId,
        });
        return secureWorkerPrepared;
      },
      advanceWorkerSecureAssignment: async (
        workerAgentId,
        assignmentId,
      ) => {
        order.push("secure:advance");
        secureWorkerCalls.push({
          operation: "advance",
          workerAgentId,
          assignmentId,
        });
        if (secureAssignmentAdvanceError) {
          throw secureAssignmentAdvanceError;
        }
        secureAssignmentAdvanceHook?.();
      },
      abortWorkerSecureAssignment: async (
        workerAgentId,
        assignmentId,
      ) => {
        secureWorkerCalls.push({
          operation: "abort",
          workerAgentId,
          assignmentId,
        });
        if (secureAssignmentAbortError) {
          throw secureAssignmentAbortError;
        }
      },
      teardownWorkerSecurePrincipal: async (workerAgentId) => {
        secureWorkerCalls.push({
          operation: "teardown",
          workerAgentId,
        });
      },
    },
    getOrCreateRuntime: async (target, creationOptions) => {
      order.push("runtime:create");
      runtimeCreationOptions.push(creationOptions);
      await runtimeCreationGate;
      if (runtimeCreationError) throw runtimeCreationError;
      if (creationOptions?.secureRuntimeRequired && !secureRuntimeAvailable) {
        throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
      }
      return {
        descriptor: target,
        sendMessage: vi.fn(async (input: string | RuntimeUserMessage) => {
          order.push("runtime:send");
          runtimeInputs.push({ targetAgentId: target.agentId, input });
          await runtimeSendGate;
          if (runtimeError) throw runtimeError;
          return {
            targetAgentId: target.agentId,
            deliveryId: `runtime-${runtimeInputs.length}`,
            acceptedMode: target.status === "streaming" ? "steer" : "prompt",
          } satisfies SendMessageReceipt;
        }),
      } as unknown as SwarmAgentRuntime;
    },
    appendProjectAgentConversation: async () => undefined,
    emitAgentMessage: (event) => agentMessages.push(event),
    saveStore: async () => {
      order.push("store:save");
      if (saveError) throw saveError;
    },
    now: () => "2026-07-16T01:00:00.000Z",
    createDeliveryNonce: () => `nonce-${++nonce}`,
    logDebug: (message, details) => debugLogs.push({ message, details }),
  };

  return {
    dispatcher: new AgentMessageDispatcher(options),
    manager,
    worker,
    order,
    runtimeInputs,
    runtimeCreationOptions,
    queuedTurns,
    ledgerPending,
    ledgerAcked,
    diagnostics,
    agentMessages,
    observability,
    debugLogs,
    secureWorkerCalls,
    setActiveParent: (value: typeof activeParent) => { activeParent = value; },
    setRuntimeError: (value: Error | undefined) => { runtimeError = value; },
    setRuntimeCreationError: (value: Error | undefined) => {
      runtimeCreationError = value;
    },
    setRuntimeSendGate: (value: Promise<void> | undefined) => { runtimeSendGate = value; },
    setRuntimeCreationGate: (value: Promise<void> | undefined) => { runtimeCreationGate = value; },
    setLedgerPendingGate: (value: Promise<void> | undefined) => { ledgerPendingGate = value; },
    setSaveError: (value: Error | undefined) => { saveError = value; },
    setSecureWorkerPrepared: (value: boolean) => { secureWorkerPrepared = value; },
    setSecureRuntimeAvailable: (value: boolean) => { secureRuntimeAvailable = value; },
    setSecureAssignmentAdvanceHook: (value: (() => void) | undefined) => {
      secureAssignmentAdvanceHook = value;
    },
    setSecureAssignmentAdvanceError: (value: Error | undefined) => {
      secureAssignmentAdvanceError = value;
    },
    setSecureAssignmentAbortError: (value: Error | undefined) => {
      secureAssignmentAbortError = value;
    },
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

  it("rejects required secure reassignment before persistence or delivery", async () => {
    const harness = createHarness();

    await expect(harness.dispatcher.sendMessage(
      "manager-1",
      "worker-1",
      "Use the granted SSH credential",
      "auto",
      { requiresSecureRuntime: true },
    )).rejects.toThrow(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);

    expect(harness.secureWorkerCalls).toEqual([
      { operation: "prepare", workerAgentId: "worker-1" },
    ]);
    expect(harness.worker.workerParentContext).toBeUndefined();
    expect(harness.runtimeCreationOptions).toEqual([]);
    expect(harness.runtimeInputs).toEqual([]);
    expect(harness.ledgerPending).toEqual([]);
  });

  it("prepares a secure worker before runtime creation and advances the persisted assignment before send", async () => {
    const harness = createHarness();
    harness.setSecureWorkerPrepared(true);

    await harness.dispatcher.sendMessage(
      "manager-1",
      "worker-1",
      "Do secure work",
    );

    expect(harness.secureWorkerCalls).toEqual([
      { operation: "prepare", workerAgentId: "worker-1" },
      {
        operation: "advance",
        workerAgentId: "worker-1",
        assignmentId: "assignment:worker-1:nonce-1",
      },
    ]);
    expect(harness.order.indexOf("secure:prepare")).toBeLessThan(
      harness.order.indexOf("secure:advance"),
    );
    expect(harness.order.indexOf("secure:advance")).toBeLessThan(
      harness.order.indexOf("runtime:create"),
    );
    expect(harness.order.indexOf("runtime:create")).toBeLessThan(
      harness.order.indexOf("runtime:send"),
    );
    expect(harness.runtimeCreationOptions).toEqual([
      { secureRuntimeRequired: true },
    ]);
    expect(harness.runtimeInputs).toHaveLength(1);
  });

  it("fails closed when secure team authority ends before runtime creation", async () => {
    const harness = createHarness();
    harness.setSecureWorkerPrepared(true);
    harness.setSecureAssignmentAdvanceHook(() => {
      harness.setSecureRuntimeAvailable(false);
    });

    await expect(
      harness.dispatcher.sendMessage(
        "manager-1",
        "worker-1",
        "Do secure work",
      ),
    ).rejects.toThrow(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);

    expect(harness.runtimeCreationOptions).toEqual([
      { secureRuntimeRequired: true },
    ]);
    expect(harness.runtimeInputs).toHaveLength(0);
    expect(harness.secureWorkerCalls).toContainEqual({
      operation: "abort",
      workerAgentId: "worker-1",
      assignmentId: "assignment:worker-1:nonce-1",
    });
  });

  it("aborts a newly prepared secure assignment when runtime creation fails", async () => {
    const harness = createHarness();
    harness.setSecureWorkerPrepared(true);
    harness.setRuntimeCreationError(new Error("runtime unavailable"));

    await expect(
      harness.dispatcher.sendMessage(
        "manager-1",
        "worker-1",
        "Do secure work",
      ),
    ).rejects.toThrow("runtime unavailable");

    expect(harness.secureWorkerCalls).toContainEqual({
      operation: "abort",
      workerAgentId: "worker-1",
      assignmentId: "assignment:worker-1:nonce-1",
    });
    expect(harness.worker.workerParentContext).toBeUndefined();
  });

  it("aborts a newly prepared secure assignment when its runtime delivery fails", async () => {
    const harness = createHarness();
    harness.setSecureWorkerPrepared(true);
    harness.setRuntimeError(new Error("runtime rejected"));

    await expect(
      harness.dispatcher.sendMessage(
        "manager-1",
        "worker-1",
        "Do secure work",
      ),
    ).rejects.toThrow("runtime rejected");

    expect(harness.secureWorkerCalls).toContainEqual({
      operation: "abort",
      workerAgentId: "worker-1",
      assignmentId: "assignment:worker-1:nonce-1",
    });
    expect(harness.secureWorkerCalls).not.toContainEqual({
      operation: "teardown",
      workerAgentId: "worker-1",
    });
  });

  it("fails closed when aborting a prepared secure assignment cannot be confirmed", async () => {
    const harness = createHarness();
    harness.setSecureWorkerPrepared(true);
    harness.setRuntimeError(new Error("runtime rejected"));
    harness.setSecureAssignmentAbortError(new Error("destroy unconfirmed"));

    await expect(
      harness.dispatcher.sendMessage(
        "manager-1",
        "worker-1",
        "Do secure work",
      ),
    ).rejects.toThrow("secure_worker_assignment_abort_failed");
  });

  it("keeps a contextless Builder assignment on the web transcript", async () => {
    const harness = createHarness();
    harness.setActiveParent(undefined);

    await harness.dispatcher.sendMessage("manager-1", "worker-1", "Do the work");

    expect(harness.worker.workerParentContext).toEqual({
      schemaVersion: 1,
      assignmentId: "assignment:worker-1:nonce-1",
      managerId: "manager-1",
      assignedAt: "2026-07-16T01:00:00.000Z",
      outputTarget: {
        kind: "session_transcript",
        channel: "web",
        sourceContext: { channel: "web" },
      },
    });
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

    await harness.dispatcher.sendWorkerResult(
      "worker-1",
      "status: done\nsummary: finished",
      "assignment-1",
    );

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
      assignmentId: "assignment-1",
    });
    expect(harness.ledgerPending[0]?.turnId).not.toBe("active-user-b");
    expect(harness.worker.workerParentContext).toBeUndefined();
  });

  it("settles recovered retired-channel results before runtime, ledger, observability, logs, or content projection", async () => {
    const harness = createHarness();
    harness.worker.workerParentContext = {
      ...parentContext("assignment-retired"),
      outputTarget: {
        kind: "external_channel",
        sourceContext: {
          channel: "telegram",
          channelId: "retired-sensitive-chat",
          userId: "retired-sensitive-user",
          threadTs: "retired-sensitive-thread",
          integrationProfileId: "retired-sensitive-profile",
        },
      },
    };

    const receipt = await harness.dispatcher.sendWorkerResult(
      "worker-1",
      "retired-sensitive-result-content",
      "assignment-retired",
    );

    expect(receipt).toEqual({
      targetAgentId: "manager-1",
      deliveryId: "retired-worker-result-discarded",
      acceptedMode: "prompt",
    });
    expect(harness.worker.workerParentContext).toBeUndefined();
    expect(harness.order).toEqual(["store:save"]);
    expect(harness.runtimeInputs).toEqual([]);
    expect(harness.queuedTurns).toEqual([]);
    expect(harness.ledgerPending).toEqual([]);
    expect(harness.ledgerAcked).toEqual([]);
    expect(harness.observability).toEqual([]);
    expect(harness.agentMessages).toEqual([]);
    expect(harness.debugLogs).toEqual([]);
    expect(harness.diagnostics).toEqual([{
      type: "conversation_message",
      agentId: "manager-1",
      role: "system",
      text: "retired_external_channel",
      timestamp: "2026-07-16T01:00:00.000Z",
      source: "worker_report",
      excludeFromModelContext: true,
    }]);
    const exposed = JSON.stringify({
      diagnostics: harness.diagnostics,
      runtimeInputs: harness.runtimeInputs,
      queuedTurns: harness.queuedTurns,
      ledgerPending: harness.ledgerPending,
      observability: harness.observability,
      agentMessages: harness.agentMessages,
      debugLogs: harness.debugLogs,
    });
    for (const sensitive of [
      "retired-sensitive-result-content",
      "retired-sensitive-chat",
      "retired-sensitive-user",
      "retired-sensitive-thread",
      "retired-sensitive-profile",
      "telegram",
    ]) {
      expect(exposed).not.toContain(sensitive);
    }
  });

  it("makes a repaired legacy worker result eligible to activate the manager turn", async () => {
    const harness = createHarness();
    harness.worker.workerParentContext = {
      ...parentContext(),
      outputTarget: { kind: "internal_only", reason: "no_active_parent" },
    };

    await harness.dispatcher.sendWorkerResult(
      "worker-1",
      "status: done\nsummary: recovered",
      "assignment-1",
    );

    expect(harness.queuedTurns[0]?.context).toMatchObject({
      source: "worker_result",
      activationEligible: true,
      assistantOutputTarget: {
        kind: "session_transcript",
        channel: "web",
        sourceContext: { channel: "web" },
      },
    });
  });

  it("coalesces concurrent delivery attempts for the same worker assignment", async () => {
    const harness = createHarness();
    const sendGate = deferred();
    harness.worker.workerParentContext = parentContext();
    harness.setRuntimeSendGate(sendGate.promise);

    const first = harness.dispatcher.sendWorkerResult(
      "worker-1",
      "status: done\nsummary: finished",
      "assignment-1",
    );
    await vi.waitFor(() => expect(harness.runtimeInputs).toHaveLength(1));
    const second = harness.dispatcher.sendWorkerResult(
      "worker-1",
      "status: done\nsummary: finished",
      "assignment-1",
    );

    expect(second).toBe(first);
    expect(harness.runtimeInputs).toHaveLength(1);
    sendGate.resolve();
    await Promise.all([first, second]);

    expect(harness.runtimeInputs).toHaveLength(1);
    expect(harness.ledgerPending).toHaveLength(1);
    expect(harness.ledgerAcked).toHaveLength(1);
  });

  it("does not dispatch a follow-up after that assignment completes while its ledger write is pending", async () => {
    const harness = createHarness();
    const ledgerGate = deferred();
    harness.worker.workerParentContext = parentContext("assignment-original");
    harness.worker.status = "streaming";
    harness.setLedgerPendingGate(ledgerGate.promise);

    const delivery = harness.dispatcher.sendMessage(
      "manager-1",
      "worker-1",
      "Also check the final edge case",
    );
    await vi.waitFor(() => expect(harness.ledgerPending).toHaveLength(1));
    harness.worker.workerParentContext.completedAt = "2026-07-16T01:01:00.000Z";
    ledgerGate.resolve();

    await expect(delivery).rejects.toThrow("completed its assignment before this message could be dispatched");
    expect(harness.runtimeInputs).toHaveLength(0);
    expect(harness.ledgerAcked).toHaveLength(1);
    expect(harness.order).toContain("rollback:turn-1");
  });

  it("does not turn a follow-up into a new assignment when completion clears the old assignment during setup", async () => {
    const harness = createHarness();
    const runtimeGate = deferred();
    harness.worker.workerParentContext = parentContext("assignment-original");
    harness.worker.status = "streaming";
    harness.setRuntimeCreationGate(runtimeGate.promise);

    const delivery = harness.dispatcher.sendMessage(
      "manager-1",
      "worker-1",
      "Also check the final edge case",
    );
    await vi.waitFor(() => expect(harness.order).toContain("runtime:create"));
    delete harness.worker.workerParentContext;
    runtimeGate.resolve();

    await expect(delivery).rejects.toThrow("assignment changed before this message could be dispatched");
    expect(harness.worker.workerParentContext).toBeUndefined();
    expect(harness.runtimeInputs).toHaveLength(0);
    expect(harness.ledgerPending).toHaveLength(0);
    expect(harness.order).toContain("rollback:turn-1");
  });

  it("can return a blocked result after the worker entered an error status", async () => {
    const harness = createHarness();
    harness.worker.status = "error";
    harness.worker.workerParentContext = parentContext();

    await expect(
      harness.dispatcher.sendWorkerResult(
        "worker-1",
        "status: blocked\nsummary: failed",
        "assignment-1",
      ),
    ).resolves.toMatchObject({ targetAgentId: "manager-1" });
  });

  it("does not reuse a worker while its completed result is awaiting delivery", async () => {
    const harness = createHarness();
    harness.worker.workerParentContext = {
      ...parentContext("assignment-awaiting-delivery"),
      completedAt: "2026-07-16T01:01:00.000Z",
    };

    await expect(
      harness.dispatcher.sendMessage("manager-1", "worker-1", "Start different work"),
    ).rejects.toThrow("waiting for result delivery");

    expect(harness.runtimeInputs).toHaveLength(0);
  });

  it("does not let workers recreate the old callback protocol", async () => {
    const harness = createHarness();

    await expect(
      harness.dispatcher.sendMessage("worker-1", "manager-1", "status: done"),
    ).rejects.toThrow("Workers return results through their final assistant output");
  });
});
