import { describe, expect, it, vi } from "vitest";
import {
  SessionInteractionCoordinator,
  type SessionInteractionCoordinatorOptions,
} from "../session-interaction-coordinator.js";
import type {
  AgentDescriptor,
  ChoiceAnswer,
  ManagerProfile,
  SpawnAgentInput,
} from "../types.js";

const NOW = "2026-07-14T14:00:00.000Z";

describe("SessionInteractionCoordinator", () => {
  it("updates an eligible Builder plan and records the normalized side effect", async () => {
    const harness = createHarness();
    const input = { plan: [{ step: "Inspect", status: "in_progress" as const }] };

    const result = await harness.coordinator.updatePlan("manager", "tool-1", input);

    expect(result).toMatchObject({ sessionAgentId: "manager", revision: 2 });
    expect(harness.options.plans.update).toHaveBeenCalledWith(
      harness.descriptors.get("manager"),
      input,
    );
    expect(harness.options.recordToolSideEffect).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({
        toolName: "update_plan",
        toolCallId: "tool-1",
        metadata: { revision: 2, stepCount: 1 },
      }),
    );
  });

  it("rejects update_plan outside a running, non-Cortex Builder manager session", async () => {
    const harness = createHarness();
    const manager = harness.descriptors.get("manager")!;
    manager.sessionSurface = "collab";
    await expect(
      harness.coordinator.updatePlan("manager", "tool", { plan: [] }),
    ).rejects.toThrow("not available for Collaboration sessions");

    manager.sessionSurface = "builder";
    manager.archetypeId = "cortex";
    await expect(
      harness.coordinator.updatePlan("manager", "tool", { plan: [] }),
    ).rejects.toThrow("not available for Cortex sessions");

    manager.archetypeId = "manager";
    manager.status = "stopped";
    await expect(
      harness.coordinator.updatePlan("manager", "tool", { plan: [] }),
    ).rejects.toThrow("Manager is not running");
  });

  it("preloads only non-Collaboration, non-Cortex session plans", async () => {
    const harness = createHarness();
    harness.descriptors.set(
      "collab",
      makeManager("collab", { sessionSurface: "collab" }),
    );
    harness.descriptors.set(
      "cortex",
      makeManager("cortex", { archetypeId: "cortex" }),
    );
    harness.descriptors.set(
      "profile-root",
      makeManager("profile-root", { profileId: undefined }),
    );

    await harness.coordinator.preloadSessionPlanStates();

    expect(harness.options.plans.preload).toHaveBeenCalledWith([
      harness.descriptors.get("manager"),
    ]);
  });

  it("couples choice requests and answers to assistant-output continuation state", async () => {
    const harness = createHarness();
    const answers: ChoiceAnswer[] = [
      { questionId: "q1", selectedOptionIds: ["yes"] },
    ];
    harness.options.choices.requestUserChoiceWithId = vi.fn(() => ({
      choiceId: "choice-1",
      promise: Promise.resolve(answers),
    }));
    harness.options.choices.getPendingChoiceOwner = vi.fn(() => ({
      agentId: "manager",
      sessionAgentId: "manager",
    }));

    await expect(
      harness.coordinator.requestUserChoice("manager", [
        { id: "q1", question: "Continue?" },
      ]),
    ).resolves.toEqual(answers);
    harness.coordinator.resolveChoiceRequest("choice-1", answers);

    expect(harness.options.assistantOutput.rememberChoiceContinuation).toHaveBeenCalledWith(
      "choice-1",
      "manager",
    );
    expect(
      harness.options.runtimeOutput.flushPreservedManagerAssistantOutputForTool,
    ).toHaveBeenCalledWith("manager", "present_choices");
    expect(harness.options.assistantOutput.activateChoiceContinuation).toHaveBeenCalledWith(
      "choice-1",
      "manager",
    );
    expect(harness.options.choices.resolveChoiceRequest).toHaveBeenCalledWith(
      "choice-1",
      answers,
    );
  });

  it("clears continuation state before choice cancellation", () => {
    const harness = createHarness();

    harness.coordinator.cancelChoiceRequest("choice-1", "expired");
    harness.coordinator.cancelAllPendingChoicesForAgent("manager");

    expect(harness.calls).toEqual([
      "output.forget:choice-1",
      "choices.cancel:choice-1:expired",
      "output.clear:manager",
      "choices.cancelAll:manager",
    ]);
  });

  it("records a plan assignment only when spawn did not deliver an initial message", async () => {
    const harness = createHarness();
    const input: SpawnAgentInput = { agentId: "worker", planStep: "Inspect" };

    const spawned = await harness.coordinator.spawnAgent("manager", input);

    expect(spawned.agentId).toBe("worker");
    expect(harness.options.lifecycle.spawnAgent).toHaveBeenCalledWith("manager", input);
    expect(harness.options.plans.recordWorkerAssignment).toHaveBeenCalledWith(
      harness.descriptors.get("manager"),
      expect.objectContaining({ step: "Inspect" }),
      { workerId: "worker", source: "spawn_agent" },
    );

    vi.mocked(harness.options.plans.recordWorkerAssignment).mockClear();
    await harness.coordinator.spawnAgent("manager", {
      ...input,
      initialMessage: "Start now",
    });
    expect(harness.options.plans.recordWorkerAssignment).not.toHaveBeenCalled();
  });

  it("routes Codex Plugin specialist spawn through the scoped delegation owner", async () => {
    const harness = createHarness();
    const input: SpawnAgentInput = {
      agentId: "codex-worker",
      specialist: "codex-plugin",
      planStep: "Research",
    };

    const spawned = await harness.coordinator.spawnAgent("manager", input);

    expect(spawned.agentId).toBe("codex-worker");
    expect(harness.options.codexPlugin.spawnSpecialistWorker).toHaveBeenCalledWith(
      "manager",
      input,
    );
    expect(harness.options.lifecycle.spawnAgent).not.toHaveBeenCalled();
    expect(harness.options.plans.recordWorkerAssignment).not.toHaveBeenCalled();
  });

  it("publishes a user-visible message with routing, output, and activity side effects", async () => {
    const harness = createHarness();

    await expect(
      harness.coordinator.publishToUser(
        "manager",
        "Ready",
        "speak_to_user",
        { channel: "telegram", channelId: "chat-1" },
      ),
    ).resolves.toEqual({
      targetContext: { channel: "telegram", channelId: "chat-1" },
      published: true,
    });

    expect(harness.events).toEqual([
      expect.objectContaining({
        type: "conversation_message",
        agentId: "manager",
        role: "assistant",
        text: "Ready",
        source: "speak_to_user",
      }),
    ]);
    expect(harness.options.runtimeOutput.markExplicitManagerAssistantOutput).toHaveBeenCalledWith(
      "manager",
    );
    expect(harness.options.events.markSessionActivity).toHaveBeenCalledWith(
      "manager",
      NOW,
    );
  });

  it("suppresses stale publication and choices after a newer user turn is queued", async () => {
    const harness = createHarness();
    vi.mocked(harness.options.turns.hasPendingSupersedingUserInput).mockReturnValue(true);

    await expect(
      harness.coordinator.publishToUser("manager", "Stale", "speak_to_user"),
    ).resolves.toMatchObject({ published: false, reason: "superseded_by_user_input" });
    await expect(
      harness.coordinator.requestUserChoice("manager", [{ id: "q1", question: "Stale?" }]),
    ).rejects.toThrow(/newer user message superseded/i);

    expect(harness.events).toEqual([]);
    expect(harness.options.events.markSessionActivity).not.toHaveBeenCalled();
    expect(harness.options.runtimeOutput.markExplicitManagerAssistantOutput).not.toHaveBeenCalled();
    expect(harness.options.choices.requestUserChoiceWithId).not.toHaveBeenCalled();
  });

  it("requires a Telegram channel id and keeps system publication free of manager-only effects", async () => {
    const harness = createHarness();

    await expect(
      harness.coordinator.publishToUser("manager", "Ready", "speak_to_user", {
        channel: "telegram",
      }),
    ).rejects.toThrow("target.channelId is required");

    await harness.coordinator.publishToUser("system-agent", "Maintenance", "system");
    expect(harness.events.at(-1)).toMatchObject({ role: "system", source: "system" });
    expect(harness.options.runtimeOutput.markExplicitManagerAssistantOutput).not.toHaveBeenCalled();
  });

  it("resets the preferred Builder manager by creating a new chat before reset publication", async () => {
    const harness = createHarness();

    await harness.coordinator.resetManagerSession("api_reset");

    expect(harness.calls).toContain("session.create:profile-1:New chat");
    expect(harness.calls).toContain("event.reset:manager:api_reset");
    expect(harness.calls.indexOf("session.create:profile-1:New chat")).toBeLessThan(
      harness.calls.indexOf("event.reset:manager:api_reset"),
    );
  });

  it("denies all interactive capabilities during an external project-agent turn", async () => {
    const harness = createHarness();
    harness.options.turns.getActiveExternalProjectAgentTurn = vi.fn(() => ({
      fromAgentId: "external-reviewer",
      fromDisplayName: "Reviewer",
    }));

    await expect(
      harness.coordinator.killAgent("manager", "worker"),
    ).rejects.toThrow("kill_agent is disabled for this turn");
    await expect(
      harness.coordinator.requestUserChoice("manager", []),
    ).rejects.toThrow("present_choices is disabled for this turn");
    expect(harness.options.lifecycle.killAgent).not.toHaveBeenCalled();
  });
});

interface Harness {
  calls: string[];
  descriptors: Map<string, AgentDescriptor>;
  events: ConversationEvent[];
  options: SessionInteractionCoordinatorOptions;
  coordinator: SessionInteractionCoordinator;
}

type ConversationEvent = Parameters<
  SessionInteractionCoordinatorOptions["events"]["emitConversationMessage"]
>[0];

function createHarness(): Harness {
  const calls: string[] = [];
  const events: ConversationEvent[] = [];
  const descriptors = new Map<string, AgentDescriptor>([
    ["manager", makeManager("manager")],
  ]);
  const worker = makeWorker("worker");
  const normalizedPlan = { plan: [{ step: "Inspect", status: "in_progress" as const }] };
  const planResult = {
    sessionAgentId: "manager",
    revision: 2,
    updatedAt: NOW,
    plan: normalizedPlan.plan,
  };

  const options: SessionInteractionCoordinatorOptions = {
    descriptors,
    directory: {
      assertDescriptorNotEffectivelyArchived: vi.fn(),
      assertManager: vi.fn((agentId) => {
        const descriptor = descriptors.get(agentId);
        if (!descriptor || descriptor.role !== "manager") throw new Error("not manager");
        return descriptor;
      }),
      getRequiredBuilderManagerDescriptor: vi.fn((agentId) => {
        const descriptor = descriptors.get(agentId);
        if (!descriptor || descriptor.role !== "manager") throw new Error("not manager");
        return descriptor as AgentDescriptor & { role: "manager"; profileId: string };
      }),
      getRequiredSessionDescriptor: vi.fn((agentId) => {
        const descriptor = descriptors.get(agentId);
        if (!descriptor || descriptor.role !== "manager") throw new Error("not session");
        return descriptor as AgentDescriptor & { role: "manager"; profileId: string };
      }),
      isSessionAgent: vi.fn(
        (descriptor) => descriptor.role === "manager" && Boolean(descriptor.profileId),
      ),
      resolvePreferredManagerId: vi.fn(() => "manager"),
    },
    plans: {
      getSnapshot: vi.fn(async (owner, requestId) => ({
        type: "session_plan_snapshot",
        sessionAgentId: owner.agentId,
        profileId: owner.profileId,
        revision: 0,
        plan: [],
        ...(requestId ? { requestId } : {}),
      })),
      preload: vi.fn(async () => undefined),
      recordWorkerAssignment: vi.fn(async () => undefined),
      resolveAssignment: vi.fn(async (_owner, step) => ({
        revision: 2,
        stepIndex: 0,
        step,
        status: "in_progress",
      })),
      update: vi.fn(async () => ({ input: normalizedPlan, result: planResult })),
    },
    choices: {
      cancelAllPendingChoicesForAgent: vi.fn((agentId) =>
        calls.push(`choices.cancelAll:${agentId}`),
      ),
      cancelChoiceRequest: vi.fn((choiceId, reason) =>
        calls.push(`choices.cancel:${choiceId}:${reason}`),
      ),
      getPendingChoice: vi.fn(() => undefined),
      getPendingChoiceIdsForSession: vi.fn(() => []),
      getPendingChoiceOwner: vi.fn(() => undefined),
      getPendingChoiceRequestsForSession: vi.fn(() => []),
      hasPendingChoicesForSession: vi.fn(() => false),
      requestUserChoiceWithId: vi.fn(() => ({
        choiceId: "choice-1",
        promise: Promise.resolve([]),
      })),
      resolveChoiceRequest: vi.fn(),
    },
    assistantOutput: {
      activateChoiceContinuation: vi.fn(() => true),
      clearChoiceContinuationsForAgent: vi.fn((agentId) =>
        calls.push(`output.clear:${agentId}`),
      ),
      forgetChoiceContinuation: vi.fn((choiceId) =>
        calls.push(`output.forget:${choiceId}`),
      ),
      rememberChoiceContinuation: vi.fn(),
    },
    runtimeOutput: {
      flushPreservedManagerAssistantOutputForTool: vi.fn(),
      markExplicitManagerAssistantOutput: vi.fn(),
    },
    lifecycle: {
      killAgent: vi.fn(async () => undefined),
      spawnAgent: vi.fn(async (_callerAgentId, input: SpawnAgentInput) => ({
        ...worker,
        agentId: input.agentId ?? worker.agentId,
      })),
    },
    codexPlugin: {
      spawnSpecialistWorker: vi.fn(async (_callerAgentId, input) => ({
        ...worker,
        agentId: input.agentId ?? "codex-worker",
      })),
    },
    turns: {
      getActiveTurnId: vi.fn(() => "turn-1"),
      hasPendingSupersedingUserInput: vi.fn(() => false),
      getActiveExternalProjectAgentTurn: vi.fn(() => undefined),
    },
    sessions: {
      createSession: vi.fn(async (profileId, sessionOptions) => {
        calls.push(`session.create:${profileId}:${sessionOptions?.label}`);
        return {
          profile: makeProfile(),
          sessionAgent: makeManager("new-session", { profileId }),
        };
      }),
    },
    events: {
      emitConversationMessage: (event) => events.push(event),
      emitConversationReset: vi.fn((agentId, reason) =>
        calls.push(`event.reset:${agentId}:${reason}`),
      ),
      markSessionActivity: vi.fn(),
    },
    recordToolSideEffect: vi.fn(),
    now: () => NOW,
    logDebug: vi.fn(),
  };

  return {
    calls,
    descriptors,
    events,
    options,
    coordinator: new SessionInteractionCoordinator(options),
  };
}

function makeManager(
  agentId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId: "profile-1",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: "/workspace",
    model: { provider: "openai", modelId: "gpt-5" },
    sessionFile: `/data/${agentId}.jsonl`,
    ...overrides,
  };
}

function makeWorker(agentId: string): AgentDescriptor {
  return {
    ...makeManager(agentId),
    role: "worker",
    managerId: "manager",
    profileId: "profile-1",
  };
}

function makeProfile(): ManagerProfile {
  return {
    profileId: "profile-1",
    displayName: "Profile",
    defaultSessionAgentId: "manager",
    defaultModel: { provider: "openai", modelId: "gpt-5" },
    createdAt: NOW,
    updatedAt: NOW,
  };
}
