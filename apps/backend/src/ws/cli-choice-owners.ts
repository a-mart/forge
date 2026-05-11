import { isSystemProfile, type ChoiceQuestion, type CliChoiceOwner } from "@forge/protocol";
import type { AgentDescriptor, ManagerProfile } from "../swarm/types.js";

export interface CliChoiceStateProvider {
  listProfiles(): ManagerProfile[];
  listAgents(): AgentDescriptor[];
  getAgent?(agentId: string): AgentDescriptor | undefined;
  getPendingChoiceIdsForSession(sessionAgentId: string): string[];
  getPendingChoice(choiceId: string): {
    agentId: string;
    sessionAgentId: string;
    questions: ChoiceQuestion[];
  } | undefined;
}

export function findCliVisibleChoiceSession(
  provider: CliChoiceStateProvider,
  sessionAgentId: string,
): (AgentDescriptor & { role: "manager" }) | undefined {
  const descriptor = getAgent(provider, sessionAgentId);
  if (!descriptor || descriptor.role !== "manager" || descriptor.sessionSurface === "collab") {
    return undefined;
  }

  const profile = getProfile(provider, descriptor.profileId ?? descriptor.agentId);
  if (!profile || isSystemProfile(profile)) {
    return undefined;
  }

  return descriptor as AgentDescriptor & { role: "manager" };
}

export function listCliChoiceOwnersForSession(
  provider: CliChoiceStateProvider,
  sessionAgentId: string,
): CliChoiceOwner[] {
  const session = findCliVisibleChoiceSession(provider, sessionAgentId);
  if (!session) {
    return [];
  }

  return provider.getPendingChoiceIdsForSession(session.agentId).flatMap((choiceId) => {
    const choice = provider.getPendingChoice(choiceId);
    return choice ? [toCliChoiceOwner(session, choiceId, choice)] : [];
  });
}

export function listCliChoiceOwnersForProfile(
  provider: CliChoiceStateProvider,
  profileId: string,
): CliChoiceOwner[] {
  return provider
    .listAgents()
    .filter((agent): agent is AgentDescriptor & { role: "manager" } => agent.role === "manager")
    .filter((agent) => (agent.profileId ?? agent.agentId) === profileId)
    .flatMap((agent) => listCliChoiceOwnersForSession(provider, agent.agentId));
}

export function listCliChoiceOwners(provider: CliChoiceStateProvider): CliChoiceOwner[] {
  return provider
    .listAgents()
    .filter((agent): agent is AgentDescriptor & { role: "manager" } => agent.role === "manager")
    .flatMap((agent) => listCliChoiceOwnersForSession(provider, agent.agentId));
}

export function getCliChoiceOwner(provider: CliChoiceStateProvider, choiceId: string): CliChoiceOwner | undefined {
  const choice = provider.getPendingChoice(choiceId);
  if (!choice) {
    return undefined;
  }

  const session = findCliVisibleChoiceSession(provider, choice.sessionAgentId);
  return session ? toCliChoiceOwner(session, choiceId, choice) : undefined;
}

function toCliChoiceOwner(
  session: AgentDescriptor & { role: "manager" },
  choiceId: string,
  choice: { agentId: string; sessionAgentId: string; questions: ChoiceQuestion[] },
): CliChoiceOwner {
  return {
    choiceId,
    agentId: choice.agentId,
    sessionAgentId: choice.sessionAgentId,
    profileId: session.profileId ?? session.agentId,
    status: "pending",
    questionSummary: choice.questions[0]?.question,
    questions: choice.questions,
  };
}

function getAgent(provider: CliChoiceStateProvider, agentId: string): AgentDescriptor | undefined {
  return provider.getAgent?.(agentId) ?? provider.listAgents().find((agent) => agent.agentId === agentId);
}

function getProfile(provider: CliChoiceStateProvider, profileId: string): ManagerProfile | undefined {
  return provider.listProfiles().find((profile) => profile.profileId === profileId);
}
