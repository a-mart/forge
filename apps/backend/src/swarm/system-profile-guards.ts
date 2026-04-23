import { isSystemProfile, type AgentDescriptor, type ManagerProfile } from "@forge/protocol";

export const SYSTEM_PROFILE_MUTATION_ERROR = "Cannot modify system-managed profile";
export const SYSTEM_PROFILE_SESSION_MUTATION_ERROR = "Cannot modify sessions in system-managed profiles";

type ProfileCollection = ReadonlyMap<string, ManagerProfile> | Iterable<ManagerProfile>;
type SessionDescriptorLookup = (
  agentId: string,
) => Pick<AgentDescriptor, "agentId" | "profileId" | "role"> | undefined;

export function requireNonSystemProfile(
  profileId: string,
  profiles: ProfileCollection,
  message = SYSTEM_PROFILE_MUTATION_ERROR,
): void {
  const profile = getProfileById(profileId, profiles);
  if (profile && isSystemProfile(profile)) {
    throw new Error(message);
  }
}

export function requireNonSystemSessionProfile(
  sessionAgentId: string,
  profiles: ProfileCollection,
  getAgent: SessionDescriptorLookup,
  message = SYSTEM_PROFILE_SESSION_MUTATION_ERROR,
): void {
  requireNonSystemProfile(resolveProfileIdForSessionAgent(sessionAgentId, getAgent), profiles, message);
}

export function filterSystemProfileIds(
  profileIds: readonly string[],
  profiles: ProfileCollection,
): string[] {
  const profileMap = asProfileMap(profiles);
  return profileIds.filter((profileId) => {
    const profile = profileMap.get(profileId);
    return !profile || !isSystemProfile(profile);
  });
}

export function resolveProfileIdForSessionAgent(
  sessionAgentId: string,
  getAgent: SessionDescriptorLookup,
): string {
  const descriptor = getAgent(sessionAgentId);
  if (!descriptor || descriptor.role !== "manager") {
    return sessionAgentId;
  }

  return descriptor.profileId ?? descriptor.agentId;
}

function getProfileById(profileId: string, profiles: ProfileCollection): ManagerProfile | undefined {
  return asProfileMap(profiles).get(profileId);
}

function asProfileMap(profiles: ProfileCollection): ReadonlyMap<string, ManagerProfile> {
  if (isProfileMap(profiles)) {
    return profiles;
  }

  const entries: Array<[string, ManagerProfile]> = [];
  for (const profile of profiles) {
    entries.push([profile.profileId, profile]);
  }

  return new Map(entries);
}

function isProfileMap(profiles: ProfileCollection): profiles is ReadonlyMap<string, ManagerProfile> {
  return typeof (profiles as ReadonlyMap<string, ManagerProfile>).get === "function";
}
