import { normalizePersistedSwarmModelDescriptor } from "../../model-presets.js";
import { normalizeOptionalAgentId } from "../../swarm-manager-utils.js";
import { DEFAULT_MANAGER_POSTURE } from "../../prompts/manager-posture.js";
import { isManagerPosture } from "@forge/protocol";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  AgentsStoreFile,
  ManagerProfile,
} from "../../types.js";

const CORTEX_PROFILE_ID = "cortex";

export interface ProfileBootMutations {
  upsertDescriptor(descriptor: AgentDescriptor): void;
  upsertProfile(profile: ManagerProfile): void;
  deleteProfile(profileId: string): void;
}

export interface ProfileBootReconcilerOptions {
  cortexEnabled: boolean;
  defaultModel: AgentModelDescriptor;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  mutations: ProfileBootMutations;
  logDebug(message: string, details?: Record<string, unknown>): void;
}

/**
 * Owns boot-time repair of the persisted relationship between manager session
 * descriptors and profiles. Runtime restoration and filesystem provisioning
 * deliberately remain outside this in-memory reconciliation boundary.
 */
export class ProfileBootReconciler {
  constructor(private readonly options: ProfileBootReconcilerOptions) {}

  reconcileProfilesOnBoot(): boolean {
    let changed = false;
    const managerDescriptorsById = new Map<string, AgentDescriptor>();

    for (const descriptor of this.options.descriptors.values()) {
      const normalizedDescriptorModel = cloneModelDescriptor(descriptor.model);
      if (!sameModelDescriptor(descriptor.model, normalizedDescriptorModel)) {
        descriptor.model = normalizedDescriptorModel;
        this.options.mutations.upsertDescriptor(descriptor);
        changed = true;
      }

      if (descriptor.delegationFallbackModel) {
        const normalizedFallbackModel = cloneModelDescriptor(descriptor.delegationFallbackModel);
        if (!sameModelDescriptor(descriptor.delegationFallbackModel, normalizedFallbackModel)) {
          descriptor.delegationFallbackModel = normalizedFallbackModel;
          this.options.mutations.upsertDescriptor(descriptor);
          changed = true;
        }
      }

      if (descriptor.role !== "manager") {
        continue;
      }

      const reconciledProfileId =
        normalizeOptionalAgentId(descriptor.profileId) ?? descriptor.agentId;
      if (descriptor.profileId !== reconciledProfileId) {
        descriptor.profileId = reconciledProfileId;
        this.options.mutations.upsertDescriptor(descriptor);
        changed = true;
      }

      managerDescriptorsById.set(descriptor.agentId, descriptor);

      if (this.options.profiles.has(reconciledProfileId)) {
        continue;
      }

      this.options.mutations.upsertProfile({
        profileId: reconciledProfileId,
        displayName: descriptor.displayName,
        defaultSessionAgentId: reconciledProfileId,
        defaultModel: { ...descriptor.model },
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.createdAt,
      });
      changed = true;
    }

    for (const [profileId, profile] of Array.from(this.options.profiles.entries())) {
      let defaultSessionDescriptor = managerDescriptorsById.get(profile.defaultSessionAgentId);
      if (!defaultSessionDescriptor || defaultSessionDescriptor.role !== "manager") {
        const rootSessionDescriptor = managerDescriptorsById.get(profileId);
        if (!rootSessionDescriptor || rootSessionDescriptor.role !== "manager") {
          this.options.mutations.deleteProfile(profileId);
          changed = true;
          continue;
        }

        profile.defaultSessionAgentId = rootSessionDescriptor.agentId;
        defaultSessionDescriptor = rootSessionDescriptor;
        changed = true;
      }

      const profileSessions = this.getBuilderSessionsForProfile(profileId);
      if (profileSessions.length === 0) {
        const rootSessionDescriptor = managerDescriptorsById.get(profileId);
        if (!rootSessionDescriptor || rootSessionDescriptor.role !== "manager") {
          this.options.mutations.deleteProfile(profileId);
          changed = true;
          continue;
        }

        if (rootSessionDescriptor.profileId !== profileId) {
          rootSessionDescriptor.profileId = profileId;
          this.options.mutations.upsertDescriptor(rootSessionDescriptor);
          changed = true;
        }
      }

      const defaultModelWasSynthesized = !isValidPersistedModelDescriptor(profile.defaultModel);
      const normalizedDefaultModel = defaultModelWasSynthesized
        ? cloneModelDescriptor(defaultSessionDescriptor?.model ?? this.options.defaultModel)
        : cloneModelDescriptor(profile.defaultModel);
      if (
        defaultModelWasSynthesized ||
        !sameModelDescriptor(profile.defaultModel, normalizedDefaultModel)
      ) {
        profile.defaultModel = normalizedDefaultModel;
        changed = true;
      }

      for (const session of this.getBuilderSessionsForProfile(profileId)) {
        if (session.modelOrigin !== undefined) {
          continue;
        }

        session.modelOrigin = inferLegacySessionModelOrigin(session, profile, {
          forceDefaultSessionInherited: defaultModelWasSynthesized,
        });
        this.options.mutations.upsertDescriptor(session);
        changed = true;
      }

      this.options.mutations.upsertProfile(profile);
    }

    return changed;
  }

  reconcileDelegationStateOnBoot(defaultDelegationRosterId: string): boolean {
    let changed = false;
    for (const profile of this.options.profiles.values()) {
      // Defense in depth: decode already omits unknown persisted postures, but
      // never propagate a future/unknown value into booted sessions here either.
      const persistedPosture = isManagerPosture(profile.defaultManagerPosture)
        ? profile.defaultManagerPosture
        : undefined;
      const inheritedPosture = persistedPosture ?? DEFAULT_MANAGER_POSTURE;
      const inheritedPostureOrigin = persistedPosture
        ? "project_default" as const
        : "product_default" as const;
      const inheritedRosterId = profile.defaultDelegationRosterId ?? defaultDelegationRosterId;
      const inheritedRosterOrigin = profile.defaultDelegationRosterId
        ? "project_default" as const
        : "global_default" as const;

      for (const session of this.getBuilderSessionsForProfile(profile.profileId)) {
        let sessionChanged = false;
        if (session.managerPosture === undefined) {
          session.managerPosture = inheritedPosture;
          session.managerPostureOrigin = inheritedPostureOrigin;
          sessionChanged = true;
        } else if (session.managerPostureOrigin === undefined) {
          session.managerPostureOrigin = session.managerPosture === inheritedPosture
            ? inheritedPostureOrigin
            : "session_override";
          sessionChanged = true;
        }

        if (session.delegationRosterId === undefined) {
          session.delegationRosterId = inheritedRosterId;
          session.delegationRosterOrigin = inheritedRosterOrigin;
          sessionChanged = true;
        } else if (session.delegationRosterOrigin === undefined) {
          session.delegationRosterOrigin = session.delegationRosterId === inheritedRosterId
            ? inheritedRosterOrigin
            : "session_override";
          sessionChanged = true;
        }

        if (sessionChanged) {
          this.options.mutations.upsertDescriptor(session);
          changed = true;
        }
      }
    }
    return changed;
  }

  prunePersistedCortexStateForBoot(store: AgentsStoreFile): {
    store: AgentsStoreFile;
    pruned: boolean;
  } {
    if (this.options.cortexEnabled) {
      return { store, pruned: false };
    }

    const agents = Array.isArray(store.agents) ? store.agents : [];
    const profiles = Array.isArray(store.profiles) ? store.profiles : [];
    const removedManagerIds = new Set(
      agents
        .filter(
          (descriptor) =>
            descriptor.role === "manager" &&
            (descriptor.agentId === CORTEX_PROFILE_ID ||
              descriptor.profileId === CORTEX_PROFILE_ID ||
              descriptor.sessionPurpose === "cortex_review"),
        )
        .map((descriptor) => descriptor.agentId),
    );
    const filteredAgents = agents.filter(
      (descriptor) =>
        !(
          descriptor.agentId === CORTEX_PROFILE_ID ||
          descriptor.profileId === CORTEX_PROFILE_ID ||
          descriptor.sessionPurpose === "cortex_review" ||
          removedManagerIds.has(descriptor.managerId)
        ),
    );
    const filteredProfiles = profiles.filter(
      (profile) => profile.profileId !== CORTEX_PROFILE_ID,
    );
    const pruned =
      filteredAgents.length !== agents.length || filteredProfiles.length !== profiles.length;

    if (pruned) {
      this.options.logDebug("boot:cortex:pruned_disabled_state", {
        removedAgents: agents.length - filteredAgents.length,
        removedProfiles: profiles.length - filteredProfiles.length,
      });
    }

    return {
      store: {
        ...store,
        agents: filteredAgents,
        profiles: filteredProfiles,
      },
      pruned,
    };
  }

  normalizeSystemProfileTypes(): boolean {
    const cortexProfile = this.options.profiles.get(CORTEX_PROFILE_ID);
    if (!cortexProfile || cortexProfile.profileType === "system") {
      return false;
    }

    this.options.mutations.upsertProfile({
      ...cortexProfile,
      profileType: "system",
    });
    return true;
  }

  private getBuilderSessionsForProfile(
    profileId: string,
  ): Array<AgentDescriptor & { role: "manager"; profileId: string }> {
    return Array.from(this.options.descriptors.values()).filter(
      (
        descriptor,
      ): descriptor is AgentDescriptor & { role: "manager"; profileId: string } =>
        descriptor.role === "manager" &&
        descriptor.profileId === profileId &&
        descriptor.sessionSurface !== "collab",
    );
  }
}

function inferLegacySessionModelOrigin(
  descriptor: AgentDescriptor & { role: "manager"; profileId?: string },
  profile: ManagerProfile,
  options?: { forceDefaultSessionInherited?: boolean },
): "profile_default" | "session_override" {
  if (
    options?.forceDefaultSessionInherited &&
    descriptor.agentId === profile.defaultSessionAgentId
  ) {
    return "profile_default";
  }

  return sameModelDescriptor(descriptor.model, profile.defaultModel)
    ? "profile_default"
    : "session_override";
}

function isValidPersistedModelDescriptor(value: unknown): value is AgentModelDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    typeof (value as { modelId?: unknown }).modelId === "string" &&
    typeof (value as { thinkingLevel?: unknown }).thinkingLevel === "string"
  );
}

function cloneModelDescriptor(model: AgentModelDescriptor): AgentModelDescriptor {
  return (
    normalizePersistedSwarmModelDescriptor(model) ?? {
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: model.thinkingLevel,
    }
  );
}

function sameModelDescriptor(
  left: AgentModelDescriptor,
  right: AgentModelDescriptor,
): boolean {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    normalizeModelThinkingLevel(left.thinkingLevel) ===
      normalizeModelThinkingLevel(right.thinkingLevel)
  );
}

function normalizeModelThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}
