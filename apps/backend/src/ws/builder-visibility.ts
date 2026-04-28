import { isSystemProfile } from "@forge/protocol";
import type { AgentDescriptor, ManagerProfile } from "../swarm/types.js";

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
