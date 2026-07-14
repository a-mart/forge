import { describe, expect, it, vi } from "vitest";
import {
  SessionLifecycleCoordinator,
  type SessionLifecycleCoordinatorOptions,
} from "../session-lifecycle-coordinator.js";
import type { AgentDescriptor, ManagerProfile } from "../types.js";

const NOW = "2026-07-13T20:00:00.000Z";

describe("SessionLifecycleCoordinator", () => {
  it("guards creation, delegates descriptor construction, then dispatches the extension hook", async () => {
    const harness = createHarness();
    const created = makeCreatedSession("forge--s2");
    harness.deps.sessions.createSession = vi.fn(async () => {
      harness.calls.push("sessions.create");
      return created;
    });
    harness.deps.extensions.dispatchSessionLifecycle = vi.fn(async () => {
      harness.calls.push("extensions.created");
    });

    await expect(
      harness.coordinator.createSession("forge", { name: "Review" }),
    ).resolves.toBe(created);
    expect(harness.calls).toEqual(["sessions.create", "extensions.created"]);
    expect(harness.deps.sessions.createSession).toHaveBeenCalledWith("forge", {
      name: "Review",
    });

    harness.profiles.get("forge")!.archivedAt = NOW;
    await expect(harness.coordinator.createSession("forge")).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    );
    expect(harness.deps.sessions.createSession).toHaveBeenCalledTimes(1);
  });

  it("archives a session in capture, Codex, archive, tools, snapshot order", async () => {
    const harness = createHarness();
    harness.deps.capture.run = vi.fn(async () => harness.calls.push("capture"));
    harness.deps.archive.archiveSession = vi.fn(async () => {
      harness.calls.push("archive");
      return {
        agentId: "forge--s2",
        profileId: "forge",
        archivedAt: NOW,
        terminatedWorkerIds: ["worker-1"],
      };
    });

    const result = await harness.coordinator.archiveSession("forge--s2");

    expect(result.terminatedWorkerIds).toEqual(["worker-1"]);
    expect(harness.calls).toEqual([
      "capture",
      "codex.close:forge--s2",
      "archive",
      "tools:forge--s2",
      "events.agents",
    ]);
  });

  it("keeps profile archive terminal suspension fail-open and preserves notification order", async () => {
    const harness = createHarness();
    harness.deps.archive.archiveProfile = vi.fn(async () => {
      harness.calls.push("archive.profile");
      return {
        profileId: "forge",
        archivedAt: NOW,
        terminatedWorkerIds: [],
      };
    });
    harness.deps.terminal.getHooks = () => ({
      suspendProfileTerminals: async () => {
        harness.calls.push("terminal.suspend");
        throw new Error("pty unavailable");
      },
      restoreProfileTerminals: vi.fn(async () => undefined),
    });

    await expect(harness.coordinator.archiveProfile("forge")).resolves.toMatchObject({
      profileId: "forge",
    });

    expect(harness.calls).toEqual([
      "codex.close:forge",
      "codex.close:forge--s2",
      "archive.profile",
      "tools:forge",
      "tools:forge--s2",
      "terminal.suspend",
      "log:archive:terminal_suspend:error",
      "events.profiles",
      "events.agents",
      "events.lifecycle:archived",
    ]);
  });

  it("deletes a Builder session in cleanup order and stops after a service failure", async () => {
    const harness = createHarness();
    harness.deps.sessions.deleteSession = vi.fn(async () => {
      harness.calls.push("sessions.delete");
      return { terminatedWorkerIds: ["worker-1"] };
    });
    harness.deps.extensions.dispatchSessionLifecycle = vi.fn(async () => {
      harness.calls.push("extensions.deleted");
    });

    await harness.coordinator.deleteSession("forge--s2");
    expect(harness.calls).toEqual([
      "codex.close:forge--s2",
      "sessions.delete",
      "plans:forge--s2",
      "tools:forge--s2",
      "extensions.deleted",
    ]);

    harness.calls.length = 0;
    harness.deps.sessions.deleteSession = vi.fn(async () => {
      harness.calls.push("sessions.delete");
      throw new Error("disk failed");
    });
    await expect(harness.coordinator.deleteSession("forge--s2")).rejects.toThrow(
      "disk failed",
    );
    expect(harness.calls).toEqual([
      "codex.close:forge--s2",
      "sessions.delete",
    ]);
  });

  it("validates the session surface before stop cleanup", async () => {
    const harness = createHarness();
    harness.deps.lifecycle.stopSession = vi.fn(async () => {
      harness.calls.push("lifecycle.stop");
      return { terminatedWorkerIds: [] };
    });

    await harness.coordinator.stopSession("forge--s2");
    expect(harness.calls).toEqual([
      "codex.close:forge--s2",
      "lifecycle.stop",
      "tools:forge--s2",
    ]);

    harness.calls.length = 0;
    harness.descriptors.get("forge--s2")!.sessionSurface = "collab";
    await expect(harness.coordinator.stopSession("forge--s2")).rejects.toThrow(
      "Cannot stop Builder sessions",
    );
    expect(harness.calls).toEqual([]);
  });

  it("forks only active Builder sessions and sends a stable source snapshot to extensions", async () => {
    const harness = createHarness();
    const source = harness.descriptors.get("forge--s2")!;
    const forked = makeCreatedSession("forge--s3");
    harness.deps.sessions.forkSession = vi.fn(async () => {
      harness.calls.push("sessions.fork");
      source.sessionLabel = "Changed after fork";
      return forked;
    });
    harness.deps.extensions.dispatchSessionLifecycle = vi.fn(async (event) => {
      harness.calls.push(`extensions.${event.action}`);
      expect(event.sourceDescriptor?.sessionLabel).toBe("Session 2");
    });

    await expect(
      harness.coordinator.forkSession("forge--s2", { fromMessageId: "message-1" }),
    ).resolves.toBe(forked);
    expect(harness.calls).toEqual(["sessions.fork", "extensions.forked"]);
  });

  it("creates a child session, persists attribution, delivers the initial message, then emits the hook", async () => {
    const harness = createHarness();
    const creator = harness.descriptors.get("forge--s2")!;
    creator.projectAgent = makeProjectAgent(["create_session"]);
    creator.modelOrigin = "session_override";
    const created = makeCreatedSession("review-session");
    harness.deps.sessions.createSessionWithOverrides = vi.fn(async () => {
      harness.calls.push("sessions.createWithOverrides");
      return created;
    });
    harness.deps.descriptorMutations.patchDescriptor = vi.fn(async (agentId, patch) => {
      harness.calls.push("descriptor.patch");
      const descriptor = { ...created.sessionAgent, ...patch };
      harness.descriptors.set(agentId, descriptor);
      return descriptor;
    });
    harness.deps.runtime.sendInitialMessage = vi.fn(async () => {
      harness.calls.push("runtime.send");
    });
    harness.deps.extensions.dispatchSessionLifecycle = vi.fn(async () => {
      harness.calls.push("extensions.created");
    });

    const result = await harness.coordinator.createSessionFromAgent("forge--s2", {
      sessionName: " Review session ",
      cwd: " /workspace/review ",
      initialMessage: " Begin review ",
    });

    expect(result).toEqual({
      sessionAgentId: "review-session",
      sessionLabel: "review-session",
      profileId: "forge",
    });
    expect(harness.calls).toEqual([
      "access:create_session",
      "runtime.cwd:/workspace/review",
      "sessions.createWithOverrides",
      "descriptor.patch",
      "events.agents",
      "events.profiles",
      "runtime.send",
      "extensions.created",
    ]);
    expect(harness.deps.runtime.sendInitialMessage).toHaveBeenCalledWith(
      "forge--s2",
      "review-session",
      "Begin review",
    );
    expect(harness.deps.sessions.createSessionWithOverrides).toHaveBeenCalledWith(
      "forge",
      { name: "Review session", label: "Review session", sessionPurpose: undefined },
      expect.objectContaining({
        cwd: "/validated/workspace/review",
        model: expect.objectContaining({ provider: "openai", modelId: "gpt-5" }),
      }),
    );
  });

  it("rolls back failed initial delivery and preserves the delivery error when rollback also fails", async () => {
    const harness = createHarness();
    harness.descriptors.get("forge--s2")!.projectAgent = makeProjectAgent([
      "create_session",
    ]);
    const created = makeCreatedSession("review-session");
    harness.deps.sessions.createSessionWithOverrides = vi.fn(async () => created);
    harness.deps.descriptorMutations.patchDescriptor = vi.fn(async (_agentId, patch) => ({
      ...created.sessionAgent,
      ...patch,
    }));
    harness.deps.runtime.sendInitialMessage = vi.fn(async () => {
      throw new Error("delivery failed");
    });
    harness.deps.sessions.deleteSession = vi.fn(async () => {
      harness.calls.push("rollback.delete");
      throw new Error("rollback failed");
    });

    await expect(
      harness.coordinator.createSessionFromAgent("forge--s2", {
        sessionName: "Review",
        initialMessage: "Start",
      }),
    ).rejects.toThrow("delivery failed");

    expect(harness.calls).toContain("rollback.delete");
    expect(harness.calls).toContain("log:createSessionFromAgent rollback failed");
    expect(harness.deps.extensions.dispatchSessionLifecycle).not.toHaveBeenCalled();
  });
});

interface Harness {
  calls: string[];
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  deps: SessionLifecycleCoordinatorOptions;
  coordinator: SessionLifecycleCoordinator;
}

function createHarness(): Harness {
  const calls: string[] = [];
  const profiles = new Map([["forge", makeProfile()]]);
  const descriptors = new Map<string, AgentDescriptor>([
    ["forge", makeManagerDescriptor("forge", { sessionLabel: "Root" })],
    ["forge--s2", makeManagerDescriptor("forge--s2", { sessionLabel: "Session 2" })],
  ]);

  const deps: SessionLifecycleCoordinatorOptions = {
    descriptors,
    profiles,
    sessions: {
      createSession: vi.fn(async () => makeCreatedSession("created")),
      createSessionWithOverrides: vi.fn(async () => makeCreatedSession("created")),
      createSessionFromBaseDescriptor: vi.fn(async () => makeCreatedSession("created")),
      deleteSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
      deleteCollaborationSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
      clearSessionConversation: vi.fn(async () => undefined),
      renameSession: vi.fn(async () => undefined),
      forkSession: vi.fn(async () => makeCreatedSession("forked")),
    },
    lifecycle: {
      stopSession: vi.fn(async () => ({ terminatedWorkerIds: [] })),
      resumeSession: vi.fn(async () => undefined),
      stopAllAgents: vi.fn(async () => ({
        managerId: "forge",
        stoppedWorkerIds: [],
        managerStopped: true,
        terminatedWorkerIds: [],
        managerTerminated: true,
      })),
      createManager: vi.fn(async () => makeManagerDescriptor("created-manager")),
      deleteManager: vi.fn(async () => ({ managerId: "forge", terminatedWorkerIds: [] })),
    },
    archive: {
      archiveSession: vi.fn(async () => ({
        agentId: "forge--s2",
        profileId: "forge",
        archivedAt: NOW,
        terminatedWorkerIds: [],
      })),
      restoreSession: vi.fn(async () => ({
        agentId: "forge--s2",
        profileId: "forge",
        openAgentId: "forge--s2",
      })),
      archiveProfile: vi.fn(async () => ({
        profileId: "forge",
        archivedAt: NOW,
        terminatedWorkerIds: [],
      })),
      restoreProfile: vi.fn(async () => ({
        profileId: "forge",
        openAgentId: "forge",
      })),
    },
    archiveHydrator: {
      hydrateArchivedRowsIfMissing: vi.fn(async () => ({
        scannedSessionCount: 0,
        hydratedSessionCount: 0,
      })),
    },
    projectAgents: {
      createAndPromoteProjectAgent: vi.fn(async () => ({
        agentId: "project-agent",
        handle: "project-agent",
        profileId: "forge",
      })),
    },
    capture: {
      run: vi.fn(async () => undefined),
    },
    plans: {
      forget: (agentId) => calls.push(`plans:${agentId}`),
    },
    extensions: {
      dispatchSessionLifecycle: vi.fn(async () => undefined),
    },
    codex: {
      closeManagerScopesAndRetry: (agentId) => calls.push(`codex.close:${agentId}`),
    },
    activeTools: {
      clearSession: (agentId) => calls.push(`tools:${agentId}`),
    },
    events: {
      emitAgentsSnapshot: () => calls.push("events.agents"),
      emitProfilesSnapshot: () => calls.push("events.profiles"),
      emitSessionLifecycle: (event) => calls.push(`events.lifecycle:${event.action}`),
    },
    terminal: {
      getHooks: () => undefined,
    },
    descriptorMutations: {
      patchDescriptor: vi.fn(async (agentId, patch) => {
        const current = descriptors.get(agentId);
        if (!current) throw new Error(`Unknown session agent: ${agentId}`);
        const updated = { ...current, ...patch };
        descriptors.set(agentId, updated);
        return updated;
      }),
    },
    runtime: {
      resolveAndValidateCwd: vi.fn(async (cwd) => {
        calls.push(`runtime.cwd:${cwd}`);
        return `/validated${cwd}`;
      }),
      beforeResumeSession: vi.fn(async () => undefined),
      sendInitialMessage: vi.fn(async () => undefined),
    },
    projectAgentAccess: {
      assertExternalCapability: (_agentId, capability) => calls.push(`access:${capability}`),
      notifySharedTargetsChanged: vi.fn(async () => undefined),
    },
    logDebug: (message) => calls.push(`log:${message}`),
  };

  return {
    calls,
    descriptors,
    profiles,
    deps,
    coordinator: new SessionLifecycleCoordinator(deps),
  };
}

function makeCreatedSession(agentId: string): {
  profile: ManagerProfile;
  sessionAgent: AgentDescriptor;
} {
  return {
    profile: makeProfile(),
    sessionAgent: makeManagerDescriptor(agentId, {
      displayName: agentId,
      sessionLabel: agentId,
    }),
  };
}

function makeProfile(): ManagerProfile {
  return {
    profileId: "forge",
    displayName: "Forge",
    defaultSessionAgentId: "forge",
    defaultModel: { provider: "openai", modelId: "gpt-5" },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeManagerDescriptor(
  agentId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId: "forge",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: "/workspace/forge",
    model: { provider: "openai", modelId: "gpt-5" },
    sessionFile: `/data/${agentId}.jsonl`,
    ...overrides,
  };
}

function makeProjectAgent(
  capabilities: NonNullable<AgentDescriptor["projectAgent"]>["capabilities"],
): NonNullable<AgentDescriptor["projectAgent"]> {
  return {
    handle: "reviewer",
    whenToUse: "When a review is needed",
    systemPrompt: "Review carefully",
    capabilities,
  };
}
