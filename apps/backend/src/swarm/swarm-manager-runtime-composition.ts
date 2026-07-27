import type { SessionActiveToolsSnapshotEvent, SessionGoalSnapshotEvent, SpecialistTargetSpace } from "@forge/protocol";
import type { VersioningMutationSink } from "../versioning/versioning-types.js";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import { BootReconciler } from "./agents/descriptor-store/boot-reconciler.js";
import { ProfileBootReconciler } from "./agents/descriptor-store/profile-boot-reconciler.js";
import { WorkerBootRecovery } from "./agents/descriptor-store/worker-boot-recovery.js";
import { ProjectAgentMirrorReconciler } from "./agents/descriptor-store/project-agent-mirror-reconciler.js";
import { AssistantOutputRouter } from "./assistant-output-router.js";
import type { BrowserAutomationService } from "./browser-automation/browser-automation-service.js";
import { CaptureCascadeCoordinator } from "./capture-cascade-coordinator.js";
import type {
  CodexPluginDelegationTurnContext,
  CodexPluginRetryAuthorizationContext,
} from "./codex-app-server/codex-plugin-delegation-coordinator.js";
import type { CodexMcpToolGateEvaluation } from "./codex-app-server/codex-mcp-tool-gate.js";
import type { ForgeExtensionHost } from "./forge-extension-host.js";
import { SessionGoalCoordinator } from "./goals/session-goal-coordinator.js";
import { loadOnboardingState } from "./onboarding-state.js";
import { modelCatalogService } from "./model-catalog-service.js";
import type { SwarmObservabilityCoordinator } from "./swarm-observability-coordinator.js";
import type { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import { blockDismissedWorkGraphWorkers } from "./planning/work-graph-restart-recovery.js";
import { ProjectExecutableTrustCoordinator } from "./project-executable-trust-coordinator.js";
import { RestartRecoveryCoordinator } from "./restart-recovery-coordinator.js";
import { ModelChangeStartupRecoveryCoordinator } from "./runtime/model-change-startup-recovery-coordinator.js";
import type { RuntimeRecoveryState } from "./runtime/runtime-recovery-state.js";
import type { RuntimeAcquisitionRequirements, RuntimeCreationOptions, SwarmAgentRuntime } from "./runtime-contracts.js";
import type { SecretsEnvService } from "./secrets-env-service.js";
import { type SessionLifecycleCoordinator, SessionLifecycleCoordinator as SessionLifecycleCoordinatorImpl } from "./session-lifecycle-coordinator.js";
import type { SecureSessionCoordinatorPort } from "./secure-sessions/secure-session-lifecycle-port.js";
import type { SessionPinCoordinator } from "./session-pin-coordinator.js";
import type { SkillMetadata } from "./skill-metadata-service.js";
import { cleanupOldSharedConfigPaths, migrateSharedConfigLayout, removeRetiredPlanningArtifacts } from "./shared-config-migration.js";
import { SwarmAgentLifecycleService } from "./swarm-agent-lifecycle-service.js";
import { SwarmBootCoordinator } from "./swarm-boot-coordinator.js";
import { SwarmCompactionCoordinator } from "./swarm-compaction-coordinator.js";
import { createSwarmManagerCoordinationComposition } from "./swarm-manager-coordination-composition.js";
import type {
  SwarmManagerCompletedRuntimeComposition,
  SwarmManagerRuntimeBoundServices,
  SwarmManagerRuntimeCompositionOverrides,
} from "./swarm-manager-runtime-boundary.js";
import {
  createSwarmRuntimeControllerHost,
  type SwarmRuntimeControllerHostAdapterOptions,
} from "./swarm-runtime-controller-host-adapter.js";
import { SwarmRuntimeController } from "./swarm-runtime-controller.js";
import {
  createRuntimeLifecycleControllerHostCallbacks,
  SwarmRuntimeLifecycleCoordinator,
} from "./swarm-runtime-lifecycle-coordinator.js";
import { SwarmSpecialistFallbackManager } from "./swarm-specialist-fallback-manager.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import { SwarmWorkerHealthService } from "./swarm-worker-health-service.js";
import { getManagedModelProviderCredentialAvailability } from "./secrets-env-service.js";
import { migrateLegacyProfileKnowledgeToReferenceDoc } from "./reference-docs.js";
import { appendTurnLedgerRecord } from "./turn-ledger.js";
import { TurnContextCoordinator } from "./turn-context-coordinator.js";
import { createWorkGraphResultRecorder, WorkerResultCoordinator } from "./worker-result-coordinator.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  AgentsStoreFile,
  ConversationAttachment,
  ConversationEntryEvent,
  ManagerProfile,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SessionLifecycleEvent,
  SpawnAgentInput,
  SwarmConfig,
} from "./types.js";
import type { ResolvedSpecialistDefinitionLike } from "./prompt-resource-coordinator.js";

type RuntimeHost = SwarmRuntimeControllerHostAdapterOptions;

export interface RuntimeCompositionDescriptorMutations {
  upsertDescriptor(descriptor: AgentDescriptor): void;
  deleteDescriptor(agentId: string): void;
  upsertProfile(profile: ManagerProfile): void;
  deleteProfile(profileId: string): void;
  patchDescriptor(
    agentId: string,
    patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor),
  ): Promise<AgentDescriptor>;
  patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>,
  ): Promise<AgentDescriptor | undefined>;
  transactionPatchDescriptor(
    agentId: string,
    patch: (descriptor: AgentDescriptor) => AgentDescriptor,
    options?: { saveMode?: "rollback" | "best-effort"; onSaveError?: (error: unknown) => void },
  ): Promise<AgentDescriptor | undefined>;
  patchDescriptorInLiveMaps(
    agentId: string,
    patch: (descriptor: AgentDescriptor) => AgentDescriptor,
  ): AgentDescriptor | undefined;
}

export interface RuntimeCompositionEvents {
  emitConversationMessage: RuntimeHost["emitConversationMessage"];
  markSessionActivity: RuntimeHost["markSessionActivity"];
  emitStatus: RuntimeHost["emitStatus"];
  emitAgentsSnapshot(): void;
  emitProfilesSnapshot(): void;
  emitSessionLifecycle(event: SessionLifecycleEvent): void;
  emitSessionGoalSnapshot(event: SessionGoalSnapshotEvent): void;
  emitSessionActiveToolsSnapshot(snapshot: SessionActiveToolsSnapshotEvent | null): void;
  clearSessionActiveTools(agentId: string): SessionActiveToolsSnapshotEvent | null;
  saveStore(): Promise<void>;
  queueVersionedToolMutation: RuntimeHost["queueVersionedToolMutation"];
  emitModelCacheObservation: RuntimeHost["emitModelCacheObservation"];
  logDebug(message: string, details?: unknown): void;
}

export interface RuntimeCompositionMessaging {
  getConversationHistory(agentId?: string): ConversationEntryEvent[];
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: {
      origin?: "user" | "internal";
      skipTurnLedger?: boolean;
      internalDeliveryKind?: "bootstrap" | "codex_plugin_bootstrap";
      attachments?: ConversationAttachment[];
      planStep?: string;
      planAssignmentSource?: "spawn_agent" | "send_message_to_agent";
    },
  ): Promise<SendMessageReceipt>;
  sendWorkerResult(
    workerAgentId: string,
    resultText: string,
    expectedAssignmentId: string,
  ): Promise<SendMessageReceipt>;
  publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system",
  ): Promise<unknown>;
  terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean },
  ): Promise<void>;
  sendManagerBootstrapMessage(managerId: string): Promise<void>;
}

export interface RuntimeCompositionRuntimeResources {
  getPiModelsJsonPath(): string;
  getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }>;
  getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>>;
  resolveAndValidateCwd(cwd: string, options?: { enforceAllowlist?: boolean }): Promise<string>;
  ensureSessionFileParentDirectory(sessionFile: string): Promise<void>;
  ensureDirectories(): Promise<void>;
  loadStore(): Promise<AgentsStoreFile>;
  loadSecrets(): Promise<void>;
  reloadSkillMetadata(): Promise<void>;
  reloadModelCatalog(): Promise<void>;
  preloadSessionPlanStates(): Promise<void>;
  deleteManagerSchedulesFile(profileId: string): Promise<void>;
  getOrCreateRuntimeForDescriptor(descriptor: AgentDescriptor, requirements?: RuntimeAcquisitionRequirements): Promise<SwarmAgentRuntime>;
}

export interface RuntimeCompositionRuntimeFactory {
  createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime>;
}

export interface RuntimeCompositionResolution {
  resolvePromptWithFallback(
    category: "archetype" | "operational",
    promptId: string,
    profileId: string,
    fallback: string,
  ): Promise<string>;
  resolveSpecialistRosterForProfile(
    profileId: string,
    targetSpace?: SpecialistTargetSpace,
  ): Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSpecialistRosterForManager(
    manager: AgentDescriptor,
    targetSpace?: SpecialistTargetSpace,
  ): Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor;
  resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string,
    profileId: string,
  ): Promise<string | undefined>;
  normalizeSpecialistHandle(value: string): Promise<string | undefined>;
  resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string>;
  injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string;
  resolveDefaultModelDescriptor(): AgentModelDescriptor;
}

export interface RuntimeCompositionCaptureOperations {
  forkSession(
    sourceAgentId: string,
    options: { label: string; fromMessageId?: string; sessionPurpose: "capture_check" },
  ): Promise<{ sessionAgent: AgentDescriptor }>;
  deleteSession(agentId: string): Promise<void>;
}

export interface RuntimeCompositionSessionOperations {
  materializeSortOrder(): void;
  deleteConversationHistory(agentId: string, sessionFile: string): void;
  assertExternalProjectAgentCapability(
    agentId: string,
    capability: "create_session" | "create_project_agent",
  ): void;
  getTerminalArchiveHooks():
    | {
        suspendProfileTerminals(profileId: string): Promise<unknown>;
        restoreProfileTerminals(profileId: string): Promise<unknown>;
      }
    | undefined;
}

export interface SwarmManagerRuntimeCompositionOptions {
  state: {
    config: SwarmConfig;
    descriptors: Map<string, AgentDescriptor>;
    profiles: Map<string, ManagerProfile>;
    runtimeRecoveryState: RuntimeRecoveryState;
    now(): string;
  };
  foundation: {
    forgeExtensionHost: ForgeExtensionHost;
    sessionPins: SessionPinCoordinator;
    secrets: SecretsEnvService;
    observability: SwarmObservabilityCoordinator;
    versioningService?: VersioningMutationSink;
  };
  toolHost: SwarmToolHost;
  browserAutomation: BrowserAutomationService;
  secureSessions: SecureSessionCoordinatorPort;
  descriptors: RuntimeCompositionDescriptorMutations;
  events: RuntimeCompositionEvents;
  messaging: RuntimeCompositionMessaging;
  runtimeResources: RuntimeCompositionRuntimeResources;
  runtimeFactory: RuntimeCompositionRuntimeFactory;
  resolution: RuntimeCompositionResolution;
  capture: RuntimeCompositionCaptureOperations;
  sessions: RuntimeCompositionSessionOperations;
}
export type {
  SwarmManagerCompletedRuntimeComposition,
  SwarmManagerRuntimeBoundServices,
  SwarmManagerRuntimeCompositionOverrides,
} from "./swarm-manager-runtime-boundary.js";
/**
 * Typed, phased owner for the runtime/lifecycle/boot graph.
 *
 * The controller must be created before conversation and turn services, while
 * lifecycle and boot must be created after them. The two explicit bind phases
 * make that order reviewable and keep every pre-existing callback lazy.
 */
export class SwarmManagerRuntimeComposition {
  readonly captureCascade: CaptureCascadeCoordinator;
  readonly restartRecovery: RestartRecoveryCoordinator;
  readonly runtimeController: SwarmRuntimeController;
  readonly assistantOutput: AssistantOutputRouter;
  readonly modelChangeStartupRecovery: ModelChangeStartupRecoveryCoordinator;
  readonly workerResults: WorkerResultCoordinator;
  readonly workerHealth: SwarmWorkerHealthService;
  readonly specialistFallback: SwarmSpecialistFallbackManager;

  private plans: SessionPlanCoordinator | undefined;
  private goalCoordinator: SessionGoalCoordinator | undefined;
  private compactionCoordinator: SwarmCompactionCoordinator | undefined;
  private services: SwarmManagerRuntimeBoundServices | undefined;
  private completed: SwarmManagerCompletedRuntimeComposition | undefined;

  constructor(private readonly options: SwarmManagerRuntimeCompositionOptions) {
    const { state, messaging } = options;
    this.captureCascade = this.createCaptureCascade();
    this.restartRecovery = new RestartRecoveryCoordinator({
      descriptors: state.descriptors,
      getSessionTarget: (agentId) => this.requireRuntimeLifecycle().getTurnLedgerSessionTarget(agentId),
      sendMessage: (fromAgentId, targetAgentId, message, delivery, sendOptions) =>
        options.messaging.sendMessage(fromAgentId, targetAgentId, message, delivery, sendOptions),
      sendWorkerResult: (workerAgentId, resultText, expectedAssignmentId) =>
        options.messaging.sendWorkerResult(workerAgentId, resultText, expectedAssignmentId),
      now: state.now,
      onDecisionResolved: () => this.requireGoals().scheduleContinuationsAfterBoot(),
      onInterruptedWorkersDismissed: (workerIds) => blockDismissedWorkGraphWorkers({ descriptors: state.descriptors, plans: this.requirePlans(), workerIds }),
      logDebug: options.events.logDebug,
    });
    this.runtimeController = new SwarmRuntimeController(this.createRuntimeControllerHost());
    this.assistantOutput = new AssistantOutputRouter({
      descriptors: state.descriptors,
      profiles: state.profiles,
      projection: {
        activateManagerAssistantOutputTurn: (agentId, target, projectionOptions) =>
          this.runtimeController.activateManagerAssistantOutputTurn(agentId, target, projectionOptions),
        clearManagerAssistantOutputTurn: (agentId) =>
          this.runtimeController.clearManagerAssistantOutputTurn(agentId),
      },
      markTurnActivatedExternally: (agentId) =>
        this.requireTurnContext().markProviderCycleActivated(agentId),
      emitConversationMessage: (event) => options.events.emitConversationMessage(event),
      markSessionActivity: (agentId, timestamp) => options.events.markSessionActivity(agentId, timestamp),
      now: state.now,
      logDebug: options.events.logDebug,
    });
    this.modelChangeStartupRecovery = new ModelChangeStartupRecoveryCoordinator({
      now: state.now,
      logDebug: options.events.logDebug,
      getEffectiveContextWindow: (modelId, provider) =>
        modelCatalogService.getEffectiveContextWindow(modelId, provider),
      hasPinnedContent: (agentId) => options.foundation.sessionPins.hasPinnedContent(agentId),
    });
    this.workerResults = new WorkerResultCoordinator({
      getConversationHistory: messaging.getConversationHistory,
      recordWorkGraphResult: createWorkGraphResultRecorder({
        descriptors: state.descriptors,
        getPlans: () => this.requirePlans(),
      }),
      deliverWorkerResult: (workerAgentId, resultText, expectedAssignmentId) =>
        messaging.sendWorkerResult(workerAgentId, resultText, expectedAssignmentId),
      logDebug: options.events.logDebug,
    });
    this.workerHealth = this.createWorkerHealth();
    this.specialistFallback = this.createSpecialistFallback();
    this.runtimeController.setSpecialistFallbackManager(this.specialistFallback);
  }

  get runtimes(): Map<string, SwarmAgentRuntime> {
    return this.runtimeController.runtimes;
  }

  get runtimeCreationPromisesByAgentId(): Map<string, Promise<SwarmAgentRuntime>> {
    return this.runtimeController.runtimeCreationPromisesByAgentId;
  }

  get runtimeTokensByAgentId(): Map<string, number> {
    return this.runtimeController.runtimeTokensByAgentId;
  }

  attachPlanning(plans: SessionPlanCoordinator): SwarmCompactionCoordinator {
    if (this.plans || this.compactionCoordinator) {
      throw new Error("Runtime composition planning is already attached");
    }
    this.plans = plans;
    const coordination = createSwarmManagerCoordinationComposition({
      options: this.options,
      plans,
      captureCascade: this.captureCascade,
      restartRecovery: this.restartRecovery,
      getServices: () => this.requireServices(),
      getTurnContext: () => this.requireTurnContext(),
      getRuntimeLifecycle: () => this.requireRuntimeLifecycle(),
    });
    this.goalCoordinator = coordination.goals;
    this.compactionCoordinator = coordination.compaction;
    return this.compactionCoordinator;
  }

  complete(
    services: SwarmManagerRuntimeBoundServices,
    overrides: SwarmManagerRuntimeCompositionOverrides = {},
  ): SwarmManagerCompletedRuntimeComposition {
    if (this.completed || this.services) {
      throw new Error("Runtime composition is already complete");
    }
    if (!this.plans || !this.compactionCoordinator) {
      throw new Error("Runtime composition planning must be attached before completion");
    }
    this.services = services;

    const turnContext = this.createTurnContext();
    const runtimeLifecycle = new SwarmRuntimeLifecycleCoordinator({
      dataDir: this.options.state.config.paths.dataDir,
      descriptors: this.options.state.descriptors,
      controller: this.runtimeController,
      workerHealth: this.workerHealth,
      turnContext,
      codexScopes: services.codexPlugin,
      plans: this.plans,
      goals: this.requireGoals(),
      choices: services.choices,
      descriptorMutations: this.options.descriptors,
      directory: services.directory,
      events: services.eventCoordinator,
      now: this.options.state.now,
      logDebug: this.options.events.logDebug,
    });

    const lifecycle = this.createLifecycle(runtimeLifecycle, services, overrides);
    const projectExecutableTrust = this.createProjectExecutableTrust(
      lifecycle,
      runtimeLifecycle,
      services,
    );
    const sessionLifecycle = this.createSessionLifecycle(
      lifecycle,
      projectExecutableTrust,
      services,
    );
    const boot = this.createBoot(
      lifecycle,
      projectExecutableTrust,
      runtimeLifecycle,
      services,
    );
    this.completed = {
      turnContext,
      runtimeLifecycle,
      goals: this.requireGoals(),
      lifecycle,
      projectExecutableTrust,
      sessionLifecycle,
      boot,
    };
    return this.completed;
  }

  get compaction(): SwarmCompactionCoordinator {
    if (!this.compactionCoordinator) {
      throw new Error("Runtime composition planning has not been attached");
    }
    return this.compactionCoordinator;
  }

  get goals(): SessionGoalCoordinator {
    return this.requireGoals();
  }

  private createRuntimeControllerHost() {
    const { state, foundation, events, runtimeResources } = this.options;
    return createSwarmRuntimeControllerHost({
      toolHost: this.options.toolHost,
      config: state.config,
      forgeExtensionHost: foundation.forgeExtensionHost,
      now: state.now,
      descriptors: state.descriptors,
      runtimeRecoveryState: state.runtimeRecoveryState,
      getWorkerHealthState: () => ({
        workerStallState: this.workerHealth.workerStallState,
        workerActivityState: this.workerHealth.workerActivityState,
      }),
      getLateBoundServices: () => ({
        conversationProjector: this.requireServices().conversation,
        promptService: this.requireServices().configuration.prompts,
        secretsEnvService: foundation.secrets,
        cortexService: this.requireServices().cortex,
      }),
      getObservabilityService: () => foundation.observability.getService(),
      getPiModelsJsonPathOrThrow: runtimeResources.getPiModelsJsonPath,
      getCompactionRuntimeSettingsProvider: () =>
        this.requireServices().knowledge.getCompactionRuntimeSettingsProvider(),
      getMemoryRuntimeResources: runtimeResources.getMemoryRuntimeResources,
      getSwarmContextFiles: runtimeResources.getSwarmContextFiles,
      resolveProjectExecutableTrustPlanForRuntime: (input) =>
        this.requireProjectExecutableTrust().resolvePlanForRuntime(input),
      maybeRecoverWorkerWithSpecialistFallback: (agentId, errorMessage, sourcePhase, runtimeToken) =>
        this.specialistFallback.maybeRecoverWorkerWithSpecialistFallback({
          agentId,
          errorMessage,
          sourcePhase,
          runtimeToken,
          handleRuntimeStatus: (token, targetAgentId, status, pendingCount, contextUsage) =>
            this.requireRuntimeLifecycle().handleRuntimeStatus(
              token,
              targetAgentId,
              status,
              pendingCount,
              contextUsage,
            ),
          handleRuntimeAgentEnd: (token, targetAgentId) =>
            this.requireRuntimeLifecycle().handleRuntimeAgentEnd(token, targetAgentId),
        }),
      updateSessionMetaForWorkerDescriptor: (descriptor, prompt) =>
        this.requireServices().knowledge.updateSessionMetaForWorkerDescriptor(descriptor, prompt),
      refreshSessionMetaStatsBySessionId: (sessionId, sessionFile) =>
        this.requireServices().knowledge.refreshSessionMetaStatsBySessionId(sessionId, sessionFile),
      refreshSessionMetaStats: (descriptor, sessionFile) =>
        this.requireServices().knowledge.refreshSessionMetaStats(descriptor, sessionFile),
      maybeRecordModelCapacityBlock: (agentId, descriptor, error) =>
        this.requireServices().configuration.maybeRecordModelCapacityBlock(agentId, descriptor, error),
      ...createRuntimeLifecycleControllerHostCallbacks(() => this.requireRuntimeLifecycle()),
      endBrowserTurn: (profileId, sessionAgentId, turnId) => this.options.browserAutomation.endBrowserTurn(profileId, sessionAgentId, turnId),
      incrementSessionCompactionCount: (profileId, sessionId, failureLogKey) =>
        this.requireServices().knowledge.incrementSessionCompactionCount(
          profileId,
          sessionId,
          failureLogKey,
        ),
      incrementWorkerCompactionCount: (agentId, failureLogKey) =>
        this.requireRuntimeLifecycle().incrementWorkerCompactionCount(agentId, failureLogKey),
      patchDescriptorFromRuntimeStatus: this.options.descriptors.patchDescriptorFromRuntimeStatus,
      emitConversationMessage: events.emitConversationMessage,
      markSessionActivity: events.markSessionActivity,
      emitStatus: events.emitStatus,
      saveStore: events.saveStore,
      queueVersionedToolMutation: events.queueVersionedToolMutation,
      logDebug: events.logDebug,
      isModelCacheVisualizationEnabled: () =>
        this.requireServices().configuration.isModelCacheVisualizationEnabled(),
      emitModelCacheObservation: events.emitModelCacheObservation,
      resolveManagerAssistantFinalOutputTarget: (agentId, target) =>
        this.assistantOutput.resolveManagerFinalTarget(agentId, target),
      resolveManagerAssistantFinalOutputRoute: (agentId, target) =>
        this.assistantOutput.resolveManagerFinalRoute(agentId, target),
    });
  }

  private createCaptureCascade(): CaptureCascadeCoordinator {
    const { state, capture, messaging, events } = this.options;
    return new CaptureCascadeCoordinator({
      dataDir: state.config.paths.dataDir,
      isEnabled: () => Boolean(
        state.config.cortexEnabled &&
          this.requireServices().knowledge.getKnowledgeV2SettingsService().getSettings().enabled
      ),
      host: {
        getDescriptor: (agentId) => state.descriptors.get(agentId),
        executeJudgePrompt: (prompt) => this.requireServices().knowledge.executeCaptureJudgePrompt(prompt),
        forkSession: async (sourceAgentId, options) => {
          const fork = await capture.forkSession(sourceAgentId, {
            label: options.label,
            fromMessageId: options.fromMessageId,
            sessionPurpose: "capture_check",
          });
          return { sessionAgentId: fork.sessionAgent.agentId };
        },
        sendRestrictedTurn: async (forkedAgentId, message) => {
          await messaging.sendMessage(forkedAgentId, forkedAgentId, message, "auto", {
            origin: "internal",
            internalDeliveryKind: "bootstrap",
            skipTurnLedger: true,
          });
        },
        discardFork: (forkedAgentId) => capture.deleteSession(forkedAgentId),
      },
      now: state.now,
      logDebug: events.logDebug,
    });
  }

  private createWorkerHealth(): SwarmWorkerHealthService {
    const { state, messaging, events } = this.options;
    return new SwarmWorkerHealthService({
      descriptors: state.descriptors,
      runtimes: this.runtimeController.runtimes,
      workerResults: this.workerResults,
      sendMessage: (fromAgentId, targetAgentId, message, delivery, sendOptions) =>
        messaging.sendMessage(fromAgentId, targetAgentId, message, delivery, sendOptions),
      publishToUser: messaging.publishToUser,
      terminateDescriptor: messaging.terminateDescriptor,
      saveStore: events.saveStore,
      emitAgentsSnapshot: events.emitAgentsSnapshot,
      isRuntimeInContextRecovery: (agentId) => this.requireRuntimeLifecycle().isRuntimeInContextRecovery(agentId),
      isRuntimeRecoveryActive: (agentId) => this.requireRuntimeLifecycle().isRuntimeRecoveryActive(agentId),
      hasRecoveryAbortedWorkerTurn: (agentId) => state.runtimeRecoveryState.hasRecoveryAbortedWorkerTurn(agentId),
      clearRecoveryAbortedWorkerTurn: (agentId) => state.runtimeRecoveryState.clearRecoveryAbortedWorkerTurn(agentId),
      isRestartRecoveryDecisionPending: () => this.restartRecovery.isDecisionPending(),
      now: state.now,
      onHealthSweep: () => this.requireRuntimeLifecycle().runLivenessHealthSweep(),
      logDebug: events.logDebug,
    });
  }

  private createSpecialistFallback(): SwarmSpecialistFallbackManager {
    const { state, resolution, events } = this.options;
    return new SwarmSpecialistFallbackManager({
      dataDir: state.config.paths.dataDir,
      descriptors: state.descriptors,
      runtimes: this.runtimeController.runtimes,
      getRuntime: (agentId) => this.runtimeController.getRuntime(agentId),
      isRuntime: (agentId, runtime) => this.runtimeController.isRuntime(agentId, runtime),
      getRuntimeToken: (agentId) => this.runtimeController.getRuntimeToken(agentId),
      clearRuntimeToken: (agentId, token) => this.requireRuntimeLifecycle().clearRuntimeToken(agentId, token),
      restoreRuntimeTokenForFallbackRollback: (agentId, token) => this.runtimeController.restoreRuntimeTokenForFallbackRollback(agentId, token),
      hasSecureRuntimeBinding: (runtime) => this.runtimeController.hasSecureRuntimeBinding(runtime),
      isSecureRuntimeBindingValid: (runtime) => this.runtimeController.isSecureRuntimeBindingValid(runtime),
      isSecureRuntimeBindingUsable: (agentId, runtime) => this.runtimeController.isSecureRuntimeBindingUsable(agentId, runtime),
      getRuntimeCreationPromise: (agentId) => this.runtimeController.getRuntimeCreationPromise(agentId),
      setRuntimeCreationPromise: (agentId, promise) => this.runtimeController.setRuntimeCreationPromise(agentId, promise),
      clearRuntimeCreationPromiseIfCurrent: (agentId, promise) => this.runtimeController.clearRuntimeCreationPromiseIfCurrent(agentId, promise),
      workerHealthService: this.workerHealth,
      now: state.now,
      resolveSpecialistRosterForProfile: resolution.resolveSpecialistRosterForProfile,
      resolveSpecialistRosterForManager: resolution.resolveSpecialistRosterForManager,
      resolveSpawnModelWithCapacityFallback: resolution.resolveSpawnModelWithCapacityFallback,
      resolveSystemPromptForDescriptor: resolution.resolveSystemPromptForDescriptor,
      injectWorkerIdentityContext: resolution.injectWorkerIdentityContext,
      createRuntimeForDescriptor: (descriptor, prompt, token, creationOptions) =>
        this.options.runtimeFactory.createRuntimeForDescriptor(
          descriptor,
          prompt,
          token,
          creationOptions,
        ),
      attachRuntime: (agentId, runtime) => this.runtimeController.attachRuntime(agentId, runtime),
      detachRuntime: (agentId, token) => this.requireRuntimeLifecycle().detachRuntime(agentId, token),
      detachRuntimeIfMatches: (agentId, runtime, token) =>
        this.runtimeController.detachRuntimeIfMatches(agentId, runtime, token),
      updateSessionMetaForWorkerDescriptor: (descriptor, prompt) =>
        this.requireServices().knowledge.updateSessionMetaForWorkerDescriptor(descriptor, prompt ?? undefined),
      refreshSessionMetaStatsBySessionId: (agentId) =>
        this.requireServices().knowledge.refreshSessionMetaStatsBySessionId(agentId),
      saveStore: events.saveStore,
      patchDescriptor: this.options.descriptors.transactionPatchDescriptor,
      patchDescriptorInLiveMaps: this.options.descriptors.patchDescriptorInLiveMaps,
      emitStatus: events.emitStatus,
      emitAgentsSnapshot: events.emitAgentsSnapshot,
      clearTrackedToolPaths: (agentId) => this.runtimeController.clearTrackedToolPaths(agentId),
      logDebug: events.logDebug,
    });
  }

  private createTurnContext() {
    const services = this.requireServices();
    return new TurnContextCoordinator<
      CodexMcpToolGateEvaluation,
      CodexPluginDelegationTurnContext,
      CodexPluginRetryAuthorizationContext
    >({
      descriptors: this.options.state.descriptors,
      getRuntimeToken: (agentId) => this.runtimeController.getRuntimeToken(agentId),
      ledger: {
        mintTurnId: (descriptor) => services.sessionMeta.mintTurnIdForDescriptor(descriptor),
        recordTurnDispatched: async (input) => {
          const target = this.requireRuntimeLifecycle().getTurnLedgerSessionTarget(input.agentId);
          if (!target) return;
          await appendTurnLedgerRecord(target, {
            t: "turn_dispatched",
            ...input,
            at: this.options.state.now(),
          });
        },
      },
      output: this.assistantOutput,
      codex: services.codexPlugin,
      observability: {
        activateRoot: (agentId, rootTurnId, parentRootTurnId) =>
          this.options.foundation.observability.activateRoot(agentId, rootTurnId, parentRootTurnId),
        clearRoot: (agentId) => this.options.foundation.observability.clearRoot(agentId),
        getActiveRootTurnId: (agentId) =>
          this.options.foundation.observability.getActiveRootTurnId(agentId),
        recordRuntimeSessionEvent: (agentId, runtimeToken, event) =>
          this.options.foundation.observability.recordRuntimeSessionEvent(agentId, runtimeToken, event),
      },
      logDebug: this.options.events.logDebug,
    });
  }

  private createLifecycle(
    runtimeLifecycle: SwarmRuntimeLifecycleCoordinator,
    services: SwarmManagerRuntimeBoundServices,
    overrides: SwarmManagerRuntimeCompositionOverrides,
  ): SwarmAgentLifecycleService {
    const { state, descriptors, events, messaging, resolution, runtimeResources, sessions } = this.options;
    return new SwarmAgentLifecycleService({
      dataDir: state.config.paths.dataDir,
      descriptors: state.descriptors,
      profiles: state.profiles,
      runtimes: this.runtimeController.runtimes,
      getRuntime: (agentId) => this.runtimeController.getRuntime(agentId),
      getRuntimeCreationPromise: (agentId) => this.runtimeController.getRuntimeCreationPromise(agentId),
      setRuntimeCreationPromise: (agentId, promise) =>
        this.runtimeController.setRuntimeCreationPromise(agentId, promise),
      clearRuntimeCreationPromiseIfCurrent: (agentId, promise) =>
        this.runtimeController.clearRuntimeCreationPromiseIfCurrent(agentId, promise),
      runtimeRecoveryState: state.runtimeRecoveryState,
      secureWorkers: this.options.secureSessions,
      modelCapacityBlocks: services.configuration.promptResources.modelCapacityBlocks,
      sessionProvisioner: services.provisioner,
      descriptorMutations: descriptors,
      now: state.now,
      getRequiredSessionDescriptor: (agentId) => services.directory.getRequiredSessionDescriptor(agentId),
      assertManager: (agentId, action) => services.directory.assertManager(agentId, action),
      hasRunningManagers: (filter) => services.directory.hasRunningManagers(filter),
      generateUniqueAgentId: (source) => services.directory.generateUniqueAgentId(source),
      generateUniqueManagerId: (source) => services.directory.generateUniqueManagerId(source),
      resolveAndValidateCwd: runtimeResources.resolveAndValidateCwd,
      resolveDefaultModelDescriptor: resolution.resolveDefaultModelDescriptor,
      getManagedModelProviderAvailability: () =>
        getManagedModelProviderCredentialAvailability(state.config, {
          credentialPoolService: this.options.foundation.secrets.getCredentialPoolService(),
        }),
      resolveSpawnWorkerArchetypeId: resolution.resolveSpawnWorkerArchetypeId,
      resolveSpecialistRosterForProfile: resolution.resolveSpecialistRosterForProfile,
      resolveSpecialistRosterForManager: resolution.resolveSpecialistRosterForManager,
      normalizeSpecialistHandle: resolution.normalizeSpecialistHandle,
      resolveSystemPromptForDescriptor: resolution.resolveSystemPromptForDescriptor,
      injectWorkerIdentityContext: resolution.injectWorkerIdentityContext,
      createRuntimeForDescriptor: (descriptor, prompt, token, creationOptions) =>
        this.options.runtimeFactory.createRuntimeForDescriptor(
          descriptor,
          prompt,
          token,
          creationOptions,
        ),
      allocateRuntimeToken: (agentId) => runtimeLifecycle.allocateRuntimeToken(agentId),
      clearRuntimeToken: (agentId, token) => runtimeLifecycle.clearRuntimeToken(agentId, token),
      getRuntimeToken: (agentId) => this.runtimeController.getRuntimeToken(agentId),
      hasSecureRuntimeBinding: (runtime) =>
        this.runtimeController.hasSecureRuntimeBinding(runtime),
      isSecureRuntimeBindingUsable: (agentId, runtime) => this.runtimeController.isSecureRuntimeBindingUsable(agentId, runtime),
      ensureSessionFileParentDirectory: runtimeResources.ensureSessionFileParentDirectory,
      updateSessionMetaForWorkerDescriptor: (descriptor, prompt) =>
        services.knowledge.updateSessionMetaForWorkerDescriptor(descriptor, prompt),
      refreshSessionMetaStatsBySessionId: (agentId) =>
        services.knowledge.refreshSessionMetaStatsBySessionId(agentId),
      refreshSessionMetaStats: (descriptor) => services.knowledge.refreshSessionMetaStats(descriptor),
      captureSessionRuntimePromptMeta: (descriptor, prompt) =>
        services.knowledge.captureSessionRuntimePromptMeta(descriptor, prompt),
      prepareManagerRuntimeCreation: (descriptor, prompt) =>
        this.modelChangeStartupRecovery.prepareManagerRuntimeCreation(descriptor, prompt),
      appendAppliedModelChangeContinuity: (descriptor, request, runtime) =>
        this.modelChangeStartupRecovery.appendAppliedModelChangeContinuity(descriptor, request, runtime),
      attachRuntime: (agentId, runtime) => this.runtimeController.attachRuntime(agentId, runtime),
      saveStore: events.saveStore,
      emitStatus: events.emitStatus,
      emitAgentsSnapshot: events.emitAgentsSnapshot,
      emitProfilesSnapshot: events.emitProfilesSnapshot,
      logDebug: events.logDebug,
      clearWorkerHealthState: (agentId) => runtimeLifecycle.clearWorkerHealthState(agentId),
      deleteWorkerStallState: (agentId) => runtimeLifecycle.deleteWorkerStallState(agentId),
      deleteWorkerActivityState: (agentId) => runtimeLifecycle.deleteWorkerActivityState(agentId),
      clearTrackedToolPaths: (agentId) => this.runtimeController.clearTrackedToolPaths(agentId),
      suppressIntentionalStopRuntimeCallbacks: (agentId, token) =>
        this.runtimeController.suppressIntentionalStopRuntimeCallbacks(agentId, token),
      clearIntentionalStopRuntimeCallbackSuppression: (agentId, token) =>
        this.runtimeController.clearIntentionalStopRuntimeCallbackSuppression(agentId, token),
      allowInvalidatedManualStopMessageEnd: (agentId, token) =>
        this.runtimeController.allowInvalidatedManualStopMessageEnd(agentId, token),
      markPendingManualManagerStopNotice: (agentId) =>
        runtimeLifecycle.markPendingManualManagerStopNotice(agentId),
      emitImmediateManualManagerStopNotice: (agentId, text) => runtimeLifecycle.emitImmediateManualManagerStopNotice(agentId, text),
      cancelAllPendingChoicesForAgent: (agentId) => {
        this.assistantOutput.clearChoiceContinuationsForAgent(agentId);
        services.choices.cancelAllPendingChoicesForAgent(agentId);
      },
      runRuntimeShutdown: (descriptor, action, shutdownOptions) => runtimeLifecycle.runRuntimeShutdown(descriptor, action, shutdownOptions),
      prepareRuntimeShutdown: (agentId) => this.runtimeController.prepareRuntimeShutdown(agentId),
      assertRuntimeCreationAllowed: (agentId) => this.runtimeController.assertRuntimeCreationAllowed(agentId),
      detachRuntime: (agentId, token) => runtimeLifecycle.detachRuntime(agentId, token),
      clearAgentTurnState: (agentId) => runtimeLifecycle.clearAgentState(agentId),
      detachRuntimeIfMatches: (agentId, runtime, token) =>
        this.runtimeController.detachRuntimeIfMatches(agentId, runtime, token),
      syncPinnedContentForManagerRuntime: async (descriptor, pinOptions) => {
        await this.options.foundation.sessionPins.syncPinnedContent(descriptor, pinOptions);
      },
      interruptExternalThreadSidecarTurn:
        overrides.interruptExternalThreadSidecarTurn ??
        ((agentId) => services.codexDirect.interruptTurn(agentId)),
      terminateExternalThreadSidecarTurn:
        overrides.terminateExternalThreadSidecarTurn ??
        ((agentId) => services.codexDirect.cleanupTurnStateForTermination(agentId)),
      sendMessage: messaging.sendMessage,
      sendManagerBootstrapMessage: messaging.sendManagerBootstrapMessage,
      materializeSortOrder: sessions.materializeSortOrder,
      getSessionsForProfile: (profileId) =>
        services.directory.getSessionsForProfile(profileId) as Array<
          AgentDescriptor & { role: "manager"; profileId: string }
        >,
      getWorkersForManager: (managerId) => services.directory.getWorkersForManager(managerId),
      deleteConversationHistory: sessions.deleteConversationHistory,
      deleteManagerSchedulesFile: runtimeResources.deleteManagerSchedulesFile,
      migrateLegacyProfileKnowledgeToReferenceDoc: async (profileId) => {
        await migrateLegacyProfileKnowledgeToReferenceDoc(state.config.paths.dataDir, profileId, {
          versioning: this.options.foundation.versioningService,
        });
      },
      prepareWorkerDescriptorForSpawn: (input) =>
        services.codexPlugin.prepareWorkerDescriptorForSpawn({
          descriptor: input.descriptor,
          specialistId: input.specialistId,
          spawnInput: input.input,
        }),
    });
  }

  private createProjectExecutableTrust(
    lifecycle: SwarmAgentLifecycleService,
    runtimeLifecycle: SwarmRuntimeLifecycleCoordinator,
    services: SwarmManagerRuntimeBoundServices,
  ): ProjectExecutableTrustCoordinator {
    const { state, descriptors, events, messaging } = this.options;
    return new ProjectExecutableTrustCoordinator({
      config: state.config,
      host: {
        listDescriptors: () => state.descriptors.values(),
        requestUserChoice: (agentId, questions) => services.choices.requestUserChoice(agentId, questions),
        applyBaseManagerRuntimeRecyclePolicy: (agentId, reason) =>
          lifecycle.applyAgentRuntimeRecyclePolicy(agentId, reason),
        terminateDescriptor: messaging.terminateDescriptor,
        getRuntime: (agentId) => this.runtimeController.getRuntime(agentId),
        getRuntimeToken: (agentId) => this.runtimeController.getRuntimeToken(agentId),
        getRuntimeCreationPromise: (agentId) => this.runtimeController.getRuntimeCreationPromise(agentId),
        deleteRuntimeCreationPromise: (agentId) =>
          this.runtimeController.runtimeCreationPromisesByAgentId.delete(agentId),
        clearRuntimeToken: (agentId, token) => runtimeLifecycle.clearRuntimeToken(agentId, token),
        suppressIntentionalStopRuntimeCallbacks: (agentId, token) =>
          this.runtimeController.suppressIntentionalStopRuntimeCallbacks(agentId, token),
        clearIntentionalStopRuntimeCallbackSuppression: (agentId, token) =>
          this.runtimeController.clearIntentionalStopRuntimeCallbackSuppression(agentId, token),
        detachRuntime: (agentId, token) => runtimeLifecycle.detachRuntime(agentId, token),
        upsertDescriptorInLiveMaps: descriptors.upsertDescriptor,
        emitStatus: events.emitStatus,
        emitTrustRuntimeRestartMessage: (agentId, timestamp) =>
          events.emitConversationMessage({
            type: "conversation_message",
            agentId,
            role: "system",
            text: "Repository executable trust changed. Manager runtime was restarted to apply the new trust policy.",
            timestamp,
            source: "system",
            sourceContext: { channel: "web" },
          }),
        saveStore: events.saveStore,
        emitAgentsSnapshot: events.emitAgentsSnapshot,
        now: state.now,
        logDebug: (message, details) => events.logDebug(message, details),
      },
      runtimeRecovery: state.runtimeRecoveryState,
      deferredPlans: this.options.foundation.forgeExtensionHost,
    });
  }

  private createSessionLifecycle(
    lifecycle: SwarmAgentLifecycleService,
    trust: ProjectExecutableTrustCoordinator,
    services: SwarmManagerRuntimeBoundServices,
  ): SessionLifecycleCoordinator {
    const { events, sessions, runtimeResources, messaging } = this.options;
    return new SessionLifecycleCoordinatorImpl({
      descriptors: this.options.state.descriptors,
      profiles: this.options.state.profiles,
      sessions: services.sessionService,
      lifecycle,
      archive: services.archive,
      archiveHydrator: services.archiveHydrator,
      projectAgents: services.projectAgentService,
      capture: this.captureCascade,
      plans: this.requirePlans(),
      goals: this.requireGoals(),
      extensions: this.options.foundation.forgeExtensionHost,
      codex: {
        closeManagerScopesAndRetry: (agentId) => services.codexPlugin.closeManagerScopesAndRetry(agentId),
      },
      activeTools: {
        clearSession: (agentId) =>
          events.emitSessionActiveToolsSnapshot(events.clearSessionActiveTools(agentId)),
      },
      browser: this.options.browserAutomation,
      secureSessions: this.options.secureSessions,
      events,
      terminal: { getHooks: sessions.getTerminalArchiveHooks },
      descriptorMutations: { patchDescriptor: this.options.descriptors.patchDescriptor },
      runtime: {
        resolveAndValidateCwd: runtimeResources.resolveAndValidateCwd,
        beforeResumeSession: (descriptor) => trust.applyPendingManagerRuntimeRecycleBeforeRuntimeUse(descriptor),
        sendInitialMessage: async (creatorAgentId, targetAgentId, message) => {
          await messaging.sendMessage(creatorAgentId, targetAgentId, message, "auto");
        },
      },
      projectAgentAccess: {
        assertExternalCapability: sessions.assertExternalProjectAgentCapability,
        notifySharedTargetsChanged: (agentId) => services.projectAgents.notifySharedTargetsChanged(agentId),
      },
      logDebug: events.logDebug,
    });
  }

  private createBoot(
    lifecycle: SwarmAgentLifecycleService,
    trust: ProjectExecutableTrustCoordinator,
    runtimeLifecycle: SwarmRuntimeLifecycleCoordinator,
    services: SwarmManagerRuntimeBoundServices,
  ): SwarmBootCoordinator {
    const { state, descriptors, events, runtimeResources } = this.options;
    const profileReconciler = new ProfileBootReconciler({
      cortexEnabled: state.config.cortexEnabled,
      defaultModel: state.config.defaultModel,
      descriptors: state.descriptors,
      profiles: state.profiles,
      mutations: {
        upsertDescriptor: descriptors.upsertDescriptor,
        upsertProfile: descriptors.upsertProfile,
        deleteProfile: descriptors.deleteProfile,
      },
      logDebug: events.logDebug,
    });
    const storeReconciler = new BootReconciler({
      config: state.config,
      descriptors: state.descriptors,
      profiles: state.profiles,
      loadStore: runtimeResources.loadStore,
      saveStore: events.saveStore,
      profileReconciler,
      preloadPinnedMessageIndexes: () => this.options.foundation.sessionPins.preload(),
      preloadSessionPlanStates: async () => {
        await Promise.all([
          runtimeResources.preloadSessionPlanStates(),
          this.requireGoals().preload(),
        ]);
      },
      logDebug: events.logDebug,
    });
    const workerRecovery = new WorkerBootRecovery({
      dataDir: state.config.paths.dataDir,
      descriptors: state.descriptors,
      upsertDescriptor: descriptors.upsertDescriptor,
      logDebug: events.logDebug,
    });

    return new SwarmBootCoordinator({
      config: state.config,
      descriptors: state.descriptors,
      storeReconciler,
      restartRecovery: this.restartRecovery,
      workerRecovery,
      preparation: {
        ensureDirectories: runtimeResources.ensureDirectories,
        migrateSharedConfigLayout: () => migrateSharedConfigLayout(state.config.paths.dataDir),
        cleanupOldSharedConfigPaths: () => cleanupOldSharedConfigPaths(state.config.paths.dataDir),
        removeRetiredPlanningArtifacts: () => removeRetiredPlanningArtifacts(state.config.paths.dataDir),
        ensureCanonicalAuthFilePath: () => ensureCanonicalAuthFilePath(state.config).then(() => undefined),
        reloadModelCatalog: runtimeResources.reloadModelCatalog,
        loadSecrets: runtimeResources.loadSecrets,
        loadCompactionSettings: () => services.knowledge.loadCompactionSettingsForRuntime(),
        reloadSkillMetadata: runtimeResources.reloadSkillMetadata,
        resolveDefaultCwd: (cwd) => runtimeResources.resolveAndValidateCwd(cwd, { enforceAllowlist: false }),
        refreshDefaultMemoryTemplate: () => services.knowledge.refreshMemoryTemplateForBoot(),
      },
      domains: {
        normalizeCodexPluginWorkers: () => services.codexPlugin.normalizeWorkersForBoot(),
        reconcileWorkerSpecialistMetadata: () => lifecycle.reconcileWorkerSpecialistMetadataForBoot(),
        ensureCortexProfile: () => services.knowledge.ensureCortexProfileForBoot(),
        loadOnboardingState: () => loadOnboardingState(state.config.paths.dataDir).then(() => undefined),
        ensureLegacyProfileKnowledgeReferenceDocs: () => services.knowledge.migrateLegacyProfileKnowledgeForBoot(),
        reconcileProjectAgentMirror: () => new ProjectAgentMirrorReconciler({
          dataDir: state.config.paths.dataDir,
          descriptors: state.descriptors,
          profiles: state.profiles,
        }).reconcileAllProfiles(),
        reconcileProjectAgentSharing: () => services.projectAgents.reconcileSharing(),
      },
      sessions: {
        ensureMemoryFiles: () => services.knowledge.ensureMemoryFilesForBoot(),
        rebuildSessionManifest: () => services.knowledge.rebuildSessionManifestForBoot(),
        hydrateCompactionCounts: () => services.knowledge.hydrateCompactionCountsForBoot(),
        startCompactionCountBackfill: () => services.knowledge.startCompactionCountBackfill(),
        loadConversationHistories: () => services.conversation.loadConversationHistoriesFromStore(),
      },
      secureSessions: this.options.secureSessions,
      runtimes: {
        sortedDescriptors: () => services.directory.sortedDescriptors(),
        shouldRestore: (descriptor) => lifecycle.shouldRestoreRuntimeForDescriptor(descriptor),
        restore: async (descriptor) => {
          await runtimeResources.getOrCreateRuntimeForDescriptor(descriptor);
        },
        hasRuntime: (agentId) => this.runtimeController.hasRuntime(agentId),
        restoredAgentIds: () => Array.from(this.runtimeController.runtimes.keys()),
        emitStatus: events.emitStatus,
      },
      publication: {
        listPrompts: () => services.promptRegistry.listAll(),
        emitAgentsSnapshot: events.emitAgentsSnapshot,
        emitProfilesSnapshot: events.emitProfilesSnapshot,
        scheduleProjectExecutableTrustPrompts: () => trust.schedulePromptsForAllManagers(),
        startWorkerHealth: () => runtimeLifecycle.startWorkerHealth(),
        scheduleGoalContinuations: () => this.requireGoals().scheduleContinuationsAfterBoot(),
      },
      store: {
        save: events.saveStore,
        upsertDescriptor: descriptors.upsertDescriptor,
      },
      now: state.now,
      logDebug: events.logDebug,
    });
  }

  private requirePlans(): SessionPlanCoordinator {
    if (!this.plans) throw new Error("Runtime composition planning has not been attached"); return this.plans;
  }
  private requireGoals(): SessionGoalCoordinator {
    if (!this.goalCoordinator) throw new Error("Runtime composition planning has not been attached");
    return this.goalCoordinator;
  }
  private requireServices(): SwarmManagerRuntimeBoundServices {
    if (!this.services) throw new Error("Runtime composition services are not bound"); return this.services;
  }
  private requireTurnContext() {
    if (!this.completed?.turnContext) throw new Error("Runtime composition is not complete");
    return this.completed.turnContext;
  }

  private requireRuntimeLifecycle(): SwarmRuntimeLifecycleCoordinator {
    if (!this.completed?.runtimeLifecycle) throw new Error("Runtime composition is not complete");
    return this.completed.runtimeLifecycle;
  }
  private requireProjectExecutableTrust(): ProjectExecutableTrustCoordinator {
    if (!this.completed?.projectExecutableTrust) throw new Error("Runtime composition is not complete");
    return this.completed.projectExecutableTrust;
  }
}
export const createSwarmManagerRuntimeComposition = (options: SwarmManagerRuntimeCompositionOptions) =>
  new SwarmManagerRuntimeComposition(options);
