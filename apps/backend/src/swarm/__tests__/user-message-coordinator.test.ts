import { describe, expect, it, vi } from "vitest";
import type { RuntimeUserMessage, SwarmAgentRuntime } from "../runtime-contracts.js";
import type {
  AgentDescriptor,
  ConversationAttachment,
  ConversationEntryEvent,
  ConversationMessageEvent,
  SendMessageReceipt,
} from "../types.js";
import {
  InboundConversationAppender,
  UserMessageCoordinator,
  type UserMessageCoordinatorOptions,
} from "../user-message-coordinator.js";

const now = "2026-07-13T12:00:00.000Z";
const receipt: SendMessageReceipt = {
  targetAgentId: "manager-1",
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

function textAttachment(data = "hello"): ConversationAttachment {
  return { type: "text", mimeType: "text/plain", data };
}

function createHarness() {
  const order: string[] = [];
  const manager = descriptor("manager-1");
  const worker = descriptor("worker-1", "worker", manager.agentId);
  const descriptors = new Map([
    [manager.agentId, manager],
    [worker.agentId, worker],
  ]);
  const emittedConversations: ConversationMessageEvent[] = [];
  const emittedAgentMessages: unknown[] = [];
  const history: ConversationEntryEvent[] = [];
  const persistedAttachment = { ...textAttachment("persisted"), filePath: "/tmp/persisted.txt" };
  const runtimeAttachment = { ...textAttachment("runtime") };
  const rollback = vi.fn(() => order.push("turn:rollback"));
  let runtimeError: Error | undefined;
  let pendingRecycle = false;

  const runtime = {
    descriptor: manager,
    sendMessage: vi.fn(async (_message: string | RuntimeUserMessage, _mode?: string) => {
      order.push("runtime:send");
      if (runtimeError) throw runtimeError;
      return receipt;
    }),
  } as unknown as SwarmAgentRuntime;

  const attachmentService = {
    normalize: vi.fn((attachments: ConversationAttachment[] | undefined) => attachments ?? []),
    prepareConversation: vi.fn(async (attachments: ConversationAttachment[] | undefined) => {
      order.push("attachments:prepare");
      return {
        normalizedAttachments: attachments ?? [],
        persistedAttachments: attachments?.length ? [persistedAttachment] : [],
        attachmentMetadata: attachments?.length
          ? [{ type: "text" as const, mimeType: "text/plain", filePath: "/tmp/persisted.txt" }]
          : [],
        runtimeAttachments: attachments?.length ? [runtimeAttachment] : [],
      };
    }),
  };
  const eventPort = {
    emitConversationMessage: vi.fn((event: ConversationMessageEvent) => {
      order.push("event:conversation");
      event.id ??= `message-${emittedConversations.length + 1}`;
      emittedConversations.push(event);
    }),
    emitAgentMessage: vi.fn((event: unknown) => {
      order.push("event:agent-message");
      emittedAgentMessages.push(event);
    }),
    markSessionActivity: vi.fn(() => order.push("event:activity")),
    markSessionUserMessageActivity: vi.fn(() => order.push("event:user-activity")),
  };
  const inboundConversation = new InboundConversationAppender({
    attachments: attachmentService,
    events: eventPort,
    now: () => now,
  });

  const options = {
    targeting: {
      descriptors,
      resolvePreferredManagerId: vi.fn(() => manager.agentId),
      assertDescriptorNotEffectivelyArchived: vi.fn((target: AgentDescriptor) => {
        order.push("target:archive-check");
        if (target.archivedAt) throw new Error("archived");
      }),
      getConversationHistory: vi.fn(() => history),
    },
    runtime: {
      recovery: {
        hasPendingManagerRuntimeRecycle: vi.fn(() => pendingRecycle),
      },
      executableTrust: {
        applyManagerRuntimeRecyclePolicy: vi.fn(async () => {
          order.push("runtime:recycle");
          return "recycled" as const;
        }),
        schedulePrompt: vi.fn(() => order.push("trust:schedule")),
      },
      getOrCreateRuntime: vi.fn(async () => {
        order.push("runtime:get");
        return runtime;
      }),
      persistRecycledRuntimeState: vi.fn(async () => {
        order.push("runtime:persist-recycle");
      }),
    },
    attachments: attachmentService,
    inboundConversation,
    agentMessages: {
      sendMessage: vi.fn(async () => {
        order.push("agent-message:send");
        return { ...receipt, targetAgentId: worker.agentId };
      }),
      prepareModelInboundMessage: vi.fn(async (_targetAgentId: string, message: RuntimeUserMessage) => {
        order.push("runtime:prepare-message");
        return message;
      }),
    },
    assistantOutput: {
      resolveTargetForUserInput: vi.fn(() => ({
        kind: "session_transcript" as const,
        channel: "web" as const,
        sourceContext: { channel: "web" as const },
      })),
    },
    codex: {
      direct: {
        maybeRouteUserMessage: vi.fn(async () => {
          order.push("codex:direct");
          return false;
        }),
      },
      plugin: {
        assertWorkerNotUserTargetable: vi.fn(() => order.push("codex:target-check")),
        classifyAndPreflightUserTurn: vi.fn(() => {
          order.push("codex:classify");
          return { kind: "none" as const };
        }),
        prepareUserTurn: vi.fn(() => {
          order.push("codex:prepare");
          return {};
        }),
        appendManagerTurnGuidance: vi.fn((message: string) => {
          order.push("codex:guidance");
          return message;
        }),
        buildTurnGate: vi.fn(() => {
          order.push("codex:gate");
          return { allowed: true, code: "allowed" as const };
        }),
        recordDispatchAccepted: vi.fn(() => order.push("codex:accepted")),
      },
    },
    knowledge: {
      compact: vi.fn(async () => {
        order.push("knowledge:compact");
      }),
      maybeRunCortexConsolidationFromIncomingMessage: vi.fn(async () => {
        order.push("knowledge:cortex-route");
        return false;
      }),
    },
    projectAgents: {
      preflightRuntime: vi.fn(async () => {
        order.push("project-agent:preflight");
      }),
    },
    turns: {
      enqueue: vi.fn(async () => {
        order.push("turn:enqueue");
        return { turnId: "turn-1", rollback };
      }),
    },
    observability: {
      beginRuntimeInput: vi.fn(() => {
        order.push("observability:begin");
        return { rootTurnId: "root-1", targetAgentId: manager.agentId, startedAt: Date.now() };
      }),
      completeRuntimeInput: vi.fn(() => order.push("observability:complete")),
      cancelRuntimeInput: vi.fn(() => order.push("observability:cancel")),
    },
    events: eventPort,
    now: () => now,
    logDebug: vi.fn(),
  } as unknown as UserMessageCoordinatorOptions;
  const coordinator = new UserMessageCoordinator(options);

  return {
    coordinator,
    options,
    manager,
    worker,
    descriptors,
    history,
    order,
    runtime,
    attachmentService,
    eventPort,
    emittedConversations,
    emittedAgentMessages,
    rollback,
    setRuntimeError: (error: Error | undefined) => { runtimeError = error; },
    setPendingRecycle: (value: boolean) => { pendingRecycle = value; },
  };
}

describe("InboundConversationAppender", () => {
  it("commits user and project-agent payloads with their distinct metadata and activity semantics", async () => {
    const harness = createHarness();
    const replyTo = { messageId: "prior", role: "assistant" as const, text: "prior text" };

    const user = await harness.options.inboundConversation.append(harness.manager, {
      text: "hello",
      source: "user_input",
      sourceContext: { channel: "web" },
      collaborationAuthor: { userId: "u1", displayName: "Ada" },
      clientRequestId: "request-1",
      attachments: [textAttachment()],
      replyTo,
    });
    await harness.options.inboundConversation.appendProjectAgentConversation(harness.manager, {
      text: "peer hello",
      runtimeText: "peer runtime",
      timestamp: now,
      projectAgentContext: { fromAgentId: "peer", fromDisplayName: "Peer", external: false },
    });

    expect(user.event).toMatchObject({
      id: "message-1",
      source: "user_input",
      sourceContext: { channel: "web" },
      clientRequestId: "request-1",
      replyTo,
      attachments: [{ filePath: "/tmp/persisted.txt" }],
    });
    expect(harness.emittedConversations[1]).toMatchObject({
      source: "project_agent_input",
      projectAgentContext: { fromAgentId: "peer" },
    });
    expect(harness.emittedConversations[1]?.sourceContext).toBeUndefined();
    expect(harness.attachmentService.prepareConversation).toHaveBeenNthCalledWith(2, undefined);
    expect(harness.eventPort.markSessionUserMessageActivity).toHaveBeenCalledTimes(1);
  });
});

describe("UserMessageCoordinator", () => {
  it("validates target and content while allowing attachment-only appends", async () => {
    const harness = createHarness();

    await expect(harness.coordinator.appendConversationUserMessage("   ")).rejects.toThrow(
      "Cannot append an empty user message",
    );
    await expect(harness.coordinator.appendConversationUserMessage("", {
      attachments: [textAttachment()],
    })).resolves.toMatchObject({ text: "", target: harness.manager });
    await expect(harness.coordinator.appendConversationUserMessage("hello", {
      targetAgentId: "missing",
    })).rejects.toThrow("Unknown target agent: missing");

    harness.worker.status = "terminated";
    await expect(harness.coordinator.appendConversationUserMessage("hello", {
      targetAgentId: harness.worker.agentId,
    })).rejects.toThrow(`Target agent is not running: ${harness.worker.agentId}`);
  });

  it("short-circuits direct Codex, Cortex consolidation, and slash compaction before append", async () => {
    const harness = createHarness();
    vi.mocked(harness.options.codex.direct.maybeRouteUserMessage).mockResolvedValueOnce(true);
    await harness.coordinator.handleUserMessage("@Codex inspect");
    expect(harness.options.projectAgents.preflightRuntime).not.toHaveBeenCalled();

    vi.mocked(
      harness.options.knowledge.maybeRunCortexConsolidationFromIncomingMessage,
    ).mockResolvedValueOnce(true);
    await harness.coordinator.handleUserMessage("consolidate");
    expect(harness.attachmentService.prepareConversation).not.toHaveBeenCalled();

    await harness.coordinator.handleUserMessage("/compact preserve decisions");
    expect(harness.options.knowledge.compact).toHaveBeenCalledWith(harness.manager.agentId, {
      customInstructions: "preserve decisions",
      sourceContext: { channel: "web" },
      trigger: "slash_command",
    });
    expect(harness.attachmentService.prepareConversation).not.toHaveBeenCalled();
  });

  it("appends before preparing Codex state and dispatches a manager turn with the visible message id", async () => {
    const harness = createHarness();
    harness.history.push({
      type: "conversation_message",
      id: "prior-1",
      agentId: harness.manager.agentId,
      role: "assistant",
      text: "quoted assistant text",
      timestamp: now,
      source: "assistant_output",
    });

    await harness.coordinator.handleUserMessage("follow up", {
      replyTo: { messageId: "prior-1" },
      clientRequestId: "request-1",
    });

    expect(harness.order.indexOf("event:conversation")).toBeLessThan(
      harness.order.indexOf("codex:prepare"),
    );
    expect(harness.order.indexOf("turn:enqueue")).toBeLessThan(
      harness.order.indexOf("runtime:send"),
    );
    expect(harness.options.codex.plugin.prepareUserTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageId: "message-1" }),
    );
    expect(harness.options.observability.beginRuntimeInput).toHaveBeenCalledWith(
      expect.objectContaining({ visibleMessageId: "message-1" }),
    );
    expect(harness.emittedConversations[0]).toMatchObject({
      clientRequestId: "request-1",
      replyTo: { messageId: "prior-1", text: "quoted assistant text" },
    });
    expect(harness.options.runtime.executableTrust.schedulePrompt).toHaveBeenCalledWith(
      harness.manager,
    );
    expect(harness.options.codex.plugin.recordDispatchAccepted).toHaveBeenCalledTimes(1);
  });

  it("rolls back turn context and cancels observability when manager dispatch fails", async () => {
    const harness = createHarness();
    const failure = new Error("provider unavailable");
    harness.setRuntimeError(failure);

    await expect(harness.coordinator.handleUserMessage("hello")).rejects.toThrow(failure);

    expect(harness.rollback).toHaveBeenCalledTimes(1);
    expect(harness.options.observability.cancelRuntimeInput).toHaveBeenCalledWith(
      expect.objectContaining({ rootTurnId: "root-1" }),
      "manager_user_dispatch_failed",
    );
    expect(harness.options.observability.completeRuntimeInput).not.toHaveBeenCalled();
    expect(harness.options.codex.plugin.recordDispatchAccepted).not.toHaveBeenCalled();
  });

  it("recycles and persists manager runtime state before runtime creation", async () => {
    const harness = createHarness();
    harness.setPendingRecycle(true);

    await harness.coordinator.dispatchRuntimeUserMessage({
      targetAgentId: harness.manager.agentId,
      text: "hello",
      sourceContext: { channel: "web" },
    });

    expect(harness.order.indexOf("runtime:recycle")).toBeLessThan(
      harness.order.indexOf("runtime:persist-recycle"),
    );
    expect(harness.order.indexOf("runtime:persist-recycle")).toBeLessThan(
      harness.order.indexOf("runtime:get"),
    );
  });

  it("routes worker input through AgentMessageDispatcher and emits the accepted receipt", async () => {
    const harness = createHarness();
    harness.history.push({
      type: "conversation_message",
      id: "prior-1",
      agentId: harness.worker.agentId,
      role: "assistant",
      text: "worker answer",
      timestamp: now,
      source: "assistant_output",
    });

    await harness.coordinator.handleUserMessage("worker follow up", {
      targetAgentId: harness.worker.agentId,
      replyTo: { messageId: "prior-1" },
    });

    expect(harness.options.agentMessages.sendMessage).toHaveBeenCalledWith(
      harness.manager.agentId,
      harness.worker.agentId,
      expect.stringContaining("[replyTo]"),
      "auto",
      { origin: "user", attachments: [] },
    );
    expect(harness.emittedAgentMessages).toEqual([
      expect.objectContaining({
        source: "user_to_agent",
        agentId: harness.manager.agentId,
        toAgentId: harness.worker.agentId,
        text: "worker follow up",
        acceptedMode: "prompt",
      }),
    ]);
    expect(harness.options.runtime.getOrCreateRuntime).not.toHaveBeenCalled();
  });
});
