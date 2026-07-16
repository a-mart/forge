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
    emitConversationMessage: () => undefined,
    markSessionActivity: () => undefined,
    now: () => "2026-07-16T01:00:00.000Z",
    logDebug: () => undefined,
  });
  return { router, manager, worker, activations, clears };
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
      kind: "external_channel",
      sourceContext: { channel: "telegram", channelId: "t1" },
    });
    expect(router.resolveTargetForUserInput(manager, { channel: "cli" })).toEqual({
      kind: "explicit_tool_required",
      reason: "unsupported_direct_cli_source",
    });
  });

  it("derives worker-result routing only from the persisted parent context", () => {
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
