import {
  ArchiveLastUsedHydrator,
  type ArchiveLastUsedHydratorDeps,
} from "./archive/archive-last-used-hydrator.js";
import { ArchiveService, type ArchiveServiceDeps } from "./archive/archive-service.js";
import { deleteProjectAgentRecord } from "./project-agent-storage.js";
import {
  ProjectAgentCoordinator,
  type ProjectAgentCoordinatorOptions,
} from "./project-agent-coordinator.js";
import {
  ProjectAgentSharingService,
  type ProjectAgentSharingServiceDependencies,
} from "./project-agent-sharing-service.js";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import type { AgentDirectory } from "./agent-directory.js";
import { CLAUDE_RUNTIME_STATE_ENTRY_TYPE } from "./claude-agent-runtime.js";
import { CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE } from "./runtime/cursor-sdk/cursor-sdk-agent-runtime.js";
import { CURSOR_SDK_USAGE_ENTRY_TYPE } from "../utils/cursor-sdk-usage-records.js";
import { copySessionHistoryForFork } from "./session/conversation-timeline.js";
import {
  SessionProvisioner,
  type SessionProvisionerOptions,
} from "./session-provisioner.js";
import type { SessionDescriptorFactory } from "./session-descriptor-factory.js";
import type { SessionPinCoordinator } from "./session-pin-coordinator.js";
import type { ConversationProjector } from "./conversation-projector.js";
import {
  SwarmProjectAgentService,
  type SwarmProjectAgentServiceOptions,
} from "./swarm-project-agent-service.js";
import { SwarmSessionService, type SwarmSessionServiceOptions } from "./swarm-session-service.js";
import { resolveDelegationRosterSettings } from "./specialists/delegation-roster-store.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "./types.js";

export interface SwarmManagerSessionCompositionState {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  runtimes: Map<string, SwarmAgentRuntime>;
  now: () => string;
}

export interface SwarmManagerSessionCompositionServices {
  directory: Pick<AgentDirectory, "sortedDescriptors" | "listProfiles">;
  descriptorFactory: SessionDescriptorFactory;
  pins: SessionPinCoordinator;
  conversations: ConversationProjector;
}

type ProvisionerOwnedKeys = "dataDir" | "runtimes" | "forgetPinnedMessages" | "conversationProjector";
type SessionOwnedKeys = "profiles" | "runtimes" | "provisioner" | "prepareSessionCreation" | "prepareSessionCreationFromBase" | "resolveGlobalDelegationRosterId" | "deleteProjectAgentRecord" | "copySessionHistoryForFork" | "copyPinnedMessagesForFork" | "resetConversationHistory";
type ProjectAgentOwnedKeys = "dataDir" | "descriptors" | "provisioner" | "now" | "prepareSessionCreation";
type SharingOwnedKeys = "dataDir" | "now" | "getProfiles" | "getDescriptor" | "getDescriptors";
type ProjectCoordinatorOwnedKeys = "config" | "descriptors" | "profiles" | "projectAgents" | "sharing" | "now";

/** Explicit capability groups consumed by the session-domain composition root. */
export interface SwarmManagerSessionCompositionOptions {
  state: SwarmManagerSessionCompositionState;
  services: SwarmManagerSessionCompositionServices;
  provisioner: Omit<SessionProvisionerOptions, ProvisionerOwnedKeys>;
  sessions: Omit<SwarmSessionServiceOptions, SessionOwnedKeys>;
  projectAgents: Omit<SwarmProjectAgentServiceOptions, ProjectAgentOwnedKeys>;
  sharing: Omit<ProjectAgentSharingServiceDependencies, SharingOwnedKeys>;
  projectAgentWorkflows: Omit<ProjectAgentCoordinatorOptions, ProjectCoordinatorOwnedKeys>;
  archive: {
    hydration: Omit<ArchiveLastUsedHydratorDeps, "getAgent" | "listSessions" | "listAgents" | "listProfiles">;
    operations: Omit<ArchiveServiceDeps, "now" | "getAgent" | "getProfile" | "listSessions" | "hydrateSessionLastUsed" | "hydrateProfileLastUsed">;
  };
}

export interface SwarmManagerSessionComposition {
  provisioner: SessionProvisioner;
  archiveLastUsedHydrator: ArchiveLastUsedHydrator;
  archiveService: ArchiveService;
  sessionService: SwarmSessionService;
  projectAgentService: SwarmProjectAgentService;
  projectAgentSharingService: ProjectAgentSharingService;
  projectAgentCoordinator: ProjectAgentCoordinator;
}

/**
 * Builds the session/archive/project-agent service graph after the runtime,
 * conversation, pin, and knowledge owners exist.
 *
 * The inputs are grouped by domain capability rather than by manager method.
 * Constructors in this graph retain lazy callbacks and do not call back into
 * the facade while the graph is being assembled.
 */
export function createSwarmManagerSessionComposition(
  options: SwarmManagerSessionCompositionOptions,
): SwarmManagerSessionComposition {
  const { state, services } = options;

  const provisioner = new SessionProvisioner({
    ...options.provisioner,
    dataDir: state.config.paths.dataDir,
    runtimes: state.runtimes,
    forgetPinnedMessages: (agentId) => services.pins.forget(agentId),
    conversationProjector: services.conversations,
  });
  const archiveLastUsedHydrator = new ArchiveLastUsedHydrator({
    ...options.archive.hydration,
    getAgent: (agentId) => state.descriptors.get(agentId),
    listSessions: () => services.directory.sortedDescriptors().filter((descriptor) => descriptor.role === "manager"),
    listAgents: () => services.directory.sortedDescriptors(),
    listProfiles: () => services.directory.listProfiles(),
  });
  const archiveService = new ArchiveService({
    ...options.archive.operations,
    now: state.now,
    getAgent: (agentId) => state.descriptors.get(agentId),
    getProfile: (profileId) => state.profiles.get(profileId),
    listSessions: () => services.directory.sortedDescriptors().filter((descriptor) => descriptor.role === "manager"),
    hydrateSessionLastUsed: async (agentId) => {
      await archiveLastUsedHydrator.hydrateSessionIfMissing(agentId);
    },
    hydrateProfileLastUsed: async (profileId) => {
      await archiveLastUsedHydrator.hydrateProfileSessionsIfMissing(profileId);
    },
  });
  const sessionService = new SwarmSessionService({
    ...options.sessions,
    profiles: state.profiles,
    runtimes: state.runtimes,
    provisioner,
    prepareSessionCreation: (profileId, creationOptions) =>
      services.descriptorFactory.prepareSessionCreation(profileId, creationOptions),
    prepareSessionCreationFromBase: (profileId, base, creationOptions) =>
      services.descriptorFactory.prepareSessionCreationFromBase(profileId, base, creationOptions),
    resolveGlobalDelegationRosterId: async () =>
      (await resolveDelegationRosterSettings(state.config.paths.dataDir)).defaultRosterId,
    deleteProjectAgentRecord: (profileId, handle) =>
      deleteProjectAgentRecord(state.config.paths.dataDir, profileId, handle),
    copySessionHistoryForFork: (sourceSessionFile, targetSessionFile, fromMessageId) =>
      copySessionHistoryForFork({
        sourceSessionFile,
        targetSessionFile,
        fromMessageId,
        omittedCustomTypes: [
          CLAUDE_RUNTIME_STATE_ENTRY_TYPE,
          CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE,
          CURSOR_SDK_USAGE_ENTRY_TYPE,
        ],
      }),
    copyPinnedMessagesForFork: (source, forked) => services.pins.copyPinsForFork(source, forked),
    resetConversationHistory: (agentId) => services.conversations.resetConversationHistory(agentId),
  });
  const projectAgentService = new SwarmProjectAgentService({
    ...options.projectAgents,
    dataDir: state.config.paths.dataDir,
    descriptors: state.descriptors,
    provisioner,
    now: state.now,
    prepareSessionCreation: (profileId, creationOptions) =>
      services.descriptorFactory.prepareSessionCreation(profileId, creationOptions),
  });
  const projectAgentSharingService = new ProjectAgentSharingService({
    ...options.sharing,
    dataDir: state.config.paths.dataDir,
    now: state.now,
    getProfiles: () => services.directory.listProfiles(),
    getDescriptor: (agentId) => state.descriptors.get(agentId),
    getDescriptors: () => state.descriptors.values(),
  });
  const projectAgentCoordinator = new ProjectAgentCoordinator({
    ...options.projectAgentWorkflows,
    config: state.config,
    descriptors: state.descriptors,
    profiles: state.profiles,
    projectAgents: projectAgentService,
    sharing: projectAgentSharingService,
    now: state.now,
  });

  return {
    provisioner,
    archiveLastUsedHydrator,
    archiveService,
    sessionService,
    projectAgentService,
    projectAgentSharingService,
    projectAgentCoordinator,
  };
}
