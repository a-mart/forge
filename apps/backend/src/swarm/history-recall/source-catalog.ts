import { isSystemProfile } from "@forge/protocol";
import type { AgentDescriptor, ManagerProfile } from "../types.js";
import { getSessionFilePath, getWorkerSessionFilePath } from "../storage/data-paths.js";
import type { HistorySearchServiceHost, HistorySourceDescriptor } from "./types.js";

const CORTEX_PROFILE_ID = "cortex";

export function isRestrictedDescriptor(descriptor: AgentDescriptor | undefined): boolean {
  if (!descriptor) {
    return true;
  }
  if (descriptor.sessionSurface === "collab" || descriptor.collab) {
    return true;
  }
  if (descriptor.sessionPurpose) {
    return true;
  }
  if (descriptor.externalThread) {
    return true;
  }
  if (descriptor.internalWorkerKind === "codex_plugin") {
    return true;
  }
  const profileId = resolveProfileId(descriptor);
  if (profileId === CORTEX_PROFILE_ID) {
    return true;
  }
  return false;
}

export function isRestrictedProfile(profile: ManagerProfile | undefined): boolean {
  if (!profile) {
    return false;
  }
  return isSystemProfile(profile) || profile.profileId === CORTEX_PROFILE_ID;
}

export function resolveCallerSession(
  host: HistorySearchServiceHost,
  callerAgentId: string,
): AgentDescriptor {
  const caller = host.getAgent(callerAgentId);
  if (!caller) {
    throw new HistoryRecallError("Caller agent not found", 404);
  }
  if (isRestrictedDescriptor(caller)) {
    throw new HistoryRecallError("History recall is not available for this runtime", 403);
  }
  if (caller.role === "manager") {
    return caller;
  }
  const session = host.getAgent(caller.managerId);
  if (!session || session.role !== "manager") {
    throw new HistoryRecallError("Owning session not found", 404);
  }
  if (isRestrictedDescriptor(session)) {
    throw new HistoryRecallError("History recall is not available for this runtime", 403);
  }
  return session;
}

export function resolveProfileId(descriptor: AgentDescriptor): string {
  return descriptor.profileId ?? (descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId);
}

export function listIndexableSources(host: HistorySearchServiceHost): HistorySourceDescriptor[] {
  const profilesById = new Map(host.listProfiles().map((profile) => [profile.profileId, profile]));
  const sources: HistorySourceDescriptor[] = [];
  for (const descriptor of host.listAgents()) {
    const source = sourceFromDescriptor(host, descriptor, profilesById);
    if (source) {
      sources.push(source);
    }
  }
  return sources;
}

export function listSessionSources(
  host: HistorySearchServiceHost,
  session: AgentDescriptor,
): HistorySourceDescriptor[] {
  const profileId = resolveProfileId(session);
  const profile = host.listProfiles().find((entry) => entry.profileId === profileId);
  const profilesById = new Map(profile ? [[profile.profileId, profile] as const] : []);
  const sources: HistorySourceDescriptor[] = [];
  const sessionSource = sourceFromDescriptor(host, session, profilesById);
  if (sessionSource) {
    sources.push(sessionSource);
  }
  for (const descriptor of host.listAgents()) {
    if (descriptor.role !== "worker" || descriptor.managerId !== session.agentId) {
      continue;
    }
    const workerSource = sourceFromDescriptor(host, descriptor, profilesById);
    if (workerSource) {
      sources.push(workerSource);
    }
  }
  return sources;
}

export function listProjectSources(
  host: HistorySearchServiceHost,
  profileId: string,
): HistorySourceDescriptor[] {
  const profile = host.listProfiles().find((entry) => entry.profileId === profileId);
  if (isRestrictedProfile(profile)) {
    return [];
  }
  const profilesById = new Map(profile ? [[profile.profileId, profile] as const] : []);
  const sources: HistorySourceDescriptor[] = [];
  for (const descriptor of host.listAgents()) {
    if (resolveProfileId(descriptor) !== profileId) {
      continue;
    }
    const source = sourceFromDescriptor(host, descriptor, profilesById);
    if (source) {
      sources.push(source);
    }
  }
  return sources;
}

export function sourceFromDescriptor(
  host: HistorySearchServiceHost,
  descriptor: AgentDescriptor,
  profilesById: ReadonlyMap<string, ManagerProfile>,
): HistorySourceDescriptor | undefined {
  if (isRestrictedDescriptor(descriptor)) {
    return undefined;
  }
  const profileId = resolveProfileId(descriptor);
  const profile = profilesById.get(profileId) ?? host.listProfiles().find((entry) => entry.profileId === profileId);
  if (isRestrictedProfile(profile)) {
    return undefined;
  }
  const session = descriptor.role === "manager" ? descriptor : host.getAgent(descriptor.managerId);
  if (!session || session.role !== "manager" || isRestrictedDescriptor(session)) {
    return undefined;
  }
  const dataDir = host.config.paths.dataDir;
  const path = descriptor.role === "manager"
    ? getSessionFilePath(dataDir, profileId, descriptor.agentId)
    : getWorkerSessionFilePath(dataDir, profileId, session.agentId, descriptor.agentId);
  return {
    sourceId: `${session.agentId}:${descriptor.agentId}`,
    profileId,
    sessionAgentId: session.agentId,
    actorAgentId: descriptor.agentId,
    path,
    archived: Boolean(session.archivedAt || profile?.archivedAt),
    sessionLabel: session.sessionLabel ?? session.displayName ?? session.agentId,
    actorLabel: descriptor.displayName ?? descriptor.agentId,
  };
}

export function findSource(
  host: HistorySearchServiceHost,
  sessionAgentId: string,
  actorAgentId: string,
): HistorySourceDescriptor | undefined {
  const session = host.getAgent(sessionAgentId);
  if (!session || session.role !== "manager") {
    return undefined;
  }
  const actor = host.getAgent(actorAgentId);
  if (!actor) {
    return undefined;
  }
  if (actor.role === "manager" && actor.agentId !== session.agentId) {
    return undefined;
  }
  if (actor.role === "worker" && actor.managerId !== session.agentId) {
    return undefined;
  }
  const profilesById = new Map(host.listProfiles().map((profile) => [profile.profileId, profile]));
  return sourceFromDescriptor(host, actor, profilesById);
}

export class HistoryRecallError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "HistoryRecallError";
  }
}
