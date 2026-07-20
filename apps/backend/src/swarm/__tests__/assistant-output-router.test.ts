import { describe, expect, it } from "vitest";
import { AssistantOutputRouter } from "../assistant-output-router.js";
import type {
  AgentDescriptor,
  AssistantOutputTarget,
  ManagerProfile,
  WorkerParentContext,
} from "../types.js";

const webTarget: AssistantOutputTarget = {
  kind: "session_transcript",
  channel: "web",
  sourceContext: { channel: "web", messageId: "user-1" },
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

function createHarness() {
  const manager = descriptor("manager-1");
  const worker = descriptor("worker-1", "worker", manager.agentId) as AgentDescriptor & { role: "worker" };
  const descriptors = new Map<string, AgentDescriptor>([
    [manager.agentId, manager],
    [worker.agentId, worker],
  ]);
  const profile: ManagerProfile = {
    profileId: "profile-1",
    displayName: "Project",
    defaultSessionAgentId: manager.agentId,
    defaultModel: { provider: "openai", modelId: "gpt-5", thinkingLevel: "none" },
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    profileType: "user",
  };
  const activations: Array<Record<string, unknown>> = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const clears: string[] = [];
  const router = new AssistantOutputRouter({
    descriptors,
    profiles: new Map([[profile.profileId, profile]]),
    projection: {
      activateManagerAssistantOutputTurn: (agentId, target, options) => {
        activations.push({ agentId, target, options });
      },
      clearManagerAssistantOutputTurn: (agentId) => clears.push(agentId),
    },
    markTurnActivatedExternally: () => undefined,
    emitConversationMessage: (event) => diagnostics.push(event),
    markSessionActivity: () => undefined,
    now: () => "2026-07-16T01:00:00.000Z",
    logDebug: () => undefined,
  });
  return { router, manager, worker, profile, activations, diagnostics, clears };
}

function workerParent(outputTarget: AssistantOutputTarget = webTarget): WorkerParentContext {
  return {
    schemaVersion: 1,
    assignmentId: "assignment-1",
    managerId: "manager-1",
    assignedAt: "2026-07-16T01:00:00.000Z",
    outputTarget: structuredClone(outputTarget),
    rootTurnId: "root-user-1",
  };
}

describe("AssistantOutputRouter", () => {
  it("resolves direct user surfaces without projecting protected turns to web", () => {
    const { router, manager } = createHarness();

    expect(router.resolveTargetForUserInput(manager, { channel: "web", messageId: "m1" })).toEqual({
      kind: "session_transcript",
      channel: "web",
      sourceContext: { channel: "web", messageId: "m1" },
    });
    expect(router.resolveTargetForUserInput(manager, { channel: "telegram", channelId: "t1" })).toEqual({
      kind: "internal_only",
      reason: "retired_external_channel",
    });
    expect(router.resolveTargetForUserInput(manager, { channel: "cli" })).toEqual({
      kind: "explicit_tool_required",
      reason: "unsupported_direct_cli_source",
    });
  });

  it("fails closed for a recovered retired target and emits only a sanitized diagnostic", () => {
    const { router, manager, worker, diagnostics } = createHarness();
    const parentContext = workerParent({
      kind: "external_channel",
      sourceContext: {
        channel: "telegram",
        channelId: "sensitive-chat",
        userId: "sensitive-user",
        threadTs: "sensitive-thread",
        integrationProfileId: "sensitive-profile",
      },
    });
    expect(router.isRecoveredRetiredWorkerResult(parentContext)).toBe(true);
    expect(() => router.prepareWorkerResult({
      worker,
      target: manager as AgentDescriptor & { role: "manager" },
      parentContext,
      modelMessage: "sensitive response text",
    })).toThrow("must be discarded before runtime preparation");
    router.emitRecoveredRetiredWorkerResultDiagnostic(manager.agentId);
    expect(diagnostics).toEqual([{
      type: "conversation_message",
      agentId: manager.agentId,
      role: "system",
      text: "retired_external_channel",
      timestamp: "2026-07-16T01:00:00.000Z",
      source: "worker_report",
      excludeFromModelContext: true,
    }]);
    const serialized = JSON.stringify(diagnostics);
    for (const sensitive of ["sensitive response text", "sensitive-chat", "sensitive-user", "sensitive-thread", "sensitive-profile", "telegram"]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it("uses the persisted parent context when it names a concrete route", () => {
    const { router, manager, worker } = createHarness();
    const parentContext = workerParent();

    const prepared = router.prepareWorkerResult({
      worker,
      target: manager as AgentDescriptor & { role: "manager" },
      parentContext,
      modelMessage: "[workerResult] result",
    });

    expect(prepared).toMatchObject({
      inputTarget: webTarget,
      projectionTarget: webTarget,
      sourceWorkerId: worker.agentId,
      requiresVisibleResponse: false,
    });
    expect(String(prepared.modelMessage)).toContain('[assistantOutputTarget] {"kind":"session_transcript"');

    (parentContext.outputTarget as { sourceContext?: { messageId?: string } }).sourceContext!.messageId = "changed";
    expect(prepared.inputTarget).toEqual(webTarget);
  });

  it("carries the last direct web target into a worker assignment after a synthetic continuation", () => {
    const { router } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: webTarget,
      routeContext: { origin: "user", requiresVisibleResponse: true },
      beginUserVisibleObligation: true,
    });
    router.completeAgentTurn("manager-1");

    expect(router.resolveWorkerParentOutputTarget("manager-1")).toEqual(webTarget);
  });

  it("preserves a non-web direct target across a synthetic continuation", () => {
    const { router } = createHarness();
    const telegramTarget: AssistantOutputTarget = {
      kind: "external_channel",
      sourceContext: { channel: "telegram", channelId: "chat-1" },
    };
    router.activateManagerTurn("manager-1", {
      target: telegramTarget,
      routeContext: { origin: "user", requiresVisibleResponse: true },
      beginUserVisibleObligation: true,
    });
    router.completeAgentTurn("manager-1");

    expect(router.resolveWorkerParentOutputTarget("manager-1")).toEqual(telegramTarget);
  });

  it("uses an active choice continuation target over an intervening routed target", () => {
    const { router } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: webTarget,
      routeContext: { origin: "user", requiresVisibleResponse: true },
      beginUserVisibleObligation: true,
    });
    router.rememberChoiceContinuation("choice-1", "manager-1");

    const telegramTarget: AssistantOutputTarget = {
      kind: "external_channel",
      sourceContext: { channel: "telegram", channelId: "chat-1" },
    };
    router.activateManagerTurn("manager-1", {
      target: telegramTarget,
      routeContext: { origin: "user", requiresVisibleResponse: true },
      beginUserVisibleObligation: true,
    });
    router.completeAgentTurn("manager-1");

    expect(router.activateChoiceContinuation("choice-1", "manager-1")).toBe(true);
    expect(router.resolveWorkerParentOutputTarget("manager-1")).toEqual(webTarget);
  });

  it("keeps an active internal parent authoritative over the last direct target", () => {
    const { router } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: webTarget,
      routeContext: { origin: "user", requiresVisibleResponse: true },
      beginUserVisibleObligation: true,
    });
    const internalTarget: AssistantOutputTarget = {
      kind: "internal_only",
      reason: "background",
    };

    expect(router.resolveWorkerParentOutputTarget("manager-1", internalTarget)).toEqual(
      internalTarget,
    );
  });

  it("keeps an ended internal route internal across its synthetic continuation", () => {
    const { router } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: webTarget,
      routeContext: { origin: "user", requiresVisibleResponse: true },
      beginUserVisibleObligation: true,
    });
    const internalTarget: AssistantOutputTarget = {
      kind: "internal_only",
      reason: "worker_health",
    };
    router.activateManagerTurn("manager-1", {
      target: internalTarget,
      routeContext: { origin: "internal", requiresVisibleResponse: false },
      beginUserVisibleObligation: false,
    });
    router.completeAgentTurn("manager-1");

    expect(router.resolveWorkerParentOutputTarget("manager-1")).toEqual(internalTarget);
  });

  it("keeps an ended tool-gated internal route authoritative", () => {
    const { router } = createHarness();
    const toolGatedTarget: AssistantOutputTarget = {
      kind: "explicit_tool_required",
      reason: "agent_message",
    };
    router.activateManagerTurn("manager-1", {
      target: toolGatedTarget,
      routeContext: { origin: "internal", requiresVisibleResponse: false },
      beginUserVisibleObligation: false,
    });
    router.completeAgentTurn("manager-1");

    expect(router.resolveWorkerParentOutputTarget("manager-1")).toEqual(toolGatedTarget);
  });

  it("defaults a contextless ordinary Builder assignment to its web transcript", () => {
    const { router } = createHarness();

    expect(router.resolveWorkerParentOutputTarget("manager-1")).toEqual({
      kind: "session_transcript",
      channel: "web",
      sourceContext: { channel: "web" },
    });
  });

  it("does not apply the Builder fallback to protected managers", () => {
    const expected: AssistantOutputTarget = {
      kind: "internal_only",
      reason: "no_active_parent",
    };

    const collab = createHarness();
    collab.manager.collab = true;
    expect(collab.router.resolveWorkerParentOutputTarget("manager-1")).toEqual(expected);

    const projectAgent = createHarness();
    projectAgent.manager.projectAgent = {
      handle: "docs",
      whenToUse: "Maintain project documentation.",
    };
    expect(projectAgent.router.resolveWorkerParentOutputTarget("manager-1")).toEqual(expected);

    const system = createHarness();
    system.profile.profileType = "system";
    expect(system.router.resolveWorkerParentOutputTarget("manager-1")).toEqual(expected);
  });

  it("repairs an already-persisted missing parent before the worker result reaches the model", () => {
    const { router, manager, worker } = createHarness();
    const prepared = router.prepareWorkerResult({
      worker,
      target: manager as AgentDescriptor & { role: "manager" },
      parentContext: workerParent({ kind: "internal_only", reason: "no_active_parent" }),
      modelMessage: "[workerResult] result",
    });

    expect(prepared.inputTarget).toEqual({
      kind: "session_transcript",
      channel: "web",
      sourceContext: { channel: "web" },
    });
    expect(String(prepared.modelMessage)).toContain(
      '[assistantOutputTarget] {"kind":"session_transcript"}',
    );
  });

  it("allows a substantive manager closeout after a web worker result without requiring one", () => {
    const { router } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: webTarget,
      routeContext: {
        origin: "worker_result",
        sourceWorkerId: "worker-1",
        requiresVisibleResponse: false,
      },
      turnId: "worker-result-turn",
      beginUserVisibleObligation: false,
    });

    const route = router.resolveManagerFinalRoute("manager-1", undefined);
    expect(route).toMatchObject({
      target: webTarget,
      sourceWorkerId: "worker-1",
      requiresVisibleResponse: false,
      decision: {
        visible: true,
        reasonCode: "render:worker_result_closeout",
      },
    });
  });

  it("keeps protected worker results internal while preserving the typed source", () => {
    const { router } = createHarness();
    const internalTarget: AssistantOutputTarget = { kind: "internal_only", reason: "background" };
    router.activateManagerTurn("manager-1", {
      target: internalTarget,
      routeContext: {
        origin: "worker_result",
        sourceWorkerId: "worker-1",
        requiresVisibleResponse: false,
      },
      beginUserVisibleObligation: false,
    });

    expect(router.resolveManagerFinalRoute("manager-1", undefined)).toMatchObject({
      sourceWorkerId: "worker-1",
      requiresVisibleResponse: false,
      decision: {
        visible: false,
        reasonCode: "deny:internal_only",
      },
    });
  });

  it("retains one active route across provider tool cycles and clears it only at agent end", () => {
    const { router, clears } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: webTarget,
      routeContext: { origin: "user", requiresVisibleResponse: true },
      turnId: "user-turn",
      beginUserVisibleObligation: true,
    });

    router.completeProviderCycle("manager-1", { pendingTargets: [] });
    router.acceptCleanManagerFinal("manager-1", { pendingTargets: [] });
    expect(router.getActiveTarget("manager-1")).toEqual(webTarget);
    expect(router.getActiveRoute("manager-1")).toEqual({
      origin: "user",
      requiresVisibleResponse: true,
    });

    router.completeAgentTurn("manager-1");
    expect(router.getActiveTarget("manager-1")).toBeUndefined();
    expect(router.getActiveRoute("manager-1")).toBeUndefined();
    expect(clears).toEqual(["manager-1"]);
  });

  it("does not infer worker-result authority from report-like text", () => {
    const { router, manager, worker } = createHarness();
    const prepared = router.prepareAgentMessage({
      sender: worker,
      target: manager,
      modelMessage: "WORKER REPORT: status: done",
    });

    expect(prepared.sourceWorkerId).toBeUndefined();
    expect(prepared.requiresVisibleResponse).toBe(false);
    expect(prepared.inputTarget).toEqual({
      kind: "explicit_tool_required",
      reason: "agent_message",
    });
  });
});
