import { describe, expect, it, vi } from "vitest";
import {
  AgentMessageDispatcher,
  type AgentMessageDispatcherOptions,
} from "../agent-message-dispatcher.js";
import { AssistantOutputRouter } from "../assistant-output-router.js";
import type { InboundTurnContextInput } from "../turn-context-coordinator.js";
import type {
  AgentDescriptor,
  AgentMessageEvent,
  ConversationAttachment,
  ManagerProfile,
  SendMessageReceipt,
} from "../types.js";
import type { RuntimeUserMessage, SwarmAgentRuntime } from "../runtime-contracts.js";

type TestGate = { allowed: boolean };

const acceptedReceipt: SendMessageReceipt = {
  targetAgentId: "target",
  deliveryId: "delivery-1",
  acceptedMode: "prompt",
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
    profileId: role === "manager" ? "profile-1" : undefined,
    status: "idle",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    cwd: "/tmp",
    model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "none" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  };
}

function profile(profileId: string, displayName = profileId): ManagerProfile {
  return {
    profileId,
    displayName,
    defaultSessionAgentId: `${profileId}-default`,
    defaultModel: { provider: "openai", modelId: "gpt-5", thinkingLevel: "none" },
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    profileType: "user",
  };
}

function createHarness() {
  const order: string[] = [];
  const manager = descriptor("manager-1");
  const worker = descriptor("worker-1", "worker", manager.agentId);
  const peer = descriptor("manager-2", "manager", "manager-2");
  const projectAgent = descriptor("project-agent-1", "manager", "project-agent-1", {
    projectAgent: { handle: "project-agent", whenToUse: "testing" },
  });
  const descriptors = new Map<string, AgentDescriptor>([
    [manager.agentId, manager],
    [worker.agentId, worker],
    [peer.agentId, peer],
    [projectAgent.agentId, projectAgent],
  ]);
  const profiles = new Map<string, ManagerProfile>([
    ["profile-1", profile("profile-1", "Project One")],
    ["profile-2", profile("profile-2", "Project Two")],
  ]);
  const turnContexts: Array<{
    agentId: string;
    context: InboundTurnContextInput<TestGate>;
  }> = [];
  const rollbacks: string[] = [];
  const ledgerPending: Array<Record<string, unknown>> = [];
  const ledgerAcked: Array<Record<string, unknown>> = [];
  const observedInputs: Array<Record<string, unknown>> = [];
  const observedDeliveries: Array<Record<string, unknown>> = [];
  const observedCancellations: string[] = [];
  const planAssignments: Array<Record<string, unknown>> = [];
  const projectConversations: Array<Record<string, unknown>> = [];
  const emitted: AgentMessageEvent[] = [];
  const logs: Array<{ message: string; details?: unknown }> = [];
  const contacts: Array<[string, string, string]> = [];
  const repoAssertions: string[] = [];
  const activeExternalTurns = new Map<string, { fromAgentId: string; fromDisplayName: string }>();
  const activeTurnIds = new Map<string, string>();
  const runtimeInputs: Array<{ input: string | RuntimeUserMessage; delivery?: string }> = [];
  let runtimeError: Error | undefined;
  let pendingLedgerError: Error | undefined;
  let ackLedgerError: Error | undefined;
  let externalAuthorization: Awaited<ReturnType<
    AgentMessageDispatcherOptions<TestGate>["projectAgents"]["authorizeExternalDelivery"]
  >> = null;
  let watchdogTurnSeq: number | undefined;
  let observabilityEnabled = true;
  let runtimeAttachmentMessage = "";
  let runtimeImages: NonNullable<RuntimeUserMessage["images"]> = [];
  let appendPlanContext = false;
  let deliveryNonce = 0;

  const runtime = {
    descriptor: worker,
    sendMessage: vi.fn(async (input: string | RuntimeUserMessage, delivery?: string) => {
      order.push("runtime:send");
      runtimeInputs.push({ input, delivery });
      if (runtimeError) throw runtimeError;
      return acceptedReceipt;
    }),
  } as unknown as SwarmAgentRuntime;

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
    now: () => "2026-07-13T12:00:00.000Z",
    logDebug: () => undefined,
  });
  const prepareOutput = output.prepareAgentMessage.bind(output);
  vi.spyOn(output, "prepareAgentMessage").mockImplementation((input) => {
    order.push("output:prepare");
    return prepareOutput(input);
  });
  const commitOutput = output.recordSuccessfulAgentMessageDispatch.bind(output);
  vi.spyOn(output, "recordSuccessfulAgentMessageDispatch").mockImplementation((input) => {
    order.push("output:commit");
    commitOutput(input);
  });

  const options: AgentMessageDispatcherOptions<TestGate> = {
    descriptors,
    profiles,
    assertMutable: (value) => {
      order.push(`mutable:${value.agentId}`);
      if (value.archivedAt) throw new Error(`archived:${value.agentId}`);
    },
    attachments: {
      normalize: (attachments) => {
        order.push("attachments:normalize");
        return attachments ?? [];
      },
      prepareRuntime: async () => {
        order.push("attachments:prepare");
        return { images: runtimeImages, attachmentMessage: runtimeAttachmentMessage };
      },
    },
    turns: {
      enqueue: async (agentId, context) => {
        order.push("turn:enqueue");
        turnContexts.push({ agentId, context });
        activeTurnIds.set(agentId, `turn-${turnContexts.length}`);
        return {
          turnId: `turn-${turnContexts.length}`,
          rollback: () => {
            order.push("turn:rollback");
            rollbacks.push(agentId);
          },
        };
      },
      getActiveTurnId: (agentId) => {
        order.push("turn:get-active");
        return activeTurnIds.get(agentId);
      },
      getActiveExternalProjectAgentTurn: (agentId) => activeExternalTurns.get(agentId),
    },
    output,
    ledger: {
      hasSessionTarget: () => {
        order.push("ledger:has-target");
        return true;
      },
      recordDeliveryPending: async (input) => {
        order.push("ledger:pending");
        ledgerPending.push(input);
        if (pendingLedgerError) throw pendingLedgerError;
      },
      recordDeliveryAcked: async (input) => {
        order.push("ledger:acked");
        ledgerAcked.push(input);
        if (ackLedgerError) throw ackLedgerError;
      },
    },
    workerHealth: {
      getWorkerReportDispatchTurnSeq: () => {
        order.push("health:get-seq");
        return watchdogTurnSeq;
      },
      markPendingWorkerReportDispatch: () => {
        order.push("health:pending");
      },
      handleFailedWorkerReportDispatch: async () => {
        order.push("health:failed");
      },
      handleSuccessfulWorkerReportDispatch: async () => {
        order.push("health:succeeded");
      },
    },
    observability: {
      getActiveRootTurnId: () => {
        order.push("observability:get-root");
        return "parent-root";
      },
      beginRuntimeInput: (input) => {
        order.push("observability:begin");
        observedInputs.push(input);
        return observabilityEnabled
          ? { rootTurnId: "root-1", targetAgentId: input.target.agentId }
          : undefined;
      },
      completeRuntimeInput: (_handle, _receipt, metadata) => {
        order.push("observability:complete");
        observedInputs.push({ completion: metadata });
      },
      cancelRuntimeInput: (_handle, reason) => {
        order.push("observability:cancel");
        observedCancellations.push(reason);
      },
      resolveParentTool: (input) => {
        order.push("observability:parent-tool");
        return input;
      },
      recordAgentDelivery: (input) => {
        order.push("observability:delivery");
        observedDeliveries.push(input);
      },
    },
    plans: {
      resolveAssignment: async (_owner, requestedStep) => {
        order.push("plans:resolve");
        return { planRunId: "plan-1", stepKey: "step-1", step: requestedStep };
      },
      appendToManagerInput: async (_owner, text) => {
        order.push("plans:append");
        return appendPlanContext ? `${text}\n\n[plan]` : text;
      },
      recordWorkerAssignment: async (_owner, _assignment, input) => {
        order.push("plans:record");
        planAssignments.push(input);
      },
    },
    projectAgents: {
      authorizeExternalDelivery: async () => {
        order.push("project:authorize-external");
        return externalAuthorization;
      },
      recordExternalContact: async (...input) => {
        order.push("project:record-contact");
        contacts.push(input);
      },
      assertRepoSourceAvailable: async (value) => {
        order.push("project:assert-repo");
        repoAssertions.push(value.agentId);
      },
      rateLimitBuckets: new Map(),
    },
    codex: {
      assertWorkerDeliveryAllowed: () => {
        order.push("codex:assert-delivery");
      },
      buildProjectAgentTurnGate: () => {
        order.push("codex:build-gate");
        return { allowed: false };
      },
    },
    getOrCreateRuntime: async () => {
      order.push("runtime:get");
      return runtime;
    },
    appendProjectAgentConversation: async (target, payload) => {
      order.push("conversation:append-project");
      projectConversations.push({ target, payload });
    },
    emitAgentMessage: (event) => {
      order.push("event:agent-message");
      emitted.push(event);
    },
    now: () => "2026-07-13T12:00:00.000Z",
    createDeliveryNonce: () => `nonce-${++deliveryNonce}`,
    logDebug: (message, details) => {
      order.push(`log:${message}`);
      logs.push({ message, details });
    },
  };
  const dispatcher = new AgentMessageDispatcher(options);

  return {
    dispatcher,
    options,
    output,
    manager,
    worker,
    peer,
    projectAgent,
    descriptors,
    profiles,
    order,
    turnContexts,
    rollbacks,
    ledgerPending,
    ledgerAcked,
    observedInputs,
    observedDeliveries,
    observedCancellations,
    planAssignments,
    projectConversations,
    emitted,
    logs,
    contacts,
    repoAssertions,
    activeExternalTurns,
    runtimeInputs,
    setRuntimeError: (error: Error | undefined) => { runtimeError = error; },
    setPendingLedgerError: (error: Error | undefined) => { pendingLedgerError = error; },
    setAckLedgerError: (error: Error | undefined) => { ackLedgerError = error; },
    setExternalAuthorization: (value: typeof externalAuthorization) => { externalAuthorization = value; },
    setWatchdogTurnSeq: (value: number | undefined) => { watchdogTurnSeq = value; },
    setObservabilityEnabled: (value: boolean) => { observabilityEnabled = value; },
    setRuntimeAttachments: (
      attachmentMessage: string,
      images: NonNullable<RuntimeUserMessage["images"]> = [],
    ) => {
      runtimeAttachmentMessage = attachmentMessage;
      runtimeImages = images;
    },
    setAppendPlanContext: (value: boolean) => { appendPlanContext = value; },
  };
}

describe("AgentMessageDispatcher", () => {
  it("runs the normal accepted-dispatch transaction in the preserved order", async () => {
    const harness = createHarness();
    const receipt = await harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.worker.agentId,
      "implement this",
      "followUp",
    );

    expect(receipt).toBe(acceptedReceipt);
    expect(harness.order).toEqual([
      "mutable:manager-1",
      "mutable:worker-1",
      "codex:assert-delivery",
      "attachments:normalize",
      "runtime:get",
      "health:get-seq",
      "attachments:prepare",
      "output:prepare",
      "health:pending",
      "observability:get-root",
      "observability:begin",
      "turn:enqueue",
      "turn:get-active",
      "ledger:has-target",
      "ledger:pending",
      "runtime:send",
      "health:succeeded",
      "output:commit",
      "ledger:acked",
      "observability:complete",
      "observability:parent-tool",
      "observability:delivery",
      "log:agent:send_message",
      "event:agent-message",
    ]);
    expect(harness.runtimeInputs).toEqual([{
      input: "SYSTEM: implement this",
      delivery: "followUp",
    }]);
    expect(harness.turnContexts[0]).toMatchObject({
      agentId: "worker-1",
      context: {
        source: "agent_message",
        routeOrigin: "internal",
        runtimeMessageText: "SYSTEM: implement this",
        activationEligible: false,
      },
    });
    expect(harness.ledgerPending[0]).toMatchObject({
      sessionAgentId: "worker-1",
      turnId: "turn-1",
      deliveryId: "worker-report:manager-1:unknown:turn-1:nonce-1",
      fromAgentId: "manager-1",
      targetAgentId: "worker-1",
      message: "implement this",
    });
    expect(harness.ledgerAcked[0]).toMatchObject({
      deliveryId: "worker-report:manager-1:unknown:turn-1:nonce-1",
    });
    expect(harness.emitted).toEqual([expect.objectContaining({
      agentId: "manager-1",
      fromAgentId: "manager-1",
      toAgentId: "worker-1",
      acceptedMode: "prompt",
    })]);
  });

  it("mints a unique delivery id for repeated sends in the same active turn", async () => {
    const harness = createHarness();
    harness.options.turns.getActiveTurnId = () => "shared-turn";

    await harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.worker.agentId,
      "first",
    );
    await harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.worker.agentId,
      "second",
    );

    expect(harness.ledgerPending.map((entry) => entry.deliveryId)).toEqual([
      "worker-report:manager-1:unknown:shared-turn:nonce-1",
      "worker-report:manager-1:unknown:shared-turn:nonce-2",
    ]);
    expect(harness.ledgerAcked.map((entry) => entry.deliveryId)).toEqual(
      harness.ledgerPending.map((entry) => entry.deliveryId),
    );
  });

  it("rolls back turn and observability before completing failed worker health", async () => {
    const harness = createHarness();
    harness.setRuntimeError(new Error("provider failed"));
    harness.setWatchdogTurnSeq(7);

    await expect(harness.dispatcher.sendMessage(
      harness.worker.agentId,
      harness.manager.agentId,
      "status: done",
    )).rejects.toThrow("provider failed");

    const failureOrder = harness.order.filter((entry) => [
      "ledger:pending",
      "runtime:send",
      "turn:rollback",
      "observability:cancel",
      "health:failed",
    ].includes(entry));
    expect(failureOrder).toEqual([
      "ledger:pending",
      "runtime:send",
      "turn:rollback",
      "observability:cancel",
      "health:failed",
    ]);
    expect(harness.rollbacks).toEqual(["manager-1"]);
    expect(harness.observedCancellations).toEqual(["runtime_send_message_failed"]);
    expect(harness.ledgerAcked).toEqual([]);
    expect(harness.observedDeliveries).toEqual([]);
    expect(harness.emitted).toEqual([]);
  });

  it("keeps delivery-ledger writes fail-open on both sides of runtime acceptance", async () => {
    const harness = createHarness();
    harness.setPendingLedgerError(new Error("pending unavailable"));
    harness.setAckLedgerError(new Error("ack unavailable"));

    await expect(harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.worker.agentId,
      "work",
    )).resolves.toBe(acceptedReceipt);

    expect(harness.runtimeInputs).toHaveLength(1);
    expect(harness.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "turn_ledger:delivery_pending:error" }),
      expect.objectContaining({ message: "turn_ledger:delivery_acked:error" }),
      expect.objectContaining({ message: "agent:send_message" }),
    ]));
  });

  it("lets output and health owners characterize an owned worker report", async () => {
    const harness = createHarness();
    harness.setWatchdogTurnSeq(9);
    harness.output.activateManagerTurn(harness.manager.agentId, {
      target: { kind: "session_transcript", channel: "web", sourceContext: { channel: "web" } },
      routeContext: { origin: "user", requiresVisibleResponse: true },
      beginUserVisibleObligation: true,
    });
    harness.output.recordSuccessfulAgentMessageDispatch({
      sender: harness.manager,
      target: harness.worker,
      modelMessage: "task",
    });
    harness.order.length = 0;

    await harness.dispatcher.sendMessage(
      harness.worker.agentId,
      harness.manager.agentId,
      "status: done\nsummary: complete",
    );

    expect(harness.runtimeInputs[0]?.input).toContain("WORKER REPORT: status: done");
    expect(harness.turnContexts[0]?.context).toMatchObject({
      routeOrigin: "terminal_worker_report",
      workerReportSourceAgentId: "worker-1",
      normalBuilderWorkerCallback: true,
      requiresVisibleResponse: false,
      assistantOutputTarget: {
        kind: "internal_only",
        reason: "worker_report_callback",
      },
    });
    expect(harness.output.getInheritedTarget("worker-1")).toBeUndefined();
  });

  it("prepares runtime attachment text, images, and manager plan context before output routing", async () => {
    const harness = createHarness();
    harness.setRuntimeAttachments(
      "The user attached a file.",
      [{ mimeType: "image/png", data: "base64" }],
    );
    harness.setAppendPlanContext(true);
    const attachment: ConversationAttachment = {
      type: "image",
      mimeType: "image/png",
      data: "base64",
    };

    await harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.manager.agentId,
      "review",
      "auto",
      { attachments: [attachment] },
    );

    expect(harness.runtimeInputs[0]?.input).toMatchObject({
      images: [{ mimeType: "image/png", data: "base64" }],
    });
    const text = (harness.runtimeInputs[0]?.input as RuntimeUserMessage).text;
    expect(text).toContain("SYSTEM: review");
    expect(text).toContain("The user attached a file.\n\n[plan]");
    expect(text).toContain("[assistantOutputTarget]");
    expect(harness.order.indexOf("plans:append")).toBeLessThan(harness.order.indexOf("output:prepare"));
  });

  it("resolves and records plan assignment around, not inside, runtime acceptance", async () => {
    const harness = createHarness();
    await harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.worker.agentId,
      "work",
      "auto",
      { planStep: "Implement API", planAssignmentSource: "spawn_agent" },
    );

    expect(harness.order.indexOf("plans:resolve")).toBeLessThan(harness.order.indexOf("codex:assert-delivery"));
    expect(harness.order.indexOf("plans:record")).toBeGreaterThan(harness.order.indexOf("observability:delivery"));
    expect(harness.planAssignments).toEqual([{
      workerId: "worker-1",
      source: "spawn_agent",
      deliveryId: "delivery-1",
      acceptedMode: "prompt",
    }]);
  });

  it("runs a local project-agent delivery as a distinct accepted transaction", async () => {
    const harness = createHarness();
    const receipt = await harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.projectAgent.agentId,
      "peer request",
      "steer",
    );

    expect(receipt).toBe(acceptedReceipt);
    const relevantOrder = harness.order.filter((entry) => [
      "plans:append",
      "observability:get-root",
      "observability:begin",
      "codex:build-gate",
      "turn:enqueue",
      "runtime:get",
      "runtime:send",
      "observability:complete",
      "observability:delivery",
      "conversation:append-project",
      "event:agent-message",
    ].includes(entry));
    expect(relevantOrder).toEqual([
      "plans:append",
      "observability:get-root",
      "observability:begin",
      "codex:build-gate",
      "turn:enqueue",
      "runtime:get",
      "runtime:send",
      "observability:complete",
      "observability:delivery",
      "conversation:append-project",
      "event:agent-message",
    ]);
    expect(harness.turnContexts[0]?.context).toMatchObject({
      source: "project_agent_input",
      assistantOutputTarget: { kind: "peer_agent", fromAgentId: "manager-1" },
      codexMcpToolGate: { allowed: false },
      projectAgentContext: {
        fromAgentId: "manager-1",
        external: false,
        fromProfileId: "profile-1",
        fromProjectName: "Project One",
      },
    });
    expect(harness.projectConversations).toHaveLength(1);
    expect(harness.emitted).toEqual([expect.objectContaining({
      agentId: "manager-1",
      projectAgentExchange: true,
    })]);
    expect(harness.ledgerPending).toEqual([]);
  });

  it("rolls back only the queued project-agent turn when its runtime rejects", async () => {
    const harness = createHarness();
    harness.setRuntimeError(new Error("project provider failed"));

    await expect(harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.projectAgent.agentId,
      "peer request",
    )).rejects.toThrow("project provider failed");

    expect(harness.order.slice(-4)).toEqual([
      "runtime:get",
      "runtime:send",
      "turn:rollback",
      "observability:cancel",
    ]);
    expect(harness.observedCancellations).toEqual(["project_agent_dispatch_failed"]);
    expect(harness.projectConversations).toEqual([]);
  });

  it("rejects project-agent attachments before plan, observability, turn, or runtime side effects", async () => {
    const harness = createHarness();
    await expect(harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.projectAgent.agentId,
      "peer request",
      "auto",
      { attachments: [{ type: "text", mimeType: "text/plain", text: "data" }] },
    )).rejects.toThrow("Project-agent deliveries do not support attachments.");

    expect(harness.order).not.toContain("plans:append");
    expect(harness.order).not.toContain("observability:begin");
    expect(harness.order).not.toContain("turn:enqueue");
    expect(harness.order).not.toContain("runtime:get");
  });

  it("authorizes repo-backed external project agents and records grant contact after projection", async () => {
    const harness = createHarness();
    const externalSender = descriptor("external-manager", "manager", "external-manager", {
      profileId: "profile-2",
    });
    harness.descriptors.set(externalSender.agentId, externalSender);
    harness.projectAgent.projectAgent = {
      handle: "project-agent",
      whenToUse: "testing",
      source: {
        type: "repo",
        workspaceKey: "workspace",
        forgeDirRealpath: "/tmp/repo/.forge",
        definitionId: "project-agent",
        activatedAt: "2026-07-13T00:00:00.000Z",
      },
    };
    harness.setExternalAuthorization({
      grantId: "grant-1",
      mode: "grant",
      sourceAgentId: harness.projectAgent.agentId,
      sourceProfileId: "profile-1",
      targetProfileId: "profile-2",
    });

    await harness.dispatcher.sendMessage(
      externalSender.agentId,
      harness.projectAgent.agentId,
      "external request",
    );

    expect(harness.repoAssertions).toEqual(["project-agent-1"]);
    expect(harness.contacts).toEqual([[
      "project-agent-1",
      "profile-2",
      "external-manager",
    ]]);
    expect(harness.order.indexOf("conversation:append-project")).toBeLessThan(
      harness.order.indexOf("project:record-contact"),
    );
  });

  it("honors external-turn reply restriction before project authorization or runtime creation", async () => {
    const harness = createHarness();
    harness.activeExternalTurns.set(harness.manager.agentId, {
      fromAgentId: "project-agent-1",
      fromDisplayName: "External Agent",
    });

    await expect(harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.worker.agentId,
      "wrong target",
    )).rejects.toThrow("restricted to a direct reply back to External Agent");
    expect(harness.order).not.toContain("runtime:get");
    expect(harness.order).not.toContain("project:authorize-external");
  });

  it("preserves sender, target, ownership, archive, and plan-step validation messages", async () => {
    const harness = createHarness();
    await expect(harness.dispatcher.sendMessage("missing", "worker-1", "x"))
      .rejects.toThrow("Unknown or unavailable sender agent: missing");
    await expect(harness.dispatcher.sendMessage("manager-1", "missing", "x"))
      .rejects.toThrow("Unknown target agent: missing");

    harness.manager.archivedAt = "2026-07-13T00:00:00.000Z";
    await expect(harness.dispatcher.sendMessage("manager-1", "worker-1", "x"))
      .rejects.toThrow("archived:manager-1");
    harness.manager.archivedAt = undefined;

    const foreignWorker = descriptor("foreign-worker", "worker", "manager-2");
    harness.descriptors.set(foreignWorker.agentId, foreignWorker);
    await expect(harness.dispatcher.sendMessage("manager-1", "foreign-worker", "x"))
      .rejects.toThrow("Manager manager-1 does not own worker foreign-worker");

    await expect(harness.dispatcher.sendMessage(
      "manager-1",
      "manager-2",
      "x",
      "auto",
      { planStep: "not a worker" },
    )).rejects.toThrow("planStep can only accompany a manager assignment to one of its workers.");

    harness.manager.status = "stopped";
    await expect(harness.dispatcher.sendMessage("manager-1", "worker-1", "x"))
      .rejects.toThrow("Unknown or unavailable sender agent: manager-1");
  });

  it("rejects a worker-to-foreign-manager send before Codex and attachment processing", async () => {
    const harness = createHarness();
    await expect(harness.dispatcher.sendMessage(
      harness.worker.agentId,
      harness.peer.agentId,
      "x",
    )).rejects.toThrow("Worker worker-1 cannot message manager manager-2 (own manager is manager-1)");
    expect(harness.order).not.toContain("codex:assert-delivery");
    expect(harness.order).not.toContain("attachments:normalize");
  });

  it("does not emit agent-to-agent activity for user-origin or self sends", async () => {
    const userHarness = createHarness();
    await userHarness.dispatcher.sendMessage(
      userHarness.manager.agentId,
      userHarness.worker.agentId,
      "user message",
      "auto",
      { origin: "user" },
    );
    expect(userHarness.emitted).toEqual([]);

    const selfHarness = createHarness();
    await selfHarness.dispatcher.sendMessage(
      selfHarness.manager.agentId,
      selfHarness.manager.agentId,
      "self message",
    );
    expect(selfHarness.emitted).toEqual([]);
  });

  it("can skip delivery ledger without changing turn enqueue or accepted dispatch", async () => {
    const harness = createHarness();
    harness.setObservabilityEnabled(false);
    await harness.dispatcher.sendMessage(
      harness.manager.agentId,
      harness.worker.agentId,
      "work",
      "auto",
      { skipTurnLedger: true },
    );

    expect(harness.turnContexts[0]?.context.skipTurnLedger).toBe(true);
    expect(harness.ledgerPending).toEqual([]);
    expect(harness.ledgerAcked).toEqual([]);
    expect(harness.runtimeInputs).toHaveLength(1);
  });
});
