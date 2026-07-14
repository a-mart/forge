import {
  COLLABORATION_DISPLAY_NAME,
  COLLABORATION_PROFILE_ID,
} from "../collaboration/constants.js";
import { getProfileMemoryPath, getSessionFilePath } from "./data-paths.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "./types.js";

export interface CollaborationStorageProvisionerOptions {
  config: SwarmConfig;
  now: () => string;
  getDescriptor(agentId: string): AgentDescriptor | undefined;
  getProfile(profileId: string): ManagerProfile | undefined;
  upsertDescriptor(descriptor: AgentDescriptor): void;
  upsertProfile(profile: ManagerProfile): void;
  ensureProfileDirectories(profileId: string): Promise<void>;
  ensureSessionFileParent(sessionFile: string): Promise<void>;
  ensureMemoryFile(path: string, profileId: string): Promise<void>;
  getAgentMemoryPath(agentId: string): string;
  writeInitialSessionMeta(descriptor: AgentDescriptor): Promise<void>;
  refreshSessionMetaStats(descriptor: AgentDescriptor): Promise<void>;
  saveStore(): Promise<void>;
  logDebug(message: string, details?: unknown): void;
}

/** Owns the exact singleton profile/session contract used for Collaboration storage. */
export class CollaborationStorageProvisioner {
  constructor(private readonly options: CollaborationStorageProvisionerOptions) {}

  hasProfile(): boolean {
    return Boolean(this.options.getProfile(COLLABORATION_PROFILE_ID));
  }

  hasRootSession(): boolean {
    const descriptor = this.options.getDescriptor(COLLABORATION_PROFILE_ID);
    return Boolean(
      descriptor
      && descriptor.role === "manager"
      && descriptor.profileId === COLLABORATION_PROFILE_ID,
    );
  }

  async ensure(): Promise<void> {
    const existingDescriptor = this.options.getDescriptor(COLLABORATION_PROFILE_ID);
    if (existingDescriptor && existingDescriptor.role !== "manager") {
      throw new Error(
        `Cannot provision collaboration profile because agentId "${COLLABORATION_PROFILE_ID}" is already in use`,
      );
    }

    const now = this.options.now();
    const existingManager = existingDescriptor as (AgentDescriptor & { role: "manager" }) | undefined;
    const existingProfile = this.options.getProfile(COLLABORATION_PROFILE_ID);
    const createdAt = existingManager?.createdAt ?? existingProfile?.createdAt ?? now;
    const descriptor = this.buildDescriptor(existingManager, createdAt, now);
    const profile = this.buildProfile(existingProfile, descriptor, createdAt, now);
    const hadProfile = Boolean(existingProfile);
    const hadDescriptor = Boolean(existingManager);
    const changed = this.hasChanged(existingProfile, profile, existingManager, descriptor);

    if (changed) {
      descriptor.updatedAt = now;
      profile.updatedAt = now;
    }

    this.options.upsertProfile(profile);
    this.options.upsertDescriptor(descriptor);
    await this.ensureArtifacts(profile, descriptor);
    if (changed) {
      await this.options.saveStore();
    }

    if (!hadProfile || !hadDescriptor) {
      this.options.logDebug("collaboration:storage-profile:ensured", {
        profileId: COLLABORATION_PROFILE_ID,
      });
    } else if (changed) {
      this.options.logDebug("collaboration:storage-profile:synced", {
        profileId: COLLABORATION_PROFILE_ID,
      });
    }
  }

  private buildDescriptor(
    existing: (AgentDescriptor & { role: "manager" }) | undefined,
    createdAt: string,
    now: string,
  ): AgentDescriptor {
    return {
      agentId: COLLABORATION_PROFILE_ID,
      displayName: COLLABORATION_DISPLAY_NAME,
      role: "manager",
      managerId: COLLABORATION_PROFILE_ID,
      profileId: COLLABORATION_PROFILE_ID,
      sessionLabel: COLLABORATION_DISPLAY_NAME,
      status: "idle",
      createdAt,
      updatedAt: existing?.updatedAt ?? now,
      cwd: existing?.cwd ?? this.options.config.defaultCwd,
      model: { ...(existing?.model ?? this.options.config.defaultModel) },
      modelOrigin: "profile_default",
      sessionFile: getSessionFilePath(
        this.options.config.paths.dataDir,
        COLLABORATION_PROFILE_ID,
        COLLABORATION_PROFILE_ID,
      ),
      archetypeId: existing?.archetypeId ?? "manager",
      ...(existing?.sessionSystemPrompt
        ? { sessionSystemPrompt: existing.sessionSystemPrompt }
        : {}),
    };
  }

  private buildProfile(
    existing: ManagerProfile | undefined,
    descriptor: AgentDescriptor,
    createdAt: string,
    now: string,
  ): ManagerProfile {
    return {
      profileId: COLLABORATION_PROFILE_ID,
      displayName: COLLABORATION_DISPLAY_NAME,
      defaultSessionAgentId: COLLABORATION_PROFILE_ID,
      defaultModel: { ...(existing?.defaultModel ?? descriptor.model) },
      createdAt: existing?.createdAt ?? createdAt,
      updatedAt: existing?.updatedAt ?? now,
      profileType: "system",
      ...(existing?.sortOrder !== undefined ? { sortOrder: existing.sortOrder } : {}),
    };
  }

  private hasChanged(
    existingProfile: ManagerProfile | undefined,
    profile: ManagerProfile,
    existing: (AgentDescriptor & { role: "manager" }) | undefined,
    descriptor: AgentDescriptor,
  ): boolean {
    return !existingProfile
      || existingProfile.displayName !== profile.displayName
      || existingProfile.defaultSessionAgentId !== profile.defaultSessionAgentId
      || existingProfile.profileType !== profile.profileType
      || !existing
      || existing.profileId !== descriptor.profileId
      || existing.managerId !== descriptor.managerId
      || existing.displayName !== descriptor.displayName
      || existing.sessionLabel !== descriptor.sessionLabel
      || existing.status !== descriptor.status
      || existing.creatorAgentId !== undefined
      || existing.sessionPurpose !== undefined
      || existing.sessionSurface !== undefined
      || existing.collab !== undefined
      || existing.projectAgent !== undefined
      || existing.sessionFile !== descriptor.sessionFile
      || existing.cwd !== descriptor.cwd
      || existing.archetypeId !== descriptor.archetypeId
      || existing.sessionSystemPrompt !== descriptor.sessionSystemPrompt
      || existing.model.provider !== descriptor.model.provider
      || existing.model.modelId !== descriptor.model.modelId
      || existing.model.thinkingLevel !== descriptor.model.thinkingLevel;
  }

  private async ensureArtifacts(profile: ManagerProfile, descriptor: AgentDescriptor): Promise<void> {
    await this.options.ensureProfileDirectories(profile.profileId);
    await this.options.ensureSessionFileParent(descriptor.sessionFile);
    await this.options.ensureMemoryFile(this.options.getAgentMemoryPath(descriptor.agentId), profile.profileId);
    await this.options.ensureMemoryFile(
      getProfileMemoryPath(this.options.config.paths.dataDir, profile.profileId),
      profile.profileId,
    );
    await this.options.writeInitialSessionMeta(descriptor);
    await this.options.refreshSessionMetaStats(descriptor);
  }
}
