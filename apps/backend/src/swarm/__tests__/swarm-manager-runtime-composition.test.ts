import { describe, expect, it, vi } from "vitest";
import type { AgentDirectory } from "../agent-directory.js";
import type { ArchiveLastUsedHydrator } from "../archive/archive-last-used-hydrator.js";
import type { ArchiveService } from "../archive/archive-service.js";
import type { CodexDirectSidecarCoordinator } from "../codex-app-server/codex-direct-sidecar-coordinator.js";
import type { CodexPluginDelegationCoordinator } from "../codex-app-server/codex-plugin-delegation-coordinator.js";
import type { ConversationProjector } from "../conversation-projector.js";
import { ForgeExtensionHost } from "../forge-extension-host.js";
import type { KnowledgeMemoryCoordinator } from "../knowledge-memory-coordinator.js";
import type { ProjectAgentCoordinator } from "../project-agent-coordinator.js";
import { RuntimeRecoveryState } from "../runtime/runtime-recovery-state.js";
import type { SecretsEnvService } from "../secrets-env-service.js";
import type { SessionPinCoordinator } from "../session-pin-coordinator.js";
import type { SessionProvisioner } from "../session-provisioner.js";
import type { SwarmChoiceService } from "../swarm-choice-service.js";
import type { SwarmConfigurationCoordinator } from "../swarm-configuration-coordinator.js";
import type { SwarmCortexService } from "../swarm-cortex-service.js";
import type { SwarmEventCoordinator } from "../swarm-event-coordinator.js";
import {
  createSwarmManagerRuntimeComposition,
  type SwarmManagerRuntimeBoundServices,
  type SwarmManagerRuntimeCompositionOptions,
} from "../swarm-manager-runtime-composition.js";
import { SwarmObservabilityCoordinator } from "../swarm-observability-coordinator.js";
import type { SwarmProjectAgentService } from "../swarm-project-agent-service.js";
import type { SwarmSessionMetaService } from "../swarm-session-meta-service.js";
import type { SwarmSessionService } from "../swarm-session-service.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { PromptRegistry } from "../prompt-registry.js";
import { SessionPlanCoordinator } from "../planning/session-plan-coordinator.js";
import type { SwarmConfig } from "../types.js";

function config(): SwarmConfig {
  return {
    host: "127.0.0.1",
    port: 47187,
    debug: false,
    isDesktop: false,
    runtimeTarget: "builder",
    cortexEnabled: false,
    allowNonManagerSubscriptions: false,
    managerDisplayName: "Manager",
    defaultModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" },
    defaultCwd: "/tmp",
    cwdAllowlistRoots: ["/tmp"],
    paths: {
      rootDir: "/tmp/forge-runtime-composition",
      dataDir: "/tmp/forge-runtime-composition/data",
      agentsStoreFile: "/tmp/forge-runtime-composition/data/swarm/agents.json",
      uploadsDir: "/tmp/forge-runtime-composition/data/uploads",
      sharedAuthFile: "/tmp/forge-runtime-composition/data/shared/config/auth/auth.json",
      managerAgentDir: "/tmp/forge-runtime-composition/manager-agent",
    } as SwarmConfig["paths"],
  };
}

function toolHost(): SwarmToolHost {
  const noResult = vi.fn();
  return {
    listAgents: vi.fn(() => []),
    getContextMode: () => "summary",
    getWorkerActivity: vi.fn(() => undefined),
    spawnAgent: noResult,
    killAgent: noResult,
    sendMessage: noResult,
    createSessionFromAgent: noResult,
    publishToUser: noResult,
    requestUserChoice: noResult,
    invokeBrowserAutomation: noResult,
    updatePlan: noResult,
    updateWorkGraph: noResult,
    acceptWorkGraphNode: noResult,
    createGoal: noResult,
    getGoal: noResult,
    updateGoal: noResult,
  } as unknown as SwarmToolHost;
}

function createOptions(late: ReturnType<typeof vi.fn>): SwarmManagerRuntimeCompositionOptions {
  const descriptors = new Map();
  const profiles = new Map();
  const now = () => "2026-07-14T12:00:00.000Z";
  const forgeExtensionHost = new ForgeExtensionHost({
    dataDir: "/tmp/forge-runtime-composition/data",
    now,
  });
  const observability = new SwarmObservabilityCoordinator({
    descriptors,
    getRuntimeToken: () => undefined,
  });

  return {
    state: {
      config: config(),
      descriptors,
      profiles,
      runtimeRecoveryState: new RuntimeRecoveryState(),
      now,
    },
    foundation: {
      forgeExtensionHost,
      sessionPins: {
        hasPinnedContent: late,
        syncPinnedContent: late,
        preload: late,
      } as unknown as SessionPinCoordinator,
      secrets: { getCredentialPoolService: late } as unknown as SecretsEnvService,
      observability,
    },
    toolHost: toolHost(),
    attention: {
      reportStatusTransition: late,
      suppressWorkingEpoch: late,
      retireSession: late,
      reportPendingTurn: late,
      reportContinuationAbandoned: late,
    },
    descriptors: {
      upsertDescriptor: late,
      deleteDescriptor: late,
      upsertProfile: late,
      deleteProfile: late,
      patchDescriptor: late,
      patchDescriptorFromRuntimeStatus: late,
      transactionPatchDescriptor: late,
      patchDescriptorInLiveMaps: late,
    },
    events: {
      emitConversationMessage: late,
      markSessionActivity: late,
      emitStatus: late,
      emitAgentsSnapshot: late,
      emitProfilesSnapshot: late,
      emitSessionLifecycle: late,
      emitSessionActiveToolsSnapshot: late,
      emitSessionGoalSnapshot: late,
      clearSessionActiveTools: late,
      saveStore: late,
      queueVersionedToolMutation: late,
      emitModelCacheObservation: late,
      emitGenerationThroughput: late,
      logDebug: vi.fn(),
    },
    messaging: {
      getConversationHistory: late,
      sendMessage: late,
      publishToUser: late,
      terminateDescriptor: late,
      sendManagerBootstrapMessage: late,
    },
    runtimeResources: {
      getPiModelsJsonPath: () => "/tmp/models.json",
      getMemoryRuntimeResources: late,
      getSwarmContextFiles: late,
      resolveAndValidateCwd: late,
      ensureSessionFileParentDirectory: late,
      ensureDirectories: late,
      loadStore: late,
      loadSecrets: late,
      loadSecureSecretSettings: late,
      reloadSkillMetadata: late,
      reloadModelCatalog: late,
      preloadSessionPlanStates: late,
      deleteManagerSchedulesFile: late,
      getOrCreateRuntimeForDescriptor: late,
    },
    runtimeFactory: { createRuntimeForDescriptor: late },
    resolution: {
      resolvePromptWithFallback: late,
      resolveSpecialistRosterForProfile: late,
      resolveSpecialistRosterForManager: late,
      resolveSpawnModelWithCapacityFallback: late,
      resolveSpawnWorkerArchetypeId: late,
      normalizeSpecialistHandle: late,
      resolveSystemPromptForDescriptor: late,
      injectWorkerIdentityContext: late,
      resolveDefaultModelDescriptor: late,
    },
    capture: { forkSession: late, deleteSession: late },
    sessions: {
      materializeSortOrder: late,
      deleteConversationHistory: late,
      assertExternalProjectAgentCapability: late,
      getTerminalArchiveHooks: late,
    },
  };
}

function boundServices(): SwarmManagerRuntimeBoundServices {
  return {
    conversation: {} as ConversationProjector,
    configuration: {
      promptResources: { modelCapacityBlocks: new Map() },
    } as unknown as SwarmConfigurationCoordinator,
    knowledge: {} as KnowledgeMemoryCoordinator,
    cortex: {} as SwarmCortexService,
    directory: {} as AgentDirectory,
    eventCoordinator: {} as SwarmEventCoordinator,
    sessionMeta: {} as SwarmSessionMetaService,
    choices: {} as SwarmChoiceService,
    provisioner: {} as SessionProvisioner,
    sessionService: {} as SwarmSessionService,
    archiveHydrator: {} as ArchiveLastUsedHydrator,
    archive: {} as ArchiveService,
    projectAgentService: {} as SwarmProjectAgentService,
    projectAgents: {} as ProjectAgentCoordinator,
    codexDirect: {} as CodexDirectSidecarCoordinator,
    codexPlugin: {} as CodexPluginDelegationCoordinator,
    promptRegistry: {} as PromptRegistry,
  };
}

describe("SwarmManagerRuntimeComposition", () => {
  it("documents the phased runtime graph and does not read late services during construction", () => {
    const late = vi.fn(() => {
      throw new Error("late runtime capability was invoked during composition");
    });

    const composition = createSwarmManagerRuntimeComposition(createOptions(late));

    expect(composition.runtimeController).toBeDefined();
    expect(composition.workerHealth).toBeDefined();
    expect(composition.specialistFallback).toBeDefined();
    expect(late).not.toHaveBeenCalled();
  });

  it("requires planning before one-shot completion and preserves lazy callback timing", () => {
    const late = vi.fn(() => {
      throw new Error("late runtime capability was invoked during composition");
    });
    const composition = createSwarmManagerRuntimeComposition(createOptions(late));

    expect(() => composition.complete(boundServices())).toThrow(
      "Runtime composition planning must be attached before completion",
    );

    const plans = new SessionPlanCoordinator({
      dataDir: "/tmp/forge-runtime-composition/data",
      now: () => "2026-07-14T12:00:00.000Z",
      getPlanSummaries: () => [],
      emitPlanSummary: vi.fn(),
      emitSnapshot: vi.fn(),
      logDebug: vi.fn(),
    });
    expect(composition.attachPlanning(plans)).toBe(composition.compaction);

    const completed = composition.complete(boundServices());

    expect(completed.turnContext).toBeDefined();
    expect(completed.lifecycle).toBeDefined();
    expect(completed.boot).toBeDefined();
    expect(() => composition.attachPlanning(plans)).toThrow(
      "Runtime composition planning is already attached",
    );
    expect(() => composition.complete(boundServices())).toThrow(
      "Runtime composition is already complete",
    );
    expect(late).not.toHaveBeenCalled();
  });
});
