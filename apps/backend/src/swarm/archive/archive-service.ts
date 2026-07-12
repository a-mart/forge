import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";
import {
  ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED,
  ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED_MESSAGE,
  ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED,
  ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED_MESSAGE,
  isProfileArchived,
  isSessionDirectlyArchivable,
  resolveProfileRestoreOpenAgentId,
} from "./archive-resolver.js";

export type ArchiveErrorCode =
  | typeof ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED
  | typeof ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED
  | "ARCHIVE_SESSION_NOT_FOUND"
  | "ARCHIVE_PROFILE_NOT_FOUND";

export class ArchiveOperationError extends Error {
  constructor(readonly code: ArchiveErrorCode, message: string) {
    super(message);
    this.name = "ArchiveOperationError";
  }
}

export interface ArchiveSessionResult {
  agentId: string;
  profileId: string;
  archivedAt: string;
  terminatedWorkerIds: string[];
}

export interface RestoreSessionResult {
  agentId: string;
  profileId: string;
  openAgentId?: string;
}

export interface ArchiveProfileResult {
  profileId: string;
  archivedAt: string;
  terminatedWorkerIds: string[];
}

export interface RestoreProfileResult {
  profileId: string;
  openAgentId: string;
}

export interface ArchiveServiceDeps {
  now: () => string;
  getAgent: (agentId: string) => AgentDescriptor | undefined;
  getProfile: (profileId: string) => ManagerProfile | undefined;
  listSessions: () => AgentDescriptor[];
  patchDescriptor: (
    agentId: string,
    patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor),
  ) => Promise<AgentDescriptor>;
  patchProfile: (
    profileId: string,
    patch: Partial<ManagerProfile> | ((profile: ManagerProfile) => ManagerProfile),
  ) => Promise<ManagerProfile>;
  stopSessionForArchive: (agentId: string) => Promise<{ terminatedWorkerIds: string[] }>;
  hydrateSessionLastUsed?: (agentId: string) => Promise<void>;
  hydrateProfileLastUsed?: (profileId: string) => Promise<void>;
  onProfileArchiveStopError?: (agentId: string, error: unknown) => void;
}

export class ArchiveService {
  constructor(private readonly deps: ArchiveServiceDeps) {}

  async archiveSession(agentId: string): Promise<ArchiveSessionResult> {
    const session = this.requireSession(agentId);
    const profile = this.requireProfile(this.resolveProfileId(session));

    if (!isSessionDirectlyArchivable({ session, profile })) {
      throw new ArchiveOperationError(
        ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED,
        ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED_MESSAGE,
      );
    }

    const preStopUpdatedAt = session.updatedAt;
    await this.deps.hydrateSessionLastUsed?.(session.agentId);
    const terminatedWorkerIds = await this.stopIfLive(session);
    const stoppedSession = this.deps.getAgent(agentId);
    if (stoppedSession && stoppedSession.updatedAt !== preStopUpdatedAt) {
      await this.deps.patchDescriptor(agentId, { updatedAt: preStopUpdatedAt });
    }

    const archivedAt = session.archivedAt ?? this.deps.now();
    const updated = await this.deps.patchDescriptor(agentId, (current) => ({
      ...current,
      archivedAt,
      updatedAt: preStopUpdatedAt,
    }));

    return {
      agentId: updated.agentId,
      profileId: this.resolveProfileId(updated),
      archivedAt,
      terminatedWorkerIds,
    };
  }

  async restoreSession(agentId: string): Promise<RestoreSessionResult> {
    const session = this.requireSession(agentId);
    const profile = this.requireProfile(this.resolveProfileId(session));

    if (isProfileArchived(profile)) {
      throw new ArchiveOperationError(
        ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED,
        ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED_MESSAGE,
      );
    }

    const updated = await this.deps.patchDescriptor(agentId, (current) => {
      const next = { ...current };
      delete next.archivedAt;
      return next;
    });

    return {
      agentId: updated.agentId,
      profileId: this.resolveProfileId(updated),
      openAgentId: updated.agentId,
    };
  }

  async archiveProfile(profileId: string): Promise<ArchiveProfileResult> {
    const profile = this.requireProfile(profileId);
    const archivedAt = profile.archivedAt ?? this.deps.now();
    const sessions = this.sessionsForProfile(profile.profileId);
    const preStopUpdatedAtByAgentId = new Map(sessions.map((session) => [session.agentId, session.updatedAt]));
    await this.deps.hydrateProfileLastUsed?.(profile.profileId);

    const updated = await this.deps.patchProfile(profile.profileId, (current) => ({
      ...current,
      archivedAt,
      updatedAt: current.updatedAt,
    }));

    const terminatedWorkerIds: string[] = [];
    for (const session of sessions) {
      try {
        terminatedWorkerIds.push(...await this.stopIfLive(session));
      } catch (error) {
        this.deps.onProfileArchiveStopError?.(session.agentId, error);
      }
    }

    for (const [agentId, updatedAt] of preStopUpdatedAtByAgentId) {
      const current = this.deps.getAgent(agentId);
      if (current && current.updatedAt !== updatedAt) {
        await this.deps.patchDescriptor(agentId, { updatedAt });
      }
    }

    return {
      profileId: updated.profileId,
      archivedAt,
      terminatedWorkerIds,
    };
  }

  async restoreProfile(profileId: string): Promise<RestoreProfileResult> {
    const profile = this.requireProfile(profileId);
    const restoredProfile = await this.deps.patchProfile(profile.profileId, (current) => {
      const next = { ...current };
      delete next.archivedAt;
      return next;
    });

    return {
      profileId: restoredProfile.profileId,
      openAgentId: resolveProfileRestoreOpenAgentId({
        profile: restoredProfile,
        sessions: this.deps.listSessions(),
      }),
    };
  }

  private requireSession(agentId: string): AgentDescriptor {
    const session = this.deps.getAgent(agentId);
    if (!session || session.role !== "manager") {
      throw new ArchiveOperationError("ARCHIVE_SESSION_NOT_FOUND", `Unknown manager session: ${agentId}`);
    }
    return session;
  }

  private requireProfile(profileId: string): ManagerProfile {
    const profile = this.deps.getProfile(profileId);
    if (!profile) {
      throw new ArchiveOperationError("ARCHIVE_PROFILE_NOT_FOUND", `Unknown manager profile: ${profileId}`);
    }
    return profile;
  }

  private sessionsForProfile(profileId: string): AgentDescriptor[] {
    return this.deps.listSessions().filter((session) => session.role === "manager" && session.profileId === profileId);
  }

  private resolveProfileId(session: AgentDescriptor): string {
    return session.profileId ?? session.managerId;
  }

  private async stopIfLive(session: AgentDescriptor): Promise<string[]> {
    if (session.status === "stopped" || session.status === "terminated") {
      return [];
    }

    const result = await this.deps.stopSessionForArchive(session.agentId);
    return result.terminatedWorkerIds;
  }
}
