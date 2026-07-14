import { describe, expect, it, vi } from "vitest";
import {
  AssistantOutputRouter,
  type AgentMessageOutputInput,
  type AssistantOutputRouterOptions,
} from "../assistant-output-router.js";
import type { AssistantOutputTarget } from "../runtime/manager-assistant-output-tracker.js";
import type { AgentDescriptor, ConversationMessageEvent, ManagerProfile } from "../types.js";

const webTarget: AssistantOutputTarget = {
  kind: "session_transcript",
  channel: "web",
  sourceContext: { channel: "web" },
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

function profile(profileId = "profile-1", profileType: ManagerProfile["profileType"] = "user"): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: "manager-1",
    defaultModel: { provider: "openai", modelId: "gpt-5", thinkingLevel: "none" },
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    profileType,
  };
}

function createHarness() {
  const descriptors = new Map<string, AgentDescriptor>();
  const manager = descriptor("manager-1");
  const worker = descriptor("worker-1", "worker", manager.agentId);
  descriptors.set(manager.agentId, manager);
  descriptors.set(worker.agentId, worker);
  const profiles = new Map<string, ManagerProfile>([["profile-1", profile()]]);
  const activations: Array<{
    agentId: string;
    target: AssistantOutputTarget;
    options?: { turnId?: string; beginUserVisibleObligation?: boolean };
  }> = [];
  const clears: string[] = [];
  const externallyActivated: string[] = [];
  const emitted: ConversationMessageEvent[] = [];
  const activity: Array<{ agentId: string; timestamp: string }> = [];
  const debug: Array<{ message: string; details?: unknown }> = [];
  const options: AssistantOutputRouterOptions = {
    descriptors,
    profiles,
    projection: {
      activateManagerAssistantOutputTurn: (agentId, target, projectionOptions) => {
        activations.push({ agentId, target, options: projectionOptions });
      },
      clearManagerAssistantOutputTurn: (agentId) => {
        clears.push(agentId);
      },
    },
    markTurnActivatedExternally: (agentId) => {
      externallyActivated.push(agentId);
    },
    emitConversationMessage: (event) => {
      emitted.push(event);
    },
    markSessionActivity: (agentId, timestamp) => {
      activity.push({ agentId, timestamp });
    },
    now: () => "2026-07-13T12:00:00.000Z",
    logDebug: (message, details) => {
      debug.push({ message, details });
    },
  };
  const router = new AssistantOutputRouter(options);

  return {
    router,
    manager,
    worker,
    descriptors,
    profiles,
    activations,
    clears,
    externallyActivated,
    emitted,
    activity,
    debug,
  };
}

function activateWeb(
  router: AssistantOutputRouter,
  overrides: Partial<Parameters<AssistantOutputRouter["activateManagerTurn"]>[1]> = {},
): void {
  router.activateManagerTurn("manager-1", {
    target: webTarget,
    routeContext: {
      origin: "user",
      requiresVisibleResponse: true,
    },
    turnId: "turn-1",
    beginUserVisibleObligation: true,
    ...overrides,
  });
}

function workerReportInput(
  manager: AgentDescriptor,
  worker: AgentDescriptor,
  overrides: Partial<AgentMessageOutputInput> = {},
): AgentMessageOutputInput {
  return {
    sender: worker,
    target: manager,
    modelMessage: "WORKER REPORT: status: done\nsummary: finished",
    rawMessage: "status: done\nsummary: finished",
    ...overrides,
  };
}

describe("AssistantOutputRouter", () => {
  it("resolves direct user surfaces without leaking protected turns to web", () => {
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
    expect(router.resolveTargetForUserInput(
      manager,
      { channel: "web" },
      { userId: "u1", displayName: "User", channelId: "collab-1" },
    )).toEqual({ kind: "explicit_tool_required", reason: "collaboration_channel" });

    const cortex = descriptor("cortex-session", "manager", "cortex-session", {
      sessionPurpose: "cortex_review",
    });
    expect(router.resolveTargetForUserInput(cortex, { channel: "web" })).toEqual({
      kind: "explicit_tool_required",
      reason: "cortex_session",
    });
  });

  it("owns activation, provider-cycle expiry, and agent-end clearing", () => {
    const { router, activations, clears } = createHarness();
    activateWeb(router);

    expect(router.getActiveTarget("manager-1")).toEqual(webTarget);
    expect(router.getActiveRoute("manager-1")).toEqual({
      origin: "user",
      requiresVisibleResponse: true,
    });
    expect(activations).toEqual([{
      agentId: "manager-1",
      target: webTarget,
      options: { turnId: "turn-1", beginUserVisibleObligation: true },
    }]);

    router.completeProviderCycle("manager-1", { pendingTargets: [webTarget] });
    expect(router.getActiveTarget("manager-1")).toEqual(webTarget);
    expect(router.getActiveRoute("manager-1")).toBeUndefined();

    router.acceptCleanManagerFinal("manager-1", { pendingTargets: [] });
    expect(router.getActiveTarget("manager-1")).toBeUndefined();

    activateWeb(router);
    router.completeAgentTurn("manager-1");
    expect(router.getActiveTarget("manager-1")).toBeUndefined();
    expect(clears).toEqual(["manager-1"]);
  });

  it("keeps the normal worker callback route across provider cycles", () => {
    const { router } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: { kind: "internal_only", reason: "worker_report_callback" },
      routeContext: {
        origin: "terminal_worker_report",
        workerReportSourceAgentId: "worker-1",
        normalBuilderWorkerCallback: true,
        requiresVisibleResponse: false,
      },
      beginUserVisibleObligation: false,
    });

    router.completeProviderCycle("manager-1", { pendingTargets: [] });
    expect(router.getActiveRoute("manager-1")).toEqual({
      origin: "terminal_worker_report",
      workerReportSourceAgentId: "worker-1",
      normalBuilderWorkerCallback: true,
      requiresVisibleResponse: false,
    });
    const route = router.resolveManagerFinalRoute("manager-1", undefined);
    expect(route.target).toEqual(webTarget);
    expect(route.sourceWorkerId).toBe("worker-1");
    expect(route.requiresVisibleResponse).toBe(false);
    expect(route.decision.reasonCode).toBe("render:terminal_worker_report_closeout");
  });

  it("captures, validates, activates, and clears web choice continuations", () => {
    const {
      router,
      activations,
      externallyActivated,
      descriptors,
    } = createHarness();
    activateWeb(router);
    router.rememberChoiceContinuation("choice-1", "manager-1");
    router.completeAgentTurn("manager-1");

    expect(router.activateChoiceContinuation("choice-1", "wrong-owner")).toBe(false);
    expect(externallyActivated).toEqual([]);

    activateWeb(router);
    router.rememberChoiceContinuation("choice-2", "manager-1");
    router.completeAgentTurn("manager-1");
    expect(router.activateChoiceContinuation("choice-2", "manager-1")).toBe(true);
    expect(router.getActiveTarget("manager-1")).toEqual(webTarget);
    expect(externallyActivated).toEqual(["manager-1"]);
    expect(activations.at(-1)).toEqual({
      agentId: "manager-1",
      target: webTarget,
      options: undefined,
    });

    activateWeb(router);
    router.rememberChoiceContinuation("choice-3", "manager-1");
    router.clearChoiceContinuationsForAgent("manager-1");
    expect(router.activateChoiceContinuation("choice-3", "manager-1")).toBe(false);

    descriptors.set("manager-1", descriptor("manager-1", "manager", "manager-1", {
      collab: { workspaceId: "w1", channelId: "c1" },
    }));
    activateWeb(router);
    router.rememberChoiceContinuation("choice-4", "manager-1");
    expect(router.activateChoiceContinuation("choice-4", "manager-1")).toBe(false);
  });

  it("turns a direct-web delegation into an internal callback with vetted web projection", () => {
    const { router, manager, worker } = createHarness();
    activateWeb(router);
    router.recordSuccessfulAgentMessageDispatch({
      sender: manager,
      target: worker,
      modelMessage: "do the work",
      rawMessage: "do the work",
    });
    expect(router.getInheritedTarget("worker-1")).toEqual(webTarget);

    const prepared = router.prepareAgentMessage(workerReportInput(manager, worker));
    expect(prepared.inputTarget).toEqual({
      kind: "internal_only",
      reason: "worker_report_callback",
    });
    expect(prepared.projectionTarget).toEqual({
      kind: "internal_only",
      reason: "worker_report_callback",
    });
    expect(prepared.eligibleWorkerReport).toBe(true);
    expect(prepared.workerReportSourceAgentId).toBe("worker-1");
    expect(prepared.normalBuilderWorkerCallback).toBe(true);
    expect(prepared.requiresVisibleResponse).toBe(false);
    expect(prepared.modelMessage).toContain("[assistantOutputTarget]");

    router.activateManagerTurn("manager-1", {
      target: prepared.projectionTarget,
      routeContext: {
        origin: "terminal_worker_report",
        workerReportSourceAgentId: prepared.workerReportSourceAgentId,
        normalBuilderWorkerCallback: prepared.normalBuilderWorkerCallback,
        requiresVisibleResponse: prepared.requiresVisibleResponse,
      },
      beginUserVisibleObligation: false,
    });
    expect(router.resolveManagerFinalRoute("manager-1", undefined).target).toEqual(webTarget);

    router.recordSuccessfulAgentMessageDispatch(workerReportInput(manager, worker));
    expect(router.getInheritedTarget("worker-1")).toBeUndefined();
  });

  it("retains protected handoffs as server-owned projection targets", () => {
    const { router, manager, worker } = createHarness();
    const telegramTarget: AssistantOutputTarget = {
      kind: "external_channel",
      sourceContext: { channel: "telegram", channelId: "t1" },
    };
    router.activateManagerTurn("manager-1", {
      target: telegramTarget,
      routeContext: { origin: "user", requiresVisibleResponse: true },
      beginUserVisibleObligation: true,
    });
    router.recordSuccessfulAgentMessageDispatch({
      sender: manager,
      target: worker,
      modelMessage: "do the work",
    });

    const prepared = router.prepareAgentMessage(workerReportInput(manager, worker));
    expect(prepared.inputTarget).toEqual({
      kind: "explicit_tool_required",
      reason: "worker_report",
    });
    expect(prepared.projectionTarget).toEqual(telegramTarget);
    expect(prepared.normalBuilderWorkerCallback).toBe(false);

    router.recordSuccessfulAgentMessageDispatch(workerReportInput(manager, worker));
    expect(router.getInheritedTarget("worker-1")).toEqual(telegramTarget);
  });

  it("rejects report-like messages without manager-owned worker provenance", () => {
    const { router, manager } = createHarness();
    const stranger = descriptor("worker-2", "worker", "manager-2");
    const prepared = router.prepareAgentMessage(workerReportInput(manager, stranger));

    expect(prepared.eligibleWorkerReport).toBe(false);
    expect(prepared.inputTarget).toEqual({
      kind: "internal_only",
      reason: "missing_worker_report_provenance",
    });
    expect(prepared.projectionTarget).toEqual(prepared.inputTarget);
    expect(prepared.normalBuilderWorkerCallback).toBe(false);
  });

  it("preserves visible-response obligation on same-manager send-tool continuation", () => {
    const { router, manager } = createHarness();
    activateWeb(router);
    const prepared = router.prepareAgentMessage({
      sender: manager,
      target: manager,
      modelMessage: "continue",
      rawMessage: "continue",
      sendMessageToolContinuation: true,
    });

    expect(prepared.inputTarget).toEqual({
      kind: "explicit_tool_required",
      reason: "agent_message",
    });
    expect(prepared.projectionTarget).toEqual(webTarget);
    expect(prepared.requiresVisibleResponse).toBe(true);
  });

  it("projects peer wrap-ups only on ordinary Builder sessions", () => {
    const { router, manager, descriptors, profiles } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: { kind: "peer_agent", fromAgentId: "peer-1" },
      routeContext: { origin: "internal", requiresVisibleResponse: true },
      beginUserVisibleObligation: false,
    });
    expect(router.resolveManagerFinalRoute("manager-1", undefined).target).toEqual(webTarget);

    descriptors.set("manager-1", descriptor("manager-1", "manager", "manager-1", {
      profileId: "system-profile",
    }));
    profiles.set("system-profile", profile("system-profile", "system"));
    const denied = router.resolveManagerFinalRoute("manager-1", undefined);
    expect(denied.target).toBeUndefined();
    expect(denied.decision.reasonCode).toBe("deny:system_profile");

    descriptors.set("manager-1", manager);
  });

  it("treats a vetted remembered web target as authoritative for internal continuations", () => {
    const { router } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: webTarget,
      routeContext: { origin: "internal", requiresVisibleResponse: true },
      beginUserVisibleObligation: false,
    });

    const route = router.resolveManagerFinalRoute("manager-1", undefined);
    expect(route.target).toEqual(webTarget);
    expect(route.decision).toMatchObject({
      visible: true,
      decision: "render",
      channel: "web",
      reasonCode: "render:user_web",
    });
  });

  it("delivers the terminal report backstop exactly once and suppresses invalid obligations", () => {
    const { router, emitted, activity, debug, descriptors } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: webTarget,
      routeContext: {
        origin: "terminal_worker_report",
        workerReportSourceAgentId: "worker-1",
        requiresVisibleResponse: true,
      },
      beginUserVisibleObligation: false,
    });
    const report = "WORKER REPORT: status: done\nsummary: shipped it";

    expect(router.deliverTerminalObligationBackstop("manager-1", report)).toBe(true);
    expect(router.deliverTerminalObligationBackstop("manager-1", report)).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      agentId: "manager-1",
      role: "system",
      source: "system",
      systemNoticeKind: "worker_outcome_backstop",
      sourceWorkerId: "worker-1",
      sourceContext: { channel: "web" },
    });
    expect(emitted[0]?.text).toContain("`worker-1` finished (status: done) — shipped it.");
    expect(activity).toEqual([{
      agentId: "manager-1",
      timestamp: "2026-07-13T12:00:00.000Z",
    }]);
    expect(debug[0]?.message).toBe("manager:terminal_obligation_backstop_delivered");

    descriptors.get("manager-1")!.status = "stopped";
    expect(router.deliverTerminalObligationBackstop("manager-1", `${report}\nother`)).toBe(false);
  });

  it("does not backstop callbacks where deliberate silence is valid", () => {
    const { router, emitted } = createHarness();
    router.activateManagerTurn("manager-1", {
      target: { kind: "internal_only", reason: "worker_report_callback" },
      routeContext: {
        origin: "terminal_worker_report",
        workerReportSourceAgentId: "worker-1",
        normalBuilderWorkerCallback: true,
        requiresVisibleResponse: false,
      },
      beginUserVisibleObligation: false,
    });

    expect(router.deliverTerminalObligationBackstop(
      "manager-1",
      "WORKER REPORT: status: done",
    )).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("clears only resettable worker inheritance on runtime errors", () => {
    const { router, manager, worker, activations, clears } = createHarness();
    activateWeb(router);
    router.recordSuccessfulAgentMessageDispatch({
      sender: manager,
      target: worker,
      modelMessage: "task",
    });
    expect(router.getInheritedTarget("worker-1")).toEqual(webTarget);

    router.handleRuntimeError("worker-1", worker);
    expect(router.getInheritedTarget("worker-1")).toBeUndefined();

    activateWeb(router);
    router.recordSuccessfulAgentMessageDispatch({
      sender: manager,
      target: worker,
      modelMessage: "task",
    });
    router.rememberChoiceContinuation("choice-1", "manager-1");
    router.handleRuntimeError("manager-1", manager);
    expect(router.getActiveTarget("manager-1")).toBeUndefined();
    expect(router.getInheritedTarget("worker-1")).toBeUndefined();
    expect(router.activateChoiceContinuation("choice-1", "manager-1")).toBe(false);
    expect(clears).toContain("manager-1");
    expect(activations.length).toBeGreaterThan(0);
  });

  it("clones externally visible state instead of exposing mutable map values", () => {
    const { router } = createHarness();
    activateWeb(router);
    const target = router.getActiveTarget("manager-1");
    const route = router.getActiveRoute("manager-1");
    expect(target?.kind).toBe("session_transcript");
    if (target?.kind === "session_transcript" && target.sourceContext) {
      target.sourceContext.channel = "cli";
    }
    if (route) {
      route.origin = "internal";
    }

    expect(router.getActiveTarget("manager-1")).toEqual(webTarget);
    expect(router.getActiveRoute("manager-1")?.origin).toBe("user");
  });

  it("has no hidden clock or async work in routing", () => {
    vi.useFakeTimers();
    try {
      const { router, manager } = createHarness();
      expect(router.prepareAgentMessage({
        sender: manager,
        target: manager,
        modelMessage: "message",
      }).inputTarget).toEqual({
        kind: "explicit_tool_required",
        reason: "agent_message",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
