import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ObservabilityFacade } from "../observability/observability-types.js";
import type { VersioningMutation, VersioningMutationSink } from "../versioning/versioning-types.js";
import type { PromptRegistry } from "./prompt-registry.js";
import { ConversationProjector } from "./conversation-projector.js";
import type { SidebarPerfRecorder } from "../stats/sidebar-perf-types.js";
import {
  createLiveCompactionRuntimeSettingsProvider,
  type CompactionRuntimeSettingsProvider,
} from "./compaction-runtime-settings-provider.js";
import { KnowledgeV2SettingsService } from "./knowledge-v2-settings-service.js";
import { KnowledgeService } from "./knowledge-service.js";
import { CaptureCascadeCoordinator } from "./capture-cascade-coordinator.js";
import { KnowledgeMemoryCoordinator } from "./knowledge-memory-coordinator.js";
import { RestartRecoveryCoordinator } from "./restart-recovery-coordinator.js";
import { SwarmBootCoordinator } from "./swarm-boot-coordinator.js";
import { SwarmObservabilityCoordinator } from "./swarm-observability-coordinator.js";
import { SwarmEventCoordinator } from "./swarm-event-coordinator.js";
import { CollaborationStorageProvisioner } from "./collaboration-storage-provisioner.js";
import {
  AgentMessageDispatcher,
  type AgentMessageLedgerPort,
} from "./agent-message-dispatcher.js";
import { SwarmCompactionCoordinator } from "./swarm-compaction-coordinator.js";
import { AgentDescriptorStore } from "./agents/agent-descriptor-store.js";
import {
  createDescriptorStoreAdapter,
  type DescriptorStoreAdapter,
} from "./agents/descriptor-store/live-map-adapter.js";
import { AgentDirectory } from "./agent-directory.js";
import { createSwarmManagerFoundation } from "./swarm-manager-foundation.js";
import { SwarmConfigurationCoordinator } from "./swarm-configuration-coordinator.js";
import { createSwarmManagerSessionComposition } from "./swarm-manager-session-composition.js";
import { createSwarmManagerRuntimeComposition } from "./swarm-manager-runtime-composition.js";
import { SessionInteractionCoordinator } from "./session-interaction-coordinator.js";
import { SwarmManagerFacade } from "./swarm-manager-facade.js";
import type { SwarmManagerFacadeServices } from "./swarm-manager-facade-services.js";
import { ManagerBootstrapCoordinator } from "./manager-bootstrap-coordinator.js";
import { ProfileSessionBookkeepingCoordinator } from "./profile-session-bookkeeping-coordinator.js";
import { ArchiveService } from "./archive/archive-service.js";
import { ArchiveLastUsedHydrator } from "./archive/archive-last-used-hydrator.js";
import { ProjectAgentCoordinator } from "./project-agent-coordinator.js";
import { PersistenceService } from "./persistence-service.js";
import { ForgeExtensionHost } from "./forge-extension-host.js";
import { RuntimeRecoveryState } from "./runtime/runtime-recovery-state.js";
import { SwarmRuntimeController } from "./swarm-runtime-controller.js";
import {
  SwarmRuntimeLifecycleCoordinator,
} from "./swarm-runtime-lifecycle-coordinator.js";
import { SwarmSpecialistFallbackManager } from "./swarm-specialist-fallback-manager.js";
import { SwarmWorkerHealthService } from "./swarm-worker-health-service.js";
import { appendTurnLedgerRecord } from "./turn-ledger.js";
import {
  getManagedModelProviderCredentialAvailability,
  SecretsEnvService
} from "./secrets-env-service.js";
import { SwarmMemoryMergeService } from "./swarm-memory-merge-service.js";
import { SwarmSessionMetaService } from "./swarm-session-meta-service.js";
import { SkillFileService } from "./skill-file-service.js";
import { SkillMetadataService, type SkillMetadata } from "./skill-metadata-service.js";
import { SwarmChoiceService } from "./swarm-choice-service.js";
import { SwarmCortexService } from "./swarm-cortex-service.js";
import {
  type ProjectExecutableTrustPlan
} from "./project-executable-trust.js";
import { ProjectExecutableTrustCoordinator } from "./project-executable-trust-coordinator.js";
import {
  SwarmAgentLifecycleService,
  type AgentLifecycleStopSessionOptions,
  type ExternalThreadStopInterruptCallback,
  type ExternalThreadTerminateCleanupCallback,
} from "./swarm-agent-lifecycle-service.js";
import { SessionProvisioner } from "./session-provisioner.js";
import { SessionDescriptorFactory } from "./session-descriptor-factory.js";
import { SessionPinCoordinator } from "./session-pin-coordinator.js";
import { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.js";
import { TurnContextCoordinator } from "./turn-context-coordinator.js";
import { SwarmSessionService } from "./swarm-session-service.js";
import { ProjectAgentSharingService } from "./project-agent-sharing-service.js";
import { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import { SessionActiveToolsState } from "./session-active-tools.js";
import { ConversationAttachmentService } from "./conversation-attachment-service.js";
import {
  InboundConversationAppender,
  UserMessageCoordinator,
} from "./user-message-coordinator.js";
import { AssistantOutputRouter } from "./assistant-output-router.js";
import type {
  RuntimeCreationOptions,
  SwarmAgentRuntime
} from "./runtime-contracts.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  ConversationEntryEvent,
  ManagerProfile,
  SwarmConfig,
  SwarmModelPreset,
} from "./types.js";
import {
  extractDescriptorAgentId,
  normalizeOptionalAgentId,
  nowIso,
  validateAgentDescriptor
} from "./swarm-manager-utils.js";
import type { CodexAppServerService } from "./codex-app-server/codex-app-server-service.js";
import {
  type CodexMcpToolGateEvaluation,
} from "./codex-app-server/codex-mcp-tool-gate.js";
import {
  CodexPluginDelegationCoordinator,
  type CodexPluginDelegationTurnContext,
  type CodexPluginRetryAuthorizationContext,
} from "./codex-app-server/codex-plugin-delegation-coordinator.js";
import {
  CodexDirectSidecarCoordinator,
  type CodexDirectSidecarManager,
} from "./codex-app-server/codex-direct-sidecar-coordinator.js";
import type { CodexAppServerServiceOptions } from "./codex-app-server/types.js";

export {
  analyzeLatestCortexCloseoutNeed,
  buildSessionMemoryRuntimeView,
  normalizeCortexUserVisiblePaths
} from "./swarm-manager-utils.js";
export type { RestartRecoverySnapshot } from "@forge/protocol";
export type { CodexTransportDebugAgentDiagnostics } from "./swarm-manager-facade.js";
export type {
  AppendConversationUserMessageOptions,
  AppendConversationUserMessageResult,
  DispatchRuntimeUserMessageOptions,
} from "./user-message-coordinator.js";

// AgentDescriptor now includes specialistId/specialistDisplayName/specialistColor directly.

// Retain recent non-web activity while preserving the full user-facing web transcript.
// Integration services add ~2 event listeners per profile (Telegram conversation_message,
// Telegram session_lifecycle). Keep this limit above base listeners +
// (2 × expected maximum profiles).
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;

export { ChoiceRequestCancelledError } from "./swarm-choice-service.js";

type SwarmManagerOptions = {
  now?: () => string;
  versioningService?: VersioningMutationSink;
  observability?: ObservabilityFacade;
  codexAppServerService?: CodexAppServerService;
  codexAppServerServiceOptions?: CodexAppServerServiceOptions;
  /** Stop-only seam for preserved sidecars; defaults to CodexAppServerService.interruptTurn(). */
  interruptExternalThreadSidecarTurn?: ExternalThreadStopInterruptCallback;
  /** Kill/delete cleanup-only seam. Distinct from stop interrupts; defaults to Codex cleanup. */
  terminateExternalThreadSidecarTurn?: ExternalThreadTerminateCleanupCallback;
  compactionRuntimeSettingsProvider?: CompactionRuntimeSettingsProvider;
  knowledgeV2SettingsService?: KnowledgeV2SettingsService;
  knowledgeService?: KnowledgeService;
};

export class SwarmManager extends SwarmManagerFacade implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly defaultModelPreset: SwarmModelPreset;

  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly profiles = new Map<string, ManagerProfile>();
  private readonly agentDirectory: AgentDirectory;
  private readonly runtimeController: SwarmRuntimeController;
  private readonly runtimes: Map<string, SwarmAgentRuntime>;
  readonly runtimeCreationPromisesByAgentId: Map<string, Promise<SwarmAgentRuntime>>;
  readonly runtimeTokensByAgentId: Map<string, number>;
  private readonly runtimeRecoveryState = new RuntimeRecoveryState();
  private readonly projectAgentMessageTimestampsBySender = new Map<string, number[]>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly workerHealthService: SwarmWorkerHealthService;
  private readonly runtimeLifecycleCoordinator: SwarmRuntimeLifecycleCoordinator;
  private readonly restartRecoveryCoordinator: RestartRecoveryCoordinator;
  private readonly bootCoordinator: SwarmBootCoordinator;
  private readonly specialistFallbackManager: SwarmSpecialistFallbackManager;
  private readonly managerBootstrapCoordinator: ManagerBootstrapCoordinator;
  private readonly profileSessionBookkeepingCoordinator: ProfileSessionBookkeepingCoordinator;
  private readonly configurationCoordinator: SwarmConfigurationCoordinator;
  private readonly sidebarPerfRecorder: SidebarPerfRecorder;
  private readonly sessionActiveTools = new SessionActiveToolsState();
  private readonly conversationProjector: ConversationProjector;
  private readonly eventCoordinator: SwarmEventCoordinator;
  private readonly conversationAttachmentService: ConversationAttachmentService;
  private readonly inboundConversationAppender: InboundConversationAppender;
  private readonly userMessageCoordinator: UserMessageCoordinator;
  private readonly sessionPlanCoordinator: SessionPlanCoordinator;
  private readonly compactionCoordinator: SwarmCompactionCoordinator;
  private readonly descriptorStore: AgentDescriptorStore;
  private readonly descriptorStoreAdapter: DescriptorStoreAdapter;
  private readonly persistenceService: PersistenceService;
  private readonly forgeExtensionHost: ForgeExtensionHost;
  private readonly skillMetadataService: SkillMetadataService;
  private readonly skillFileService: SkillFileService;
  private readonly secretsEnvService: SecretsEnvService;
  private readonly sessionMetaService: SwarmSessionMetaService;
  private readonly collaborationStorageProvisioner: CollaborationStorageProvisioner;
  private readonly cortexService: SwarmCortexService;
  private readonly memoryMergeService: SwarmMemoryMergeService;
  private readonly knowledgeMemoryCoordinator: KnowledgeMemoryCoordinator;
  private readonly sessionProvisioner: SessionProvisioner;
  private readonly sessionDescriptorFactory: SessionDescriptorFactory;
  private readonly sessionPinCoordinator: SessionPinCoordinator;
  private readonly assistantOutputRouter: AssistantOutputRouter;
  private readonly projectExecutableTrustCoordinator: ProjectExecutableTrustCoordinator;
  private readonly turnContextCoordinator: TurnContextCoordinator<
    CodexMcpToolGateEvaluation,
    CodexPluginDelegationTurnContext,
    CodexPluginRetryAuthorizationContext
  >;
  private readonly lifecycleService: SwarmAgentLifecycleService;
  private readonly choiceService: SwarmChoiceService;
  private readonly sessionService: SwarmSessionService;
  private readonly archiveLastUsedHydrator: ArchiveLastUsedHydrator;
  private readonly archiveService: ArchiveService;
  private readonly projectAgentSharingService: ProjectAgentSharingService;
  private readonly projectAgentCoordinator: ProjectAgentCoordinator;
  private readonly agentMessageDispatcher: AgentMessageDispatcher<CodexMcpToolGateEvaluation>;
  private readonly sessionLifecycleCoordinator: SessionLifecycleCoordinator;
  private readonly sessionInteractionCoordinator: SessionInteractionCoordinator;
  private readonly facadeServices: SwarmManagerFacadeServices;
  readonly promptRegistry: PromptRegistry;
  private readonly codexDirectSidecarCoordinator: CodexDirectSidecarCoordinator;
  private readonly codexPluginDelegationCoordinator: CodexPluginDelegationCoordinator;

  private terminalArchiveHooks: {
    suspendProfileTerminals: (profileId: string) => Promise<unknown>;
    restoreProfileTerminals: (profileId: string) => Promise<unknown>;
  } | undefined;
  private readonly versioningService: VersioningMutationSink | undefined;
  private readonly observabilityCoordinator: SwarmObservabilityCoordinator;
  private readonly knowledgeV2SettingsService: KnowledgeV2SettingsService;
  private readonly knowledgeService: KnowledgeService;
  private readonly captureCascadeCoordinator: CaptureCascadeCoordinator;

  constructor(config: SwarmConfig, options?: SwarmManagerOptions) {
    super();
    this.now = options?.now ?? nowIso;
    this.versioningService = options?.versioningService;
    const foundation = createSwarmManagerFoundation({
      config,
      descriptors: this.descriptors,
      profiles: this.profiles,
      now: this.now,
      versioningService: this.versioningService,
      getConfiguredManagerId: () => normalizeOptionalAgentId(config.managerId),
      getRuntimeToken: (agentId) => this.runtimeController.getRuntimeToken(agentId),
      sessionPins: {
        listSessions: () => Array.from(this.descriptors.values()).filter(
          (descriptor): descriptor is AgentDescriptor & { role: "manager"; profileId: string } =>
            this.agentDirectory.isSessionAgent(descriptor),
        ),
        requireSession: (agentId) => this.agentDirectory.getRequiredSessionDescriptor(agentId),
        requireBuilderSession: (agentId, action) => this.agentDirectory.getRequiredBuilderSessionDescriptor(agentId, action),
        assertMutable: (descriptor) =>
          this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
        getConversationHistory: (agentId) => this.getConversationHistory(agentId),
        getRuntime: (agentId) => this.runtimes.get(agentId),
        patchDescriptor: (agentId, patch) => this.descriptorStoreAdapter.patchDescriptor(agentId, patch),
        setConversationMessagePinned: (agentId, messageId, pinned) =>
          this.conversationProjector.setConversationMessagePinned(agentId, messageId, pinned),
        captureRuntimePromptMeta: (descriptor, prompt) =>
          this.knowledgeMemoryCoordinator.captureSessionRuntimePromptMeta(descriptor, prompt),
        emitMessagePinned: (agentId, messageId, pinned, timestamp) =>
          this.eventCoordinator.emitMessagePinned(agentId, messageId, pinned, timestamp),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        logDebug: (message, details) => this.logDebug(message, details, config),
      },
      logDebug: (message, details) => this.logDebug(message, details, config),
      overrides: {
        observability: options?.observability,
        compactionRuntimeSettingsProvider: options?.compactionRuntimeSettingsProvider,
        knowledgeV2SettingsService: options?.knowledgeV2SettingsService,
        knowledgeService: options?.knowledgeService,
      },
    });
    this.config = foundation.config;
    this.defaultModelPreset = foundation.defaultModelPreset;
    this.knowledgeV2SettingsService = foundation.knowledgeV2SettingsService;
    this.knowledgeService = foundation.knowledgeService;
    this.promptRegistry = foundation.promptRegistry;
    this.forgeExtensionHost = foundation.forgeExtensionHost;
    this.sidebarPerfRecorder = foundation.sidebarPerfRecorder;
    this.descriptorStore = foundation.descriptorStore;
    this.conversationAttachmentService = foundation.conversationAttachmentService;
    this.sessionDescriptorFactory = foundation.sessionDescriptorFactory;
    this.sessionPinCoordinator = foundation.sessionPinCoordinator;
    this.skillMetadataService = foundation.skillMetadataService;
    this.skillFileService = foundation.skillFileService;
    this.secretsEnvService = foundation.secretsEnvService;
    this.observabilityCoordinator = foundation.observabilityCoordinator;
    this.agentDirectory = this.createAgentDirectory();
    const { compactionRuntimeSettingsProvider, liveCompactionRuntimeSettingsProvider } = foundation;
    const runtimeComposition = this.createRuntimeComposition();
    this.captureCascadeCoordinator = runtimeComposition.captureCascade;
    this.restartRecoveryCoordinator = runtimeComposition.restartRecovery;
    this.runtimeController = runtimeComposition.runtimeController;
    this.assistantOutputRouter = runtimeComposition.assistantOutput;
    this.workerHealthService = runtimeComposition.workerHealth;
    this.specialistFallbackManager = runtimeComposition.specialistFallback;
    this.runtimes = runtimeComposition.runtimes;
    this.runtimeCreationPromisesByAgentId = runtimeComposition.runtimeCreationPromisesByAgentId;
    this.runtimeTokensByAgentId = runtimeComposition.runtimeTokensByAgentId;
    this.managerBootstrapCoordinator = new ManagerBootstrapCoordinator({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      promptRegistry: this.promptRegistry,
      hasRuntime: (agentId) => this.runtimes.has(agentId),
      sendMessage: (fromAgentId, targetAgentId, message, delivery, sendOptions) =>
        this.sendMessage(fromAgentId, targetAgentId, message, delivery, sendOptions),
      logDebug: (message, details) => this.logDebug(message, details),
    });
    this.descriptorStoreAdapter = createDescriptorStoreAdapter({
      store: this.descriptorStore,
      descriptors: this.descriptors,
      profiles: this.profiles,
      logDebug: (message, details) => this.logDebug(message, details),
    });
    this.persistenceService = new PersistenceService({
      config: this.config,
      descriptors: this.descriptors,
      sortedDescriptors: () => this.agentDirectory.sortedDescriptors(),
      sortedProfiles: () => this.agentDirectory.sortedProfiles(),
      getConfiguredManagerId: () => this.agentDirectory.getConfiguredManagerId(),
      resolveMemoryOwnerAgentId: (descriptor) =>
        this.knowledgeMemoryCoordinator.resolveMemoryOwnerAgentId(descriptor),
      validateAgentDescriptor,
      extractDescriptorAgentId,
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.conversationProjector = new ConversationProjector({
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      conversationEntriesByAgentId: this.conversationEntriesByAgentId,
      now: this.now,
      emitServerEvent: (eventName, payload) => {
        this.emit(eventName, payload);
        if (payload.type === "agent_tool_call") {
          this.eventCoordinator.emitSessionActiveToolsSnapshot(this.sessionActiveTools.recordToolCall(payload));
        }
      },
      logDebug: (message, details) => this.logDebug(message, details),
      perf: this.sidebarPerfRecorder,
      getPinnedMessageIds: (agentId) => this.sessionPinCoordinator.getPinnedMessageIds(agentId)
    });
    this.sessionPlanCoordinator = new SessionPlanCoordinator({
      dataDir: this.config.paths.dataDir,
      now: this.now,
      getPlanSummaries: (sessionAgentId) => this.conversationProjector
        .getConversationHistory(sessionAgentId)
        .filter((entry) => entry.type === "plan_summary"),
      emitPlanSummary: (event) => this.conversationProjector.emitPlanSummary(event),
      emitSnapshot: (event) => this.emit("session_plan_snapshot", event),
      logDebug: (message, details) => this.logDebug(message, details),
    });
    this.compactionCoordinator = runtimeComposition.attachPlanning(this.sessionPlanCoordinator);
    this.codexDirectSidecarCoordinator = this.createCodexDirectSidecarCoordinator(options);
    this.codexPluginDelegationCoordinator = this.createCodexPluginDelegationCoordinator();
    this.configurationCoordinator = this.createConfigurationCoordinator();
    this.sessionMetaService = new SwarmSessionMetaService({
      dataDir: this.config.paths.dataDir,
      agentsStoreFile: this.config.paths.agentsStoreFile,
      descriptors: this.descriptors,
      getSortedDescriptors: () => this.agentDirectory.sortedDescriptors(),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      emitAgentsSnapshot: () => {
        this.eventCoordinator.emitAgentsSnapshot();
      },
      ensureSkillMetadataLoaded: () => this.skillMetadataService.ensureSkillMetadataLoaded(),
      getAdditionalSkillPaths: () => this.skillMetadataService.getAdditionalSkillPaths(),
      getAgentMemoryPath: (agentId) => this.knowledgeMemoryCoordinator.getAgentMemoryPath(agentId),
      resolveSystemPromptForDescriptor: (descriptor) => this.resolveSystemPromptForDescriptor(descriptor)
    });
    this.collaborationStorageProvisioner = this.createCollaborationStorageProvisioner();
    this.cortexService = new SwarmCortexService({
      config: this.config,
      now: this.now,
      descriptors: this.descriptors,
      knowledgeService: this.knowledgeService,
      knowledgeV2SettingsService: this.knowledgeV2SettingsService,
      handleCaptureCascade: (descriptor, trigger) => this.captureCascadeCoordinator.run(descriptor.agentId, trigger),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.eventCoordinator = this.createEventCoordinator();
    this.inboundConversationAppender = this.createInboundConversationAppender();
    this.memoryMergeService = new SwarmMemoryMergeService({
      config: this.config,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      emitAgentsSnapshot: () => {
        this.eventCoordinator.emitAgentsSnapshot();
      },
      getRequiredSessionDescriptor: (agentId) => this.agentDirectory.getRequiredSessionDescriptor(agentId),
      upsertDescriptor: (descriptor) => this.descriptorStoreAdapter.upsertDescriptor(descriptor),
      getAgentMemoryPath: (agentId) => this.knowledgeMemoryCoordinator.getAgentMemoryPath(agentId),
      resolvePreferredManagerId: (options) => this.agentDirectory.resolvePreferredManagerId(options),
      resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
        this.managerBootstrapCoordinator.resolvePromptWithFallback(category, promptId, profileId, fallback),
      ensureMemoryFilesForBoot: (options) => this.persistenceService.ensureMemoryFilesForBoot(options),
      ensureAgentMemoryFileInPersistence: (memoryFilePath, memoryTemplateContent) =>
        this.persistenceService.ensureAgentMemoryFile(memoryFilePath, memoryTemplateContent),
      readSessionMetaForDescriptor: (descriptor) =>
        this.knowledgeMemoryCoordinator.readSessionMetaForDescriptor(descriptor),
      writeSessionMemoryMergeAttemptMeta: (descriptor, attempt) =>
        this.knowledgeMemoryCoordinator.writeSessionMemoryMergeAttemptMeta(descriptor, attempt),
      recordSessionMemoryMergeAttempt: (descriptor, attempt) =>
        this.knowledgeMemoryCoordinator.recordSessionMemoryMergeAttempt(descriptor, attempt),
      appendSessionMemoryMergeAuditEntry: (entry) =>
        this.knowledgeMemoryCoordinator.appendSessionMemoryMergeAuditEntry(entry),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) =>
        this.knowledgeMemoryCoordinator.refreshSessionMetaStatsBySessionId(sessionAgentId),
      queueVersioningMutation: (mutation) => {
        this.queueVersioningMutation(mutation);
      },
      saveStore: async () => {
        await this.descriptorStoreAdapter.saveStore();
      },
      runSessionMemoryLLMMerge: (descriptor, profileMemoryContent, sessionMemoryContent) =>
        this.executeSessionMemoryLLMMerge(descriptor, profileMemoryContent, sessionMemoryContent),
      getPiModelsJsonPath: () => this.getPiModelsJsonPathOrThrow()
    });
    this.knowledgeMemoryCoordinator = this.createKnowledgeMemoryCoordinator(
      compactionRuntimeSettingsProvider,
      liveCompactionRuntimeSettingsProvider,
    );
    const sessionComposition = this.createSessionComposition(runtimeComposition);
    this.sessionProvisioner = sessionComposition.provisioner;
    this.archiveLastUsedHydrator = sessionComposition.archiveLastUsedHydrator;
    this.archiveService = sessionComposition.archiveService;
    this.sessionService = sessionComposition.sessionService;
    this.projectAgentSharingService = sessionComposition.projectAgentSharingService;
    this.projectAgentCoordinator = sessionComposition.projectAgentCoordinator;
    this.profileSessionBookkeepingCoordinator = new ProfileSessionBookkeepingCoordinator({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      profiles: this.profiles,
      directory: this.agentDirectory,
      persistence: this.descriptorStoreAdapter,
      now: this.now,
      notifySharedTargetsChanged: (agentId) =>
        this.projectAgentCoordinator.notifySharedTargetsChanged(agentId),
      emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
      emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
    });
    this.choiceService = new SwarmChoiceService({
      now: this.now,
      getDescriptor: (agentId) => this.descriptors.get(agentId),
      emitChoiceRequest: (event) => this.eventCoordinator.emitChoiceRequest(event),
      emitAgentsSnapshot: () => {
        this.eventCoordinator.emitAgentsSnapshot();
      }
    });
    const completedRuntime = runtimeComposition.complete(
      {
        conversation: this.conversationProjector,
        configuration: this.configurationCoordinator,
        knowledge: this.knowledgeMemoryCoordinator,
        cortex: this.cortexService,
        directory: this.agentDirectory,
        eventCoordinator: this.eventCoordinator,
        sessionMeta: this.sessionMetaService,
        choices: this.choiceService,
        provisioner: this.sessionProvisioner,
        sessionService: this.sessionService,
        archiveHydrator: this.archiveLastUsedHydrator,
        archive: this.archiveService,
        projectAgentService: sessionComposition.projectAgentService,
        projectAgents: this.projectAgentCoordinator,
        codexDirect: this.codexDirectSidecarCoordinator,
        codexPlugin: this.codexPluginDelegationCoordinator,
        promptRegistry: this.promptRegistry,
      },
      {
        interruptExternalThreadSidecarTurn: options?.interruptExternalThreadSidecarTurn,
        terminateExternalThreadSidecarTurn: options?.terminateExternalThreadSidecarTurn,
      },
    );
    this.turnContextCoordinator = completedRuntime.turnContext;
    this.runtimeLifecycleCoordinator = completedRuntime.runtimeLifecycle;
    this.lifecycleService = completedRuntime.lifecycle;
    this.projectExecutableTrustCoordinator = completedRuntime.projectExecutableTrust;
    this.sessionLifecycleCoordinator = completedRuntime.sessionLifecycle;
    this.bootCoordinator = completedRuntime.boot;
    this.sessionInteractionCoordinator = this.createSessionInteractionCoordinator();
    this.agentMessageDispatcher = this.createAgentMessageDispatcher(completedRuntime.goals);
    this.userMessageCoordinator = this.createUserMessageCoordinator(completedRuntime.goals);
    this.facadeServices = {
      interactions: this.sessionInteractionCoordinator,
      goals: completedRuntime.goals,
      sessions: this.sessionLifecycleCoordinator,
      pins: this.sessionPinCoordinator,
      projectAgents: this.projectAgentCoordinator,
      profileBookkeeping: this.profileSessionBookkeepingCoordinator,
      knowledge: this.knowledgeMemoryCoordinator,
      agents: this.lifecycleService,
      codexPlugin: this.codexPluginDelegationCoordinator,
      messages: this.agentMessageDispatcher,
      userMessages: this.userMessageCoordinator,
      boot: this.bootCoordinator,
      recovery: this.restartRecoveryCoordinator,
      configuration: this.configurationCoordinator,
      registry: {
        directory: this.agentDirectory,
      },
      runtime: {
        controller: this.runtimeController,
        lifecycle: this.runtimeLifecycleCoordinator,
        specialists: this.specialistFallbackManager,
        turns: this.turnContextCoordinator,
        assistantOutput: this.assistantOutputRouter,
        activeTools: this.sessionActiveTools,
        runtimes: this.runtimes,
      },
      events: this.eventCoordinator,
      conversation: {
        projector: this.conversationProjector,
        sidebarPerf: this.sidebarPerfRecorder,
      },
      collaboration: this.collaborationStorageProvisioner,
      trust: this.projectExecutableTrustCoordinator,
      codexDirect: this.codexDirectSidecarCoordinator,
      observability: this.observabilityCoordinator,
      persistence: this.sessionMetaService,
      extensions: this.forgeExtensionHost,
      host: {
        config: this.config,
        versioningService: this.versioningService,
        setTerminalArchiveHooks: (hooks) => {
          this.terminalArchiveHooks = hooks;
        },
        logDebug: (message, details) => this.logDebug(message, details),
      },
    };
    this.setMaxListeners(SWARM_MANAGER_MAX_EVENT_LISTENERS);
  }

  protected getFacadeServices(): SwarmManagerFacadeServices {
    return this.facadeServices;
  }

  private createSessionInteractionCoordinator(): SessionInteractionCoordinator {
    return new SessionInteractionCoordinator({
      descriptors: this.descriptors,
      directory: this.agentDirectory,
      plans: this.sessionPlanCoordinator,
      choices: this.choiceService,
      assistantOutput: this.assistantOutputRouter,
      runtimeOutput: {
        flushPreservedManagerAssistantOutputForTool: (agentId, toolName) =>
          this.runtimeController.flushPreservedManagerAssistantOutputForTool(agentId, toolName),
        markExplicitManagerAssistantOutput: (agentId) =>
          this.runtimeController.markExplicitManagerAssistantOutput(agentId),
      },
      lifecycle: this.lifecycleService,
      codexPlugin: this.codexPluginDelegationCoordinator,
      turns: this.turnContextCoordinator,
      sessions: {
        createSession: (profileId, options) =>
          this.sessionLifecycleCoordinator.createSession(profileId, options),
      },
      events: {
        emitConversationMessage: (event) => this.eventCoordinator.emitConversationMessage(event),
        emitConversationReset: (agentId, reason) =>
          this.eventCoordinator.emitConversationReset(agentId, reason),
        markSessionActivity: (agentId, timestamp) =>
          this.eventCoordinator.markSessionActivity(agentId, timestamp),
      },
      recordToolSideEffect: (agentId, event) =>
        this.observabilityCoordinator.recordToolSideEffect(agentId, event),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }

  private createRuntimeComposition(): ReturnType<typeof createSwarmManagerRuntimeComposition> {
    return createSwarmManagerRuntimeComposition({
      state: {
        config: this.config,
        descriptors: this.descriptors,
        profiles: this.profiles,
        runtimeRecoveryState: this.runtimeRecoveryState,
        now: this.now,
      },
      foundation: {
        forgeExtensionHost: this.forgeExtensionHost,
        sessionPins: this.sessionPinCoordinator,
        secrets: this.secretsEnvService,
        observability: this.observabilityCoordinator,
        versioningService: this.versioningService,
      },
      toolHost: this,
      descriptors: {
        upsertDescriptor: (descriptor) =>
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
        deleteDescriptor: (agentId) =>
          this.descriptorStoreAdapter.deleteDescriptorInLiveMaps(agentId),
        upsertProfile: (profile) =>
          this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile),
        deleteProfile: (profileId) =>
          this.descriptorStoreAdapter.deleteProfileInLiveMaps(profileId),
        patchDescriptor: (agentId, descriptorPatch) =>
          this.descriptorStoreAdapter.patchDescriptor(agentId, descriptorPatch),
        patchDescriptorFromRuntimeStatus: (agentId, descriptorPatch) =>
          this.patchDescriptorFromRuntimeStatus(agentId, descriptorPatch),
        transactionPatchDescriptor: (agentId, descriptorPatch, transactionOptions) =>
          this.descriptorStoreAdapter.transactionDescriptors(
            (store) => store.patchDescriptor(agentId, descriptorPatch),
            transactionOptions,
          ),
        patchDescriptorInLiveMaps: (agentId, descriptorPatch) =>
          this.descriptorStoreAdapter.patchDescriptorInLiveMaps(agentId, descriptorPatch),
      },
      events: {
        emitConversationMessage: (event) => this.eventCoordinator.emitConversationMessage(event),
        markSessionActivity: (agentId, timestamp) =>
          this.eventCoordinator.markSessionActivity(agentId, timestamp),
        emitStatus: (agentId, status, pendingCount, contextUsage) =>
          this.eventCoordinator.emitStatus(agentId, status, pendingCount, contextUsage),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
        emitSessionLifecycle: (event) => this.eventCoordinator.emitSessionLifecycle(event),
        emitSessionGoalSnapshot: (event) => this.emit("session_goal_snapshot", event),
        emitSessionActiveToolsSnapshot: (snapshot) => this.eventCoordinator.emitSessionActiveToolsSnapshot(snapshot),
        clearSessionActiveTools: (agentId) => this.sessionActiveTools.clearSession(agentId),
        saveStore: () => this.descriptorStoreAdapter.saveStore(),
        queueVersionedToolMutation: (agentId, event) =>
          this.queueVersionedToolMutation(agentId, event),
        emitModelCacheObservation: (event) =>
          this.eventCoordinator.emitModelCacheObservation(event),
        logDebug: (message, details) => this.logDebug(message, details),
      },
      messaging: {
        getConversationHistory: (agentId) => this.getConversationHistory(agentId),
        sendMessage: (fromAgentId, targetAgentId, message, delivery, sendOptions) =>
          this.sendMessage(fromAgentId, targetAgentId, message, delivery, sendOptions),
        publishToUser: (agentId, text, source) => this.publishToUser(agentId, text, source),
        terminateDescriptor: (descriptor, terminateOptions) =>
          this.terminateDescriptor(descriptor, terminateOptions),
        sendManagerBootstrapMessage: (managerId) =>
          this.managerBootstrapCoordinator.sendManagerBootstrapMessage(managerId),
      },
      runtimeResources: {
        getPiModelsJsonPath: () => this.configurationCoordinator.getPiModelsJsonPathOrThrow(),
        getMemoryRuntimeResources: (descriptor) => this.getMemoryRuntimeResources(descriptor),
        getSwarmContextFiles: (cwd) => this.getSwarmContextFiles(cwd),
        resolveAndValidateCwd: (cwd, cwdOptions) =>
          this.configurationCoordinator.resolveAndValidateCwd(cwd, cwdOptions),
        ensureSessionFileParentDirectory: (sessionFile) =>
          this.ensureSessionFileParentDirectory(sessionFile),
        ensureDirectories: () => this.ensureDirectories(),
        loadStore: () => this.descriptorStoreAdapter.loadStore(),
        loadSecrets: () => this.configurationCoordinator.loadSecretsStore(),
        reloadSkillMetadata: () => this.configurationCoordinator.reloadSkillMetadata(),
        reloadModelCatalog: () =>
          this.configurationCoordinator.reloadModelCatalogOverridesAndProjection(),
        preloadSessionPlanStates: () => this.sessionInteractionCoordinator.preloadSessionPlanStates(),
        deleteManagerSchedulesFile: (profileId) => this.deleteManagerSchedulesFile(profileId),
        getOrCreateRuntimeForDescriptor: (descriptor) =>
          this.getOrCreateRuntimeForDescriptor(descriptor),
      },
      runtimeFactory: { createRuntimeForDescriptor: (...args) => this.createRuntimeForDescriptor(...args) },
      resolution: {
        resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
          this.managerBootstrapCoordinator.resolvePromptWithFallback(
            category,
            promptId,
            profileId,
            fallback,
          ),
        resolveSpecialistRosterForProfile: (profileId, targetSpace) =>
          this.configurationCoordinator.resolveSpecialistRosterForProfile(profileId, targetSpace),
        resolveSpecialistRosterForManager: (manager, targetSpace) =>
          this.configurationCoordinator.resolveSpecialistRosterForManager(manager, targetSpace),
        resolveSpawnModelWithCapacityFallback: (model) =>
          this.resolveSpawnModelWithCapacityFallback(model),
        resolveSpawnWorkerArchetypeId: (input, normalizedAgentId, profileId) =>
          this.configurationCoordinator.resolveSpawnWorkerArchetypeId(
            input,
            normalizedAgentId,
            profileId,
          ),
        normalizeSpecialistHandle: async (value) => {
          const registry = await this.configurationCoordinator.loadSpecialistRegistryModule();
          return registry.normalizeSpecialistHandle(value) || undefined;
        },
        resolveSystemPromptForDescriptor: (descriptor) =>
          this.configurationCoordinator.resolveSystemPromptForDescriptor(descriptor),
        injectWorkerIdentityContext: (descriptor, systemPrompt) =>
          this.configurationCoordinator.injectWorkerIdentityContext(descriptor, systemPrompt),
        resolveDefaultModelDescriptor: () =>
          this.configurationCoordinator.resolveDefaultModelDescriptor(),
      },
      capture: {
        forkSession: (sourceAgentId, forkOptions) =>
          this.forkSession(sourceAgentId, forkOptions),
        deleteSession: async (agentId) => {
          await this.deleteSession(agentId);
        },
      },
      sessions: {
        materializeSortOrder: () =>
          this.profileSessionBookkeepingCoordinator.materializeProfileSortOrder(),
        deleteConversationHistory: (agentId, sessionFile) =>
          this.conversationProjector.deleteConversationHistory(agentId, sessionFile),
        assertExternalProjectAgentCapability: (agentId, capability) =>
          this.sessionInteractionCoordinator.assertExternalProjectAgentTurnCapabilityAllowed(
            agentId,
            capability,
          ),
        getTerminalArchiveHooks: () => this.terminalArchiveHooks,
      },
    });
  }
  private createCodexDirectSidecarCoordinator(
    options?: SwarmManagerOptions,
  ): CodexDirectSidecarCoordinator {
    return new CodexDirectSidecarCoordinator({
      dataDir: this.config.paths.dataDir,
      codexAppServerService: options?.codexAppServerService,
      codexAppServerServiceOptions: options?.codexAppServerServiceOptions,
      host: {
        now: this.now,
        logDebug: (message, details) => this.logDebug(message, details),
        getDescriptor: (agentId) => this.descriptors.get(agentId),
        upsertDescriptor: (descriptor) =>
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
        saveStore: () => this.descriptorStoreAdapter.saveStore(),
        ensureSessionFileParentDirectory: (sessionFile) =>
          mkdir(dirname(sessionFile), { recursive: true }).then(() => undefined),
        emitConversationMessage: (event) => this.eventCoordinator.emitConversationMessage(event),
        emitConversationLog: (event) => this.conversationProjector.emitConversationLog(event),
        emitAgentMessage: (event) => this.eventCoordinator.emitAgentMessage(event),
        emitAgentToolCall: (event) => this.conversationProjector.emitAgentToolCall(event),
        emitStatus: (agentId, status, pendingCount) =>
          this.eventCoordinator.emitStatus(agentId, status, pendingCount),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
        listWorkersForSession: (agentId) => this.agentDirectory.getWorkersForManager(agentId),
        listSessionsForProfile: (profileId) => this.agentDirectory.getSessionsForProfile(profileId),
        scheduleProjectExecutableTrustPrompt: (manager) =>
          this.scheduleFacadeProjectExecutableTrustPrompt(manager),
        markSessionActivity: (agentId, timestamp) =>
          this.eventCoordinator.markSessionActivity(agentId, timestamp),
        markSessionUserMessageActivity: (agentId, timestamp) =>
          this.eventCoordinator.markSessionUserMessageActivity(agentId, timestamp),
      },
    });
  }

  private createEventCoordinator(): SwarmEventCoordinator {
    return new SwarmEventCoordinator({
      host: {
        emit: (eventName, event) => {
          this.emit(eventName, event);
        },
        getDescriptor: (agentId) => this.descriptors.get(agentId),
        getRuntime: (agentId) => this.runtimes.get(agentId),
        listManagerAgents: () => this.agentDirectory.listManagerAgents(),
        listProfiles: () => this.agentDirectory.listProfiles(),
        upsertDescriptor: (descriptor) =>
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
      },
      conversationProjector: this.conversationProjector,
      observability: this.observabilityCoordinator,
      sessionActiveTools: this.sessionActiveTools,
      now: this.now,
    });
  }

  private createAgentDirectory(): AgentDirectory {
    return new AgentDirectory({
      descriptors: this.descriptors,
      profiles: this.profiles,
      configuredManagerId: this.config.managerId,
      getPendingChoiceCount: (agentId) =>
        this.choiceService.getPendingChoiceIdsForSession(agentId).length,
    });
  }

  private createConfigurationCoordinator(): SwarmConfigurationCoordinator {
    return new SwarmConfigurationCoordinator({
      config: this.config,
      defaultModelPreset: this.defaultModelPreset,
      descriptors: this.descriptors,
      profiles: this.profiles,
      promptRegistry: this.promptRegistry,
      skillMetadataService: this.skillMetadataService,
      skillFileService: this.skillFileService,
      secretsEnvService: this.secretsEnvService,
      sessions: {
        getSessionsForProfile: (profileId) =>
          this.agentDirectory.getBuilderSessionsForProfile(profileId),
        getAllManagerSessions: () => Array.from(this.descriptors.values()).filter(
          (descriptor): descriptor is AgentDescriptor & { role: "manager"; profileId: string } =>
            this.agentDirectory.isSessionAgent(descriptor),
        ),
        getSessionById: (agentId) => {
          const descriptor = this.descriptors.get(agentId);
          return this.agentDirectory.isSessionAgent(descriptor) ? descriptor : undefined;
        },
      },
      access: {
        assertManagerSettingsTargetNotArchived: (managerId, action) =>
          this.agentDirectory.assertManagerSettingsTargetNotArchived(managerId, action),
        assertProfileNotArchived: (profileId) =>
          this.agentDirectory.assertProfileNotArchived(profileId),
        getRequiredBuilderSessionDescriptor: (agentId, action) => this.agentDirectory.getRequiredBuilderSessionDescriptor(agentId, action),
        getRequiredCollaborationSessionDescriptor: (agentId, action) =>
          this.agentDirectory.getRequiredCollaborationSessionDescriptor(agentId, action),
        assertDescriptorNotEffectivelyArchived: (descriptor) => this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
      },
      persistence: {
        transactionDescriptors: (callback) =>
          this.descriptorStoreAdapter.transactionDescriptors(callback),
        saveStore: () => this.descriptorStoreAdapter.saveStore(),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
      },
      prompt: {
        getAgentMemoryPath: (agentId) =>
          this.knowledgeMemoryCoordinator.getAgentMemoryPath(agentId),
        ensureAgentMemoryFile: (memoryFilePath, profileId) =>
          this.knowledgeMemoryCoordinator.ensureAgentMemoryFile(memoryFilePath, profileId),
        resolveMemoryOwnerAgentId: (descriptor) =>
          this.knowledgeMemoryCoordinator.resolveMemoryOwnerAgentId(descriptor),
        resolveSessionProfileId: (memoryOwnerAgentId) =>
          this.knowledgeMemoryCoordinator.resolveSessionProfileId(memoryOwnerAgentId),
        refreshSessionMetaStats: (descriptor) =>
          this.knowledgeMemoryCoordinator.refreshSessionMetaStats(descriptor),
        refreshSessionMetaStatsBySessionId: (sessionAgentId) =>
          this.knowledgeMemoryCoordinator.refreshSessionMetaStatsBySessionId(sessionAgentId),
        getExternalProjectAgentDirectoryEntries: (profileId) =>
          this.projectAgentCoordinator.getExternalDirectory(profileId),
        getKnowledgeV2Enabled: () => this.knowledgeV2SettingsService.getSettings().enabled,
      },
      applySpecialistAvailability: (roster, targetSpace, managerAgentId) =>
        this.codexPluginDelegationCoordinator.applySpecialistAvailability(
          roster,
          targetSpace,
          managerAgentId,
        ),
      applyManagerRuntimeRecyclePolicy: (agentId, reason) =>
        this.projectExecutableTrustCoordinator.applyManagerRuntimeRecyclePolicy(agentId, reason),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }

  private createKnowledgeMemoryCoordinator(
    runtimeProvider: CompactionRuntimeSettingsProvider,
    liveProvider: ReturnType<typeof createLiveCompactionRuntimeSettingsProvider>,
  ): KnowledgeMemoryCoordinator {
    return new KnowledgeMemoryCoordinator({
      config: this.config,
      descriptors: this.descriptors,
      profiles: this.profiles,
      services: {
        capture: this.captureCascadeCoordinator,
        compaction: this.compactionCoordinator,
        cortex: this.cortexService,
        knowledge: this.knowledgeService,
        knowledgeSettings: this.knowledgeV2SettingsService,
        memory: this.memoryMergeService,
        sessionMeta: this.sessionMetaService,
      },
      compactionSettings: {
        runtimeProvider,
        liveProvider,
        getProviderAvailability: () =>
          getManagedModelProviderCredentialAvailability(this.config, {
            credentialPoolService: this.getCredentialPoolService(),
          }),
      },
      sessions: {
        requireBuilderSession: (agentId, operation) =>
          this.agentDirectory.getRequiredBuilderSessionDescriptor(agentId, operation),
        assertMutable: (descriptor) => this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
        resolvePreferredManagerId: (options) => this.agentDirectory.resolvePreferredManagerId(options),
      },
      cortexBootstrap: {
        sortedProfiles: () => this.agentDirectory.sortedProfiles(),
        upsertDescriptor: (descriptor) =>
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
        upsertProfile: (profile) => this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile),
        ensureProfileDirectories: (profileId) => this.ensureProfilePiDirectories(profileId),
        ensureSessionFileParent: (sessionFile) =>
          this.ensureSessionFileParentDirectory(sessionFile),
        getAgentMemoryPath: (agentId) =>
          this.knowledgeMemoryCoordinator.getAgentMemoryPath(agentId),
        resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
          this.managerBootstrapCoordinator.resolvePromptWithFallback(category, promptId, profileId, fallback),
      },
      getPiModelsJsonPath: () => this.getPiModelsJsonPathOrThrow(),
      versioning: this.versioningService,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }

  private createCollaborationStorageProvisioner(): CollaborationStorageProvisioner {
    return new CollaborationStorageProvisioner({
      config: this.config,
      now: this.now,
      getDescriptor: (agentId) => this.descriptors.get(agentId),
      getProfile: (profileId) => this.profiles.get(profileId),
      upsertDescriptor: (descriptor) => this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
      upsertProfile: (profile) => this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile),
      ensureProfileDirectories: (profileId) => this.ensureProfilePiDirectories(profileId),
      ensureSessionFileParent: (sessionFile) => this.ensureSessionFileParentDirectory(sessionFile),
      ensureMemoryFile: (path, profileId) =>
        this.knowledgeMemoryCoordinator.ensureAgentMemoryFile(path, profileId),
      getAgentMemoryPath: (agentId) => this.knowledgeMemoryCoordinator.getAgentMemoryPath(agentId),
      writeInitialSessionMeta: (descriptor) =>
        this.knowledgeMemoryCoordinator.writeInitialSessionMeta(descriptor),
      refreshSessionMetaStats: (descriptor) =>
        this.knowledgeMemoryCoordinator.refreshSessionMetaStats(descriptor),
      saveStore: () => this.descriptorStoreAdapter.saveStore(),
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }

  private createSessionComposition(runtimeComposition: ReturnType<typeof createSwarmManagerRuntimeComposition>): ReturnType<typeof createSwarmManagerSessionComposition> {
    return createSwarmManagerSessionComposition({
      state: {
        config: this.config,
        descriptors: this.descriptors,
        profiles: this.profiles,
        runtimes: this.runtimes,
        now: this.now,
      },
      services: {
        directory: this.agentDirectory,
        descriptorFactory: this.sessionDescriptorFactory,
        pins: this.sessionPinCoordinator,
        conversations: this.conversationProjector,
      },
      provisioner: {
        descriptorMutations: {
          upsertDescriptor: (descriptor) =>
            this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
          deleteDescriptor: (agentId) =>
            this.descriptorStoreAdapter.deleteDescriptorInLiveMaps(agentId),
          upsertProfile: (profile) =>
            this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile),
          deleteProfile: (profileId) =>
            this.descriptorStoreAdapter.deleteProfileInLiveMaps(profileId),
        },
        ensureProfilePiDirectories: (profileId) => this.ensureProfilePiDirectories(profileId),
        ensureSessionFileParentDirectory: (sessionFile) =>
          this.ensureSessionFileParentDirectory(sessionFile),
        ensureAgentMemoryFile: (memoryFilePath, profileId) =>
          this.knowledgeMemoryCoordinator.ensureAgentMemoryFile(memoryFilePath, profileId),
        getAgentMemoryPath: (agentId) =>
          this.knowledgeMemoryCoordinator.getAgentMemoryPath(agentId),
        writeInitialSessionMeta: (descriptor) =>
          this.knowledgeMemoryCoordinator.writeInitialSessionMeta(descriptor),
        runRuntimeShutdown: (descriptor, action, options) =>
          this.runtimeLifecycleCoordinator.runRuntimeShutdown(descriptor, action, options),
        detachRuntime: (agentId, runtimeToken) =>
          this.runtimeLifecycleCoordinator.detachRuntime(agentId, runtimeToken),
        clearAgentTurnState: (agentId) =>
          this.runtimeLifecycleCoordinator.clearAgentState(agentId),
        deleteManagerSessionFile: (sessionFile) => this.deleteManagerSessionFile(sessionFile),
        logDebug: (message, details) => this.logDebug(message, details),
      },
      sessions: {
        getRequiredSessionDescriptor: (agentId) =>
          this.agentDirectory.getRequiredSessionDescriptor(agentId),
        getOrCreateRuntimeForDescriptor: (descriptor) =>
          this.getOrCreateRuntimeForDescriptor(descriptor),
        stopSessionInternal: (agentId, options) => this.stopSessionInternal(agentId, options),
        assertSessionIsDeletable: (descriptor) =>
          this.agentDirectory.assertSessionIsDeletable(descriptor),
        saveStore: () => this.descriptorStoreAdapter.saveStore(),
        writeInitialSessionMeta: (descriptor) =>
          this.knowledgeMemoryCoordinator.writeInitialSessionMeta(descriptor),
        notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
        emitSessionLifecycle: (event) => this.eventCoordinator.emitSessionLifecycle(event),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
        emitConversationReset: (agentId, source) =>
          this.eventCoordinator.emitConversationReset(agentId, source as "api_reset"),
        injectAgentCreatorContext: (agentId, profileId) =>
          this.managerBootstrapCoordinator.injectAgentCreatorContext(agentId, profileId),
        cancelAllPendingChoicesForAgent: (agentId) =>
          this.sessionInteractionCoordinator.cancelAllPendingChoicesForAgent(agentId),
        clearPinsForConversationReset: (descriptor) =>
          this.sessionPinCoordinator.clearForConversationReset(descriptor),
        captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
          this.knowledgeMemoryCoordinator.captureSessionRuntimePromptMeta(
            descriptor,
            resolvedSystemPrompt,
          ),
        appendSessionRenameHistoryEntry: (descriptor, entry) =>
          this.profileSessionBookkeepingCoordinator.appendSessionRenameHistoryEntry(
            descriptor,
            entry,
          ),
        clearSessionPlan: async (descriptor) => {
          await this.sessionPlanCoordinator.clear(descriptor);
        },
        clearSessionGoal: async (descriptor) => { await runtimeComposition.goals.clear(descriptor); },
        writeForkedSessionMemoryHeader: (sourceDescriptor, forkedAgentId, fromMessageId) =>
          this.knowledgeMemoryCoordinator.writeForkedSessionMemoryHeader(
            sourceDescriptor,
            forkedAgentId,
            fromMessageId,
          ),
        logDebug: (message, details) => this.logDebug(message, details),
        now: this.now,
      },
      projectAgents: {
        getRequiredSessionDescriptor: (agentId) =>
          this.agentDirectory.getRequiredSessionDescriptor(agentId),
        assertSessionSupportsProjectAgent: (descriptor) =>
          this.agentDirectory.assertSessionSupportsProjectAgent(descriptor),
        getOrCreateRuntimeForDescriptor: (descriptor) =>
          this.getOrCreateRuntimeForDescriptor(descriptor),
        upsertDescriptorInLiveMaps: (descriptor) =>
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
        captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
          this.knowledgeMemoryCoordinator.captureSessionRuntimePromptMeta(
            descriptor,
            resolvedSystemPrompt,
          ),
        saveStore: () => this.descriptorStoreAdapter.saveStore(),
        emitSessionLifecycle: (event) => this.eventCoordinator.emitSessionLifecycle(event),
        emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
        emitProfilesSnapshot: () => this.eventCoordinator.emitProfilesSnapshot(),
        emitSessionProjectAgentUpdated: (agentId, profileId, projectAgent) =>
          this.eventCoordinator.emitSessionProjectAgentUpdated(agentId, profileId, projectAgent),
        notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
        logDebug: (message, details) => this.logDebug(message, details),
      },
      sharing: {
        logDebug: (message, details) => this.logDebug(message, details),
      },
      projectAgentWorkflows: {
        access: {
          getRequiredBuilderSession: (agentId, operation) =>
            this.agentDirectory.getRequiredBuilderSessionDescriptor(agentId, operation),
          assertDescriptorNotEffectivelyArchived: (descriptor) =>
            this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
          assertSessionSupportsProjectAgent: (descriptor) =>
            this.agentDirectory.assertSessionSupportsProjectAgent(descriptor),
        },
        prompt: {
          getConversationHistory: (agentId) => this.getConversationHistory(agentId),
          buildResolvedManagerPrompt: (descriptor, options) =>
            this.configurationCoordinator.buildResolvedManagerPrompt(descriptor, options),
          resolveLiveSystemPrompt: (descriptor) =>
            this.configurationCoordinator.resolveSystemPromptForDescriptor(descriptor),
          readPersistedSystemPrompt: (descriptor) =>
            this.sessionMetaService.readSessionMetaForDescriptor(descriptor).then(
              (meta) => meta?.resolvedSystemPrompt ?? null,
            ),
        },
        runtime: {
          hasRuntime: (agentId) => this.runtimes.has(agentId),
          recycleManager: (agentId, reason) =>
            this.applyFacadeManagerRuntimeRecyclePolicy(agentId, reason),
        },
        persistence: {
          upsertDescriptorInLiveMaps: (descriptor) =>
            this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
          saveStore: () => this.descriptorStoreAdapter.saveStore(),
        },
        events: {
          emitAgentsSnapshot: () => this.eventCoordinator.emitAgentsSnapshot(),
          emitSessionProjectAgentUpdated: (agentId, profileId, projectAgent) =>
            this.eventCoordinator.emitSessionProjectAgentUpdated(agentId, profileId, projectAgent),
        },
        notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
        listSessionsForProfile: (profileId) =>
          this.agentDirectory.getSessionsForProfile(profileId),
        getPiModelsJsonPath: () => this.configurationCoordinator.getPiModelsJsonPathOrThrow(),
        logDebug: (message, details) => this.logDebug(message, details),
      },
      archive: {
        hydration: {
          patchDescriptor: (agentId, patch) =>
            this.descriptorStoreAdapter.patchDescriptor(agentId, patch),
          warn: (message, details) => this.logDebug(message, details),
        },
        operations: {
          patchDescriptor: (agentId, patch) =>
            this.descriptorStoreAdapter.patchDescriptor(agentId, patch),
          patchProfile: (profileId, patch) =>
            this.descriptorStoreAdapter.patchProfile(profileId, patch),
          stopSessionForArchive: (agentId) =>
            this.stopSessionInternal(agentId, {
              saveStore: true,
              emitSnapshots: true,
              manualStopNotice: false,
              taskLifecycle: "none",
            }),
          onProfileArchiveStopError: (agentId, error) =>
            this.logDebug("archive:profile_stop_session:error", {
              agentId,
              error: error instanceof Error ? error.message : String(error),
            }),
        },
      },
    });
  }
  private createAgentMessageDispatcher(goals: ReturnType<typeof createSwarmManagerRuntimeComposition>["goals"]): AgentMessageDispatcher<CodexMcpToolGateEvaluation> {
    const ledger = {
      hasSessionTarget: (agentId) =>
        Boolean(this.runtimeLifecycleCoordinator.getTurnLedgerSessionTarget(agentId)),
      recordDeliveryPending: async (input) => {
        const target = this.runtimeLifecycleCoordinator.getTurnLedgerSessionTarget(input.sessionAgentId);
        if (!target) return;
        await appendTurnLedgerRecord(target, {
          t: "delivery_pending",
          ...(input.turnId ? { turnId: input.turnId } : {}),
          deliveryId: input.deliveryId,
          from: input.fromAgentId,
          to: input.targetAgentId,
          message: input.message,
          at: input.at,
        });
      },
      recordDeliveryAcked: async (input) => {
        const target = this.runtimeLifecycleCoordinator.getTurnLedgerSessionTarget(input.sessionAgentId);
        if (!target) return;
        await appendTurnLedgerRecord(target, {
          t: "delivery_acked",
          deliveryId: input.deliveryId,
          at: input.at,
        });
      },
    } satisfies AgentMessageLedgerPort;

    return new AgentMessageDispatcher({
      descriptors: this.descriptors,
      profiles: this.profiles,
      assertMutable: (descriptor) => this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
      attachments: this.conversationAttachmentService,
      turns: this.turnContextCoordinator,
      output: this.assistantOutputRouter,
      ledger,
      workerHealth: this.workerHealthService,
      observability: this.observabilityCoordinator,
      plans: {
        resolveAssignment: (owner, requestedStep) =>
          this.sessionPlanCoordinator.resolveAssignment(owner, requestedStep),
        appendToManagerInput: (owner, text) =>
          this.sessionPlanCoordinator.appendToManagerInput(owner, text),
        recordWorkerAssignment: (owner, assignment, input) =>
          this.sessionPlanCoordinator.recordWorkerAssignment(owner, assignment, input),
      },
      goals: { appendToManagerInput: (owner, text) => goals.appendToManagerInput(owner, text) },
      projectAgents: {
        authorizeExternalDelivery: (input) =>
          this.projectAgentSharingService.authorizeExternalDelivery(input),
        recordExternalContact: (sourceAgentId, targetProfileId, targetSessionAgentId) =>
          this.projectAgentSharingService.recordExternalContact(
            sourceAgentId,
            targetProfileId,
            targetSessionAgentId,
          ),
        assertRepoSourceAvailable: (descriptor) =>
          this.projectAgentCoordinator.assertRepoSourceAvailableForExternalDelivery(descriptor),
        rateLimitBuckets: this.projectAgentMessageTimestampsBySender,
      },
      codex: {
        assertWorkerDeliveryAllowed: (sender, target, options) =>
          this.codexPluginDelegationCoordinator.assertWorkerDeliveryAllowed(sender, target, {
            origin: options?.origin,
            hasAttachments:
              this.conversationAttachmentService.normalize(options?.attachments).length > 0,
          }),
        buildProjectAgentTurnGate: (target, message) =>
          this.codexPluginDelegationCoordinator.buildTurnGate(
            target,
            { channel: "web" },
            message,
            { kind: "none" },
            "project_agent_input",
          ),
      },
      getOrCreateRuntime: (descriptor) => this.getOrCreateRuntimeForDescriptor(descriptor),
      appendProjectAgentConversation: (target, payload) =>
        this.inboundConversationAppender.appendProjectAgentConversation(target, payload),
      emitAgentMessage: (event) => this.eventCoordinator.emitAgentMessage(event),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }

  private createInboundConversationAppender(): InboundConversationAppender {
    return new InboundConversationAppender({
      attachments: this.conversationAttachmentService,
      events: this.eventCoordinator,
      now: this.now,
    });
  }

  private createUserMessageCoordinator(goals: ReturnType<typeof createSwarmManagerRuntimeComposition>["goals"]): UserMessageCoordinator {
    return new UserMessageCoordinator({
      targeting: {
        descriptors: this.descriptors,
        resolvePreferredManagerId: () => this.agentDirectory.resolvePreferredManagerId(),
        assertDescriptorNotEffectivelyArchived: (descriptor) =>
          this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
        getConversationHistory: (agentId) => this.getConversationHistory(agentId),
      },
      runtime: {
        recovery: this.runtimeRecoveryState,
        executableTrust: this.projectExecutableTrustCoordinator,
        withRuntimeAdmission: (agentId, operation) =>
          this.runtimeController.withRuntimeAdmission(agentId, operation),
        getOrCreateRuntime: (descriptor) => this.getOrCreateRuntimeForDescriptor(descriptor),
        persistRecycledRuntimeState: async () => {
          await this.descriptorStoreAdapter.saveStore();
          this.eventCoordinator.emitAgentsSnapshot();
        },
      },
      attachments: this.conversationAttachmentService,
      inboundConversation: this.inboundConversationAppender,
      agentMessages: this.agentMessageDispatcher,
      assistantOutput: this.assistantOutputRouter,
      codex: {
        direct: this.codexDirectSidecarCoordinator,
        plugin: this.codexPluginDelegationCoordinator,
      },
      knowledge: this.knowledgeMemoryCoordinator,
      projectAgents: this.projectAgentCoordinator,
      goals,
      turns: this.turnContextCoordinator,
      observability: this.observabilityCoordinator,
      events: this.eventCoordinator,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
  }

  private createCodexPluginDelegationCoordinator(): CodexPluginDelegationCoordinator {
    return new CodexPluginDelegationCoordinator({
      appServer: this.codexDirectSidecarCoordinator.appServerService,
      host: {
        getDescriptor: (agentId) => this.descriptors.get(agentId),
        listDescriptors: () => this.descriptors.values(),
        assertDescriptorNotArchived: (descriptor) =>
          this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor),
        assertMentionRoutingAvailable: (manager) =>
          this.codexDirectSidecarCoordinator.assertMentionRoutingAvailable(
            manager as CodexDirectSidecarManager,
          ),
        spawnAgent: (managerAgentId, input) =>
          this.lifecycleService.spawnAgent(managerAgentId, input),
        sendInitialTask: ({ managerAgentId, workerAgentId, message, planStep }) =>
          this.sendMessage(managerAgentId, workerAgentId, message, "auto", {
            origin: "internal",
            internalDeliveryKind: "codex_plugin_bootstrap",
            ...(planStep ? { planStep } : {}),
            planAssignmentSource: "spawn_agent",
          }).then(() => undefined),
        getSessionDir: (descriptor) => this.getFacadeSessionDirForDescriptor(descriptor),
        now: this.now,
        logDebug: (event, details) => this.logDebug(event, details),
      },
    });
  }

  private async stopSessionInternal(
    agentId: string,
    options: AgentLifecycleStopSessionOptions
  ): Promise<{ terminatedWorkerIds: string[]; unsafeShutdownAgentIds: string[] }> {
    return this.lifecycleService.stopSessionInternal(agentId, options);
  }

  private logDebug(message: string, details?: unknown, config = this.config): void {
    if (!config.debug) return;
    const prefix = `[swarm][${this.now()}] ${message}`;
    if (details === undefined) console.log(prefix);
    else console.log(prefix, details);
  }

  private async getOrCreateRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    this.agentDirectory.assertDescriptorNotEffectivelyArchived(descriptor);
    if (descriptor.role === "manager") {
      await this.applyFacadePendingManagerRuntimeRecycleBeforeRuntimeUse(
        descriptor as AgentDescriptor & { role: "manager" },
      );
    }
    await this.projectAgentCoordinator.preflightRuntime(descriptor);
    return this.lifecycleService.getOrCreateRuntimeForDescriptor(descriptor);
  }

  private resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor {
    return this.lifecycleService.resolveSpawnModelWithCapacityFallback(model);
  }

  private async resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string> {
    return this.configurationCoordinator.resolveSystemPromptForDescriptor(descriptor);
  }

  private async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    this.codexPluginDelegationCoordinator.closeDescriptorScopes(descriptor);
    await this.lifecycleService.terminateDescriptor(descriptor, options);
    if (descriptor.role === "manager") {
      this.projectExecutableTrustCoordinator.forgetManager(descriptor.agentId);
    }
  }

  protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }> {
    return this.configurationCoordinator.getMemoryRuntimeResources(descriptor);
  }

  protected async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    return this.configurationCoordinator.getSwarmContextFiles(cwd);
  }

  protected async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = this.runtimeController.allocateRuntimeToken(descriptor.agentId),
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    return this.runtimeController.createRuntimeForDescriptor(
      descriptor,
      systemPrompt,
      runtimeToken,
      options,
    );
  }

  protected async resolveProjectExecutableTrustPlanForRuntime(options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }): Promise<ProjectExecutableTrustPlan> {
    return this.projectExecutableTrustCoordinator.resolvePlanForRuntime(options);
  }

  private queueVersioningMutation(mutation: VersioningMutation): void {
    void this.versioningService?.recordMutation(mutation).catch((error) => {
      this.logDebug("versioning:record_error", {
        path: mutation.path,
        source: mutation.source,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async ensureDirectories(): Promise<void> {
    await this.persistenceService.ensureDirectories();
  }

  private getPiModelsJsonPathOrThrow(): string {
    return this.configurationCoordinator.getPiModelsJsonPathOrThrow();
  }

  private async ensureSessionFileParentDirectory(sessionFile: string): Promise<void> {
    await mkdir(dirname(sessionFile), { recursive: true });
  }

  protected async executeSessionMemoryLLMMerge(
    descriptor: AgentDescriptor,
    profileMemoryContent: string,
    sessionMemoryContent: string
  ): Promise<{ mergedContent: string; model: string }> {
    return this.memoryMergeService.executeSessionMemoryLLMMerge(
      descriptor,
      profileMemoryContent,
      sessionMemoryContent
    );
  }

  private async ensureProfilePiDirectories(profileId: string): Promise<void> {
    await this.persistenceService.ensureProfilePiDirectories(profileId);
  }

  private async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    await this.persistenceService.deleteManagerSessionFile(sessionFile);
  }

  private async deleteManagerSchedulesFile(profileId: string): Promise<void> {
    await this.persistenceService.deleteManagerSchedulesFile(profileId);
  }

  async patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>
  ): Promise<AgentDescriptor | undefined> {
    return this.descriptorStoreAdapter.patchDescriptorInLiveMaps(agentId, patch);
  }
}
