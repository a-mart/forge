import { describe, expect, it, vi } from "vitest";
import {
  ProfileBootReconciler,
  type ProfileBootMutations,
} from "../agents/descriptor-store/profile-boot-reconciler.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  AgentsStoreFile,
  ManagerProfile,
} from "../types.js";

const NOW = "2026-07-13T20:00:00.000Z";
const DEFAULT_MODEL: AgentModelDescriptor = {
  provider: "openai-codex",
  modelId: "gpt-5.5",
  thinkingLevel: "medium",
};

describe("ProfileBootReconciler", () => {
  it("prunes disabled Cortex managers, review sessions, their workers, and the system profile", () => {
    const harness = createHarness({ cortexEnabled: false });
    const forge = makeManager("forge", "forge");
    const forgeWorker = makeWorker("forge-worker", "forge");
    const cortex = makeManager("cortex", "cortex");
    const cortexWorker = makeWorker("cortex-worker", "cortex");
    const review = makeManager("review-run", "forge", { sessionPurpose: "cortex_review" });
    const reviewWorker = makeWorker("review-worker", "review-run");
    const cortexScopedWorker = makeWorker("cortex-scoped-worker", "forge", {
      profileId: "cortex",
    });
    const store: AgentsStoreFile = {
      agents: [
        forge,
        forgeWorker,
        cortex,
        cortexWorker,
        review,
        reviewWorker,
        cortexScopedWorker,
      ],
      profiles: [makeProfile("forge"), makeProfile("cortex", { profileType: "system" })],
    };

    const result = harness.reconciler.prunePersistedCortexStateForBoot(store);

    expect(result.pruned).toBe(true);
    expect(result.store.agents.map((descriptor) => descriptor.agentId)).toEqual([
      "forge",
      "forge-worker",
    ]);
    expect(result.store.profiles?.map((profile) => profile.profileId)).toEqual(["forge"]);
    expect(harness.logDebug).toHaveBeenCalledWith("boot:cortex:pruned_disabled_state", {
      removedAgents: 5,
      removedProfiles: 1,
    });
    expect(store.agents).toHaveLength(7);
    expect(store.profiles).toHaveLength(2);
  });

  it("returns enabled Cortex state unchanged", () => {
    const harness = createHarness({ cortexEnabled: true });
    const store: AgentsStoreFile = {
      agents: [makeManager("cortex", "cortex")],
      profiles: [makeProfile("cortex")],
    };

    const result = harness.reconciler.prunePersistedCortexStateForBoot(store);

    expect(result).toEqual({ store, pruned: false });
    expect(result.store).toBe(store);
    expect(harness.logDebug).not.toHaveBeenCalled();
  });

  it("creates missing profiles and repairs blank manager profile ids", () => {
    const manager = makeManager("forge", "forge", { profileId: "   " });
    const worker = makeWorker("worker", "forge", {
      model: { ...DEFAULT_MODEL, thinkingLevel: "x-high" },
    });
    const harness = createHarness({ descriptors: [manager, worker] });

    const changed = harness.reconciler.reconcileProfilesOnBoot();

    expect(changed).toBe(true);
    expect(manager.profileId).toBe("forge");
    expect(harness.profiles.get("forge")).toEqual({
      profileId: "forge",
      displayName: "forge",
      defaultSessionAgentId: "forge",
      defaultModel: DEFAULT_MODEL,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(manager.modelOrigin).toBe("profile_default");
    // x-high and xhigh compare as the same persisted model, so boot avoids a
    // cosmetic descriptor write for this legacy spelling.
    expect(worker.model.thinkingLevel).toBe("x-high");
    expect(harness.upsertedDescriptorIds).toContain("forge");
    expect(harness.upsertedDescriptorIds).not.toContain("worker");
  });

  it("repairs a missing default session and infers legacy model origins", () => {
    const root = makeManager("forge", "forge");
    const inherited = makeManager("inherited", "forge");
    const overridden = makeManager("overridden", "forge", {
      model: {
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        thinkingLevel: "high",
      },
    });
    const collab = makeManager("collab", "forge", { sessionSurface: "collab" });
    const profile = makeProfile("forge", { defaultSessionAgentId: "missing" });
    const harness = createHarness({
      descriptors: [root, inherited, overridden, collab],
      profiles: [profile],
    });

    const changed = harness.reconciler.reconcileProfilesOnBoot();

    expect(changed).toBe(true);
    expect(harness.profiles.get("forge")?.defaultSessionAgentId).toBe("forge");
    expect(root.modelOrigin).toBe("profile_default");
    expect(inherited.modelOrigin).toBe("profile_default");
    expect(overridden.modelOrigin).toBe("session_override");
    expect(collab.modelOrigin).toBeUndefined();
  });

  it("synthesizes an invalid profile model from its default session", () => {
    const root = makeManager("forge", "forge", {
      model: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        thinkingLevel: "high",
      },
    });
    const profile = makeProfile("forge", {
      defaultModel: { provider: 42 } as unknown as AgentModelDescriptor,
    });
    const harness = createHarness({ descriptors: [root], profiles: [profile] });

    const changed = harness.reconciler.reconcileProfilesOnBoot();

    expect(changed).toBe(true);
    expect(harness.profiles.get("forge")?.defaultModel).toEqual(root.model);
    expect(root.modelOrigin).toBe("profile_default");
  });

  it("deletes profiles that have neither their configured default nor a root manager", () => {
    const orphan = makeProfile("orphan", { defaultSessionAgentId: "missing" });
    const harness = createHarness({ profiles: [orphan] });

    const changed = harness.reconciler.reconcileProfilesOnBoot();

    expect(changed).toBe(true);
    expect(harness.profiles.has("orphan")).toBe(false);
    expect(harness.deletedProfileIds).toEqual(["orphan"]);
  });

  it("preserves explicit model origins and reports no semantic change for normalized state", () => {
    const root = makeManager("forge", "forge", { modelOrigin: "profile_default" });
    const profile = makeProfile("forge");
    const harness = createHarness({ descriptors: [root], profiles: [profile] });

    const changed = harness.reconciler.reconcileProfilesOnBoot();

    expect(changed).toBe(false);
    expect(root.modelOrigin).toBe("profile_default");
    expect(harness.upsertedProfileIds).toEqual(["forge"]);
  });

  it("persists effective posture and roster inheritance for legacy manager sessions", () => {
    const productDefault = makeManager("product-default", "forge");
    const projectDefault = makeManager("project-default", "forge");
    const explicit = makeManager("explicit", "forge", {
      managerPosture: "hands_on",
      delegationRosterId: "special",
    });
    const collab = makeManager("collab", "forge", { sessionSurface: "collab" });
    const profile = makeProfile("forge", {
      defaultManagerPosture: "hands_on",
      defaultDelegationRosterId: "project-roster",
    });
    const harness = createHarness({
      descriptors: [productDefault, projectDefault, explicit, collab],
      profiles: [profile],
    });

    expect(harness.reconciler.reconcileDelegationStateOnBoot("global-roster")).toBe(true);
    expect(productDefault).toMatchObject({
      managerPosture: "hands_on",
      managerPostureOrigin: "project_default",
      delegationRosterId: "project-roster",
      delegationRosterOrigin: "project_default",
    });
    expect(explicit).toMatchObject({
      managerPosture: "hands_on",
      managerPostureOrigin: "project_default",
      delegationRosterId: "special",
      delegationRosterOrigin: "session_override",
    });
    expect(collab.managerPosture).toBeUndefined();
    expect(harness.reconciler.reconcileDelegationStateOnBoot("global-roster")).toBe(false);
  });

  it("marks the Cortex profile as system and is idempotent", () => {
    const cortex = makeProfile("cortex", { profileType: "user" });
    const harness = createHarness({ profiles: [cortex] });

    expect(harness.reconciler.normalizeSystemProfileTypes()).toBe(true);
    expect(harness.profiles.get("cortex")?.profileType).toBe("system");
    expect(harness.reconciler.normalizeSystemProfileTypes()).toBe(false);
  });

  it("does nothing when no Cortex profile exists", () => {
    const harness = createHarness({ profiles: [makeProfile("forge")] });

    expect(harness.reconciler.normalizeSystemProfileTypes()).toBe(false);
    expect(harness.upsertedProfileIds).toEqual([]);
  });
});

interface Harness {
  reconciler: ProfileBootReconciler;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  upsertedDescriptorIds: string[];
  upsertedProfileIds: string[];
  deletedProfileIds: string[];
  logDebug: ReturnType<typeof vi.fn>;
}

function createHarness(options: {
  cortexEnabled?: boolean;
  descriptors?: AgentDescriptor[];
  profiles?: ManagerProfile[];
} = {}): Harness {
  const descriptors = new Map(
    (options.descriptors ?? []).map((descriptor) => [descriptor.agentId, descriptor]),
  );
  const profiles = new Map(
    (options.profiles ?? []).map((profile) => [profile.profileId, profile]),
  );
  const upsertedDescriptorIds: string[] = [];
  const upsertedProfileIds: string[] = [];
  const deletedProfileIds: string[] = [];
  const logDebug = vi.fn();
  const mutations: ProfileBootMutations = {
    upsertDescriptor: (descriptor) => {
      upsertedDescriptorIds.push(descriptor.agentId);
      descriptors.set(descriptor.agentId, descriptor);
    },
    upsertProfile: (profile) => {
      upsertedProfileIds.push(profile.profileId);
      profiles.set(profile.profileId, {
        ...profile,
        defaultModel: { ...profile.defaultModel },
      });
    },
    deleteProfile: (profileId) => {
      deletedProfileIds.push(profileId);
      profiles.delete(profileId);
    },
  };

  return {
    reconciler: new ProfileBootReconciler({
      cortexEnabled: options.cortexEnabled ?? true,
      defaultModel: DEFAULT_MODEL,
      descriptors,
      profiles,
      mutations,
      logDebug,
    }),
    descriptors,
    profiles,
    upsertedDescriptorIds,
    upsertedProfileIds,
    deletedProfileIds,
    logDebug,
  };
}

function makeProfile(
  profileId: string,
  overrides: Partial<ManagerProfile> = {},
): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: { ...DEFAULT_MODEL },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeManager(
  agentId: string,
  profileId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId,
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: "/workspace",
    model: { ...DEFAULT_MODEL },
    sessionFile: `/sessions/${agentId}.jsonl`,
    ...overrides,
  };
}

function makeWorker(
  agentId: string,
  managerId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    ...makeManager(agentId, managerId),
    role: "worker",
    managerId,
    profileId: undefined,
    ...overrides,
  };
}
