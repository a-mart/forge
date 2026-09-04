import { existsSync } from "node:fs";
import { getSessionDir, getSessionFilePath } from "./data-paths.js";
import { normalizePersistedSwarmModelDescriptor } from "./model-presets.js";
import {
  parseSessionNumberFromAgentId,
  sanitizeCliSessionMetadata,
  slugifySessionName,
} from "./swarm-manager-utils.js";
import type { AgentDescriptor, AgentModelDescriptor, ManagerProfile } from "./types.js";
import { DEFAULT_MANAGER_POSTURE, type ManagerPosture } from "@forge/protocol";

const CORTEX_PROFILE_ID = "cortex";
const SESSION_ID_SUFFIX_SEPARATOR = "--s";
const ROOT_SESSION_NUMBER = 1;

export interface SessionCreationOptions {
  label?: string;
  name?: string;
  sessionAgentId?: string;
  sessionPurpose?: AgentDescriptor["sessionPurpose"];
  cli?: AgentDescriptor["cli"];
  managerPosture?: ManagerPosture;
  delegationRosterId?: string;
}

export interface SessionCreationBaseDescriptor {
  model: AgentModelDescriptor;
  modelOrigin?: AgentDescriptor["modelOrigin"];
  cwd: string;
  archetypeId?: AgentDescriptor["archetypeId"];
  sessionSystemPrompt?: string;
  managerPosture?: AgentDescriptor["managerPosture"];
  managerPostureOrigin?: AgentDescriptor["managerPostureOrigin"];
  delegationRosterId?: AgentDescriptor["delegationRosterId"];
  delegationRosterOrigin?: AgentDescriptor["delegationRosterOrigin"];
}

export type PreparedManagerSessionDescriptor = AgentDescriptor & {
  role: "manager";
  profileId: string;
};

export interface PreparedSessionCreation {
  profile: ManagerProfile;
  sessionDescriptor: PreparedManagerSessionDescriptor;
  sessionNumber: number;
}

interface PreparedSessionIdentity {
  profile: ManagerProfile;
  sessionAgentId: string;
  sessionLabel: string;
  displayName: string;
  sessionNumber: number;
  createdAt: string;
}

/**
 * Owns the pure policy for assigning session identities and constructing new
 * manager-session descriptors. Persistence and runtime provisioning remain the
 * responsibility of SessionProvisioner and SwarmSessionService.
 */
export class SessionDescriptorFactory {
  constructor(
    private readonly dataDir: string,
    private readonly profiles: ReadonlyMap<string, ManagerProfile>,
    private readonly descriptors: ReadonlyMap<string, AgentDescriptor>,
    private readonly now: () => string,
  ) {}

  prepareSessionCreation(
    profileId: string,
    options?: SessionCreationOptions,
  ): PreparedSessionCreation {
    const profile = this.requireProfile(profileId);
    const templateDescriptor = this.descriptors.get(profile.defaultSessionAgentId);

    if (!templateDescriptor || templateDescriptor.role !== "manager") {
      throw new Error(`Profile default session is missing: ${profile.defaultSessionAgentId}`);
    }

    if (templateDescriptor.sessionSurface === "collab") {
      throw new Error(`Profile default session must remain Builder-only: ${templateDescriptor.agentId}`);
    }

    return this.prepareSessionCreationFromBase(
      profileId,
      {
        model: cloneProfileDefaultModel(profile.defaultModel),
        modelOrigin: "profile_default",
        cwd: templateDescriptor.cwd,
        archetypeId: templateDescriptor.archetypeId,
        ...(templateDescriptor.sessionSystemPrompt !== undefined
          ? { sessionSystemPrompt: templateDescriptor.sessionSystemPrompt }
          : {}),
        managerPosture: profile.defaultManagerPosture ?? DEFAULT_MANAGER_POSTURE,
        managerPostureOrigin: profile.defaultManagerPosture
          ? "project_default"
          : "product_default",
        ...(profile.defaultDelegationRosterId
          ? {
              delegationRosterId: profile.defaultDelegationRosterId,
              delegationRosterOrigin: "project_default" as const,
            }
          : {}),
      },
      options,
    );
  }

  prepareSessionCreationFromBase(
    profileId: string,
    base: SessionCreationBaseDescriptor,
    options?: SessionCreationOptions,
  ): PreparedSessionCreation {
    const identity = this.prepareSessionIdentity(profileId, options);
    const shouldApplyBaseSessionSystemPrompt =
      options?.sessionPurpose !== "agent_creator" && base.sessionSystemPrompt !== undefined;

    const sessionDescriptor: PreparedManagerSessionDescriptor = {
      agentId: identity.sessionAgentId,
      displayName: identity.displayName,
      role: "manager",
      managerId: identity.sessionAgentId,
      profileId: identity.profile.profileId,
      sessionLabel: identity.sessionLabel,
      sessionPurpose: options?.sessionPurpose,
      cli: sanitizeCliSessionMetadata(options?.cli),
      status: "idle",
      createdAt: identity.createdAt,
      updatedAt: identity.createdAt,
      cwd: base.cwd,
      model: { ...base.model },
      ...(base.modelOrigin !== undefined ? { modelOrigin: base.modelOrigin } : {}),
      sessionFile: getSessionFilePath(
        this.dataDir,
        identity.profile.profileId,
        identity.sessionAgentId,
      ),
      managerPosture: options?.managerPosture ?? base.managerPosture ?? DEFAULT_MANAGER_POSTURE,
      managerPostureOrigin: options?.managerPosture
        ? "session_override"
        : base.managerPostureOrigin ?? "product_default",
      ...(options?.delegationRosterId
        ? {
            delegationRosterId: options.delegationRosterId,
            delegationRosterOrigin: "session_override" as const,
          }
        : base.delegationRosterId
          ? {
              delegationRosterId: base.delegationRosterId,
              delegationRosterOrigin: base.delegationRosterOrigin ?? "project_default",
            }
          : {}),
      ...(base.archetypeId !== undefined ? { archetypeId: base.archetypeId } : {}),
      ...(shouldApplyBaseSessionSystemPrompt
        ? { sessionSystemPrompt: base.sessionSystemPrompt }
        : {}),
    };

    if (sessionDescriptor.sessionPurpose === "agent_creator") {
      sessionDescriptor.archetypeId = "agent-architect";
      if (
        !sessionDescriptor.sessionLabel ||
        sessionDescriptor.sessionLabel === `Session ${identity.sessionNumber}`
      ) {
        sessionDescriptor.sessionLabel = "Agent Creator";
        sessionDescriptor.displayName = "Agent Creator";
      }
    }

    return {
      profile: identity.profile,
      sessionDescriptor,
      sessionNumber: identity.sessionNumber,
    };
  }

  private prepareSessionIdentity(
    profileId: string,
    options?: SessionCreationOptions,
  ): PreparedSessionIdentity {
    const profile = this.requireProfile(profileId);

    if (options?.sessionPurpose === "agent_creator" && profileId === CORTEX_PROFILE_ID) {
      throw new Error("Agent creator sessions cannot be created in the Cortex profile");
    }

    const { agentId: autoSessionAgentId, sessionNumber } =
      this.generateSessionAgentIdentity(profileId);
    const normalizedName = options?.name?.trim();
    const normalizedLabel = options?.label?.trim();
    const normalizedSessionAgentId = options?.sessionAgentId?.trim();

    let sessionAgentId = autoSessionAgentId;
    let sessionLabel =
      normalizedLabel && normalizedLabel.length > 0
        ? normalizedLabel
        : `Session ${sessionNumber}`;
    let displayName =
      normalizedLabel && normalizedLabel.length > 0 ? normalizedLabel : sessionAgentId;

    if (normalizedName && normalizedName.length > 0) {
      const slug = slugifySessionName(normalizedName);
      if (!slug) {
        throw new Error("Session name must include at least one letter, number, or dash");
      }

      sessionAgentId = this.generateUniqueSessionAgentId(profileId, slug);
      sessionLabel = normalizedName;
      displayName = normalizedName;
    }

    if (normalizedSessionAgentId && normalizedSessionAgentId.length > 0) {
      if (this.isSessionAgentIdReserved(profileId, normalizedSessionAgentId)) {
        throw new Error(`Session agent id already exists: ${normalizedSessionAgentId}`);
      }

      sessionAgentId = normalizedSessionAgentId;
      if (!normalizedLabel || normalizedLabel.length === 0) {
        displayName =
          normalizedName && normalizedName.length > 0
            ? normalizedName
            : normalizedSessionAgentId;
      }
    }

    return {
      profile,
      sessionAgentId,
      sessionLabel,
      displayName,
      sessionNumber,
      createdAt: this.now(),
    };
  }

  private requireProfile(profileId: string): ManagerProfile {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }
    return profile;
  }

  private generateSessionAgentIdentity(
    profileId: string,
  ): { agentId: string; sessionNumber: number } {
    const existingSessions = this.getBuilderSessionsForProfile(profileId);
    let highestSessionNumber = existingSessions.some(
      (descriptor) => descriptor.agentId === profileId,
    )
      ? ROOT_SESSION_NUMBER
      : 0;

    for (const descriptor of existingSessions) {
      const parsedSessionNumber = parseSessionNumberFromAgentId(descriptor.agentId, profileId);
      if (parsedSessionNumber !== undefined) {
        highestSessionNumber = Math.max(highestSessionNumber, parsedSessionNumber);
      }
    }

    let nextSessionNumber = Math.max(ROOT_SESSION_NUMBER + 1, highestSessionNumber + 1);
    let sessionAgentId = `${profileId}${SESSION_ID_SUFFIX_SEPARATOR}${nextSessionNumber}`;

    while (this.isSessionAgentIdReserved(profileId, sessionAgentId)) {
      nextSessionNumber += 1;
      sessionAgentId = `${profileId}${SESSION_ID_SUFFIX_SEPARATOR}${nextSessionNumber}`;
    }

    return {
      agentId: sessionAgentId,
      sessionNumber: nextSessionNumber,
    };
  }

  private generateUniqueSessionAgentId(profileId: string, baseAgentId: string): string {
    let candidate = baseAgentId;
    let suffix = 2;

    while (this.isSessionAgentIdReserved(profileId, candidate)) {
      candidate = `${baseAgentId}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  private isSessionAgentIdReserved(profileId: string, agentId: string): boolean {
    return (
      this.descriptors.has(agentId) ||
      existsSync(getSessionDir(this.dataDir, profileId, agentId))
    );
  }

  private getBuilderSessionsForProfile(profileId: string): AgentDescriptor[] {
    return Array.from(this.descriptors.values()).filter(
      (descriptor) =>
        descriptor.role === "manager" &&
        descriptor.profileId === profileId &&
        descriptor.sessionSurface !== "collab",
    );
  }
}

function cloneProfileDefaultModel(model: AgentModelDescriptor): AgentModelDescriptor {
  return (
    normalizePersistedSwarmModelDescriptor(model) ?? {
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: model.thinkingLevel,
    }
  );
}
