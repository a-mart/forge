import { isSystemProfile, type AgentDescriptor, type ManagerProfile } from "@forge/protocol";

const CORTEX_PROFILE_ID = "cortex";

function isBuilderVisibleSystemProfileId(profileId: string | undefined): boolean {
  return profileId === CORTEX_PROFILE_ID;
}

function isHiddenSystemProfileId(profileId: string | undefined, systemProfileIds: Set<string>): boolean {
  return Boolean(profileId && systemProfileIds.has(profileId) && !isBuilderVisibleSystemProfileId(profileId));
}

export function filterBuilderVisibleProfiles(profiles: ManagerProfile[]): ManagerProfile[] {
  return profiles.filter((profile) => !isSystemProfile(profile) || isBuilderVisibleSystemProfileId(profile.profileId));
}

/**
 * A session listed in the Builder inventory (sidebar Inbox, attention, unread).
 * Temporary side chats stay in conversation agent snapshots, where their panel
 * reads them, but are never listed as sessions.
 */
export function isBuilderInventorySession(agent: AgentDescriptor): boolean {
  return agent.role === "manager" && agent.sessionPurpose !== "side_chat";
}

export function filterBuilderVisibleAgents(
  agents: AgentDescriptor[],
  systemProfileIds: Set<string>,
): AgentDescriptor[] {
  return agents.filter((agent) => {
    if (agent.sessionSurface === "collab") {
      return false;
    }

    return !isHiddenSystemProfileId(agent.profileId, systemProfileIds);
  });
}
