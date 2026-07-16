import { createHash } from "node:crypto";
import type { AuthCredential } from "@earendil-works/pi-coding-agent";
import type {
  ActivateRepoProjectAgentRequest,
  AgentRuntimeExtensionSnapshot,
  BuilderTimelineChannelView,
  CortexConsolidationRunRecord,
  CortexConsolidationTrigger,
  CredentialPoolState,
  CredentialPoolStrategy,
  ManagerExactModelSelection,
  ModelCacheObservationEvent,
  OpenAIBrokerInviteRedeemResponse,
  OpenAIBrokerSettingsResponse,
  OpenAIBrokerTestResponse,
  PooledCredentialInfo,
  PromptPreviewResponse,
  RedeemOpenAIBrokerInviteRequest,
  RestartRecoverySnapshot,
  SessionMemoryMergeResult,
  SessionPlanSnapshotEvent,
  SessionActiveToolsSnapshotEvent,
  SkillBundleManifestV1,
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillImportPreviewResponse,
  SkillImportResultResponse,
  SkillImportTarget,
  SkillInventoryEntry,
  SkillShareResponse,
  UpdateOpenAIBrokerSettingsRequest,
} from "@forge/protocol";
import type { ObservabilityFacade } from "../observability/observability-types.js";
import type {
  SidebarConversationHistoryDiagnostics,
  SidebarPerfRecorder,
  SidebarPerfSlowEvent,
  SidebarPerfSummary,
} from "../stats/sidebar-perf-types.js";
import type { VersioningMutation, VersioningMutationSink } from "../versioning/versioning-types.js";
import type { AgentMessageSendOptions } from "./agent-message-dispatcher.js";
import type { AssistantOutputRouter } from "./assistant-output-router.js";
import type { ArchiveLastUsedHydrationResult } from "./archive/archive-last-used-hydrator.js";
import type {
  CodexCatalogSnapshot,
  CodexMcpToolCallResult,
} from "./codex-app-server/codex-mcp-catalog.js";
import type {
  CodexPluginExportFormat,
  CodexPluginScopedExportResult,
  CodexPluginScopeRuntimeView,
} from "./codex-app-server/codex-plugin-scope-service.js";
import type { CompactionRuntimeSettingsProvider } from "./compaction-runtime-settings-provider.js";
import type { CompactionSettingsService } from "./compaction-settings-service.js";
import type { CredentialPoolService } from "./credential-pool.js";
import { getSessionDir } from "./data-paths.js";
import type { DirectoryListingResult, DirectoryValidationResult } from "./cwd-policy.js";
import type { ForgeExtensionHost } from "./forge-extension-host.js";
import type { VersioningCommitEvent as ForgeVersioningCommitEvent } from "./forge-extension-types.js";
import type { KnowledgeMemoryCoordinator } from "./knowledge-memory-coordinator.js";
import type {
  KnowledgeEntry,
  KnowledgeEntryScope,
  KnowledgeEntryType,
  KnowledgeSearchResult,
  KnowledgeService,
} from "./knowledge-service.js";
import type { KnowledgeV2SettingsService } from "./knowledge-v2-settings-service.js";
import type { UpdatePlanInput, UpdatePlanResult } from "./planning/update-plan-tool.js";
import type { ProjectAgentRecommendations } from "./project-agent-analysis.js";
import type { ProjectAgentCoordinator } from "./project-agent-coordinator.js";
import type { ProjectExecutableTrustCoordinator } from "./project-executable-trust-coordinator.js";
import type { AssistantOutputTarget } from "./runtime/manager-assistant-output-tracker.js";
import type {
  RuntimeCodexTransportDebugDiagnostics,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  SmartCompactResult,
} from "./runtime-contracts.js";
import type {
  SessionCreationBaseDescriptor,
  SessionCreationOptions,
} from "./session-descriptor-factory.js";
import type {
  CreateProjectAgentInput,
  CreateSessionFromAgentInput,
  SessionCreationOverrides,
  SessionLifecycleCoordinator,
} from "./session-lifecycle-coordinator.js";
import type {
  PublishToUserSource,
  PublishToUserResult,
  ResetManagerSessionReason,
  SessionInteractionCoordinator,
} from "./session-interaction-coordinator.js";
import type { SessionPinCoordinator } from "./session-pin-coordinator.js";
import type { ImportSkillOptions } from "./skills/skill-sharing-service.js";
import type { CompactAgentContextOptions } from "./swarm-compaction-coordinator.js";
import type { SwarmConfigurationCoordinator } from "./swarm-configuration-coordinator.js";
import type { SwarmRuntimeLifecycleCoordinator } from "./swarm-runtime-lifecycle-coordinator.js";
import type { SwarmToolSideEffectEvent } from "./swarm-tool-host.js";
import { SwarmManagerGoalFacade } from "./swarm-manager-goal-facade.js";
import type {
  AppendConversationUserMessageOptions,
  AppendConversationUserMessageResult,
  DispatchRuntimeUserMessageOptions,
  HandleUserMessageOptions,
} from "./user-message-coordinator.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceRequestStatus,
  ConversationEntryEvent,
  ManagerProfile,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SettingsAuthProvider,
  SkillEnvRequirement,
  SpawnAgentInput,
  SwarmConfig,
  SwarmModelPreset,
  SwarmReasoningLevel,
} from "./types.js";
import { normalizeOptionalAgentId } from "./swarm-manager-utils.js";

export interface CreateManagerInput {
  name: string;
  cwd: string;
  model?: SwarmModelPreset;
  modelSelection?: ManagerExactModelSelection;
  reasoningLevel?: SwarmReasoningLevel;
}

export interface SetSessionProjectAgentInput {
  whenToUse: string;
  systemPrompt?: string;
  handle?: string;
  capabilities?: NonNullable<AgentDescriptor["projectAgent"]>["capabilities"];
}

export interface ForkSessionOptions {
  label?: string;
  fromMessageId?: string;
  sessionPurpose?: AgentDescriptor["sessionPurpose"];
}

export type CreateSessionBaseInput = Pick<
  SessionCreationBaseDescriptor,
  "model" | "cwd" | "archetypeId" | "sessionSystemPrompt"
>;

type SessionTranscriptAssistantOutputTarget = Extract<
  AssistantOutputTarget,
  { kind: "session_transcript" }
>;

export interface CodexTransportDebugAgentDiagnostics {
  agentId: string;
  agentIdHash: string;
  role: AgentDescriptor["role"];
  status: AgentDescriptor["status"];
  modelId?: string;
  provider?: string;
  api?: string;
  selectedConfigTransport: "sse" | "websocket" | "websocket-cached" | "auto" | null;
  runtimeAvailable: boolean;
  runtimeTransport?: string;
  runtimeModelProvider?: string;
  runtimeModelApi?: string;
  piSessionIdPresent: boolean;
  websocketStatsStatus:
    | RuntimeCodexTransportDebugDiagnostics["websocketStatsStatus"]
    | "runtime_inactive"
    | "not_pi_runtime";
  directPiSessionStatsStatus:
    | RuntimeCodexTransportDebugDiagnostics["directPiSessionStatsStatus"]
    | "runtime_inactive"
    | "not_pi_runtime";
  websocketStats?: RuntimeCodexTransportDebugDiagnostics["websocketStats"];
}

export interface SaveLearningInput {
  type: KnowledgeEntryType;
  scope: KnowledgeEntryScope;
  title: string;
  body: string;
  evidence: "user-stated" | "observed";
}

export interface CodexPluginScopedExportInput {
  scopedToolName: string;
  args?: Record<string, unknown>;
  fileName?: string;
  format: CodexPluginExportFormat;
  includePreview: boolean;
}

export type {
  SwarmManagerFacadeServices,
  SwarmManagerSessionFacadeServices,
  TerminalArchiveHooks,
} from "./swarm-manager-facade-services.js";
import type {
  SwarmManagerFacadeServices,
  TerminalArchiveHooks,
} from "./swarm-manager-facade-services.js";

/**
 * Stable public and control API inherited by SwarmManager.
 *
 * This facade is deliberately stateless: application policy lives in the
 * coordinators above, while this class keeps the manager's compatibility
 * surface explicit without forcing every delegate into the composition root.
 */
export abstract class SwarmManagerFacade extends SwarmManagerGoalFacade {
  protected abstract getFacadeServices(): SwarmManagerFacadeServices;
  flushPendingPersistence(): Promise<void> { return this.services.persistence.flushPendingTurnSeqPersists(); }
  getSessionPlanSnapshot(
    sessionAgentId: string,
    requestId?: string,
  ): Promise<SessionPlanSnapshotEvent> {
    return this.services.interactions.getSessionPlanSnapshot(sessionAgentId, requestId);
  }

  updatePlan(
    callerAgentId: string,
    toolCallId: string,
    input: UpdatePlanInput,
  ): Promise<UpdatePlanResult> {
    return this.services.interactions.updatePlan(callerAgentId, toolCallId, input);
  }

  requestUserChoice(agentId: string, questions: ChoiceQuestion[]): Promise<ChoiceAnswer[]> {
    return this.services.interactions.requestUserChoice(agentId, questions);
  }

  resolveChoiceRequest(choiceId: string, answers: ChoiceAnswer[]): void {
    this.services.interactions.resolveChoiceRequest(choiceId, answers);
  }

  cancelChoiceRequest(
    choiceId: string,
    reason: Extract<ChoiceRequestStatus, "cancelled" | "expired">,
  ): void {
    this.services.interactions.cancelChoiceRequest(choiceId, reason);
  }

  cancelAllPendingChoicesForAgent(agentId: string): void {
    this.services.interactions.cancelAllPendingChoicesForAgent(agentId);
  }

  hasPendingChoicesForSession(sessionAgentId: string): boolean {
    return this.services.interactions.hasPendingChoicesForSession(sessionAgentId);
  }

  getPendingChoiceIdsForSession(sessionAgentId: string): string[] {
    return this.services.interactions.getPendingChoiceIdsForSession(sessionAgentId);
  }

  getPendingChoiceRequestsForSession(
    sessionAgentId: string,
  ): ReturnType<SessionInteractionCoordinator["getPendingChoiceRequestsForSession"]> {
    return this.services.interactions.getPendingChoiceRequestsForSession(sessionAgentId);
  }

  getPendingChoiceOwner(
    choiceId: string,
  ): ReturnType<SessionInteractionCoordinator["getPendingChoiceOwner"]> {
    return this.services.interactions.getPendingChoiceOwner(choiceId);
  }

  getPendingChoice(
    choiceId: string,
  ): ReturnType<SessionInteractionCoordinator["getPendingChoice"]> {
    return this.services.interactions.getPendingChoice(choiceId);
  }

  createSession(
    profileId: string,
    options?: SessionCreationOptions,
  ): ReturnType<SessionLifecycleCoordinator["createSession"]> {
    return this.services.sessions.createSession(profileId, options);
  }

  createSessionWithOverrides(
    profileId: string,
    options: SessionCreationOptions = {},
    overrides: SessionCreationOverrides = {},
  ): ReturnType<SessionLifecycleCoordinator["createSessionWithOverrides"]> {
    return this.services.sessions.createSessionWithOverrides(profileId, options, overrides);
  }

  createSessionFromBaseDescriptor(
    profileId: string,
    base: CreateSessionBaseInput,
    options: SessionCreationOptions = {},
    overrides: Pick<SessionCreationOverrides, "sessionSurface" | "collab"> = {},
  ): ReturnType<SessionLifecycleCoordinator["createSessionFromBaseDescriptor"]> {
    return this.services.sessions.createSessionFromBaseDescriptor(
      profileId,
      base,
      options,
      overrides,
    );
  }

  createSessionFromAgent(
    creatorAgentId: string,
    params: CreateSessionFromAgentInput,
  ): ReturnType<SessionLifecycleCoordinator["createSessionFromAgent"]> {
    return this.services.sessions.createSessionFromAgent(creatorAgentId, params);
  }

  createAndPromoteProjectAgent(
    creatorAgentId: string,
    params: CreateProjectAgentInput,
  ): ReturnType<SessionLifecycleCoordinator["createAndPromoteProjectAgent"]> {
    return this.services.sessions.createAndPromoteProjectAgent(creatorAgentId, params);
  }

  archiveSession(agentId: string): ReturnType<SessionLifecycleCoordinator["archiveSession"]> {
    return this.services.sessions.archiveSession(agentId);
  }

  restoreSession(agentId: string): ReturnType<SessionLifecycleCoordinator["restoreSession"]> {
    return this.services.sessions.restoreSession(agentId);
  }

  hydrateArchivedLastUsed(): Promise<ArchiveLastUsedHydrationResult> {
    return this.services.sessions.hydrateArchivedLastUsed();
  }

  archiveProfile(profileId: string): ReturnType<SessionLifecycleCoordinator["archiveProfile"]> {
    return this.services.sessions.archiveProfile(profileId);
  }

  restoreProfile(profileId: string): ReturnType<SessionLifecycleCoordinator["restoreProfile"]> {
    return this.services.sessions.restoreProfile(profileId);
  }

  stopSession(agentId: string): ReturnType<SessionLifecycleCoordinator["stopSession"]> {
    return this.services.sessions.stopSession(agentId);
  }

  stopCollaborationSession(
    agentId: string,
  ): ReturnType<SessionLifecycleCoordinator["stopCollaborationSession"]> {
    return this.services.sessions.stopCollaborationSession(agentId);
  }

  resumeSession(agentId: string): ReturnType<SessionLifecycleCoordinator["resumeSession"]> {
    return this.services.sessions.resumeSession(agentId);
  }

  deleteCollaborationSession(
    agentId: string,
  ): ReturnType<SessionLifecycleCoordinator["deleteCollaborationSession"]> {
    return this.services.sessions.deleteCollaborationSession(agentId);
  }

  deleteSession(agentId: string): ReturnType<SessionLifecycleCoordinator["deleteSession"]> {
    return this.services.sessions.deleteSession(agentId);
  }

  pinMessage(
    agentId: string,
    messageId: string,
    pinned: boolean,
  ): ReturnType<SessionPinCoordinator["pinMessage"]> {
    return this.services.pins.pinMessage(agentId, messageId, pinned);
  }

  clearAllPins(agentId: string): ReturnType<SessionPinCoordinator["clearAllPins"]> {
    return this.services.pins.clearAllPins(agentId);
  }

  clearSessionConversation(
    agentId: string,
  ): ReturnType<SessionLifecycleCoordinator["clearSessionConversation"]> {
    return this.services.sessions.clearSessionConversation(agentId);
  }

  pinSession(
    agentId: string,
    pinned: boolean,
  ): ReturnType<SessionPinCoordinator["pinSession"]> {
    return this.services.pins.pinSession(agentId, pinned);
  }

  activateRepoProjectAgent(
    request: ActivateRepoProjectAgentRequest,
  ): ReturnType<ProjectAgentCoordinator["activateRepoProjectAgent"]> {
    return this.services.projectAgents.activateRepoProjectAgent(request);
  }

  setSessionProjectAgent(
    agentId: string,
    projectAgent: SetSessionProjectAgentInput | null,
  ): ReturnType<ProjectAgentCoordinator["setSessionProjectAgent"]> {
    return this.services.projectAgents.setSessionProjectAgent(agentId, projectAgent);
  }

  requestProjectAgentRecommendations(agentId: string): Promise<ProjectAgentRecommendations> {
    return this.services.projectAgents.requestRecommendations(agentId);
  }

  renameSession(
    agentId: string,
    label: string,
  ): ReturnType<SessionLifecycleCoordinator["renameSession"]> {
    return this.services.sessions.renameSession(agentId, label);
  }

  renameProfile(profileId: string, displayName: string): Promise<void> {
    return this.services.profileBookkeeping.renameProfile(profileId, displayName);
  }

  mergeSessionMemory(agentId: string): Promise<SessionMemoryMergeResult> {
    return this.services.knowledge.mergeSessionMemory(agentId);
  }

  forkSession(
    sourceAgentId: string,
    options?: ForkSessionOptions,
  ): ReturnType<SessionLifecycleCoordinator["forkSession"]> {
    return this.services.sessions.forkSession(sourceAgentId, options);
  }

  spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    return this.services.interactions.spawnAgent(callerAgentId, input);
  }

  killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    return this.services.interactions.killAgent(callerAgentId, targetAgentId);
  }

  async stopWorker(agentId: string): Promise<void> {
    this.services.codexPlugin.markWorkerStoppedAndCloseScope(agentId);
    await this.services.agents.stopWorker(agentId);
  }

  resumeWorker(agentId: string): Promise<void> {
    return this.services.agents.resumeWorker(agentId);
  }

  stopAllAgents(
    callerAgentId: string,
    targetManagerId: string,
  ): ReturnType<SessionLifecycleCoordinator["stopAllAgents"]> {
    return this.services.sessions.stopAllAgents(callerAgentId, targetManagerId);
  }

  createManager(
    callerAgentId: string,
    input: CreateManagerInput,
  ): ReturnType<SessionLifecycleCoordinator["createManager"]> {
    return this.services.sessions.createManager(callerAgentId, input);
  }

  deleteManager(
    callerAgentId: string,
    targetManagerId: string,
  ): ReturnType<SessionLifecycleCoordinator["deleteManager"]> {
    return this.services.sessions.deleteManager(callerAgentId, targetManagerId);
  }

  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode = "auto",
    options?: AgentMessageSendOptions,
  ): Promise<SendMessageReceipt> {
    return this.services.messages.sendMessage(
      fromAgentId,
      targetAgentId,
      message,
      delivery,
      options,
    );
  }

  sendWorkerResult(
    workerAgentId: string,
    resultText: string,
    expectedAssignmentId?: string,
  ): Promise<SendMessageReceipt> {
    return this.services.messages.sendWorkerResult(
      workerAgentId,
      resultText,
      expectedAssignmentId,
    );
  }

  publishToUser(
    agentId: string,
    text: string,
    source: PublishToUserSource = "speak_to_user",
    targetContext?: MessageTargetContext,
  ): Promise<PublishToUserResult> {
    return this.services.interactions.publishToUser(agentId, text, source, targetContext);
  }

  compactAgentContext(
    agentId: string,
    options?: CompactAgentContextOptions,
  ): Promise<unknown> {
    return this.services.knowledge.compact(agentId, options);
  }

  smartCompactAgentContext(
    agentId: string,
    options?: CompactAgentContextOptions,
  ): Promise<SmartCompactResult> {
    return this.services.knowledge.smartCompact(agentId, options);
  }

  appendConversationUserMessage(
    text: string,
    options?: AppendConversationUserMessageOptions,
  ): Promise<AppendConversationUserMessageResult> {
    return this.services.userMessages.appendConversationUserMessage(text, options);
  }

  dispatchRuntimeUserMessage(options: DispatchRuntimeUserMessageOptions): Promise<void> {
    return this.services.userMessages.dispatchRuntimeUserMessage(options);
  }

  handleUserMessage(text: string, options?: HandleUserMessageOptions): Promise<void> {
    return this.services.userMessages.handleUserMessage(text, options);
  }

  resetManagerSession(
    managerIdOrReason: string | ResetManagerSessionReason = "api_reset",
    maybeReason?: ResetManagerSessionReason,
  ): Promise<void> {
    return this.services.interactions.resetManagerSession(managerIdOrReason, maybeReason);
  }

  // Boot, recovery, and read services.

  boot(): Promise<void> {
    return this.services.boot.boot();
  }

  getRestartRecoverySnapshot(): RestartRecoverySnapshot | null {
    return this.services.recovery.getSnapshot();
  }

  dismissRestartRecovery(): RestartRecoverySnapshot | null {
    return this.services.recovery.dismiss();
  }

  resumeRestartRecovery(): Promise<RestartRecoverySnapshot | null> {
    return this.services.recovery.resume();
  }

  getAgentsSnapshotVersion(): number {
    return this.services.events.getAgentsSnapshotVersion();
  }

  getProfilesSnapshotVersion(): number {
    return this.services.events.getProfilesSnapshotVersion();
  }

  hasCollaborationStorageProfile(): boolean {
    return this.services.collaboration.hasProfile();
  }

  hasCollaborationStorageRootSession(): boolean {
    return this.services.collaboration.hasRootSession();
  }

  ensureCollaborationStorageProfile(): Promise<void> {
    return this.services.collaboration.ensure();
  }

  listCortexConsolidationRuns(): Promise<CortexConsolidationRunRecord[]> {
    return this.services.knowledge.listCortexConsolidationRuns();
  }

  getCortexConsolidationSnapshot(): ReturnType<
    KnowledgeMemoryCoordinator["getCortexConsolidationSnapshot"]
  > {
    return this.services.knowledge.getCortexConsolidationSnapshot();
  }

  runCortexConsolidation(
    trigger: CortexConsolidationTrigger,
  ): Promise<CortexConsolidationRunRecord | null> {
    return this.services.knowledge.runCortexConsolidation(trigger);
  }

  getConversationHistory(agentId?: string): ConversationEntryEvent[] {
    const resolvedAgentId =
      normalizeOptionalAgentId(agentId) ??
      this.services.registry.directory.resolvePreferredManagerId();
    if (!resolvedAgentId) return [];
    return this.services.conversation.projector.getConversationHistory(resolvedAgentId);
  }
  getConversationHistoryWithDiagnostics(agentId?: string): {
    history: ConversationEntryEvent[];
    diagnostics: SidebarConversationHistoryDiagnostics;
  } {
    const resolvedAgentId =
      normalizeOptionalAgentId(agentId) ??
      this.services.registry.directory.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return {
        history: [],
        diagnostics: {
          cacheState: "memory",
          historySource: "memory",
          coldLoad: false,
          fsReadOps: 0,
          fsReadBytes: 0,
          detail: "missing_agent",
        },
      };
    }
    return this.services.conversation.projector.getConversationHistoryWithDiagnostics(resolvedAgentId);
  }

  getConversationHistoryPage(agentId: string, options?: { cursor?: string; limit?: number; view?: BuilderTimelineChannelView }) {
    return this.services.conversation.projector.getConversationHistoryPage(agentId, options);
  }
  getSidebarPerfRecorder(): SidebarPerfRecorder {
    return this.services.conversation.sidebarPerf;
  }
  readSidebarPerfSummary(): SidebarPerfSummary {
    return this.services.conversation.sidebarPerf.readSummary();
  }

  readSidebarPerfSlowEvents(): SidebarPerfSlowEvent[] {
    return this.services.conversation.sidebarPerf.readRecentSlowEvents();
  }

  protected getFacadeSessionDirForDescriptor(descriptor: {
    agentId: string;
    profileId?: string;
  }): string {
    return getSessionDir(
      this.services.host.config.paths.dataDir,
      descriptor.profileId ?? descriptor.agentId,
      descriptor.agentId,
    );
  }

  protected scheduleFacadeProjectExecutableTrustPrompt(
    descriptor: AgentDescriptor & { role: "manager" },
  ): void {
    this.services.trust.schedulePrompt(descriptor);
  }

  maybePromptForProjectExecutableTrust(
    descriptor: AgentDescriptor & { role: "manager" },
  ): Promise<void> {
    return this.services.trust.maybePrompt(descriptor);
  }

  applyProjectResourceTrustChange(trustKey: string): Promise<void> {
    return this.services.trust.applyTrustChange(trustKey);
  }

  applyProjectResourceWorkspaceChange(workspaceKey: string): Promise<void> {
    return this.services.trust.applyWorkspaceChange(workspaceKey);
  }

  // Model, prompt, and runtime configuration.

  loadModelCacheVisualizationSettings(): Promise<void> {
    return this.services.configuration.loadModelCacheVisualizationSettings();
  }

  isModelCacheVisualizationEnabled(): boolean {
    return this.services.configuration.isModelCacheVisualizationEnabled();
  }

  applyModelCacheVisualizationSettingsChange(enabled: boolean): Promise<void> {
    return this.services.configuration.applyModelCacheVisualizationSettingsChange(enabled);
  }

  updateManagerModel(
    managerId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<void> {
    return this.services.configuration.updateManagerModel(
      managerId,
      modelPreset,
      reasoningLevel,
    );
  }

  updateCollaborationSessionModel(
    sessionAgentId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<void> {
    return this.services.configuration.updateCollaborationSessionModel(
      sessionAgentId,
      modelPreset,
      reasoningLevel,
    );
  }

  updateManagerExactModel(
    managerId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<AgentDescriptor["model"]> {
    return this.services.configuration.updateManagerExactModel(
      managerId,
      modelSelection,
      reasoningLevel,
    );
  }

  updateProfileDefaultModel(
    profileId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<void> {
    return this.services.configuration.updateProfileDefaultModel(
      profileId,
      modelPreset,
      reasoningLevel,
    );
  }

  updateProfileDefaultExactModel(
    profileId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<AgentDescriptor["model"]> {
    return this.services.configuration.updateProfileDefaultExactModel(
      profileId,
      modelSelection,
      reasoningLevel,
    );
  }

  updateSessionModel(
    sessionAgentId: string,
    mode: "inherit" | "override",
    modelPreset?: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<void> {
    return this.services.configuration.updateSessionModel(
      sessionAgentId,
      mode,
      modelPreset,
      reasoningLevel,
    );
  }

  updateSessionExactModel(
    sessionAgentId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel,
  ): Promise<AgentDescriptor["model"]> {
    return this.services.configuration.updateSessionExactModel(
      sessionAgentId,
      modelSelection,
      reasoningLevel,
    );
  }

  updateManagerCwd(managerId: string, newCwd: string): Promise<string> {
    return this.services.configuration.updateManagerCwd(managerId, newCwd);
  }

  notifyModelSpecificInstructionsChanged(modelKeys: string[]): Promise<void> {
    return this.services.configuration.notifyModelSpecificInstructionsChanged(modelKeys);
  }

  notifySpecialistRosterChanged(
    profileId: string,
    options?: { sessionAgentId?: string },
  ): Promise<void> {
    return this.services.agents.notifySpecialistRosterChanged(profileId, options);
  }

  notifyProjectAgentsChanged(profileId: string): Promise<void> {
    return this.services.projectAgents.notifyProjectAgentsChanged(profileId);
  }

  protected applyFacadeManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: Parameters<ProjectExecutableTrustCoordinator["applyManagerRuntimeRecyclePolicy"]>[1],
  ): ReturnType<ProjectExecutableTrustCoordinator["applyManagerRuntimeRecyclePolicy"]> {
    return this.services.trust.applyManagerRuntimeRecyclePolicy(agentId, reason);
  }

  protected applyFacadePendingManagerRuntimeRecycleBeforeRuntimeUse(
    descriptor: AgentDescriptor & { role: "manager" },
  ): Promise<void> {
    return this.services.trust.applyPendingManagerRuntimeRecycleBeforeRuntimeUse(descriptor);
  }

  previewManagerSystemPrompt(profileId: string): Promise<PromptPreviewResponse> {
    return this.services.configuration.previewManagerSystemPrompt(profileId);
  }

  previewManagerSystemPromptForAgent(agentId: string): Promise<PromptPreviewResponse> {
    return this.services.configuration.previewManagerSystemPromptForAgent(agentId);
  }

  reloadModelCatalogOverridesAndProjection(): Promise<void> {
    return this.services.configuration.reloadModelCatalogOverridesAndProjection();
  }

  reloadOpenRouterModelsAndProjection(): Promise<void> {
    return this.services.configuration.reloadOpenRouterModelsAndProjection();
  }

  emitModelCacheObservation(event: ModelCacheObservationEvent): void {
    this.services.events.emitModelCacheObservation(event);
  }

  // Agent, profile, Project Agent, and directory registry.

  listAgents(): AgentDescriptor[] {
    return this.services.registry.directory.listAgents();
  }

  listAgentsForInternalUse(): AgentDescriptor[] {
    return this.services.registry.directory.listAgentsForInternalUse();
  }

  isAgentEffectivelyArchived(agentId: string): boolean {
    return this.services.registry.directory.isAgentEffectivelyArchived(agentId);
  }

  listBootstrapAgents(): AgentDescriptor[] {
    return this.services.registry.directory.listBootstrapAgents();
  }

  listManagerAgents(): AgentDescriptor[] {
    return this.services.registry.directory.listManagerAgents();
  }

  listWorkersForSession(sessionAgentId: string): AgentDescriptor[] {
    return this.services.registry.directory.listWorkersForSession(sessionAgentId);
  }

  listProfiles(): ManagerProfile[] {
    return this.services.registry.directory.listProfiles();
  }

  listUserProfiles(): ManagerProfile[] {
    return this.services.registry.directory.listUserProfiles();
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return this.services.registry.directory.getAgent(agentId);
  }

  getAgentForInternalUse(agentId: string): AgentDescriptor | undefined {
    return this.services.registry.directory.getAgentForInternalUse(agentId);
  }

  getProjectAgentConfig(
    agentId: string,
  ): ReturnType<ProjectAgentCoordinator["getProjectAgentConfig"]> {
    return this.services.projectAgents.getProjectAgentConfig(agentId);
  }

  getProjectAgentSharing(
    agentId: string,
  ): ReturnType<ProjectAgentCoordinator["getProjectAgentSharing"]> {
    return this.services.projectAgents.getProjectAgentSharing(agentId);
  }

  setProjectAgentSharing(
    agentId: string,
    targetProfileIds: readonly string[],
  ): ReturnType<ProjectAgentCoordinator["setProjectAgentSharing"]> {
    return this.services.projectAgents.setProjectAgentSharing(agentId, targetProfileIds);
  }

  getProjectAgentExternalDirectory(
    profileId: string,
  ): ReturnType<ProjectAgentCoordinator["getExternalDirectory"]> {
    return this.services.projectAgents.getExternalDirectory(profileId);
  }

  listProjectAgentReferences(agentId: string): Promise<string[]> {
    return this.services.projectAgents.listReferences(agentId);
  }

  getProjectAgentReference(agentId: string, fileName: string): Promise<string> {
    return this.services.projectAgents.getReference(agentId, fileName);
  }

  setProjectAgentReference(
    agentId: string,
    fileName: string,
    content: string,
  ): Promise<void> {
    return this.services.projectAgents.setReference(agentId, fileName, content);
  }

  deleteProjectAgentReference(agentId: string, fileName: string): Promise<void> {
    return this.services.projectAgents.deleteReference(agentId, fileName);
  }

  listDirectories(path?: string): Promise<DirectoryListingResult> {
    return this.services.configuration.listDirectories(path);
  }

  validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return this.services.configuration.validateDirectory(path);
  }

  createDirectory(
    parentPath: string,
    name: string,
  ): ReturnType<SwarmConfigurationCoordinator["createDirectory"]> {
    return this.services.configuration.createDirectory(parentPath, name);
  }

  pickDirectory(defaultPath?: string): Promise<string | null> {
    return this.services.configuration.pickDirectory(defaultPath);
  }

  reorderProfiles(profileIds: string[]): Promise<void> {
    return this.services.profileBookkeeping.reorderProfiles(profileIds);
  }

  validateProjectAgentSourceForRead(agentId: string): Promise<void> {
    return this.services.projectAgents.validateSourceForRead(agentId);
  }

  resolveAgentSystemPromptForRead(agentId: string): Promise<string | null> {
    return this.services.projectAgents.resolveSystemPromptForRead(agentId);
  }

  resolveProjectAgentSystemPromptOverride(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean },
  ): Promise<{ prompt: string | undefined; sourcePath: string | undefined }> {
    return this.services.configuration.resolveProjectAgentSystemPromptOverride(
      descriptor,
      options,
    );
  }

  // Skill, authentication, broker, and credential settings.

  setIntegrationContextProvider(provider?: (profileId: string) => string): void {
    this.services.configuration.setIntegrationContextProvider(provider);
  }

  listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    return this.services.configuration.listSettingsEnv();
  }

  listSkillMetadata(
    profileId?: string,
    sessionAgentId?: string,
  ): Promise<SkillInventoryEntry[]> {
    return this.services.configuration.listSkillMetadata(profileId, sessionAgentId);
  }

  getCollaborationGlobalSkillHandles(): Iterable<string> {
    return this.services.configuration.getCollaborationGlobalSkillHandles();
  }

  listSkillFiles(
    skillId: string,
    relativePath = "",
    context?: { profileId?: string; sessionAgentId?: string },
  ): Promise<SkillFilesResponse> {
    return this.services.configuration.listSkillFiles(skillId, relativePath, context);
  }

  getSkillFileContent(
    skillId: string,
    relativePath: string,
    context?: { profileId?: string; sessionAgentId?: string },
  ): Promise<SkillFileContentResponse> {
    return this.services.configuration.getSkillFileContent(skillId, relativePath, context);
  }

  shareSkill(skillId: string): Promise<SkillShareResponse> {
    return this.services.configuration.shareSkill(skillId);
  }

  previewSkillImportFromUrl(
    url: string,
    target?: SkillImportTarget,
  ): Promise<SkillImportPreviewResponse> {
    return this.services.configuration.previewSkillImportFromUrl(url, target);
  }

  previewSkillImportBundle(
    bundle: SkillBundleManifestV1,
    target?: SkillImportTarget,
  ): Promise<SkillImportPreviewResponse> {
    return this.services.configuration.previewSkillImportBundle(bundle, target);
  }

  importSkill(options: ImportSkillOptions): Promise<SkillImportResultResponse> {
    return this.services.configuration.importSkill(options);
  }

  updateSettingsEnv(values: Record<string, string>): Promise<void> {
    return this.services.configuration.updateSettingsEnv(values);
  }

  deleteSettingsEnv(name: string): Promise<void> {
    return this.services.configuration.deleteSettingsEnv(name);
  }

  listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    return this.services.configuration.listSettingsAuth();
  }

  updateSettingsAuth(values: Record<string, string>): Promise<void> {
    return this.services.configuration.updateSettingsAuth(values);
  }

  deleteSettingsAuth(provider: string): Promise<void> {
    return this.services.configuration.deleteSettingsAuth(provider);
  }

  updateSettingsAuthCredential(
    provider: string,
    credential: AuthCredential,
  ): Promise<void> {
    return this.services.configuration.updateSettingsAuthCredential(provider, credential);
  }

  getOpenAIAuthBrokerSettings(): Promise<OpenAIBrokerSettingsResponse> {
    return this.services.configuration.getOpenAIAuthBrokerSettings();
  }

  updateOpenAIAuthBrokerSettings(
    request: UpdateOpenAIBrokerSettingsRequest,
  ): Promise<OpenAIBrokerSettingsResponse> {
    return this.services.configuration.updateOpenAIAuthBrokerSettings(request);
  }

  redeemOpenAIAuthBrokerInvite(
    request: RedeemOpenAIBrokerInviteRequest,
  ): Promise<OpenAIBrokerInviteRedeemResponse> {
    return this.services.configuration.redeemOpenAIAuthBrokerInvite(request);
  }

  disableOpenAIAuthBroker(): Promise<OpenAIBrokerSettingsResponse> {
    return this.services.configuration.disableOpenAIAuthBroker();
  }

  clearOpenAIAuthBrokerSettings(): Promise<OpenAIBrokerSettingsResponse> {
    return this.services.configuration.clearOpenAIAuthBrokerSettings();
  }

  testOpenAIAuthBrokerSettings(
    request?: Partial<UpdateOpenAIBrokerSettingsRequest>,
  ): Promise<OpenAIBrokerTestResponse> {
    return this.services.configuration.testOpenAIAuthBrokerSettings(request);
  }

  isOpenAIAuthBrokerModeActive(): Promise<boolean> {
    return this.services.configuration.isOpenAIAuthBrokerModeActive();
  }

  getCredentialPoolService(): CredentialPoolService {
    return this.services.configuration.getCredentialPoolService();
  }

  getOpenAIAuthBrokerRuntimeService(): ReturnType<
    SwarmConfigurationCoordinator["getOpenAIAuthBrokerRuntimeService"]
  > {
    return this.services.configuration.getOpenAIAuthBrokerRuntimeService();
  }

  listCredentialPool(provider: string): Promise<CredentialPoolState> {
    return this.services.configuration.listCredentialPool(provider);
  }

  renamePooledCredential(
    provider: string,
    credentialId: string,
    label: string,
  ): Promise<void> {
    return this.services.configuration.renamePooledCredential(provider, credentialId, label);
  }

  removePooledCredential(provider: string, credentialId: string): Promise<void> {
    return this.services.configuration.removePooledCredential(provider, credentialId);
  }

  setPrimaryPooledCredential(provider: string, credentialId: string): Promise<void> {
    return this.services.configuration.setPrimaryPooledCredential(provider, credentialId);
  }

  setCredentialPoolStrategy(
    provider: string,
    strategy: CredentialPoolStrategy,
  ): Promise<void> {
    return this.services.configuration.setCredentialPoolStrategy(provider, strategy);
  }

  resetPooledCredentialCooldown(provider: string, credentialId: string): Promise<void> {
    return this.services.configuration.resetPooledCredentialCooldown(provider, credentialId);
  }

  addPooledCredential(
    provider: string,
    oauthCredential: AuthCredential,
    identity?: { label?: string; autoLabel?: string; accountId?: string },
  ): Promise<PooledCredentialInfo> {
    return this.services.configuration.addPooledCredential(
      provider,
      oauthCredential,
      identity,
    );
  }

  // Direct and scoped Codex API.

  isExternalThreadSidecarDescriptor(descriptor: AgentDescriptor): boolean {
    return this.services.codexDirect.isSidecarDescriptor(descriptor);
  }

  retryCodexPluginWorker(
    managerAgentId: string,
    input: { initialMessage: string; retryContextId?: string },
  ): Promise<AgentDescriptor> {
    return this.services.codexPlugin.retryWorker(managerAgentId, input);
  }

  browseCodexMcpCatalog(managerAgentId: string): Promise<CodexCatalogSnapshot> {
    return this.services.codexPlugin.browseCatalog(managerAgentId);
  }

  async listCodexMcpTools(_managerAgentId: string): Promise<CodexCatalogSnapshot> {
    return this.services.codexPlugin.listRawTools();
  }

  async callCodexMcpTool(
    _managerAgentId: string,
    _params: { selector: string; args?: Record<string, unknown> },
  ): Promise<CodexMcpToolCallResult> {
    return this.services.codexPlugin.callRawTool();
  }

  getCodexPluginScopeForWorker(
    workerAgentId: string,
  ): CodexPluginScopeRuntimeView | undefined {
    return this.services.codexPlugin.getScopeForWorker(workerAgentId);
  }

  callCodexPluginScopedTool(
    workerAgentId: string,
    scopedToolName: string,
    args?: Record<string, unknown>,
  ): Promise<CodexMcpToolCallResult> {
    return this.services.codexPlugin.callScopedTool(workerAgentId, scopedToolName, args);
  }

  exportCodexPluginScopedToolResult(
    workerAgentId: string,
    input: CodexPluginScopedExportInput,
  ): Promise<CodexPluginScopedExportResult> {
    return this.services.codexPlugin.exportScopedToolResult(workerAgentId, input);
  }

  // Knowledge API.

  getCompactionRuntimeSettingsProvider(): CompactionRuntimeSettingsProvider {
    return this.services.knowledge.getCompactionRuntimeSettingsProvider();
  }

  getCompactionSettingsService(): CompactionSettingsService | null {
    return this.services.knowledge.getCompactionSettingsService();
  }

  getKnowledgeV2SettingsService(): KnowledgeV2SettingsService {
    return this.services.knowledge.getKnowledgeV2SettingsService();
  }

  getKnowledgeService(): KnowledgeService {
    return this.services.knowledge.getKnowledgeService();
  }

  searchKnowledge(
    callerAgentId: string,
    input: { query?: string; scope?: "global" | "profile" | "all"; limit?: number },
  ): Promise<KnowledgeSearchResult[]> {
    return this.services.knowledge.searchKnowledge(callerAgentId, input);
  }

  readKnowledgeEntry(callerAgentId: string, id: string): Promise<KnowledgeEntry> {
    return this.services.knowledge.readKnowledgeEntry(callerAgentId, id);
  }

  saveLearning(callerAgentId: string, input: SaveLearningInput): Promise<KnowledgeEntry> {
    return this.services.knowledge.saveLearning(callerAgentId, input);
  }

  handleCaptureFeedbackSignal(profileId: string, sessionId: string): Promise<void> {
    return this.services.knowledge.handleCaptureFeedbackSignal(profileId, sessionId);
  }

  // Runtime, diagnostics, observability, extensions, and host API.

  getCodexTransportDebugDiagnostics(): CodexTransportDebugAgentDiagnostics[] {
    return this.services.registry.directory
      .sortedDescriptors()
      .filter((descriptor) => isOpenAICodexDescriptor(descriptor))
      .map((descriptor) => {
        const runtime = this.services.runtime.runtimes.get(descriptor.agentId);
        const diagnostics =
          runtime?.runtimeType === "pi"
            ? runtime.getCodexTransportDebugDiagnostics?.()
            : undefined;
        const runtimeAvailable = Boolean(runtime);
        const websocketStatsStatus = runtime
          ? runtime.runtimeType === "pi"
            ? diagnostics?.websocketStatsStatus ?? "not_pi_runtime"
            : "not_pi_runtime"
          : "runtime_inactive";
        const directPiSessionStatsStatus = runtime
          ? runtime.runtimeType === "pi"
            ? diagnostics?.directPiSessionStatsStatus ?? "not_pi_runtime"
            : "not_pi_runtime"
          : "runtime_inactive";

        return {
          agentId: descriptor.agentId,
          agentIdHash: hashDebugAgentId(descriptor.agentId),
          role: descriptor.role,
          status: descriptor.status,
          modelId: descriptor.model?.modelId,
          provider: descriptor.model?.provider,
          api: diagnostics?.modelApi,
          selectedConfigTransport: selectedOpenAICodexTransport(),
          runtimeAvailable,
          runtimeTransport: diagnostics?.transport,
          runtimeModelProvider: diagnostics?.modelProvider,
          runtimeModelApi: diagnostics?.modelApi,
          piSessionIdPresent: diagnostics?.piSessionIdPresent ?? false,
          websocketStatsStatus,
          directPiSessionStatsStatus,
          ...(diagnostics?.websocketStats
            ? { websocketStats: diagnostics.websocketStats }
            : {}),
        } satisfies CodexTransportDebugAgentDiagnostics;
      });
  }

  updateWorkerActivity(agentId: string, event: RuntimeSessionEvent): void {
    this.services.runtime.controller.updateWorkerActivity(agentId, event);
  }

  resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor,
  ): Promise<AgentModelDescriptor | undefined> {
    return this.services.runtime.specialists.resolveSpecialistFallbackModelForDescriptor(
      descriptor,
    );
  }

  maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number,
  ): Promise<boolean> {
    return this.services.runtime.specialists.maybeRecoverWorkerWithSpecialistFallback({
      agentId,
      errorMessage,
      sourcePhase,
      runtimeToken,
      handleRuntimeStatus: (token, targetAgentId, status, pendingCount, contextUsage) =>
        this.services.runtime.lifecycle.handleRuntimeStatus(
          token,
          targetAgentId,
          status,
          pendingCount,
          contextUsage,
        ),
      handleRuntimeAgentEnd: (token, targetAgentId) =>
        this.services.runtime.lifecycle.handleRuntimeAgentEnd(token, targetAgentId),
    });
  }

  getWorkerActivity(
    agentId: string,
  ): ReturnType<SwarmRuntimeLifecycleCoordinator["getWorkerActivity"]> {
    return this.services.runtime.lifecycle.getWorkerActivity(agentId);
  }

  getSessionActiveToolsSnapshot(sessionAgentId: string): SessionActiveToolsSnapshotEvent {
    this.services.registry.directory.getRequiredSessionDescriptor(sessionAgentId);
    return this.services.runtime.activeTools.buildSnapshotEvent(sessionAgentId);
  }

  recordToolSideEffect(callerAgentId: string, event: SwarmToolSideEffectEvent): void {
    this.services.observability.recordToolSideEffect(callerAgentId, event);
  }

  getConfig(): SwarmConfig {
    return this.services.host.config;
  }

  getObservabilityService(): ObservabilityFacade | undefined {
    return this.services.observability.getService();
  }

  beforeRuntimeEventProjection(
    agentId: string,
    runtimeToken: number | undefined,
    event: RuntimeSessionEvent,
  ): void {
    this.services.runtime.turns.beforeRuntimeEventProjection(agentId, runtimeToken, event);
  }

  afterRuntimeEventProjection(
    agentId: string,
    runtimeToken: number | undefined,
    event: RuntimeSessionEvent,
  ): void {
    this.services.runtime.turns.afterRuntimeEventProjection(agentId, runtimeToken, event);
  }

  getVersioningService(): VersioningMutationSink | undefined {
    return this.services.host.versioningService;
  }

  getActiveTurnId(agentId: string, runtimeToken?: number): string | undefined {
    return this.services.runtime.turns.getActiveTurnId(agentId, runtimeToken);
  }

  resolveManagerAssistantFinalOutputTarget(
    agentId: string,
    activeTarget: AssistantOutputTarget | undefined,
  ): SessionTranscriptAssistantOutputTarget | undefined {
    return this.services.runtime.assistantOutput.resolveManagerFinalTarget(
      agentId,
      activeTarget,
    );
  }

  resolveManagerAssistantFinalOutputRoute(
    agentId: string,
    activeTarget: AssistantOutputTarget | undefined,
  ): ReturnType<AssistantOutputRouter["resolveManagerFinalRoute"]> {
    return this.services.runtime.assistantOutput.resolveManagerFinalRoute(
      agentId,
      activeTarget,
    );
  }

  listRuntimeExtensionSnapshots(): AgentRuntimeExtensionSnapshot[] {
    return this.services.runtime.controller.listRuntimeExtensionSnapshots();
  }

  buildForgeExtensionSettingsSnapshot(
    options: { cwdValues: string[] },
  ): ReturnType<ForgeExtensionHost["buildSettingsSnapshot"]> {
    return this.services.extensions.buildSettingsSnapshot({
      ...options,
      sessions: this.listAgents().filter((descriptor) => descriptor.role === "manager"),
    });
  }

  dispatchForgeVersioningCommit(event: ForgeVersioningCommitEvent): Promise<void> {
    return this.services.extensions.dispatchVersioningCommit(event);
  }

  setTerminalArchiveHooks(hooks?: TerminalArchiveHooks): void {
    this.services.host.setTerminalArchiveHooks(hooks);
  }

  maybeRecordModelCapacityBlock(
    agentId: string,
    descriptor: AgentDescriptor,
    error: RuntimeErrorEvent,
  ): void {
    this.services.configuration.maybeRecordModelCapacityBlock(agentId, descriptor, error);
  }

  handleRuntimeSessionEvent(
    runtimeTokenOrAgentId: number | string,
    agentIdOrEvent: string | RuntimeSessionEvent,
    maybeEvent?: RuntimeSessionEvent,
  ): Promise<void> {
    return this.services.runtime.lifecycle.handleRuntimeSessionEvent(
      runtimeTokenOrAgentId,
      agentIdOrEvent,
      maybeEvent,
    );
  }

  handleRuntimeError(
    runtimeTokenOrAgentId: number | string,
    agentIdOrError: string | RuntimeErrorEvent,
    maybeError?: RuntimeErrorEvent,
  ): Promise<void> {
    return this.services.runtime.lifecycle.handleRuntimeError(
      runtimeTokenOrAgentId,
      agentIdOrError,
      maybeError,
    );
  }
  async queueVersionedToolMutation(
    descriptor: AgentDescriptor,
    mutation: VersioningMutation,
  ): Promise<void> {
    void descriptor;
    this.queueFacadeVersioningMutation(mutation);
  }
  private queueFacadeVersioningMutation(mutation: VersioningMutation): void {
    void this.services.host.versioningService?.recordMutation(mutation).catch((error) => {
      this.services.host.logDebug("versioning:record_error", {
        path: mutation.path,
        source: mutation.source,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private get services(): SwarmManagerFacadeServices {
    return this.getFacadeServices();
  }
}
function isOpenAICodexDescriptor(descriptor: AgentDescriptor): boolean {
  return String(descriptor.model?.provider ?? "").toLowerCase() === "openai-codex";
}
function selectedOpenAICodexTransport(): CodexTransportDebugAgentDiagnostics["selectedConfigTransport"] {
  const rawTransport = process.env.FORGE_OPENAI_CODEX_TRANSPORT?.trim().toLowerCase();
  switch (rawTransport) {
    case undefined: case "":
      return "sse";
    case "sse":
    case "websocket":
    case "websocket-cached":
    case "auto":
      return rawTransport;
    default:
      return "sse";
  }
}
function hashDebugAgentId(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 16);
}
