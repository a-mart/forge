import { describe, expect, it, vi } from "vitest";
import {
  SwarmManagerFacade,
  type SwarmManagerFacadeServices,
} from "../swarm-manager-facade.js";

describe("SwarmManagerSessionFacade", () => {
  it("keeps interactive command arguments and results intact", async () => {
    const services = createServices();
    const facade = new TestFacade(services);
    const planInput = { plan: [{ step: "Inspect", status: "in_progress" as const }] };

    await expect(facade.updatePlan("manager", "tool-1", planInput)).resolves.toEqual({
      revision: 1,
    });
    await expect(
      facade.publishToUser("manager", "Ready", "speak_to_user", { channel: "web" }),
    ).resolves.toEqual({ targetContext: { channel: "web" } });
    await facade.spawnAgent("manager", { agentId: "worker" });
    await facade.resetManagerSession("manager", "user_new_command");

    expect(services.interactions.updatePlan).toHaveBeenCalledWith(
      "manager",
      "tool-1",
      planInput,
    );
    expect(services.interactions.publishToUser).toHaveBeenCalledWith(
      "manager",
      "Ready",
      "speak_to_user",
      { channel: "web" },
    );
    expect(services.interactions.spawnAgent).toHaveBeenCalledWith("manager", {
      agentId: "worker",
    });
    expect(services.interactions.resetManagerSession).toHaveBeenCalledWith(
      "manager",
      "user_new_command",
    );
  });

  it("exposes the existing session, pin, project-agent, and profile facade", async () => {
    const services = createServices();
    const facade = new TestFacade(services);

    await facade.createSession("profile-1", { label: "Review" });
    await facade.archiveSession("session-1");
    await facade.pinMessage("session-1", "message-1", true);
    await facade.activateRepoProjectAgent({
      profileId: "profile-1",
      source: { kind: "repo", relativePath: ".forge/specialists/reviewer.md" },
    });
    await facade.renameProfile("profile-1", "New name");

    expect(services.sessions.createSession).toHaveBeenCalledWith("profile-1", {
      label: "Review",
    });
    expect(services.sessions.archiveSession).toHaveBeenCalledWith("session-1");
    expect(services.pins.pinMessage).toHaveBeenCalledWith(
      "session-1",
      "message-1",
      true,
    );
    expect(services.projectAgents.activateRepoProjectAgent).toHaveBeenCalledTimes(1);
    expect(services.profileBookkeeping.renameProfile).toHaveBeenCalledWith(
      "profile-1",
      "New name",
    );
  });

  it("closes the Codex Plugin scope before stopping a worker", async () => {
    const calls: string[] = [];
    const services = createServices();
    services.codexPlugin.markWorkerStoppedAndCloseScope = vi.fn(() => calls.push("codex"));
    services.agents.stopWorker = vi.fn(async () => {
      calls.push("lifecycle");
    });
    const facade = new TestFacade(services);

    await facade.stopWorker("worker");

    expect(calls).toEqual(["codex", "lifecycle"]);
  });

  it("preserves message defaults and user-message/knowledge delegates", async () => {
    const services = createServices();
    const facade = new TestFacade(services);

    await facade.sendMessage("manager", "worker", "Do it");
    await facade.compactAgentContext("manager", { reason: "manual" });
    await facade.appendConversationUserMessage("Hello", { targetAgentId: "manager" });
    await facade.handleUserMessage("Hello", { targetAgentId: "manager" });

    expect(services.messages.sendMessage).toHaveBeenCalledWith(
      "manager",
      "worker",
      "Do it",
      "auto",
      undefined,
    );
    expect(services.knowledge.compact).toHaveBeenCalledWith("manager", {
      reason: "manual",
    });
    expect(services.userMessages.appendConversationUserMessage).toHaveBeenCalledWith(
      "Hello",
      { targetAgentId: "manager" },
    );
    expect(services.userMessages.handleUserMessage).toHaveBeenCalledWith("Hello", {
      targetAgentId: "manager",
    });
  });
});

class TestFacade extends SwarmManagerFacade {
  constructor(private readonly facadeServices: SwarmManagerFacadeServices) {
    super();
  }

  protected getFacadeServices(): SwarmManagerFacadeServices {
    return this.facadeServices;
  }
}

function createServices(): SwarmManagerFacadeServices {
  const interactions = {
    getSessionPlanSnapshot: vi.fn(async () => ({ revision: 0 })),
    updatePlan: vi.fn(async () => ({ revision: 1 })),
    requestUserChoice: vi.fn(async () => []),
    resolveChoiceRequest: vi.fn(),
    cancelChoiceRequest: vi.fn(),
    cancelAllPendingChoicesForAgent: vi.fn(),
    hasPendingChoicesForSession: vi.fn(() => false),
    getPendingChoiceIdsForSession: vi.fn(() => []),
    getPendingChoiceRequestsForSession: vi.fn(() => []),
    getPendingChoiceOwner: vi.fn(() => undefined),
    getPendingChoice: vi.fn(() => undefined),
    spawnAgent: vi.fn(async () => ({ agentId: "worker" })),
    killAgent: vi.fn(async () => undefined),
    publishToUser: vi.fn(async () => ({ targetContext: { channel: "web" } })),
    resetManagerSession: vi.fn(async () => undefined),
  };
  const sessions = {
    createSession: vi.fn(async () => ({ profile: {}, sessionAgent: {} })),
    createSessionWithOverrides: vi.fn(async () => ({ profile: {}, sessionAgent: {} })),
    createSessionFromBaseDescriptor: vi.fn(async () => ({ profile: {}, sessionAgent: {} })),
    createSessionFromAgent: vi.fn(async () => ({
      sessionAgentId: "session",
      sessionLabel: "Session",
      profileId: "profile-1",
    })),
    createAndPromoteProjectAgent: vi.fn(async () => ({
      agentId: "agent",
      handle: "agent",
      profileId: "profile-1",
    })),
    archiveSession: vi.fn(async () => ({})),
    restoreSession: vi.fn(async () => ({})),
    hydrateArchivedLastUsed: vi.fn(async () => ({})),
    archiveProfile: vi.fn(async () => ({})),
    restoreProfile: vi.fn(async () => ({})),
    stopSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
    stopCollaborationSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
    resumeSession: vi.fn(async () => undefined),
    deleteCollaborationSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
    deleteSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
    clearSessionConversation: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({ profile: {}, sessionAgent: {} })),
    stopAllAgents: vi.fn(async () => ({ managerId: "manager" })),
    createManager: vi.fn(async () => ({ agentId: "manager" })),
    deleteManager: vi.fn(async () => ({ managerId: "manager", terminatedWorkerIds: [] })),
  };
  const pins = {
    pinMessage: vi.fn(async () => ({ pinned: true, timestamp: "now" })),
    clearAllPins: vi.fn(async () => undefined),
    pinSession: vi.fn(async () => ({ pinnedAt: "now" })),
  };
  const projectAgents = {
    activateRepoProjectAgent: vi.fn(async () => ({})),
    setSessionProjectAgent: vi.fn(async () => ({})),
    requestRecommendations: vi.fn(async () => ({})),
  };
  const profileBookkeeping = {
    renameProfile: vi.fn(async () => undefined),
  };
  const knowledge = {
    compact: vi.fn(async () => undefined),
    smartCompact: vi.fn(async () => ({})),
    mergeSessionMemory: vi.fn(async () => ({})),
  };
  const agents = {
    stopWorker: vi.fn(async () => undefined),
    resumeWorker: vi.fn(async () => undefined),
  };
  const codexPlugin = {
    markWorkerStoppedAndCloseScope: vi.fn(),
  };
  const messages = {
    sendMessage: vi.fn(async () => ({ acceptedMode: "queued" })),
  };
  const userMessages = {
    appendConversationUserMessage: vi.fn(async () => ({})),
    dispatchRuntimeUserMessage: vi.fn(async () => undefined),
    handleUserMessage: vi.fn(async () => undefined),
  };

  return {
    interactions,
    sessions,
    pins,
    projectAgents,
    profileBookkeeping,
    knowledge,
    agents,
    codexPlugin,
    messages,
    userMessages,
  } as unknown as SwarmManagerFacadeServices;
}
