import { describe, expect, it, vi } from "vitest";

import { decodeAgentsStoreFile } from "../agents/descriptor-store/descriptor-codec.js";
import {
  ProfileBootReconciler,
  type ProfileBootMutations,
} from "../agents/descriptor-store/profile-boot-reconciler.js";
import { DEFAULT_MANAGER_POSTURE } from "../prompts/manager-posture.js";
import type { AgentDescriptor, AgentModelDescriptor, ManagerProfile } from "../types.js";

const NOW = "2026-07-13T20:00:00.000Z";
const DEFAULT_MODEL: AgentModelDescriptor = {
  provider: "openai-codex",
  modelId: "gpt-5.5",
  thinkingLevel: "medium",
};

function storeOptions() {
  return {
    dataDir: "/tmp/forge-data",
    storeFilePath: "/tmp/forge-data/swarm/agents.json",
    logDebug: vi.fn(),
    warn: vi.fn(),
  };
}

function manager(agentId: string, profileId: string): AgentDescriptor {
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
  };
}

function profile(profileId: string, overrides: Partial<ManagerProfile> = {}): ManagerProfile {
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

describe("persisted profile posture boundary", () => {
  it("omits an unknown persisted defaultManagerPosture but keeps the profile", () => {
    const options = storeOptions();
    const decoded = decodeAgentsStoreFile(
      JSON.stringify({
        agents: [],
        profiles: [
          {
            ...profile("forge"),
            defaultManagerPosture: "review_led",
          },
        ],
      }),
      options,
    );

    expect(decoded.store.profiles).toHaveLength(1);
    expect(decoded.store.profiles?.[0]).not.toHaveProperty("defaultManagerPosture");
    expect(options.warn).toHaveBeenCalled();
  });

  it("keeps current and omitted persisted postures valid", () => {
    for (const posture of ["delegation_first", "adaptive", "hands_on"] as const) {
      const decoded = decodeAgentsStoreFile(
        JSON.stringify({
          agents: [],
          profiles: [{ ...profile("forge"), defaultManagerPosture: posture }],
        }),
        storeOptions(),
      );
      expect(decoded.store.profiles?.[0]?.defaultManagerPosture).toBe(posture);
    }

    const omitted = decodeAgentsStoreFile(
      JSON.stringify({ agents: [], profiles: [profile("forge")] }),
      storeOptions(),
    );
    expect(omitted.store.profiles?.[0]?.defaultManagerPosture).toBeUndefined();
  });

  it("boot reconciliation falls back to the product default for an unknown persisted posture", () => {
    const session = manager("session", "forge");
    const unknown = profile("forge", {
      defaultManagerPosture: "review_led" as unknown as ManagerProfile["defaultManagerPosture"],
    });
    const descriptors = new Map([[session.agentId, session]]);
    const profiles = new Map([[unknown.profileId, unknown]]);
    const mutations: ProfileBootMutations = {
      upsertDescriptor: (descriptor) => descriptors.set(descriptor.agentId, descriptor),
      upsertProfile: (next) => profiles.set(next.profileId, next),
      deleteProfile: (profileId) => profiles.delete(profileId),
    };
    const reconciler = new ProfileBootReconciler({
      cortexEnabled: true,
      defaultModel: DEFAULT_MODEL,
      descriptors,
      profiles,
      mutations,
      logDebug: vi.fn(),
    });

    expect(reconciler.reconcileDelegationStateOnBoot("global-roster")).toBe(true);
    expect(session.managerPosture).toBe(DEFAULT_MANAGER_POSTURE);
    expect(session.managerPostureOrigin).toBe("product_default");
  });
});
