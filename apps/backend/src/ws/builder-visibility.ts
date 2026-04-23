import { isSystemProfile } from "@forge/protocol";
import type { AgentDescriptor, ManagerProfile } from "../swarm/types.js";

export function filterBuilderVisibleProfiles(profiles: ManagerProfile[]): ManagerProfile[] {
  return profiles.filter((profile) => !isSystemProfile(profile));
}

export function filterBuilderVisibleAgents(
  agents: AgentDescriptor[],
  systemProfileIds: Set<string>,
): AgentDescriptor[] {
  return agents.filter((agent) => {
    if (agent.profileId && systemProfileIds.has(agent.profileId)) {
      return false;
    }

    return true;
  });
}
