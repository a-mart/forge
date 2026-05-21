import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";

export const ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED = "ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED" as const;
export const ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED_MESSAGE = "The default session for a project can’t be archived directly." as const;
export const ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED = "ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED" as const;
export const ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED_MESSAGE = "Restore the project first." as const;
export const ARCHIVED_SESSION_OPERATION_MESSAGE = "Archived sessions can’t be used until restored." as const;
export const ARCHIVED_PROJECT_OPERATION_MESSAGE = "Archived projects can’t be used until restored." as const;

export function isProfileArchived(profile: Pick<ManagerProfile, "archivedAt"> | undefined | null): boolean {
  return Boolean(profile?.archivedAt);
}

export function isSessionDirectlyArchived(session: Pick<AgentDescriptor, "archivedAt"> | undefined | null): boolean {
  return Boolean(session?.archivedAt);
}

export function isSessionEffectivelyArchived(input: {
  session?: Pick<AgentDescriptor, "archivedAt"> | undefined | null;
  profile?: Pick<ManagerProfile, "archivedAt"> | undefined | null;
}): boolean {
  return isSessionDirectlyArchived(input.session) || isProfileArchived(input.profile);
}

export function isSessionDirectlyArchivable(input: {
  session: Pick<AgentDescriptor, "agentId" | "role">;
  profile: Pick<ManagerProfile, "defaultSessionAgentId">;
}): boolean {
  return input.session.role === "manager" && input.session.agentId !== input.profile.defaultSessionAgentId;
}

export function resolveProfileRestoreOpenAgentId(input: {
  profile: Pick<ManagerProfile, "profileId" | "defaultSessionAgentId">;
  sessions: Array<Pick<AgentDescriptor, "agentId" | "profileId" | "role" | "updatedAt" | "archivedAt">>;
}): string {
  const activeSessions = input.sessions
    .filter((session) => session.role === "manager")
    .filter((session) => session.profileId === input.profile.profileId)
    .filter((session) => !isSessionDirectlyArchived(session))
    .sort((left, right) => {
      const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
      return byUpdatedAt || right.agentId.localeCompare(left.agentId);
    });

  return activeSessions[0]?.agentId ?? input.profile.defaultSessionAgentId;
}
