import { describe, expect, it } from "vitest";
import { createAgentDescriptor } from "../../test-support/fixtures.js";
import { AgentDirectory } from "../agent-directory.js";
import type { AgentDescriptor, ManagerProfile } from "../types.js";

const EARLY = "2026-01-01T00:00:00.000Z";
const LATE = "2026-01-02T00:00:00.000Z";

describe("AgentDirectory", () => {
  it("sorts descriptors by configured manager, role, creation time, and id without leaking live state", () => {
    const harness = createHarness({ configuredManagerId: "primary" });
    const primary = manager("primary", "primary", { createdAt: LATE, sessionSystemPrompt: "private" });
    const alpha = manager("alpha", "alpha", { createdAt: EARLY });
    const beta = manager("beta", "beta", { createdAt: EARLY });
    const workerDescriptor = worker("worker", "primary", {
      createdAt: EARLY,
      internalWorkerKind: "codex_plugin",
    });
    addDescriptors(harness, beta, workerDescriptor, primary, alpha);

    const publicRows = harness.directory.listAgents();
    const internalRows = harness.directory.listAgentsForInternalUse();

    expect(publicRows.map(({ agentId }) => agentId)).toEqual(["primary", "alpha", "beta", "worker"]);
    expect(publicRows.find(({ agentId }) => agentId === "primary")).not.toHaveProperty(
      "sessionSystemPrompt",
    );
    expect(publicRows.find(({ agentId }) => agentId === "worker")).not.toHaveProperty(
      "internalWorkerKind",
    );
    expect(internalRows.find(({ agentId }) => agentId === "primary")?.sessionSystemPrompt).toBe(
      "private",
    );
    expect(internalRows.find(({ agentId }) => agentId === "worker")?.internalWorkerKind).toBe(
      "codex_plugin",
    );

    publicRows[0].displayName = "mutated";
    publicRows[0].model.modelId = "mutated";
    expect(primary.displayName).toBe("primary");
    expect(primary.model.modelId).toBe("gpt-5.5");
  });

  it("sorts and clones profiles while excluding system profiles from the user view", () => {
    const harness = createHarness({ configuredManagerId: "primary" });
    const profiles = [
      profile("late", { createdAt: LATE }),
      profile("beta", { sortOrder: 2, createdAt: EARLY }),
      profile("primary", { sortOrder: 99, createdAt: LATE }),
      profile("alpha", { sortOrder: 2, createdAt: EARLY }),
      profile("system", { sortOrder: 1, profileType: "system" }),
    ];
    for (const entry of profiles) harness.profiles.set(entry.profileId, entry);

    const listed = harness.directory.listProfiles();
    expect(listed.map(({ profileId }) => profileId)).toEqual([
      "primary",
      "system",
      "alpha",
      "beta",
      "late",
    ]);
    expect(harness.directory.listUserProfiles().map(({ profileId }) => profileId)).toEqual([
      "primary",
      "alpha",
      "beta",
      "late",
    ]);

    listed[0].displayName = "mutated";
    listed[0].defaultModel.modelId = "mutated";
    expect(harness.profiles.get("primary")?.displayName).toBe("primary");
    expect(harness.profiles.get("primary")?.defaultModel.modelId).toBe("gpt-5.5");
  });

  it("projects legacy sort-order materialization and reorder assignments without mutation", () => {
    const harness = createHarness({ configuredManagerId: "primary" });
    const primary = profile("primary", { sortOrder: 3 });
    const archived = profile("archived", { sortOrder: 1, archivedAt: LATE });
    const system = profile("system", { sortOrder: 2, profileType: "system" });
    const alpha = profile("alpha");
    const beta = profile("beta", { sortOrder: 0 });
    for (const entry of [primary, archived, system, alpha, beta]) {
      harness.profiles.set(entry.profileId, entry);
    }

    expect(harness.directory.getConfiguredManagerId()).toBe("primary");
    expect(harness.directory.materializeProfileSortOrder()).toEqual([
      { profileId: "primary", sortOrder: 0 },
      { profileId: "beta", sortOrder: 1 },
      { profileId: "archived", sortOrder: 2 },
      { profileId: "system", sortOrder: 3 },
      { profileId: "alpha", sortOrder: 4 },
    ]);
    expect(alpha.sortOrder).toBeUndefined();

    alpha.sortOrder = 4;
    expect(harness.directory.materializeProfileSortOrder()).toBeUndefined();
    expect(harness.directory.prepareProfileReorder(["alpha", "primary", "beta"])).toEqual([
      { profileId: "alpha", sortOrder: 0 },
      { profileId: "archived", sortOrder: 1 },
      { profileId: "system", sortOrder: 2 },
      { profileId: "primary", sortOrder: 3 },
      { profileId: "beta", sortOrder: 4 },
    ]);
    expect(primary.sortOrder).toBe(3);

    expect(() => harness.directory.prepareProfileReorder(["alpha", "alpha", "beta"])).toThrow(
      "Duplicate profile IDs in reorder request",
    );
    expect(() => harness.directory.prepareProfileReorder(["alpha", "primary"])).toThrow(
      "Profile ID count mismatch: expected 3 but got 2",
    );
    expect(() => harness.directory.prepareProfileReorder(["alpha", "primary", "archived"])).toThrow(
      "Unknown or non-reorderable profile ID: archived",
    );
  });

  it("projects Builder managers with worker and pending-choice counts", () => {
    const harness = createHarness({
      pendingChoices: new Map([
        ["builder", 3],
        ["collab", 7],
      ]),
    });
    const builder = manager("builder", "profile");
    const collab = manager("collab", "profile", { sessionSurface: "collab" });
    const active = worker("active", "builder", { status: "streaming", sessionSystemPrompt: "secret" });
    const idle = worker("idle", "builder");
    const collabWorker = worker("collab-worker", "collab");
    addDescriptors(harness, collabWorker, idle, collab, active, builder);

    expect(harness.directory.listManagerAgents()).toEqual([
      expect.objectContaining({
        agentId: "builder",
        workerCount: 2,
        activeWorkerCount: 1,
        pendingChoiceCount: 3,
      }),
    ]);
    expect(harness.directory.listBootstrapAgents()).toEqual(
      harness.directory.listManagerAgents(),
    );
    expect(harness.directory.listWorkersForSession("builder").map(({ agentId }) => agentId)).toEqual([
      "active",
      "idle",
    ]);
    expect(harness.directory.listWorkersForSession("collab").map(({ agentId }) => agentId)).toEqual([
      "collab-worker",
    ]);
    expect(harness.directory.listWorkersForSession("builder")[0]).not.toHaveProperty(
      "sessionSystemPrompt",
    );
    expect(harness.directory.getWorkersForManager("builder")).toEqual([active, idle]);
    expect(builder).not.toHaveProperty("workerCount");
  });

  it("reads live maps and separates all profile sessions from Builder sessions", () => {
    const harness = createHarness();
    const builder = manager("builder", "profile");
    const collab = manager("collab", "profile", { sessionSurface: "collab" });
    const other = manager("other", "other");
    addDescriptors(harness, builder, collab, other);

    expect(harness.directory.getSessionsForProfile("profile")).toEqual([builder, collab]);
    expect(harness.directory.getBuilderSessionsForProfile("profile")).toEqual([builder]);
    expect(harness.directory.getAgent("builder")).toEqual(builder);
    expect(harness.directory.getAgent("missing")).toBeUndefined();

    const later = manager("later", "profile", { createdAt: LATE });
    harness.descriptors.set(later.agentId, later);
    expect(harness.directory.getSessionsForProfile("profile")).toEqual([builder, collab, later]);
  });

  it("resolves the configured or earliest available manager with restart semantics", () => {
    const harness = createHarness({ configuredManagerId: "primary" });
    harness.profiles.set("archived", profile("archived", { archivedAt: LATE }));
    addDescriptors(
      harness,
      manager("primary", "primary", { status: "stopped", createdAt: LATE }),
      manager("archived", "archived", { createdAt: EARLY }),
      manager("beta", "beta", { createdAt: EARLY }),
      manager("alpha", "alpha", { createdAt: EARLY }),
      manager("errored", "errored", { status: "error", createdAt: EARLY }),
      worker("worker", "alpha", { createdAt: EARLY }),
    );

    expect(harness.directory.resolvePreferredManagerId()).toBe("alpha");
    expect(
      harness.directory.resolvePreferredManagerId({ includeStoppedOnRestart: true }),
    ).toBe("primary");

    harness.descriptors.get("primary")!.status = "terminated";
    harness.descriptors.get("alpha")!.status = "stopped";
    harness.descriptors.get("beta")!.status = "stopped";
    expect(harness.directory.resolvePreferredManagerId()).toBeUndefined();
  });

  it("enforces session, manager, and Builder/Collaboration lookup contracts", () => {
    const harness = createHarness();
    const builder = manager("builder", "profile");
    const collab = manager("collab", "profile", { sessionSurface: "collab" });
    const legacy = manager("legacy", undefined);
    const child = worker("child", "builder");
    addDescriptors(harness, builder, collab, legacy, child);

    expect(harness.directory.isSessionAgent(builder)).toBe(true);
    expect(harness.directory.isSessionAgent(legacy)).toBe(false);
    expect(harness.directory.getRequiredSessionDescriptor("builder")).toBe(builder);
    expect(() => harness.directory.getRequiredSessionDescriptor("child")).toThrow(
      "Unknown session agent: child",
    );
    expect(() => harness.directory.getRequiredBuilderSessionDescriptor("collab", "edit")).toThrow(
      "Cannot edit for collaboration-backed session collab.",
    );
    expect(() =>
      harness.directory.getRequiredCollaborationSessionDescriptor("builder", "edit"),
    ).toThrow("Cannot edit for Builder session builder.");
    expect(harness.directory.getRequiredManagerDescriptor("builder")).toBe(builder);
    expect(() => harness.directory.getRequiredManagerDescriptor("child")).toThrow(
      "Unknown manager: child",
    );
    expect(() => harness.directory.getRequiredBuilderManagerDescriptor("collab", "reset")).toThrow(
      "Cannot reset for collaboration-backed session collab.",
    );
  });

  it("inherits archive state from manager and profile with exact operation messages", () => {
    const harness = createHarness();
    const direct = manager("direct", "active", { archivedAt: LATE });
    const projectSession = manager("project-session", "archived-project");
    const child = worker("child", "project-session");
    const orphan = worker("orphan", "missing");
    harness.profiles.set("active", profile("active"));
    harness.profiles.set("archived-project", profile("archived-project", { archivedAt: LATE }));
    addDescriptors(harness, direct, projectSession, child, orphan);

    expect(harness.directory.getDescriptorArchiveBlockReason(direct)).toBe(
      "Archived sessions can’t be used until restored.",
    );
    expect(harness.directory.getDescriptorArchiveBlockReason(child)).toBe(
      "Archived projects can’t be used until restored.",
    );
    expect(harness.directory.getDescriptorArchiveBlockReason(orphan)).toBeUndefined();
    expect(harness.directory.isAgentEffectivelyArchived("child")).toBe(true);
    expect(harness.directory.isAgentEffectivelyArchived("missing")).toBe(false);
    expect(() => harness.directory.assertDescriptorNotEffectivelyArchived(direct)).toThrow(
      "Archived sessions can’t be used until restored.",
    );
    expect(() => harness.directory.assertProfileNotArchived("archived-project")).toThrow(
      "Archived projects can’t be used until restored.",
    );
    expect(() =>
      harness.directory.assertManagerSettingsTargetNotArchived("project-session", "change model"),
    ).toThrow("Archived projects can’t be used until restored.");
  });

  it("guards project-agent promotion and default-session deletion", () => {
    const harness = createHarness();
    const root = manager("profile", "profile");
    const ordinary = manager("ordinary", "profile");
    const collab = manager("collab", "profile", { sessionSurface: "collab" });
    const cortex = manager("cortex", "cortex");
    const review = manager("review", "profile", { sessionPurpose: "cortex_review" });
    const creator = manager("creator", "profile", { sessionPurpose: "agent_creator" });
    harness.profiles.set("profile", profile("profile"));
    addDescriptors(harness, root, ordinary, collab, cortex, review, creator);

    expect(() => harness.directory.assertSessionSupportsProjectAgent(ordinary)).not.toThrow();
    expect(() => harness.directory.assertSessionSupportsProjectAgent(collab)).toThrow(
      "Cannot promote Builder sessions to project agents for collaboration-backed session collab.",
    );
    expect(() => harness.directory.assertSessionSupportsProjectAgent(cortex)).toThrow(
      "Cortex root cannot be promoted to a project agent",
    );
    expect(() => harness.directory.assertSessionSupportsProjectAgent(review)).toThrow(
      "Cortex review sessions cannot be promoted to project agents",
    );
    expect(() => harness.directory.assertSessionSupportsProjectAgent(creator)).toThrow(
      "Agent creator sessions cannot be promoted to project agents",
    );
    expect(() => harness.directory.assertSessionIsDeletable(root)).toThrow(
      "Cannot delete default session: profile",
    );
    expect(() => harness.directory.assertSessionIsDeletable(ordinary)).not.toThrow();
  });

  it("generates normalized unique ids and reserves the configured manager for workers", () => {
    const harness = createHarness({ configuredManagerId: "manager" });
    addDescriptors(harness, manager("worker", "worker"), manager("worker-2", "worker-2"));

    expect(harness.directory.generateUniqueAgentId(" New Worker ")).toBe("new-worker");
    expect(harness.directory.generateUniqueAgentId("worker")).toBe("worker-3");
    expect(harness.directory.generateUniqueManagerId("worker")).toBe("worker-3");
    expect(() => harness.directory.generateUniqueAgentId("manager")).toThrow(
      'spawn_agent agentId "manager" is reserved',
    );
    expect(() => harness.directory.generateUniqueAgentId("___")).toThrow(
      "spawn_agent agentId must include at least one letter or number",
    );
    expect(() => harness.directory.generateUniqueManagerId("___")).toThrow(
      "create_manager name must include at least one letter or number",
    );
  });

  it("requires a running manager and can ignore Cortex when checking availability", () => {
    const harness = createHarness();
    const cortex = manager("cortex", "cortex", { archetypeId: " CORTEX " });
    const stopped = manager("stopped", "stopped", { status: "stopped" });
    const workerDescriptor = worker("worker", "cortex");
    addDescriptors(harness, cortex, stopped, workerDescriptor);

    expect(harness.directory.assertManager("cortex", "speak")).toBe(cortex);
    expect(() => harness.directory.assertManager("stopped", "speak")).toThrow(
      "Manager is not running: stopped",
    );
    expect(() => harness.directory.assertManager("worker", "speak")).toThrow(
      "Only manager can speak",
    );
    expect(harness.directory.hasRunningManagers()).toBe(true);
    expect(harness.directory.hasRunningManagers({ excludeCortex: true })).toBe(false);
  });
});

interface Harness {
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  directory: AgentDirectory;
}

function createHarness(options?: {
  configuredManagerId?: string;
  pendingChoices?: ReadonlyMap<string, number>;
}): Harness {
  const descriptors = new Map<string, AgentDescriptor>();
  const profiles = new Map<string, ManagerProfile>();
  return {
    descriptors,
    profiles,
    directory: new AgentDirectory({
      descriptors,
      profiles,
      configuredManagerId: options?.configuredManagerId,
      getPendingChoiceCount: (agentId) => options?.pendingChoices?.get(agentId) ?? 0,
    }),
  };
}

function addDescriptors(harness: Harness, ...descriptors: AgentDescriptor[]): void {
  for (const descriptor of descriptors) harness.descriptors.set(descriptor.agentId, descriptor);
}

function manager(
  agentId: string,
  profileId: string | undefined,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return createAgentDescriptor({
    agentId,
    role: "manager",
    managerId: agentId,
    displayName: agentId,
    profileId,
    ...overrides,
  });
}

function worker(
  agentId: string,
  managerId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return createAgentDescriptor({
    agentId,
    role: "worker",
    managerId,
    displayName: agentId,
    ...overrides,
  });
}

function profile(profileId: string, overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    createdAt: EARLY,
    updatedAt: EARLY,
    ...overrides,
  };
}
