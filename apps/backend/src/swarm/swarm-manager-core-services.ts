import { ConversationProjector } from "./conversation-projector.js";
import {
  createDescriptorStoreAdapter,
  type DescriptorStoreAdapter,
} from "./agents/descriptor-store/live-map-adapter.js";
import type { AgentDirectory } from "./agent-directory.js";
import type { AgentDescriptorStore } from "./agents/agent-descriptor-store.js";
import { ManagerBootstrapCoordinator } from "./manager-bootstrap-coordinator.js";
import { PersistenceService } from "./persistence-service.js";
import { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import type { SwarmManagerFoundation } from "./swarm-manager-foundation.js";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import {
  extractDescriptorAgentId,
  validateAgentDescriptor,
} from "./swarm-manager-utils.js";
import type {
  AgentDescriptor,
  ConversationEntryEvent,
  ManagerProfile,
  SwarmConfig,
} from "./types.js";

export interface SwarmManagerCoreServicesState {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  runtimes: Map<string, SwarmAgentRuntime>;
  conversationEntriesByAgentId: Map<string, ConversationEntryEvent[]>;
  now: () => string;
}

export interface SwarmManagerCoreServices {
  managerBootstrapCoordinator: ManagerBootstrapCoordinator;
  descriptorStoreAdapter: DescriptorStoreAdapter;
  persistenceService: PersistenceService;
  conversationProjector: ConversationProjector;
  sessionPlanCoordinator: SessionPlanCoordinator;
}

export interface SwarmManagerCoreServicesOptions {
  state: SwarmManagerCoreServicesState;
  foundation: Pick<SwarmManagerFoundation, "promptRegistry" | "sidebarPerfRecorder">;
  descriptorStore: AgentDescriptorStore;
  directory: AgentDirectory;
  logDebug: (message: string, details?: unknown) => void;
  managerBootstrap: Omit<
    ConstructorParameters<typeof ManagerBootstrapCoordinator>[0],
    "dataDir" | "descriptors" | "promptRegistry" | "hasRuntime" | "logDebug"
  >;
  descriptorStoreAdapter: Omit<
    Parameters<typeof createDescriptorStoreAdapter>[0],
    "store" | "descriptors" | "profiles" | "logDebug"
  >;
  persistence: Omit<
    ConstructorParameters<typeof PersistenceService>[0],
    | "config"
    | "descriptors"
    | "sortedDescriptors"
    | "sortedProfiles"
    | "getConfiguredManagerId"
    | "validateAgentDescriptor"
    | "extractDescriptorAgentId"
    | "logDebug"
  >;
  conversation: Omit<
    ConstructorParameters<typeof ConversationProjector>[0],
    | "descriptors"
    | "runtimes"
    | "conversationEntriesByAgentId"
    | "now"
    | "perf"
    | "logDebug"
  >;
  sessionPlan: Pick<
    ConstructorParameters<typeof SessionPlanCoordinator>[0],
    "emitSnapshot" | "isWorkerActive"
  >;
}

/**
 * Composes the core services which bridge foundation-owned state to later
 * runtime and event coordinators. Their callbacks remain lazy, preserving the
 * manager's constructor ordering while keeping that wiring out of the facade.
 */
export function createSwarmManagerCoreServices(
  options: SwarmManagerCoreServicesOptions,
): SwarmManagerCoreServices {
  const { state, foundation } = options;
  const managerBootstrapCoordinator = new ManagerBootstrapCoordinator({
    ...options.managerBootstrap,
    dataDir: state.config.paths.dataDir,
    descriptors: state.descriptors,
    promptRegistry: foundation.promptRegistry,
    hasRuntime: (agentId) => state.runtimes.has(agentId),
    logDebug: options.logDebug,
  });
  const descriptorStoreAdapter = createDescriptorStoreAdapter({
    ...options.descriptorStoreAdapter,
    store: options.descriptorStore,
    descriptors: state.descriptors,
    profiles: state.profiles,
    logDebug: options.logDebug,
  });
  const persistenceService = new PersistenceService({
    ...options.persistence,
    config: state.config,
    descriptors: state.descriptors,
    sortedDescriptors: () => options.directory.sortedDescriptors(),
    sortedProfiles: () => options.directory.sortedProfiles(),
    getConfiguredManagerId: () => options.directory.getConfiguredManagerId(),
    validateAgentDescriptor,
    extractDescriptorAgentId,
    logDebug: options.logDebug,
  });
  const conversationProjector = new ConversationProjector({
    ...options.conversation,
    descriptors: state.descriptors,
    runtimes: state.runtimes,
    conversationEntriesByAgentId: state.conversationEntriesByAgentId,
    now: state.now,
    perf: foundation.sidebarPerfRecorder,
    logDebug: options.logDebug,
  });
  const sessionPlanCoordinator = new SessionPlanCoordinator({
    ...options.sessionPlan,
    dataDir: state.config.paths.dataDir,
    now: state.now,
    getPlanSummaries: (sessionAgentId) => conversationProjector
      .getConversationHistory(sessionAgentId)
      .filter((entry) => entry.type === "plan_summary"),
    emitPlanSummary: (event) => conversationProjector.emitPlanSummary(event),
    logDebug: options.logDebug,
  });

  return {
    managerBootstrapCoordinator,
    descriptorStoreAdapter,
    persistenceService,
    conversationProjector,
    sessionPlanCoordinator,
  };
}
