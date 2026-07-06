import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import { isRepoProjectAgentSource, isSystemProfile, type SpecialistTargetSpace } from "@forge/protocol";
import type {
  AgentRuntimeExtensionSnapshot,
  ChoiceRequestEvent,
  CollaborationAuthor,
  ConversationReplyTarget,
  ConversationReplyTargetInput,
  CredentialPoolState,
  CredentialPoolStrategy,
  OpenAIBrokerInviteRedeemResponse,
  OpenAIBrokerSettingsResponse,
  OpenAIBrokerTestResponse,
  RedeemOpenAIBrokerInviteRequest,
  UpdateOpenAIBrokerSettingsRequest,
  PooledCredentialInfo,
  CortexReviewRunRecord,
  CortexReviewRunScope,
  CortexReviewRunTrigger,
  PromptPreviewResponse,
  ManagerExactModelSelection,
  ServerEvent,
  SessionActiveToolsSnapshotEvent,
  SessionTaskStateSnapshotEvent,
  ModelCacheObservationEvent,
  WorkPlanCreatedEvent,
  SessionMemoryMergeAttemptStatus,
  SessionMemoryMergeFailureStage,
  SessionMemoryMergeResult,
  SessionMemoryMergeStrategy,
  SessionMeta,
  SkillBundleManifestV1,
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillImportPreviewResponse,
  SkillImportResultResponse,
  SkillImportTarget,
  SkillInventoryEntry,
  SkillShareResponse,
  ActivateRepoProjectAgentRequest,
  ProjectAgentExternalDirectoryEntry
} from "@forge/protocol";
import { persistConversationAttachments } from "../ws/attachment-parser.js";
import {
  COLLABORATION_DISPLAY_NAME,
  COLLABORATION_PROFILE_ID,
} from "../collaboration/constants.js";

import type { ObservabilityFacade, ObservabilityRuntimeInputHandle, ObservabilityRootSource } from "../observability/observability-types.js";
import type { VersioningMutation, VersioningMutationSink } from "../versioning/versioning-types.js";
import {
  FileBackedPromptRegistry,
  normalizeArchetypeId,
  resolvePromptVariables,
  type PromptCategory,
  type PromptRegistry
} from "./prompt-registry.js";
import { ConversationProjector } from "./conversation-projector.js";
import { resolveConversationReplyTarget } from "./conversation-reply.js";
import {
  collectConversationMessageIdsFromSessionFile,
  copySessionHistoryForFork
} from "./session/conversation-timeline.js";
import {
  getWorkerIdFromCanonicalTranscriptFileName,
  isWorkerTranscriptSidecarAgentId,
  isWorkerTranscriptSidecarSessionFile
} from "./session/worker-transcript-files.js";
import {
  getCommonKnowledgePath,
  getCortexPromotionManifestsDir,
  getCortexReviewLogPath,
  getCortexReviewRunsPath,
  getCortexWorkerPromptsPath,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getSessionDir,
  getSessionFilePath,
  getWorkerSessionFilePath,
  getWorkersDir,
  resolveMemoryFilePath
} from "./data-paths.js";
import {
  clearAllPins as clearAllSessionPins,
  combineCompactionCustomInstructions,
  formatPinnedMessagesForCompaction,
  loadPins,
  savePins,
  togglePin,
  type PinRegistry
} from "./message-pins.js";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import { backendSidebarPerfMetricManifest } from "../stats/sidebar-perf-metrics.js";
import { createSidebarPerfRegistry } from "../stats/sidebar-perf-registry.js";
import type {
  SidebarConversationHistoryDiagnostics,
  SidebarPerfRecorder,
  SidebarPerfSlowEvent,
  SidebarPerfSummary
} from "../stats/sidebar-perf-types.js";
import type { CredentialPoolService } from "./credential-pool.js";
import {
  createLiveCompactionRuntimeSettingsProvider,
  LiveCompactionRuntimeSettingsProvider,
  type CompactionRuntimeSettingsProvider,
} from "./compaction-runtime-settings-provider.js";
import { CompactionSettingsService } from "./compaction-settings-service.js";
import { KnowledgeV2SettingsService } from "./knowledge-v2-settings-service.js";
import {
  KnowledgeService,
  type KnowledgeEntry,
  type KnowledgeEntryScope,
  type KnowledgeEntryType,
  type KnowledgeSearchResult,
} from "./knowledge-service.js";
import { AgentDescriptorStore } from "./agents/agent-descriptor-store.js";
import { ArchiveService } from "./archive/archive-service.js";
import { ArchiveLastUsedHydrator, type ArchiveLastUsedHydrationResult } from "./archive/archive-last-used-hydrator.js";
import {
  ARCHIVED_PROJECT_OPERATION_MESSAGE,
  ARCHIVED_SESSION_OPERATION_MESSAGE,
  isProfileArchived,
  isSessionDirectlyArchived,
} from "./archive/archive-resolver.js";
import { BootReconciler } from "./agents/descriptor-store/boot-reconciler.js";
import { ProjectAgentMirrorReconciler } from "./agents/descriptor-store/project-agent-mirror-reconciler.js";
import { cleanupOldSharedConfigPaths, migrateSharedConfigLayout } from "./shared-config-migration.js";
import {
  formatAgentCreatorContextMessage,
  gatherAgentCreatorContext
} from "./agent-creator-context.js";
import {
  analyzeSessionForPromotion,
  type AnalyzeSessionForPromotionOptions,
  type ProjectAgentRecommendations
} from "./project-agent-analysis.js";
import { deleteProjectAgentRecord } from "./project-agent-storage.js";
import {
  deliverProjectAgentMessage,
  formatProjectAgentRuntimeMessage,
  getProjectAgentPublicName,
  isReservedProjectAgentHandle,
} from "./project-agents.js";
import { PersistenceService } from "./persistence-service.js";
import { ForgeExtensionHost } from "./forge-extension-host.js";
import type { VersioningCommitEvent as ForgeVersioningCommitEvent } from "./forge-extension-types.js";
import { migrateLegacyProfileKnowledgeToReferenceDoc } from "./reference-docs.js";
import { generatePiProjection } from "./model-catalog-projection.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { CLAUDE_RUNTIME_STATE_ENTRY_TYPE } from "./claude-agent-runtime.js";
import { CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE } from "./runtime/cursor-sdk/cursor-sdk-agent-runtime.js";
import type { AssistantOutputTarget } from "./runtime/manager-assistant-output-tracker.js";
import { formatAssistantOutputTargetMetadata } from "./runtime/manager-assistant-output-target-metadata.js";
import { isCleanManagerAssistantFinalMessage } from "./runtime/manager-assistant-final-message.js";
import { CURSOR_SDK_USAGE_ENTRY_TYPE } from "../utils/cursor-sdk-usage-records.js";
import { ModelChangeStartupRecoveryCoordinator } from "./runtime/model-change-startup-recovery-coordinator.js";
import { reconcileInterruptedToolCallsForBoot } from "./interrupted-tool-reconciliation.js";
import {
  isRuntimeRecoveryActiveForRuntime,
  RuntimeRecoveryState
} from "./runtime/runtime-recovery-state.js";
import {
  SwarmRuntimeController,
  type SwarmRuntimeControllerHost
} from "./swarm-runtime-controller.js";
import { SwarmSpecialistFallbackManager } from "./swarm-specialist-fallback-manager.js";
import {
  SwarmWorkerHealthService,
  type WatchdogBatchEntry,
  type WorkerActivityState,
  type WorkerStallState,
  type WorkerWatchdogState
} from "./swarm-worker-health-service.js";
import { createPiModelRegistry } from "./pi-model-registry.js";
import type { ImportSkillOptions } from "./skills/skill-sharing-service.js";
import {
  getManagedModelProviderCredentialAvailability,
  SecretsEnvService
} from "./secrets-env-service.js";
import { SwarmMemoryMergeService, type SessionMemoryMergeAuditEntry } from "./swarm-memory-merge-service.js";
import { SwarmSessionMetaService, type SessionMemoryMergeAttemptMetaUpdate } from "./swarm-session-meta-service.js";
import { SkillFileService } from "./skill-file-service.js";
import { SkillMetadataService, type SkillMetadata } from "./skill-metadata-service.js";
import { resolveCollaborationSkillRoster } from "./skills/collaboration-skill-resolver.js";
import { SwarmChoiceService } from "./swarm-choice-service.js";
import { SwarmCortexService } from "./swarm-cortex-service.js";
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";
import {
  buildProjectExecutableTrustPlan,
  resolveProjectExecutableTrustPlan,
  type ProjectExecutableTrustPlan
} from "./project-executable-trust.js";
import { ProjectWorkspaceResolver } from "./project-workspace-resolver.js";
import { SwarmPromptService } from "./swarm-prompt-service.js";
import { SwarmSettingsService } from "./swarm-settings-service.js";
import {
  SwarmAgentLifecycleService,
  type AgentLifecycleStopSessionOptions,
  type ExternalThreadStopInterruptCallback,
  type ExternalThreadTerminateCleanupCallback,
  type ManagerRuntimeRecycleReason
} from "./swarm-agent-lifecycle-service.js";
import { MANUAL_MANAGER_STOP_NOTICE } from "./manual-stop-notice.js";
import { SessionProvisioner } from "./session-provisioner.js";
import { SwarmSessionService } from "./swarm-session-service.js";
import { SwarmProjectAgentService } from "./swarm-project-agent-service.js";
import {
  ProjectAgentSharingService,
  type ExternalProjectAgentDeliveryAuthorization,
} from "./project-agent-sharing-service.js";
import { SessionCoordinationStore } from "./coordination/session-coordination-store.js";
import {
  toWorkPlanServiceErrorDescriptor,
  WorkPlanService,
  WorkPlanServiceValidationError,
  type WorkPlanMutationResult,
  type WorkPlanServiceAction,
} from "./coordination/work-plan-service.js";
import {
  normalizeTaskToolInput,
  type TaskToolGetInput,
  type TaskToolInput,
  type TaskToolRecoverableErrorResult,
  type TaskToolResult,
} from "./coordination/task-tool.js";
import { ACTIVE_WORK_PLANS_SKILL_HANDLE } from "./coordination/work-plans-settings.js";
import { getModelCacheVisualizationEnabled } from "./model-cache-visualization-settings.js";
import { scanRepoProjectAgentDefinitions } from "./repo-project-agent-definitions.js";
import {
  assertRepoProjectAgentSourceAvailable,
  resolveRepoProjectAgentSource,
  type RepoProjectAgentSourceResolution
} from "./agents/repo-project-agent-source.js";
import { SessionActiveToolsState } from "./session-active-tools.js";
import {
  normalizeAllowlistRoots,
  validateDirectoryPath,
  type DirectoryListingResult,
  type DirectoryValidationResult
} from "./cwd-policy.js";
import {
  isConversationBinaryAttachment,
  isConversationImageAttachment,
  isConversationTextAttachment
} from "./conversation-validators.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
  isAbortLikeErrorMessage,
  normalizeProviderErrorMessage
} from "./message-utils.js";
import { classifyRuntimeCapacityError } from "./runtime-utils.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  inferSwarmModelPresetFromDescriptor,
  normalizePersistedSwarmModelDescriptor,
  parseSwarmModelPreset,
  parseSwarmReasoningLevel,
  resolveModelDescriptorFromPreset
} from "./model-presets.js";
import { loadOnboardingState } from "./onboarding-state.js";
import {
  generateRosterBlock as specialistGenerateRosterBlock,
  getSpecialistsEnabled as specialistGetSpecialistsEnabled,
  LEGACY_MODEL_ROUTING_GUIDANCE,
  normalizeSpecialistHandle as specialistNormalizeSpecialistHandle,
  resolveCollaborationChannelRoster as specialistResolveCollaborationChannelRoster,
  resolveRoster as specialistResolveRoster,
  resolveWorkspaceRoster as specialistResolveWorkspaceRoster,
} from "./specialists/specialist-registry.js";
import {
  isNonRunningAgentStatus,
  transitionAgentStatus
} from "./agent-state-machine.js";
import { createCollaborationDbHelpers } from "../collaboration/collab-db-helpers.js";
import { parseCollaborationSpecialistHandlesJson } from "../collaboration/specialist-selection.js";
import { isBuilderRuntimeTarget, isCollaborationServerRuntimeTarget } from "../runtime-target.js";
import type {
  RuntimeCodexTransportDebugDiagnostics,
  RuntimeImageAttachment,
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeSessionMessage,
  RuntimeShutdownOptions,
  RuntimeUserMessage,
  SetPinnedContentOptions,
  SmartCompactResult,
  SwarmAgentRuntime
} from "./runtime-contracts.js";
import type { SwarmToolHost, SwarmToolSideEffectEvent } from "./swarm-tool-host.js";
import type {
  AgentMessageEvent,
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  AgentStatusEvent,
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceRequestStatus,
  AgentsSnapshotEvent,
  AgentsStoreFile,
  ConversationAttachment,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationMessageEvent,
  ManagerProfile,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SettingsAuthProvider,
  SessionLifecycleEvent,
  SkillEnvRequirement,
  SpawnAgentInput,
  SwarmConfig,
  SwarmModelPreset,
  SwarmReasoningLevel
} from "./types.js";
import { cloneDescriptorForPersistence } from "./agents/descriptor-store/descriptor-clone.js";
import {
  assertBuilderSession,
  assertCollabSession,
  buildModelCapacityBlockKey,
  clampModelCapacityBlockDurationMs,
  cloneDescriptor,
  cloneProjectAgentInfoValue,
  extractDescriptorAgentId,
  extractRuntimeMessageText,
  formatBinaryAttachmentForPrompt,
  formatInboundUserMessageForManager,
  formatTextAttachmentForPrompt,
  getCollabSessionInfo,
  isCollabSession,
  isEnoentError,
  isRecord,
  normalizeAgentId,
  normalizeContextUsage,
  normalizeConversationAttachments,
  normalizeCortexUserVisiblePaths,
  normalizeMessageSourceContext,
  normalizeMessageTargetContext,
  normalizeOptionalAgentId,
  normalizeOptionalAttachmentPath,
  normalizeOptionalModelId,
  nowIso,
  normalizeThinkingLevelForProvider,
  parseCompactSlashCommand,
  parseSessionNumberFromAgentId,
  previewForLog,
  readFileHead,
  readStringDetail,
  sanitizeCliSessionMetadata,
  sanitizeAttachmentFileName,
  sanitizePathSegment,
  slugifySessionName,
  toConversationAttachmentMetadata,
  toRuntimeDispatchAttachments,
  toRuntimeImageAttachments,
  validateAgentDescriptor
} from "./swarm-manager-utils.js";
import {
  isExternalThreadDescriptor,
  reconcilePersistedExternalThreadSidecarsForBoot,
  shouldIncludeDescriptorInBootInterruptedToolReconciliation,
} from "./external-thread-compatibility.js";
import { CodexAppServerService } from "./codex-app-server/codex-app-server-service.js";
import type { CodexCatalogSnapshot, CodexMcpToolCallResult } from "./codex-app-server/codex-mcp-catalog.js";
import {
  assertCodexMcpToolGateAllowed,
  buildCodexMcpToolTurnAuthorization,
  evaluateCodexMcpCatalogBrowseGate,
  evaluateCodexMcpToolGate,
  type CodexMcpToolGateEvaluation,
} from "./codex-app-server/codex-mcp-tool-gate.js";
import {
  classifyCodexUserMessage,
  isBuilderWebCodexRoutingSurface,
  parseLeadingCodexMention,
} from "./codex-app-server/codex-mention-router.js";
import {
  buildCodexPluginInitialTask,
  buildCodexPluginWorkerPrompt,
  CODEX_PLUGIN_INTERNAL_WORKER_KIND,
  CODEX_PLUGIN_SPECIALIST_COLOR,
  CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
  CODEX_PLUGIN_SPECIALIST_ID,
  CodexPluginScopeService,
  createCodexPluginDelegationId,
  isCodexPluginWorkerDescriptor,
  type CodexPluginExportFormat,
  type CodexPluginScopedExportResult,
  type CodexPluginScopeRuntimeView,
} from "./codex-app-server/codex-plugin-scope-service.js";
import { reconcilePersistedCodexDetailStateForBoot } from "./codex-app-server/codex-detail-boot-reconciliation.js";
import { createCodexSidecarHostAdapter } from "./codex-app-server/codex-sidecar-host-adapter.js";
import { truncateCodexPreview } from "./codex-app-server/codex-sidecar-parent-cards.js";
import type { CodexAppServerServiceOptions } from "./codex-app-server/types.js";
import { CodexSidecarBusyError } from "./codex-app-server/types.js";

export {
  analyzeLatestCortexCloseoutNeed,
  buildSessionMemoryRuntimeView,
  normalizeCortexUserVisiblePaths
} from "./swarm-manager-utils.js";

export interface AppendConversationUserMessageOptions {
  targetAgentId?: string;
  attachments?: ConversationAttachment[];
  sourceContext?: MessageSourceContext;
  collaborationAuthor?: CollaborationAuthor;
  replyTo?: ConversationReplyTarget;
}

export interface AppendConversationUserMessageResult {
  target: AgentDescriptor;
  text: string;
  sourceContext: MessageSourceContext;
  receivedAt: string;
  event: ConversationMessageEvent;
  persistedAttachments: ConversationAttachment[];
  runtimeAttachments: ConversationAttachment[];
}

export interface DispatchRuntimeUserMessageOptions {
  targetAgentId: string;
  text: string;
  sourceContext: MessageSourceContext;
  collaborationAuthor?: CollaborationAuthor;
  runtimeAttachments?: ConversationAttachment[];
  persistedAttachmentCount?: number;
  delivery?: RequestedDeliveryMode;
}

interface PreparedInboundConversationPayload {
  text: string;
  runtimeText?: string;
  timestamp?: string;
  source: "user_input" | "project_agent_input";
  sourceContext?: MessageSourceContext;
  collaborationAuthor?: CollaborationAuthor;
  projectAgentContext?: ConversationMessageEvent["projectAgentContext"];
  attachments?: ConversationAttachment[];
  replyTo?: ConversationReplyTarget;
}

interface AppendPreparedInboundConversationPayloadResult {
  event: ConversationMessageEvent;
  persistedAttachments: ConversationAttachment[];
  runtimeAttachments: ConversationAttachment[];
}

interface CodexPluginDelegationTurnContext {
  contextId: string;
  managerAgentId: string;
  originalText: string;
  strippedText: string;
  selectors: string[];
  sourceContext: MessageSourceContext;
  userMessageId?: string;
}

interface PendingCodexPluginSpawnContext {
  delegationId: string;
  activeContext: CodexPluginDelegationTurnContext;
  task: string;
  materializedWorkerAgentIds: Set<string>;
}

interface CodexPluginRetryContext {
  retryContextId: string;
  activeContext: CodexPluginDelegationTurnContext;
  createdAt: number;
  lastWorkerAgentId?: string;
}

interface CodexPluginRetryAuthorizationContext {
  retryContextId: string;
  activeContext: CodexPluginDelegationTurnContext;
  authorizedUserMessageId?: string;
  createdAt: number;
  lastWorkerAgentId?: string;
}

type SessionTranscriptAssistantOutputTarget = Extract<AssistantOutputTarget, { kind: "session_transcript" }>;

interface PendingInboundTurnContext {
  turnId?: string;
  runtimeToken?: number;
  activationEligible?: boolean;
  source: PreparedInboundConversationPayload["source"] | "agent_message";
  rootTurnId?: string;
  parentRootTurnId?: string;
  runtimeMessageText?: string;
  projectAgentContext?: ConversationMessageEvent["projectAgentContext"];
  sourceContext?: MessageSourceContext;
  collaborationAuthor?: CollaborationAuthor;
  assistantOutputTarget?: AssistantOutputTarget;
  assistantOutputProjectionTarget?: AssistantOutputTarget;
  codexMcpToolGate?: CodexMcpToolGateEvaluation;
  codexPluginDelegationContext?: CodexPluginDelegationTurnContext;
  codexPluginRetryAuthorizationContext?: CodexPluginRetryAuthorizationContext;
}

interface PendingChoiceAssistantOutputContinuation {
  managerId: string;
  target: SessionTranscriptAssistantOutputTarget;
}

interface ActiveObservabilityRootContext {
  rootTurnId: string;
  parentRootTurnId?: string;
}

interface ActiveTurnContext {
  turnId: string;
  runtimeToken?: number;
}

interface ExternalProjectAgentTurnContext {
  fromAgentId: string;
  fromDisplayName: string;
  fromProfileId?: string;
  fromProjectName?: string;
}

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
  websocketStatsStatus: RuntimeCodexTransportDebugDiagnostics["websocketStatsStatus"] | "runtime_inactive" | "not_pi_runtime";
  directPiSessionStatsStatus: RuntimeCodexTransportDebugDiagnostics["directPiSessionStatsStatus"] | "runtime_inactive" | "not_pi_runtime";
  websocketStats?: RuntimeCodexTransportDebugDiagnostics["websocketStats"];
}

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId: string;
  provider: string;
  reasoningLevel?: SwarmReasoningLevel;
  fallbackModelId?: string;
  fallbackProvider?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
  webSearch?: boolean;
  promptBody: string;
  available: boolean;
  availabilityCode?: string;
  availabilityMessage?: string;
}

interface SpecialistRegistryModule {
  resolveRoster(profileId: string, targetSpace?: SpecialistTargetSpace): Promise<ResolvedSpecialistDefinitionLike[]>;
  generateRosterBlock(roster: ResolvedSpecialistDefinitionLike[]): string;
  normalizeSpecialistHandle(value: string): string;
  getSpecialistsEnabled(): Promise<boolean>;
  legacyModelRoutingGuidance: string;
}

// AgentDescriptor now includes specialistId/specialistDisplayName/specialistColor directly.


const MANAGER_ARCHETYPE_ID = "manager";
const MERGER_ARCHETYPE_ID = "merger";
const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";
const CORTEX_DISPLAY_NAME = "Cortex";
const INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: ";
// Terminal worker reports get their own prefix: the manager prompt teaches the
// model that `SYSTEM:` messages are non-actionable context, which is the wrong
// frame for a final report that requires closing the loop with the user.
const WORKER_REPORT_MESSAGE_PREFIX = "WORKER REPORT: ";
const TERMINAL_WORKER_REPORT_BODY_PATTERN = /^status:\s*(?:done|partial|blocked|completed)\b/i;
const MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE = `You are a newly created manager agent for this specific project/profile.

Cortex may already have captured durable cross-project user defaults such as preferred name, technical level, and response preferences.
If an onboarding snapshot or onboarding-derived summary is present in injected context, treat that as authoritative over any rendered natural-language copy.

Do NOT re-run a generic user onboarding interview.
Do NOT ask broad user-level questions like:
- what they like to be called
- whether they prefer concise or detailed responses in general
- whether they prefer autonomy or collaboration in general
- what explanation depth they want in general
unless that information is truly missing and directly necessary for the immediate work.

Important honesty rule:
- If onboarding defaults are actually present, you may briefly acknowledge that you already have a baseline sense of how they like to work.
- If onboarding was skipped, is still pending, or is effectively empty, do NOT imply that you already know their preferences.
- In that case, stay project-focused and let Cortex handle cross-project preferences later.

Your first job is to orient to THIS project.

Send a warm welcome. Then run a short, practical, project bootstrap conversation focused on:
1. What they are building or trying to accomplish here.
2. Which repo, directory, or codebase is the source of truth.
3. The project stack and architecture, if not obvious from files.
4. Validation commands and quality gates.
5. Repo-specific conventions, constraints, workflows, or guardrails.
6. Docs or guidance you should read first.
7. What they want to do first.

Keep this conversational, not checklist-like.
Ask only the next most useful question.
If the user arrives with a concrete task, get enough bootstrap context to work safely, then move into execution.

Prefer repo inspection over interrogation.
Start by reading these in order when they exist and are relevant:
1. AGENTS.md / SWARM.md / repo-specific agent instructions
2. README.md or top-level docs for project overview
3. package.json / pnpm-workspace.yaml / pyproject.toml / Cargo.toml / go.mod / equivalent manifests
4. build, test, lint, typecheck, or task-runner config
5. CONTRIBUTING.md, docs/DEVELOPMENT.md, or similar contributor guidance

Ask the user only for what you cannot infer confidently from those materials.
Distinguish durable repo conventions from one-off task details.
Do not collapse project-specific rules into cross-project user defaults.

Useful first-message shapes:
- If onboarding defaults are present: "Hi - I already have a baseline sense of how you like to work, so I'll focus on this project. What are we building here, and which repo or directory should I treat as the source of truth?"
- If onboarding defaults are absent: "Hi - I'll focus on getting oriented to this project. What are we building here, and which repo or directory should I treat as the source of truth?"

Do not include the old generic "how do you like to work" interview.
This manager's onboarding is about the project, not the person.`;
const COMMON_KNOWLEDGE_INITIAL_TEMPLATE = `# Common Knowledge
<!-- Maintained by Cortex. Last updated: {ISO timestamp} -->

## Interaction Defaults

## Workflow Defaults

## Cross-Project Technical Standards

## Cross-Project Gotchas
`;

const CORTEX_WORKER_PROMPTS_INITIAL_TEMPLATE = `# Cortex Worker Prompt Templates — v4
<!-- Cortex Worker Prompts Version: 4 -->

> Owned by Cortex. Refine these templates over time based on what produces good vs bad results from workers.

Use these templates when spawning workers. Copy the relevant template, fill in the placeholders (marked with \`{{...}}\`), and send as the worker's task message.

Model-selection guidance:
- Cortex chooses the actual runtime model.
- Default to a cheap/fast extraction model for narrow transcript work.
- Retry with a more reliable balanced model if the fast path idles or emits no output.
- Escalate to a deep-synthesis model for ambiguity, conflict resolution, or large reconciliation passes.

---

## Promotion Discipline (all templates)

Default to **precision over coverage**.

- A clean **no durable findings** result is good work.
- Prefer **discard** over weak promotion.
- Prefer **note** over weak \`inject\` / \`reference\` proposals.
- Prefer **reference** over **inject** for narrow procedures, command catalogs, troubleshooting flows, and task-local runbooks.
- Only use **inject** when the finding should change future agent behavior by default within its scope.
- Distill findings into future-facing guidance. Do not copy transcript chronology, long command sequences, or logs unless the exact string is itself the durable convention.
- Cap retained findings to the strongest few. Merge overlaps instead of emitting near-duplicates.
- Prioritize explicit user statements, trusted artifacts, explicit feedback, and repeated user-side patterns over assistant chatter.

## Evidence Discipline (all templates)

Prefer **exogenous evidence** over **endogenous evidence**.

Stronger evidence:
- explicit user instructions or corrections
- trusted source-of-truth artifacts (\`AGENTS.md\`, stable design docs, configs)
- explicit feedback telemetry
- repeated user-side patterns across sessions

Weaker evidence:
- manager/worker behavior that may have been shaped by existing memory
- assistant narrative claims
- session-memory text by itself
- one-off inferences from ambiguous context

Rules:
- Do not propose weak evidence directly for \`common\` injected memory.
- Treat session memory as supporting evidence, not authoritative truth.
- If a signal is interesting but weak, return it as \`note\`.

## Required Finding Schema (all extraction templates)

Write markdown, but include one fenced \`json\` block containing this normalized shape:

\`\`\`json
{
  "profile": "<profileId>",
  "session": "<sessionId>",
  "source_kind": "transcript | session_memory | feedback",
  "findings": [
    {
      "id": "F1",
      "statement": "atomic durable claim",
      "type": "preference | workflow | decision | fact | gotcha | procedure | feedback",
      "proposed_outcome": "note | inject | reference | discard",
      "proposed_target": "common | profile_memory | reference/<file>.md | notes | none",
      "scope": "common | profile",
      "confidence": "high | medium | low",
      "evidence_tier": "explicit_user | trusted_artifact | feedback_signal | repeated_user_pattern | agent_inference",
      "sources": [
        { "kind": "session_message | session_memory | feedback | doc", "ref": "..." }
      ],
      "rationale": "why this routing is appropriate"
    }
  ],
  "summary": {
    "finding_count": 0,
    "blockers": []
  }
}
\`\`\`

Schema rules:
- cap retained findings to the strongest 8 unless the task explicitly asks for fewer
- prefer atomic claims rather than bundled paragraphs
- return empty \`findings\` if nothing durable exists
- do not substitute a prose session summary for structured findings

---

## Callback Format (all templates)

Every worker MUST send a final callback to the manager via \`send_message_to_agent\` in this format:

\`\`\`
STATUS: DONE | FAILED
FINDINGS: <count>
ARTIFACT: <path to output file>
BLOCKER: <none | brief description>
\`\`\`

Detailed reasoning and full findings go in the output artifact file, NOT in the callback message.

---

## 1. Session Transcript Extraction Worker

Use for: Reviewing a single session's transcript delta and extracting durable knowledge signals.

\`\`\`
You are a knowledge extraction worker for Cortex.

## Task
Review only the transcript delta that starts at byte offset {{BYTE_OFFSET}} in \`{{SESSION_JSONL_PATH}}\`.

Important: the \`read\` tool offset is line-based, NOT byte-based. Do NOT pass {{BYTE_OFFSET}} into \`read\` directly.

Use this workflow:
1. If \`{{BYTE_OFFSET}}\` is greater than 0, use \`bash\` with Python/Node to copy the transcript slice starting at byte offset {{BYTE_OFFSET}} into \`{{DELTA_SLICE_PATH}}\`.
2. Read \`{{DELTA_SLICE_PATH}}\` with the \`read\` tool.
3. If \`{{BYTE_OFFSET}}\` is 0, you may read the original session file directly.

The file is JSONL. Prioritize \`user_message\` entries, then explicit decisions or conventions stated elsewhere. Treat assistant behavior that may have been shaped by existing memory as weak evidence.

## Extract only durable signals
Examples:
- user preferences
- workflow patterns
- technical decisions
- project facts
- quality standards
- working conventions
- recurring gotchas
- cross-project patterns

## Skip
- transient task details
- implementation minutiae
- secrets
- ephemeral progress chatter
- raw code unless it clearly reveals a durable convention
- long runbooks unless the exact command/name is itself the durable convention

## Output
Write markdown to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
1. \`Outcome: promote | no-op | follow-up-needed\`
2. \`Why:\` one short paragraph
3. \`Candidate Findings (JSON)\` containing the required normalized schema with:
   - \`profile: "{{PROFILE_ID}}"\`
   - \`session: "{{SESSION_ID}}"\`
   - \`source_kind: "transcript"\`
4. \`Discarded candidates\` with brief bullets for tempting but weak/transient signals
5. \`Concise completion summary\` with 1-3 bullets Cortex could reuse in a user closeout

Additional rules:
- At most 8 retained findings.
- Use \`note\` when the signal is plausible but not strong enough to promote.
- Do not promote weak evidence directly to \`common\`.
- Do not summarize the whole session.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 2. Session-Memory Extraction Worker

Use for: Reviewing a session working-memory file for signals worth promoting or preserving as notes.

\`\`\`
You are a session-memory review worker for Cortex.

## Task
Read the session memory file at \`{{SESSION_MEMORY_PATH}}\`.

For context, the current profile memory is:
{{PROFILE_MEMORY_CONTENT_OR "Profile memory is currently empty."}}

## Evidence rule
Session memory is supporting evidence, not authoritative truth. If a claim is interesting but not independently strong, return it as \`note\`.

## What to look for
- durable decisions or conventions
- corrections to existing profile memory
- architecture/gotcha signals worth remembering
- patterns not yet captured in profile memory

## What to skip
- active task state and in-progress work items
- duplicates of existing profile memory
- speculative notes without support
- Cortex-internal orchestration details
- long procedural detail better suited for reference

## Output
Write markdown to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
1. \`Outcome: promote | no-op | follow-up-needed\`
2. \`Why:\` one short paragraph
3. \`Candidate Findings (JSON)\` containing the required normalized schema with:
   - \`profile: "{{PROFILE_ID}}"\`
   - \`session: "{{SESSION_ID}}"\`
   - \`source_kind: "session_memory"\`
4. \`Discarded candidates\`
5. \`Concise completion summary\`

Additional rules:
- Prefer \`note\` when the signal is not independently confirmed.
- Default target is \`profile_memory\`, \`reference/<file>.md\`, or \`notes\`.
- Do not create common injected lore from session memory alone.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 3. Knowledge Synthesis Worker

Use for: Deduplicating multiple worker artifacts into promotion-ready actions.

\`\`\`
You are a knowledge synthesis worker for Cortex.

## Task
Below are raw findings from multiple worker artifacts. Deduplicate, reconcile conflicts, and produce promotion-ready actions.

## Raw findings
{{PASTE_ALL_WORKER_FINDINGS_HERE}}

## Current knowledge state
{{PASTE_RELEVANT_EXISTING_KNOWLEDGE_OR "No existing entries — all findings are new."}}

## Instructions
1. Deduplicate overlapping findings.
2. Reconcile conflicts and flag tensions explicitly.
3. Keep only findings that add new durable signal.
4. Validate each retained finding's proposed outcome and target.
5. Prefer no-op over marginal promotion.

## Output
Write markdown to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
1. \`Outcome: promote | no-op | follow-up-needed\`
2. \`Recommended Actions (JSON)\` in this shape:

\`\`\`json
{
  "actions": [
    {
      "action": "add_note | promote_to_inject | promote_to_reference | update_entry | retire_entry | merge_duplicate | no_change",
      "target_file": "relative/path.md | notes | none",
      "target_section": "section name or managed block",
      "finding_ids": ["F1"],
      "confidence": "high | medium | low",
      "conflict_status": "none | tension | blocked",
      "proposed_text": "concise future-facing text",
      "reason": "why this action is appropriate"
    }
  ],
  "summary": {
    "promote_count": 0,
    "note_count": 0,
    "discard_count": 0,
    "blockers": []
  }
}
\`\`\`

3. \`Discarded / no-op findings\`
4. \`Open tensions or blockers\`
5. \`Concise completion summary\` with 2-4 bullets Cortex can adapt into a short user-facing completion

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 4. Scan / Triage Worker (fallback only)

Use for: Optional fallback when Cortex cannot safely run the bounded scan directly.

\`\`\`
You are a scan and triage worker for Cortex.

## Task
Only use this worker if Cortex explicitly asked for delegated scan help. Cortex normally runs the bounded scan itself.

1. Execute: \`bash node {{SWARM_SCRIPTS_DIR}}/cortex-scan.js {{SWARM_DATA_DIR}}\`
2. Parse transcript, memory, and feedback drift.
3. Sort by the requested priority rule.

## Output
Write results to \`{{OUTPUT_ARTIFACT_PATH}}\`:
- \`Review Queue\` table
- \`Summary\` bullets
- \`Notable priority drivers\`

Do NOT read any session files.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 5. Feedback Telemetry Worker (programmatic-first)

Use for: Feedback-system reviews where you want structured signal without reading whole sessions manually.

\`\`\`
You are a feedback telemetry worker for Cortex.

## Task
Use scripts and structured outputs first.

1. Run one or more telemetry scripts as needed:
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-review-queue.js {{SWARM_DATA_DIR}}\`
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-session-digest.js {{SWARM_DATA_DIR}} --profile {{PROFILE_ID}} --session {{SESSION_ID}}\`
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-global-summary.js {{SWARM_DATA_DIR}}\`
2. Identify high-signal anomalies.
3. Only if needed, run targeted context extraction:
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-target-context.js {{SWARM_DATA_DIR}} --profile {{PROFILE_ID}} --session {{SESSION_ID}} --target {{TARGET_ID}}\`

## Output
Write markdown to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
1. \`Outcome: promote | no-op | follow-up-needed\`
2. \`Programmatic digest\`
3. \`Candidate Findings (JSON)\` containing the required normalized schema with:
   - \`profile: "{{PROFILE_ID}}"\`
   - \`session: "{{SESSION_ID}}"\`
   - \`source_kind: "feedback"\`
4. \`Data quality issues\`
5. \`Concise completion summary\`

Additional rules:
- Allow \`note\` when feedback reveals a plausible pattern but not a promotion-ready one.
- Treat explicit negative/positive feedback as stronger evidence than assistant narration.
- Never include secrets.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 6. Orchestration Kickoff Worker

Use for: Planning a review cycle from scan results.

\`\`\`
You are an orchestration planning worker for Cortex.

## Task
Given scan results, produce a concrete execution plan.

## Scan results
{{SCAN_RESULTS_OR_ARTIFACT_CONTENT}}

## Constraints
- Max concurrent workers: {{MAX_WORKERS | default: 5}}
- Use the current fast extraction default first.
- Prefer balanced fallback for reliability retries.
- Escalate to deep-synthesis model only for ambiguity/high-complexity work.

## Output
Write plan to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
- execution batches
- risk flags
- synthesis plan
- likely no-op targets vs likely promotion/note targets

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 7. Deep Audit Worker

Use for: Auditing knowledge files for stale entries, scope drift, contradictions, and bloat.

\`\`\`
You are a knowledge audit worker for Cortex.

## Task
Audit the listed knowledge files for quality and scope correctness.

## Files to audit
{{LIST_OF_FILES_TO_AUDIT}}

## Current file contents
{{PASTE_FILE_CONTENTS_HERE}}

## Output
Write audit results to \`{{OUTPUT_ARTIFACT_PATH}}\`.
For each issue include:
- **Entry**
- **Issue type**: stale | scope-drift | contradiction | vague | bloated | missing-link
- **Recommendation**: update | move | remove | sharpen | split-to-reference | demote-to-note
- **Detail**

End with:
- **Top priority fixes**: max 5 bullets
- **Concise completion summary**: 1-3 bullets Cortex could reuse

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 8. Prune / Retirement Worker

Use for: Identifying knowledge entries that should be retired or demoted from inject to reference/note.

\`\`\`
You are a knowledge pruning worker for Cortex.

## Task
Review the knowledge file below and identify entries that should be retired, demoted, archived, or sharpened.

## File to prune
Path: {{FILE_PATH}}
Contents:
{{FILE_CONTENTS}}

## Recent evidence
{{RECENT_EVIDENCE_SUMMARY_OR "No recent evidence provided."}}

## Output
Write recommendations to \`{{OUTPUT_ARTIFACT_PATH}}\`.
For each entry include:
- **Action**: retire | demote-to-reference | demote-to-note | archive | sharpen
- **Rationale**
- **Replacement text**: (if sharpen)

End with:
- **Concise completion summary**: 1-3 bullets Cortex could reuse

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 9. Migration / Reclassification Worker

Use for: Migrating legacy \`shared/knowledge/profiles/<profileId>.md\` content into the v2 structure.

\`\`\`
You are a knowledge migration worker for Cortex.

## Task
Reclassify the legacy profile knowledge file into \`note | inject | reference | discard\` outputs.

## Legacy file
Path: {{LEGACY_FILE_PATH}}
Contents:
{{LEGACY_FILE_CONTENTS}}

## Current v2 state
Profile memory (\`profiles/{{PROFILE_ID}}/memory.md\`):
{{PROFILE_MEMORY_CONTENTS_OR "Empty — not yet created."}}

Reference docs exist: {{REFERENCE_DOCS_LIST_OR "None yet."}}

## Output
Write migration recommendations to \`{{OUTPUT_ARTIFACT_PATH}}\` with sections:
- \`Outcome: promote | no-op | follow-up-needed\`
- \`Candidate Findings (JSON)\` using the required schema (\`source_kind\` may be \`doc\` in \`sources\`)
- \`Migration summary\`
- \`Concise completion summary\`

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## Usage Notes

- Cortex normally runs the bounded scan itself.
- Use template 1 for transcript deltas.
- Use template 2 when session memory drift exists.
- Use template 3 when 3+ workers need synthesis or when shard reconciliation is needed.
- Use template 4 only as fallback for delegated scan help.
- Use template 5 for feedback-specific analysis.
- Use template 6 for large review-cycle planning.
- Use template 7 periodically for quality audits.
- Use template 8 when injected knowledge grows stale or bloated.
- Use template 9 for legacy-profile-knowledge migration/reclassification.
- Every template requires the concise callback.
- Workers propose \`note | inject | reference | discard\`; Cortex validates before promotion.
- No-op is a first-class outcome. Clean closure beats noisy promotion.
`;

const CORTEX_WORKER_PROMPTS_VERSION_MARKER = "<!-- Cortex Worker Prompts Version: 4 -->";
const PREVIOUS_CORTEX_WORKER_PROMPTS_VERSION_MARKERS = ["<!-- Cortex Worker Prompts Version: 3 -->", "<!-- Cortex Worker Prompts Version: 2 -->"] as const;
const LEGACY_CORTEX_WORKER_PROMPTS_SIGNATURES = [
  "# Cortex Worker Prompt Templates",
  "Read the session file at \\`{{SESSION_JSONL_PATH}}\\` starting from byte offset {{BYTE_OFFSET}}",
  "Return your findings as a structured list.",
  "Workers report back via \\`worker_message\\`."
] as const;

const FORKED_SESSION_MEMORY_HEADER_TEMPLATE = [
  "# Session Memory",
  '> Forked from session "' + "$" + "{SOURCE_LABEL}" + '" (' + "$" + "{SOURCE_AGENT_ID}" + ") on " + "$" + "{FORK_TIMESTAMP}",
  "> " + "$" + "{FORK_HISTORY_NOTE}",
  ""
].join("\n");

const IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE = `⚠️ [IDLE WORKER WATCHDOG — BATCHED]

\${WORKER_COUNT} \${WORKER_WORD} went idle without reporting this turn.
Workers: \${WORKER_IDS}

Use list_agents({"verbose":true,"limit":50,"offset":0}) for a paged full list.`;
// Retain recent non-web activity while preserving the full user-facing web transcript.
// Integration services add ~2 event listeners per profile (Telegram conversation_message,
// Telegram session_lifecycle). Keep this limit above base listeners +
// (2 × expected maximum profiles).
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;
const PENDING_MANUAL_MANAGER_STOP_NOTICE_TTL_MS = 15_000;
const MODEL_CAPACITY_BLOCK_DEFAULT_MS = 10 * 60_000;
const CODEX_PLUGIN_RETRY_CONTEXT_TTL_MS = 2 * 60 * 60_000;
const CODEX_PLUGIN_RETRY_AUTHORIZATION_TTL_MS = 10 * 60_000;
const SESSION_ID_SUFFIX_SEPARATOR = "--s";
const ROOT_SESSION_NUMBER = 1;

export { ChoiceRequestCancelledError } from "./swarm-choice-service.js";

interface SessionRenameHistoryEntry {
  from: string;
  to: string;
  renamedAt: string;
}

interface ModelCapacityBlock {
  provider: string;
  modelId: string;
  blockedUntilMs: number;
  blockSetAt: string;
  sourcePhase: RuntimeErrorEvent["phase"];
  reason: string;
}

function getCortexWorkerPromptsBackupSuffix(content: string): ".v1.bak" | ".v2.bak" | ".v3.bak" | undefined {
  if (content.includes(CORTEX_WORKER_PROMPTS_VERSION_MARKER)) {
    return undefined;
  }

  for (const marker of PREVIOUS_CORTEX_WORKER_PROMPTS_VERSION_MARKERS) {
    if (content.includes(marker)) {
      return marker.includes("Version: 3") ? ".v3.bak" : ".v2.bak";
    }
  }

  if (LEGACY_CORTEX_WORKER_PROMPTS_SIGNATURES.every((signature) => content.includes(signature))) {
    return ".v1.bak";
  }

  return undefined;
}

function shouldUpgradeLegacyCortexWorkerPrompts(content: string): boolean {
  return getCortexWorkerPromptsBackupSuffix(content) !== undefined;
}

async function backupLegacyCortexWorkerPrompts(path: string, content: string): Promise<void> {
  const suffix = getCortexWorkerPromptsBackupSuffix(content);
  if (!suffix) {
    return;
  }

  try {
    await copyFile(path, `${path}${suffix}`);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST"
    ) {
      return;
    }

    throw error;
  }
}

function formatRuntimeErrorForCapacityClassification(error: RuntimeErrorEvent): string {
  const detailParts = [readStringDetail(error.details, "errorName"), readStringDetail(error.details, "errorCode")]
    .filter((value): value is string => !!value);
  return detailParts.length > 0 ? `${error.message} ${detailParts.join(" ")}` : error.message;
}

interface DescriptorStoreAdapter {
  loadStore: () => Promise<AgentsStoreFile>;
  saveStore: () => Promise<void>;
  transactionDescriptors: <T>(
    callback: (store: AgentDescriptorStore) => T | Promise<T>,
    options?: { saveMode?: "rollback" | "best-effort"; onSaveError?: (error: unknown) => void }
  ) => Promise<T>;
  persistBestEffort: () => Promise<void>;
  upsertDescriptor: (descriptor: AgentDescriptor) => Promise<void>;
  upsertDescriptorInLiveMaps: (descriptor: AgentDescriptor) => void;
  patchDescriptor: (
    agentId: string,
    patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor)
  ) => Promise<AgentDescriptor>;
  patchDescriptorInLiveMaps: (
    agentId: string,
    patch: Partial<AgentDescriptor> | ((descriptor: AgentDescriptor) => AgentDescriptor)
  ) => AgentDescriptor | undefined;
  deleteDescriptor: (agentId: string) => Promise<boolean>;
  deleteDescriptorInLiveMaps: (agentId: string) => boolean;
  upsertProfile: (profile: ManagerProfile) => Promise<void>;
  upsertProfileInLiveMaps: (profile: ManagerProfile) => void;
  patchProfile: (
    profileId: string,
    patch: Partial<ManagerProfile> | ((profile: ManagerProfile) => ManagerProfile)
  ) => Promise<ManagerProfile>;
  deleteProfile: (profileId: string) => Promise<boolean>;
  deleteProfileInLiveMaps: (profileId: string) => boolean;
}

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

export class SwarmManager extends EventEmitter implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly defaultModelPreset: SwarmModelPreset;

  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly profiles = new Map<string, ManagerProfile>();
  private readonly runtimeController: SwarmRuntimeController;
  private readonly runtimes: Map<string, SwarmAgentRuntime>;
  readonly runtimeCreationPromisesByAgentId: Map<string, Promise<SwarmAgentRuntime>>;
  readonly runtimeTokensByAgentId: Map<string, number>;
  private readonly runtimeRecoveryState = new RuntimeRecoveryState();
  private readonly modelChangeStartupRecoveryCoordinator: ModelChangeStartupRecoveryCoordinator;
  private readonly projectAgentMessageTimestampsBySender = new Map<string, number[]>();
  private readonly pendingProjectExecutableTrustPromptsByKey = new Set<string>();
  // Deferred trust activation state machine:
  // 1. A prompt answer writes trusted state to disk but keeps the pre-activation plan here.
  // 2. protectAllRuntimeCreations guards the short window before affected managers are marked,
  //    so racing runtime creation still sees the old untrusted executable policy.
  // 3. Once affected managers are marked, only those manager IDs and their workers stay on the
  //    pre-activation plan until the manager runtime recycle boundary invalidates workers and clears state.
  private readonly deferredProjectExecutableTrustActivationsByKey = new Map<string, {
    trustKey: string;
    preActivationPlan: ProjectExecutableTrustPlan;
    pendingManagerIds: Set<string>;
    protectAllRuntimeCreations: boolean;
  }>();
  private readonly pendingProjectExecutableTrustActivationByManagerId = new Map<string, string>();
  private readonly pendingProjectExecutableWorkerInvalidationByManagerId = new Map<string, string>();
  private readonly pendingManualManagerStopNoticeTimersByAgentId = new Map<string, NodeJS.Timeout>();
  private readonly pendingInboundTurnContextsByAgentId = new Map<string, PendingInboundTurnContext[]>();
  private readonly inboundTurnContextActivatedByAgentId = new Set<string>();
  // Inbound turn ids are minted when dispatch is accepted and cleared on rollback,
  // turn_end, agent_end, runtime error, or runtime detach. The first queued turn
  // owns activeTurn until a runtime event dequeues a later context; this is safe
  // because dispatch into a single agent runtime is ordered, while runtimeToken
  // prevents events from a replacement runtime from inheriting the old id.
  // Some queued contexts are id carriers only: they advance activeTurn for event
  // projection but intentionally do not participate in assistant-output routing.
  private readonly activeTurnByAgentId = new Map<string, ActiveTurnContext>();
  private readonly activeAssistantOutputTargetByManagerId = new Map<string, AssistantOutputTarget>();
  private readonly activeWebAssistantOutputTurnByManagerId = new Map<string, SessionTranscriptAssistantOutputTarget>();
  private readonly inheritedAssistantOutputTargetByWorkerId = new Map<string, AssistantOutputTarget>();
  private readonly pendingChoiceAssistantOutputContinuationByChoiceId = new Map<string, PendingChoiceAssistantOutputContinuation>();
  private readonly codexMcpToolTurnGateByManagerId = new Map<string, CodexMcpToolGateEvaluation>();
  private readonly activeCodexPluginDelegationByManagerId = new Map<string, CodexPluginDelegationTurnContext>();
  private readonly lastCodexPluginDelegationByManagerId = new Map<string, CodexPluginRetryContext>();
  private readonly activeCodexPluginRetryAuthorizationByManagerId = new Map<string, CodexPluginRetryAuthorizationContext>();
  private readonly stoppedCodexPluginWorkersById = new Set<string>();
  private readonly pendingCodexPluginSpawnByManagerId = new Map<string, PendingCodexPluginSpawnContext>();
  private readonly pendingCodexPluginSpawnByInput = new WeakMap<SpawnAgentInput, PendingCodexPluginSpawnContext>();
  private readonly pendingCodexPluginInitialTaskByWorkerId = new Map<string, string>();
  private readonly activeExternalProjectAgentTurnByAgentId = new Map<string, ExternalProjectAgentTurnContext>();
  private readonly activeObservabilityRootByAgentId = new Map<string, ActiveObservabilityRootContext>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly pinnedMessageIdsBySessionAgentId = new Map<string, Set<string>>();
  private pendingAgentsSnapshotEmit = false;
  private agentsSnapshotVersion = 0;
  private profilesSnapshotVersion = 0;
  private readonly workerHealthService: SwarmWorkerHealthService;
  private readonly specialistFallbackManager: SwarmSpecialistFallbackManager;
  private readonly modelCapacityBlocks = new Map<string, ModelCapacityBlock>();
  private readonly sidebarPerfRecorder: SidebarPerfRecorder;
  private readonly sessionActiveTools = new SessionActiveToolsState();
  private readonly conversationProjector: ConversationProjector;
  private readonly descriptorStore: AgentDescriptorStore;
  private readonly descriptorStoreAdapter: DescriptorStoreAdapter;
  private readonly persistenceService: PersistenceService;
  private readonly forgeExtensionHost: ForgeExtensionHost;
  private piModelsJsonPath: string | null = null;
  private readonly skillMetadataService: SkillMetadataService;
  private readonly skillFileService: SkillFileService;
  private readonly secretsEnvService: SecretsEnvService;
  private readonly sessionMetaService: SwarmSessionMetaService;
  private readonly cortexService: SwarmCortexService;
  private readonly memoryMergeService: SwarmMemoryMergeService;
  private readonly sessionProvisioner: SessionProvisioner;
  private readonly lifecycleService: SwarmAgentLifecycleService;
  private readonly settingsService: SwarmSettingsService;
  private readonly choiceService: SwarmChoiceService;
  private readonly promptService: SwarmPromptService;
  private readonly sessionService: SwarmSessionService;
  private readonly archiveLastUsedHydrator: ArchiveLastUsedHydrator;
  private readonly archiveService: ArchiveService;
  private readonly projectAgentService: SwarmProjectAgentService;
  private readonly projectAgentSharingService: ProjectAgentSharingService;
  readonly promptRegistry: PromptRegistry;
  private readonly codexAppServerService: CodexAppServerService;
  private readonly codexPluginScopeService: CodexPluginScopeService;

  private integrationContextProvider: ((profileId: string) => string) | undefined;
  private terminalArchiveHooks: {
    suspendProfileTerminals: (profileId: string) => Promise<unknown>;
    restoreProfileTerminals: (profileId: string) => Promise<unknown>;
  } | undefined;
  private readonly versioningService: VersioningMutationSink | undefined;
  private readonly observability: ObservabilityFacade | undefined;
  private specialistRegistryModulePromise: Promise<SpecialistRegistryModule> | null = null;
  private workPlansEnabled = false;
  private modelCacheVisualizationEnabled = false;
  private readonly liveCompactionRuntimeSettingsProvider: LiveCompactionRuntimeSettingsProvider;
  private compactionRuntimeSettingsProvider: CompactionRuntimeSettingsProvider;
  private compactionSettingsService: CompactionSettingsService | null = null;
  private readonly knowledgeV2SettingsService: KnowledgeV2SettingsService;
  private readonly knowledgeService: KnowledgeService;

  constructor(config: SwarmConfig, options?: SwarmManagerOptions) {
    super();

    this.defaultModelPreset =
      inferSwarmModelPresetFromDescriptor(config.defaultModel) ?? DEFAULT_SWARM_MODEL_PRESET;
    this.config = {
      ...config,
      defaultModel: resolveModelDescriptorFromPreset(this.defaultModelPreset)
    };
    this.now = options?.now ?? nowIso;
    this.versioningService = options?.versioningService;
    this.observability = options?.observability;
    this.liveCompactionRuntimeSettingsProvider = createLiveCompactionRuntimeSettingsProvider();
    this.compactionRuntimeSettingsProvider =
      options?.compactionRuntimeSettingsProvider ?? this.liveCompactionRuntimeSettingsProvider;
    this.knowledgeV2SettingsService =
      options?.knowledgeV2SettingsService ??
      new KnowledgeV2SettingsService({ dataDir: this.config.paths.dataDir });
    this.knowledgeService =
      options?.knowledgeService ??
      new KnowledgeService({
        dataDir: this.config.paths.dataDir,
        settingsService: this.knowledgeV2SettingsService,
        versioning: this.versioningService,
        now: () => new Date(this.now()),
      });
    const resourcesDir = this.config.paths.resourcesDir ?? this.config.paths.rootDir;
    this.promptRegistry = new FileBackedPromptRegistry({
      dataDir: this.config.paths.dataDir,
      repoDir: this.config.paths.rootDir,
      builtinArchetypesDir: join(resourcesDir, "apps", "backend", "src", "swarm", "archetypes", "builtins"),
      builtinOperationalDir: join(resourcesDir, "apps", "backend", "src", "swarm", "operational", "builtins"),
      versioning: this.versioningService
    });
    this.forgeExtensionHost = new ForgeExtensionHost({
      dataDir: this.config.paths.dataDir,
      now: this.now
    });
    this.sidebarPerfRecorder = createSidebarPerfRegistry({
      manifest: backendSidebarPerfMetricManifest
    });
    this.runtimeController = new SwarmRuntimeController(this as unknown as SwarmRuntimeControllerHost);
    this.modelChangeStartupRecoveryCoordinator = new ModelChangeStartupRecoveryCoordinator({
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      getEffectiveContextWindow: (modelId, provider) =>
        modelCatalogService.getEffectiveContextWindow(modelId, provider),
      hasPinnedContent: (agentId) => this.pinnedMessageIdsBySessionAgentId.has(agentId)
    });
    this.runtimes = this.runtimeController.runtimes;
    this.runtimeCreationPromisesByAgentId = this.runtimeController.runtimeCreationPromisesByAgentId;
    this.runtimeTokensByAgentId = this.runtimeController.runtimeTokensByAgentId;
    this.workerHealthService = new SwarmWorkerHealthService({
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      now: this.now,
      getConversationHistory: (agentId) => this.getConversationHistory(agentId),
      sendMessage: (fromAgentId, targetAgentId, message, delivery, sendOptions) =>
        this.sendMessage(fromAgentId, targetAgentId, message, delivery, sendOptions),
      publishToUser: (agentId, text, source) => this.publishToUser(agentId, text, source),
      terminateDescriptor: (descriptor, terminateOptions) => this.terminateDescriptor(descriptor, terminateOptions),
      saveStore: () => this.saveStore(),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
        this.resolvePromptWithFallback(category, promptId, profileId, fallback),
      isRuntimeInContextRecovery: (agentId) => this.isRuntimeInContextRecovery(agentId),
      isRuntimeRecoveryActive: (agentId) => this.isRuntimeRecoveryActive(agentId),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.specialistFallbackManager = new SwarmSpecialistFallbackManager({
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      getRuntime: (agentId) => this.runtimeController.getRuntime(agentId),
      isRuntime: (agentId, runtime) => this.runtimeController.isRuntime(agentId, runtime),
      getRuntimeToken: (agentId) => this.runtimeController.getRuntimeToken(agentId),
      clearRuntimeToken: (agentId, runtimeToken) => this.runtimeController.clearRuntimeToken(agentId, runtimeToken),
      restoreRuntimeTokenForFallbackRollback: (agentId, runtimeToken) =>
        this.runtimeController.restoreRuntimeTokenForFallbackRollback(agentId, runtimeToken),
      getRuntimeCreationPromise: (agentId) => this.runtimeController.getRuntimeCreationPromise(agentId),
      setRuntimeCreationPromise: (agentId, promise) =>
        this.runtimeController.setRuntimeCreationPromise(agentId, promise),
      clearRuntimeCreationPromiseIfCurrent: (agentId, promise) =>
        this.runtimeController.clearRuntimeCreationPromiseIfCurrent(agentId, promise),
      workerHealthService: this.workerHealthService,
      now: this.now,
      resolveSpecialistRosterForProfile: (profileId, targetSpace) => this.resolveSpecialistRosterForProfile(profileId, targetSpace),
      resolveSpecialistRosterForManager: (manager, targetSpace) => this.resolveSpecialistRosterForManager(manager, targetSpace),
      resolveSpawnModelWithCapacityFallback: (model) => this.resolveSpawnModelWithCapacityFallback(model),
      resolveSystemPromptForDescriptor: (descriptor) => this.resolveSystemPromptForDescriptor(descriptor),
      injectWorkerIdentityContext: (descriptor, systemPrompt) =>
        this.injectWorkerIdentityContext(descriptor, systemPrompt),
      createRuntimeForDescriptor: (descriptor, systemPrompt, runtimeToken, options) =>
        this.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options),
      attachRuntime: (agentId, runtime) => {
        this.runtimeController.attachRuntime(agentId, runtime);
      },
      detachRuntime: (agentId, runtimeToken) => this.runtimeController.detachRuntime(agentId, runtimeToken),
      detachRuntimeIfMatches: (agentId, runtime, runtimeToken) =>
        this.runtimeController.detachRuntimeIfMatches(agentId, runtime, runtimeToken),
      updateSessionMetaForWorkerDescriptor: (descriptor, resolvedSystemPrompt) =>
        this.updateSessionMetaForWorkerDescriptor(descriptor, resolvedSystemPrompt ?? undefined),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) => this.refreshSessionMetaStatsBySessionId(sessionAgentId),
      saveStore: () => this.saveStore(),
      patchDescriptor: (agentId, patch, options) =>
        this.descriptorStoreAdapter.transactionDescriptors((store) => store.patchDescriptor(agentId, patch), options),
      patchDescriptorInLiveMaps: (agentId, patch) => this.descriptorStoreAdapter.patchDescriptorInLiveMaps(agentId, patch),
      emitStatus: (agentId, status, pendingCount, contextUsage) =>
        this.emitStatus(agentId, status, pendingCount, contextUsage),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      clearTrackedToolPaths: (agentId) => {
        this.runtimeController.clearTrackedToolPaths(agentId);
      },
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.runtimeController.setSpecialistFallbackManager(this.specialistFallbackManager);
    this.descriptorStore = new AgentDescriptorStore({
      dataDir: this.config.paths.dataDir,
      storeFilePath: this.config.paths.agentsStoreFile,
      configuredManagerId: this.getConfiguredManagerId(),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.descriptorStoreAdapter = this.createDescriptorStoreAdapter();
    this.persistenceService = new PersistenceService({
      config: this.config,
      descriptors: this.descriptors,
      sortedDescriptors: () => this.sortedDescriptors(),
      sortedProfiles: () => this.sortedProfiles(),
      getConfiguredManagerId: () => this.getConfiguredManagerId(),
      resolveMemoryOwnerAgentId: (descriptor) => this.resolveMemoryOwnerAgentId(descriptor),
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
          this.emitSessionActiveToolsSnapshot(this.sessionActiveTools.recordToolCall(payload));
        }
      },
      logDebug: (message, details) => this.logDebug(message, details),
      perf: this.sidebarPerfRecorder,
      getPinnedMessageIds: (agentId) => this.pinnedMessageIdsBySessionAgentId.get(agentId)
    });
    this.codexAppServerService =
      options?.codexAppServerService ??
      new CodexAppServerService(this.createCodexSidecarHost(), {
        dataDir: this.config.paths.dataDir,
        ...options?.codexAppServerServiceOptions,
      });
    this.codexPluginScopeService = new CodexPluginScopeService({
      catalog: {
        listCatalog: () => this.codexAppServerService.listCodexMcpTools(),
        resolvePlugin: (selector, catalog) =>
          this.codexAppServerService.resolveCodexPluginInCatalog(selector, catalog),
        resolveTool: (selector, catalog) =>
          this.codexAppServerService.resolveCodexMcpToolInCatalog(selector, catalog),
        filterToolsForAuthorizedSelectors: (catalog, authorizedSelectors) =>
          this.codexAppServerService.filterCodexMcpToolsForAuthorizedSelectors(
            catalog,
            authorizedSelectors,
          ),
      },
    });
    this.skillMetadataService = new SkillMetadataService({
      config: this.config
    });
    this.skillFileService = new SkillFileService();
    this.secretsEnvService = new SecretsEnvService({
      config: this.config,
      ensureSkillMetadataLoaded: () => this.skillMetadataService.ensureSkillMetadataLoaded(),
      getSkillMetadata: () => this.skillMetadataService.getSkillMetadata()
    });
    this.sessionMetaService = new SwarmSessionMetaService({
      dataDir: this.config.paths.dataDir,
      agentsStoreFile: this.config.paths.agentsStoreFile,
      descriptors: this.descriptors,
      getSortedDescriptors: () => this.sortedDescriptors(),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      ensureSkillMetadataLoaded: () => this.skillMetadataService.ensureSkillMetadataLoaded(),
      getAdditionalSkillPaths: () => this.skillMetadataService.getAdditionalSkillPaths(),
      getAgentMemoryPath: (agentId) => this.getAgentMemoryPath(agentId),
      resolveSystemPromptForDescriptor: (descriptor) => this.resolveSystemPromptForDescriptor(descriptor)
    });
    this.cortexService = new SwarmCortexService({
      config: this.config,
      now: this.now,
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      getWorkersForManager: (managerId) => this.getWorkersForManager(managerId),
      getConversationHistory: (agentId) => this.getConversationHistory(agentId),
      createSession: (profileId, options) => this.createSession(profileId, options),
      handleUserMessage: (text, options) => this.handleUserMessage(text, options),
      ensureCortexProfile: () => this.ensureCortexProfile(),
      sendMessage: (fromAgentId, targetAgentId, message, delivery, options) =>
        this.sendMessage(fromAgentId, targetAgentId, message, delivery, options),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.memoryMergeService = new SwarmMemoryMergeService({
      config: this.config,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      getRequiredSessionDescriptor: (agentId) => this.getRequiredSessionDescriptor(agentId),
      upsertDescriptor: (descriptor) => this.descriptorStoreAdapter.upsertDescriptor(descriptor),
      getAgentMemoryPath: (agentId) => this.getAgentMemoryPath(agentId),
      resolvePreferredManagerId: (options) => this.resolvePreferredManagerId(options),
      resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
        this.resolvePromptWithFallback(category, promptId, profileId, fallback),
      ensureMemoryFilesForBoot: (options) => this.persistenceService.ensureMemoryFilesForBoot(options),
      ensureAgentMemoryFileInPersistence: (memoryFilePath, memoryTemplateContent) =>
        this.persistenceService.ensureAgentMemoryFile(memoryFilePath, memoryTemplateContent),
      readSessionMetaForDescriptor: (descriptor) => this.readSessionMetaForDescriptor(descriptor),
      writeSessionMemoryMergeAttemptMeta: (descriptor, attempt) =>
        this.writeSessionMemoryMergeAttemptMeta(descriptor, attempt),
      recordSessionMemoryMergeAttempt: (descriptor, attempt) =>
        this.recordSessionMemoryMergeAttempt(descriptor, attempt),
      appendSessionMemoryMergeAuditEntry: (entry) => this.appendSessionMemoryMergeAuditEntry(entry),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) =>
        this.refreshSessionMetaStatsBySessionId(sessionAgentId),
      queueVersioningMutation: (mutation) => {
        this.queueVersioningMutation(mutation);
      },
      resolveActiveCortexReviewRunIdForDescriptor: (descriptor) =>
        this.cortexService.resolveActiveReviewRunIdForDescriptor(descriptor),
      saveStore: async () => {
        await this.saveStore();
      },
      runSessionMemoryLLMMerge: (descriptor, profileMemoryContent, sessionMemoryContent) =>
        this.executeSessionMemoryLLMMerge(descriptor, profileMemoryContent, sessionMemoryContent),
      getPiModelsJsonPath: () => this.getPiModelsJsonPathOrThrow()
    });
    this.sessionProvisioner = new SessionProvisioner({
      dataDir: this.config.paths.dataDir,
      descriptorMutations: {
        upsertDescriptor: (descriptor) => {
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
        },
        deleteDescriptor: (agentId) => {
          this.descriptorStoreAdapter.deleteDescriptorInLiveMaps(agentId);
        },
        upsertProfile: (profile) => {
          this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile);
        },
        deleteProfile: (profileId) => {
          this.descriptorStoreAdapter.deleteProfileInLiveMaps(profileId);
        }
      },
      runtimes: this.runtimes,
      pinnedMessageIdsBySessionAgentId: this.pinnedMessageIdsBySessionAgentId,
      conversationProjector: this.conversationProjector,
      ensureProfilePiDirectories: (profileId) => this.ensureProfilePiDirectories(profileId),
      ensureSessionFileParentDirectory: (sessionFile) => this.ensureSessionFileParentDirectory(sessionFile),
      ensureAgentMemoryFile: (memoryFilePath, profileId) => this.ensureAgentMemoryFile(memoryFilePath, profileId),
      getAgentMemoryPath: (agentId) => this.getAgentMemoryPath(agentId),
      writeInitialSessionMeta: (descriptor) => this.writeInitialSessionMeta(descriptor),
      runRuntimeShutdown: (descriptor, action, options) => this.runRuntimeShutdown(descriptor, action, options),
      detachRuntime: (agentId, runtimeToken) => this.detachRuntime(agentId, runtimeToken),
      deleteManagerSessionFile: (sessionFile) => this.deleteManagerSessionFile(sessionFile),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.settingsService = new SwarmSettingsService({
      config: this.config,
      profiles: this.profiles,
      skillMetadataService: this.skillMetadataService,
      skillFileService: this.skillFileService,
      secretsEnvService: this.secretsEnvService,
      getSessionsForProfile: (profileId) => this.getBuilderSessionsForProfile(profileId) as Array<AgentDescriptor & { role: "manager"; profileId: string }>,
      getAllManagerSessions: () => Array.from(this.descriptors.values()).filter(
        (descriptor): descriptor is AgentDescriptor & { role: "manager"; profileId: string } =>
          descriptor.role === "manager" && typeof descriptor.profileId === "string"
      ),
      getSessionById: (agentId) => {
        const descriptor = this.descriptors.get(agentId);
        if (!descriptor || descriptor.role !== "manager" || !descriptor.profileId) {
          return undefined;
        }

        return descriptor as AgentDescriptor & { role: "manager"; profileId: string };
      },
      resolveAndValidateCwd: (cwd) => this.resolveAndValidateCwd(cwd),
      assertCanChangeManagerCwd: (profileId, sessions) => this.assertCanChangeManagerCwd(profileId, sessions),
      applyManagerRuntimeRecyclePolicy: (agentId, reason) => this.applyManagerRuntimeRecyclePolicy(agentId, reason),
      now: this.now,
      transactionDescriptors: (callback) => this.descriptorStoreAdapter.transactionDescriptors(callback),
      saveStore: async () => {
        await this.saveStore();
      },
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      emitProfilesSnapshot: () => {
        this.emitProfilesSnapshot();
      },
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.choiceService = new SwarmChoiceService({
      now: this.now,
      getDescriptor: (agentId) => this.descriptors.get(agentId),
      emitChoiceRequest: (event) => {
        this.emitChoiceRequest(event);
      },
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      }
    });
    this.promptService = new SwarmPromptService({
      config: this.config,
      descriptors: this.descriptors,
      profiles: this.profiles,
      promptRegistry: this.promptRegistry,
      skillMetadataService: this.skillMetadataService,
      getAgentMemoryPath: (agentId) => this.getAgentMemoryPath(agentId),
      ensureAgentMemoryFile: (memoryFilePath, profileId) =>
        this.ensureAgentMemoryFile(memoryFilePath, profileId),
      resolveMemoryOwnerAgentId: (descriptor) => this.resolveMemoryOwnerAgentId(descriptor),
      resolveSessionProfileId: (memoryOwnerAgentId) => this.resolveSessionProfileId(memoryOwnerAgentId),
      refreshSessionMetaStats: (descriptor) => this.refreshSessionMetaStats(descriptor),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) =>
        this.refreshSessionMetaStatsBySessionId(sessionAgentId),
      getSessionsForProfile: (profileId) => this.getBuilderSessionsForProfile(profileId),
      getExternalProjectAgentDirectoryEntries: (profileId) =>
        this.getSourceAwareExternalProjectAgentDirectoryEntries(profileId),
      loadSpecialistRegistryModule: () => this.loadSpecialistRegistryModule(),
      resolveSpecialistRosterForManager: (manager, targetSpace) => this.resolveSpecialistRosterForManager(manager, targetSpace),
      resolveSkillRosterForDescriptor: (descriptor) => this.resolveSkillRosterForDescriptor(descriptor),
      getWorkPlansEnabled: () => this.isWorkPlansEnabled(),
      getIntegrationContext: (profileId) => this.integrationContextProvider?.(profileId),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.lifecycleService = new SwarmAgentLifecycleService({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      profiles: this.profiles,
      runtimes: this.runtimes,
      getRuntime: (agentId) => this.runtimeController.getRuntime(agentId),
      getRuntimeCreationPromise: (agentId) => this.runtimeController.getRuntimeCreationPromise(agentId),
      setRuntimeCreationPromise: (agentId, promise) =>
        this.runtimeController.setRuntimeCreationPromise(agentId, promise),
      clearRuntimeCreationPromiseIfCurrent: (agentId, promise) =>
        this.runtimeController.clearRuntimeCreationPromiseIfCurrent(agentId, promise),
      runtimeRecoveryState: this.runtimeRecoveryState,
      modelCapacityBlocks: this.modelCapacityBlocks,
      sessionProvisioner: this.sessionProvisioner,
      descriptorMutations: {
        upsertDescriptor: (descriptor) => {
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
        },
        deleteDescriptor: (agentId) => {
          this.descriptorStoreAdapter.deleteDescriptorInLiveMaps(agentId);
        },
        upsertProfile: (profile) => {
          this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile);
        },
        deleteProfile: (profileId) => {
          this.descriptorStoreAdapter.deleteProfileInLiveMaps(profileId);
        }
      },
      now: this.now,
      getRequiredSessionDescriptor: (agentId) => this.getRequiredSessionDescriptor(agentId),
      assertManager: (agentId, action) => this.assertManager(agentId, action),
      hasRunningManagers: (options) => this.hasRunningManagers(options),
      generateUniqueAgentId: (source) => this.generateUniqueAgentId(source),
      generateUniqueManagerId: (source) => this.generateUniqueManagerId(source),
      resolveAndValidateCwd: (cwd) => this.resolveAndValidateCwd(cwd),
      resolveDefaultModelDescriptor: () => this.resolveDefaultModelDescriptor(),
      getManagedModelProviderAvailability: () => getManagedModelProviderCredentialAvailability(this.config, {
        credentialPoolService: this.secretsEnvService.getCredentialPoolService(),
      }),
      resolveSpawnWorkerArchetypeId: (input, normalizedAgentId, profileId) =>
        this.resolveSpawnWorkerArchetypeId(input, normalizedAgentId, profileId),
      resolveSpecialistRosterForProfile: (profileId, targetSpace) => this.resolveSpecialistRosterForProfile(profileId, targetSpace),
      resolveSpecialistRosterForManager: (manager, targetSpace) => this.resolveSpecialistRosterForManager(manager, targetSpace),
      normalizeSpecialistHandle: async (value) => {
        const specialistModule = await this.loadSpecialistRegistryModule();
        return specialistModule.normalizeSpecialistHandle(value) || undefined;
      },
      resolveSystemPromptForDescriptor: (descriptor) => this.resolveSystemPromptForDescriptor(descriptor),
      injectWorkerIdentityContext: (descriptor, systemPrompt) =>
        this.injectWorkerIdentityContext(descriptor, systemPrompt),
      createRuntimeForDescriptor: (descriptor, systemPrompt, runtimeToken, options) =>
        this.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options),
      allocateRuntimeToken: (agentId) => this.allocateRuntimeToken(agentId),
      clearRuntimeToken: (agentId, runtimeToken) => this.clearRuntimeToken(agentId, runtimeToken),
      getRuntimeToken: (agentId) => this.runtimeController.getRuntimeToken(agentId),
      ensureSessionFileParentDirectory: (sessionFile) => this.ensureSessionFileParentDirectory(sessionFile),
      updateSessionMetaForWorkerDescriptor: (descriptor, resolvedSystemPrompt) =>
        this.updateSessionMetaForWorkerDescriptor(descriptor, resolvedSystemPrompt),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) => this.refreshSessionMetaStatsBySessionId(sessionAgentId),
      refreshSessionMetaStats: (descriptor) => this.refreshSessionMetaStats(descriptor),
      captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
        this.captureSessionRuntimePromptMeta(descriptor, resolvedSystemPrompt),
      prepareManagerRuntimeCreation: (descriptor, systemPrompt) =>
        this.modelChangeStartupRecoveryCoordinator.prepareManagerRuntimeCreation(descriptor, systemPrompt),
      appendAppliedModelChangeContinuity: (descriptor, request, runtime) =>
        this.modelChangeStartupRecoveryCoordinator.appendAppliedModelChangeContinuity(descriptor, request, runtime),
      attachRuntime: (agentId, runtime) => {
        this.runtimeController.attachRuntime(agentId, runtime);
      },
      saveStore: async () => {
        await this.saveStore();
      },
      emitStatus: (agentId, status, pendingCount, contextUsage) =>
        this.emitStatus(agentId, status, pendingCount, contextUsage),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      emitProfilesSnapshot: () => {
        this.emitProfilesSnapshot();
      },
      logDebug: (message, details) => this.logDebug(message, details),
      seedWorkerCompletionReportTimestamp: (agentId) => this.seedWorkerCompletionReportTimestamp(agentId),
      clearWatchdogState: (agentId) => {
        this.clearWatchdogState(agentId);
      },
      deleteWorkerStallState: (agentId) => {
        this.workerHealthService.deleteWorkerStallState(agentId);
      },
      deleteWorkerActivityState: (agentId) => {
        this.workerHealthService.deleteWorkerActivityState(agentId);
      },
      deleteWorkerCompletionReportState: (agentId) => {
        this.workerHealthService.deleteWorkerCompletionReportState(agentId);
      },
      clearTrackedToolPaths: (agentId) => {
        this.runtimeController.clearTrackedToolPaths(agentId);
      },
      suppressIntentionalStopRuntimeCallbacks: (agentId, runtimeToken) => {
        this.runtimeController.suppressIntentionalStopRuntimeCallbacks(agentId, runtimeToken);
      },
      clearIntentionalStopRuntimeCallbackSuppression: (agentId, runtimeToken) => {
        this.runtimeController.clearIntentionalStopRuntimeCallbackSuppression(agentId, runtimeToken);
      },
      allowInvalidatedManualStopMessageEnd: (agentId, runtimeToken) => {
        this.runtimeController.allowInvalidatedManualStopMessageEnd(agentId, runtimeToken);
      },
      markPendingManualManagerStopNotice: (agentId) => this.markPendingManualManagerStopNotice(agentId),
      emitImmediateManualManagerStopNotice: (agentId) => this.emitImmediateManualManagerStopNotice(agentId),
      cancelAllPendingChoicesForAgent: (agentId) => {
        this.cancelAllPendingChoicesForAgent(agentId);
      },
      runRuntimeShutdown: (descriptor, action, options) => this.runRuntimeShutdown(descriptor, action, options),
      detachRuntime: (agentId, runtimeToken) => this.detachRuntime(agentId, runtimeToken),
      detachRuntimeIfMatches: (agentId, runtime, runtimeToken) =>
        this.runtimeController.detachRuntimeIfMatches(agentId, runtime, runtimeToken),
      syncPinnedContentForManagerRuntime: async (descriptor, options) => {
        await this.syncPinnedContentForManagerRuntime(descriptor, options);
      },
      transitionSessionWorkPlansForManualStop: async (descriptor) => {
        await this.transitionSessionWorkPlansForLifecycle(descriptor, "manual_stop");
      },
      interruptExternalThreadSidecarTurn:
        options?.interruptExternalThreadSidecarTurn ??
        ((agentId) => this.codexAppServerService.interruptTurn(agentId)),
      terminateExternalThreadSidecarTurn:
        options?.terminateExternalThreadSidecarTurn ??
        ((agentId) => this.codexAppServerService.cleanupSidecarTurnStateForTermination(agentId)),
      sendMessage: (fromAgentId, targetAgentId, message, delivery, options) =>
        this.sendMessage(fromAgentId, targetAgentId, message, delivery, options),
      sendManagerBootstrapMessage: (managerId) => this.sendManagerBootstrapMessage(managerId),
      materializeSortOrder: () => {
        this.materializeSortOrder();
      },
      getSessionsForProfile: (profileId) =>
        this.getSessionsForProfile(profileId) as Array<AgentDescriptor & { role: "manager"; profileId: string }>,
      getWorkersForManager: (managerId) => this.getWorkersForManager(managerId),
      deleteConversationHistory: (agentId, sessionFile) => {
        this.conversationProjector.deleteConversationHistory(agentId, sessionFile);
      },
      deleteManagerSchedulesFile: (profileId) => this.deleteManagerSchedulesFile(profileId),
      migrateLegacyProfileKnowledgeToReferenceDoc: async (profileId) => {
        await migrateLegacyProfileKnowledgeToReferenceDoc(this.config.paths.dataDir, profileId, {
          versioning: this.versioningService
        });
      },
      prepareWorkerDescriptorForSpawn: async ({ descriptor, specialistId, input }) => {
        if (specialistId !== CODEX_PLUGIN_SPECIALIST_ID) {
          return;
        }

        const pending = this.pendingCodexPluginSpawnByInput.get(input) ??
          this.pendingCodexPluginSpawnByManagerId.get(descriptor.managerId);
        if (!pending) {
          return;
        }

        const materialized = await this.codexPluginScopeService.materializePendingScope({
          managerAgentId: descriptor.managerId,
          workerAgentId: descriptor.agentId,
          delegationId: pending.delegationId,
          selectors: pending.activeContext.selectors,
        });
        pending.materializedWorkerAgentIds.add(descriptor.agentId);
        this.codexPluginScopeService.closeScopesForManager(descriptor.managerId, {
          exceptWorkerAgentId: descriptor.agentId,
        });

        descriptor.displayName = CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME;
        descriptor.internalWorkerKind = CODEX_PLUGIN_INTERNAL_WORKER_KIND;
        descriptor.specialistId = CODEX_PLUGIN_SPECIALIST_ID;
        descriptor.specialistDisplayName = CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME;
        descriptor.specialistColor = CODEX_PLUGIN_SPECIALIST_COLOR;

        this.pendingCodexPluginInitialTaskByWorkerId.set(
          descriptor.agentId,
          buildCodexPluginInitialTask({
            managerAgentId: descriptor.managerId,
            task: pending.task,
            userMessage: pending.activeContext.originalText,
            strippedRequest: pending.activeContext.strippedText,
            selectors: pending.activeContext.selectors,
            allowedTools: materialized.scope.allowedTools,
          }),
        );
      },
    });
    this.archiveLastUsedHydrator = new ArchiveLastUsedHydrator({
      getAgent: (agentId) => this.descriptors.get(agentId),
      listSessions: () => this.sortedDescriptors().filter((descriptor) => descriptor.role === "manager"),
      listAgents: () => this.sortedDescriptors(),
      listProfiles: () => this.listProfiles(),
      patchDescriptor: (agentId, patch) => this.descriptorStoreAdapter.patchDescriptor(agentId, patch),
      warn: (message, details) => this.logDebug(message, details),
    });
    this.archiveService = new ArchiveService({
      now: this.now,
      getAgent: (agentId) => this.descriptors.get(agentId),
      getProfile: (profileId) => this.profiles.get(profileId),
      listSessions: () => this.sortedDescriptors().filter((descriptor) => descriptor.role === "manager"),
      patchDescriptor: (agentId, patch) => this.descriptorStoreAdapter.patchDescriptor(agentId, patch),
      patchProfile: (profileId, patch) => this.descriptorStoreAdapter.patchProfile(profileId, patch),
      stopSessionForArchive: (agentId) =>
        this.stopSessionInternal(agentId, {
          saveStore: true,
          emitSnapshots: true,
          manualStopNotice: false,
          taskLifecycle: "none",
        }),
      transitionSessionWorkPlansForArchive: async (session) => {
        await this.transitionSessionWorkPlansForLifecycle(
          session as AgentDescriptor & { role: "manager"; profileId: string },
          "archived"
        );
      },
      hydrateSessionLastUsed: async (agentId) => {
        await this.archiveLastUsedHydrator.hydrateSessionIfMissing(agentId);
      },
      hydrateProfileLastUsed: async (profileId) => {
        await this.archiveLastUsedHydrator.hydrateProfileSessionsIfMissing(profileId);
      },
      onProfileArchiveStopError: (agentId, error) => {
        this.logDebug("archive:profile_stop_session:error", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.sessionService = new SwarmSessionService({
      profiles: this.profiles,
      runtimes: this.runtimes,
      provisioner: this.sessionProvisioner,
      prepareSessionCreation: (profileId, options) => this.prepareSessionCreation(profileId, options),
      prepareSessionCreationFromBase: (profileId, base, options) =>
        this.prepareSessionCreationFromBase(profileId, base, options),
      getRequiredSessionDescriptor: (agentId) => this.getRequiredSessionDescriptor(agentId),
      getOrCreateRuntimeForDescriptor: (descriptor) => this.getOrCreateRuntimeForDescriptor(descriptor),
      stopSessionInternal: (agentId, options) => this.stopSessionInternal(agentId, options),
      assertSessionIsDeletable: (descriptor) => this.assertSessionIsDeletable(descriptor),
      saveStore: async () => {
        await this.saveStore();
      },
      writeInitialSessionMeta: (descriptor) => this.writeInitialSessionMeta(descriptor),
      deleteProjectAgentRecord: (profileId, handle) =>
        deleteProjectAgentRecord(this.config.paths.dataDir, profileId, handle),
      notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
      emitSessionLifecycle: (event) => {
        this.emitSessionLifecycle(event);
      },
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      emitProfilesSnapshot: () => {
        this.emitProfilesSnapshot();
      },
      emitConversationReset: (agentId, source) => {
        this.emitConversationReset(agentId, source as "api_reset");
      },
      injectAgentCreatorContext: (agentId, profileId) => this.injectAgentCreatorContext(agentId, profileId),
      cancelAllPendingChoicesForAgent: (agentId) => {
        this.cancelAllPendingChoicesForAgent(agentId);
      },
      getSessionDirForDescriptor: (descriptor) => this.getSessionDirForDescriptor(descriptor),
      syncPinnedContentForManagerRuntime: async (descriptor, options) => {
        await this.syncPinnedContentForManagerRuntime(descriptor, options);
      },
      resetConversationHistory: (agentId) => {
        this.conversationProjector.resetConversationHistory(agentId);
      },
      captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
        this.captureSessionRuntimePromptMeta(descriptor, resolvedSystemPrompt),
      appendSessionRenameHistoryEntry: (descriptor, entry) => this.appendSessionRenameHistoryEntry(descriptor, entry),
      clearSessionWorkPlans: async (descriptor) => {
        await this.transitionSessionWorkPlansForLifecycle(descriptor, "conversation_cleared");
      },
      copySessionHistoryForFork: (sourceSessionFile, targetSessionFile, fromMessageId) =>
        copySessionHistoryForFork({
          sourceSessionFile,
          targetSessionFile,
          fromMessageId,
          omittedCustomTypes: [
            CLAUDE_RUNTIME_STATE_ENTRY_TYPE,
            CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE,
            CURSOR_SDK_USAGE_ENTRY_TYPE
          ]
        }),
      copySessionWorkPlansForFork: async (sourceDescriptor, forkedDescriptor, fromMessageId) => {
        await this.copySessionWorkPlansForFork(sourceDescriptor, forkedDescriptor, fromMessageId);
      },
      copyPinnedMessagesForFork: (sourceDescriptor, forkedDescriptor) =>
        this.copyPinnedMessagesForFork(sourceDescriptor, forkedDescriptor),
      writeForkedSessionMemoryHeader: (sourceDescriptor, forkedSessionAgentId, fromMessageId) =>
        this.writeForkedSessionMemoryHeader(sourceDescriptor, forkedSessionAgentId, fromMessageId),
      logDebug: (message, details) => this.logDebug(message, details),
      now: this.now
    });
    this.projectAgentService = new SwarmProjectAgentService({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      provisioner: this.sessionProvisioner,
      now: this.now,
      prepareSessionCreation: (profileId, options) => this.prepareSessionCreation(profileId, options),
      getRequiredSessionDescriptor: (agentId) => this.getRequiredSessionDescriptor(agentId),
      assertSessionSupportsProjectAgent: (descriptor) => this.assertSessionSupportsProjectAgent(descriptor),
      getOrCreateRuntimeForDescriptor: (descriptor) => this.getOrCreateRuntimeForDescriptor(descriptor),
      upsertDescriptorInLiveMaps: (descriptor) => this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor),
      captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
        this.captureSessionRuntimePromptMeta(descriptor, resolvedSystemPrompt),
      saveStore: async () => {
        await this.saveStore();
      },
      emitSessionLifecycle: (event) => {
        this.emitSessionLifecycle(event);
      },
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      emitProfilesSnapshot: () => {
        this.emitProfilesSnapshot();
      },
      emitSessionProjectAgentUpdated: (agentId, profileId, projectAgent) => {
        this.emitSessionProjectAgentUpdated(agentId, profileId, projectAgent);
      },
      notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.projectAgentSharingService = new ProjectAgentSharingService({
      dataDir: this.config.paths.dataDir,
      now: this.now,
      getProfiles: () => this.listProfiles(),
      getDescriptor: (agentId) => this.descriptors.get(agentId),
      getDescriptors: () => this.descriptors.values(),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.setMaxListeners(SWARM_MANAGER_MAX_EVENT_LISTENERS);
  }

  async boot(): Promise<void> {
    this.logDebug("boot:start", {
      host: this.config.host,
      port: this.config.port,
      authFile: this.config.paths.sharedAuthFile,
      managerId: this.config.managerId
    });

    await this.ensureDirectories();
    await migrateSharedConfigLayout(this.config.paths.dataDir);
    await cleanupOldSharedConfigPaths(this.config.paths.dataDir);
    await ensureCanonicalAuthFilePath(this.config);
    await this.reloadModelCatalogOverridesAndProjection();
    await this.loadSecretsStore();
    await this.ensureCompactionSettingsLoadedForRuntime();
    await this.reloadSkillMetadata();

    try {
      this.config.defaultCwd = await this.resolveAndValidateCwd(this.config.defaultCwd);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid default working directory: ${error.message}`);
      }
      throw error;
    }

    await this.refreshDefaultMemoryTemplateNormalizedLines();

    await new BootReconciler({
      config: this.config,
      descriptors: this.descriptors,
      profiles: this.profiles,
      loadStore: () => this.loadStore(),
      saveStore: () => this.saveStore(),
      prunePersistedCortexStateForBoot: (store) => this.prunePersistedCortexStateForBoot(store),
      prunePersistedWorkerSidecarDescriptorsForBoot: (store) => this.prunePersistedWorkerSidecarDescriptorsForBoot(store),
      preloadPinnedMessageIndexes: () => this.preloadPinnedMessageIndexes(),
      reconcileProfilesOnBoot: () => this.reconcileProfilesOnBoot(),
      normalizeSystemProfileTypes: () => this.normalizeSystemProfileTypes(),
      logDebug: (message, details) => this.logDebug(message, details)
    }).loadAndReconcilePersistedStore();
    const migratedCodexPluginWorkers = this.normalizeCodexPluginWorkersForVisibleSpecialistBoot();
    if (migratedCodexPluginWorkers) {
      await this.saveStore();
    }
    await this.ensureCortexProfile();
    await loadOnboardingState(this.config.paths.dataDir);
    await this.ensureLegacyProfileKnowledgeReferenceDocs();
    // IMPORTANT: reconcileInterruptedCortexReviewRunsForBoot MUST precede
    // normalizeStreamingStatusesForBoot — reconciliation relies on descriptors
    // still having status "streaming" to detect interrupted review runs.
    // Reordering these calls will silently break interrupted-run detection.
    await this.cortexService.reconcileInterruptedReviewRunsForBoot();
    const interruptedStreamingAgentIds = this.collectStreamingAgentIdsForBoot();
    reconcileInterruptedToolCallsForBoot({
      descriptors: this.descriptors,
      interruptedActorAgentIds: interruptedStreamingAgentIds,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details)
    });
    reconcilePersistedCodexDetailStateForBoot({
      descriptors: this.descriptors,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
    });
    this.normalizeStreamingStatusesForBoot();
    const reconciledExternalThreadSidecarIds = reconcilePersistedExternalThreadSidecarsForBoot({
      descriptors: this.descriptors.values(),
      now: this.now,
      upsertDescriptor: (descriptor) => {
        this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
      },
    });
    if (reconciledExternalThreadSidecarIds.length > 0) {
      this.logDebug("boot:reconcile_external_thread_sidecars", {
        reconciledAgentIds: reconciledExternalThreadSidecarIds,
      });
    }
    await this.cortexService.recoverIncompleteReviewRunDispatchesForBoot();
    await this.recoverMissingWorkerDescriptorsForBoot();

    // Reconcile project agent storage: hydrate descriptors from on-disk config,
    // materialize missing directories from descriptor data (first-boot migration).
    await new ProjectAgentMirrorReconciler({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      profiles: this.profiles
    }).reconcileAllProfiles();

    await this.projectAgentSharingService.reconcile();

    await this.ensureMemoryFilesForBoot();
    await this.saveStore();
    await this.rebuildSessionManifestForBoot();
    await this.hydrateCompactionCountsForBoot();
    this.startCompactionCountBackfill();

    this.loadConversationHistoriesFromStore();
    await this.restoreRuntimesForBoot();

    const managerDescriptor = this.getBootLogManagerDescriptor();
    const loadedPrompts = await this.promptRegistry.listAll();
    const loadedArchetypeIds = loadedPrompts
      .filter((entry) => entry.category === "archetype")
      .map((entry) => entry.promptId)
      .sort((left, right) => left.localeCompare(right));

    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();
    this.scheduleProjectExecutableTrustPromptsForAllManagers();
    this.cortexService.scheduleReviewRunQueueCheck(0);

    this.workerHealthService.ensureStarted();

    this.logDebug("boot:ready", {
      managerId: managerDescriptor?.agentId,
      managerStatus: managerDescriptor?.status,
      model: managerDescriptor?.model,
      cwd: managerDescriptor?.cwd,
      managerAgentDir: this.config.paths.managerAgentDir,
      managerSystemPromptSource: managerDescriptor ? `archetype:${MANAGER_ARCHETYPE_ID}` : undefined,
      loadedArchetypeIds,
      restoredAgentIds: Array.from(this.runtimes.keys())
    });
  }

  async loadWorkPlansSettings(): Promise<void> {
    this.workPlansEnabled = false;
  }

  async loadModelCacheVisualizationSettings(): Promise<void> {
    this.modelCacheVisualizationEnabled = await getModelCacheVisualizationEnabled(
      this.config.paths.dataDir,
    );
  }

  isWorkPlansEnabled(): boolean {
    return this.workPlansEnabled;
  }

  isModelCacheVisualizationEnabled(): boolean {
    return this.modelCacheVisualizationEnabled;
  }

  async applyModelCacheVisualizationSettingsChange(enabled: boolean): Promise<void> {
    this.modelCacheVisualizationEnabled = enabled;
  }

  async applyWorkPlansSettingsChange(_enabled: boolean): Promise<void> {
    this.workPlansEnabled = false;
  }

  listAgents(): AgentDescriptor[] {
    return this.sortedDescriptors().map((descriptor) => cloneDescriptor(descriptor));
  }

  listAgentsForInternalUse(): AgentDescriptor[] {
    return this.sortedDescriptors().map((descriptor) => cloneDescriptorForPersistence(descriptor));
  }

  isAgentEffectivelyArchived(agentId: string): boolean {
    const descriptor = this.descriptors.get(agentId);
    return descriptor ? this.isDescriptorEffectivelyArchived(descriptor) : false;
  }

  getCodexTransportDebugDiagnostics(): CodexTransportDebugAgentDiagnostics[] {
    return this.sortedDescriptors()
      .filter((descriptor) => isOpenAICodexDescriptor(descriptor))
      .map((descriptor) => {
        const runtime = this.runtimes.get(descriptor.agentId);
        const runtimeDiagnostics = runtime?.runtimeType === "pi"
          ? runtime.getCodexTransportDebugDiagnostics?.()
          : undefined;
        const runtimeAvailable = Boolean(runtime);
        const websocketStatsStatus = runtime
          ? runtime.runtimeType === "pi"
            ? runtimeDiagnostics?.websocketStatsStatus ?? "not_pi_runtime"
            : "not_pi_runtime"
          : "runtime_inactive";
        const directPiSessionStatsStatus = runtime
          ? runtime.runtimeType === "pi"
            ? runtimeDiagnostics?.directPiSessionStatsStatus ?? "not_pi_runtime"
            : "not_pi_runtime"
          : "runtime_inactive";

        return {
          agentId: descriptor.agentId,
          agentIdHash: hashDebugAgentId(descriptor.agentId),
          role: descriptor.role,
          status: descriptor.status,
          modelId: descriptor.model?.modelId,
          provider: descriptor.model?.provider,
          api: runtimeDiagnostics?.modelApi,
          selectedConfigTransport: selectedOpenAICodexTransport(),
          runtimeAvailable,
          runtimeTransport: runtimeDiagnostics?.transport,
          runtimeModelProvider: runtimeDiagnostics?.modelProvider,
          runtimeModelApi: runtimeDiagnostics?.modelApi,
          piSessionIdPresent: runtimeDiagnostics?.piSessionIdPresent ?? false,
          websocketStatsStatus,
          directPiSessionStatsStatus,
          ...(runtimeDiagnostics?.websocketStats ? { websocketStats: runtimeDiagnostics.websocketStats } : {})
        } satisfies CodexTransportDebugAgentDiagnostics;
      });
  }

  updateWorkerActivity(agentId: string, event: RuntimeSessionEvent): void {
    this.runtimeController.updateWorkerActivity(agentId, event);
  }

  async resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor,
  ): Promise<AgentModelDescriptor | undefined> {
    return this.specialistFallbackManager.resolveSpecialistFallbackModelForDescriptor(descriptor);
  }

  async maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number
  ): Promise<boolean> {
    return this.specialistFallbackManager.maybeRecoverWorkerWithSpecialistFallback({
      agentId,
      errorMessage,
      sourcePhase,
      runtimeToken,
      handleRuntimeStatus: (token, targetAgentId, status, pendingCount, contextUsage) =>
        this.handleRuntimeStatus(token, targetAgentId, status, pendingCount, contextUsage),
      handleRuntimeAgentEnd: (token, targetAgentId) => this.handleRuntimeAgentEnd(token, targetAgentId)
    });
  }

  getWorkerActivity(agentId: string): {
    currentTool: string | null;
    currentToolElapsedSec: number;
    toolCalls: number;
    errors: number;
    turns: number;
    idleSec: number;
  } | undefined {
    return this.workerHealthService.getWorkerActivity(agentId);
  }

  listBootstrapAgents(): AgentDescriptor[] {
    return this.listManagerAgents();
  }

  listManagerAgents(): AgentDescriptor[] {
    const grouped = this.buildWorkerVisibilityGroups();
    return grouped.managers.map((descriptor) =>
      this.cloneManagerDescriptorWithWorkerCounts(descriptor, grouped.workersByManagerId.get(descriptor.agentId) ?? [])
    );
  }

  listWorkersForSession(sessionAgentId: string): AgentDescriptor[] {
    const grouped = this.buildWorkerVisibilityGroups();
    return (grouped.workersByManagerId.get(sessionAgentId) ?? []).map((descriptor) => cloneDescriptor(descriptor));
  }

  getSessionActiveToolsSnapshot(sessionAgentId: string): SessionActiveToolsSnapshotEvent {
    this.getRequiredSessionDescriptor(sessionAgentId);
    return this.sessionActiveTools.buildSnapshotEvent(sessionAgentId);
  }

  async getSessionTaskStateSnapshot(
    sessionAgentId: string,
    requestId?: string,
  ): Promise<SessionTaskStateSnapshotEvent> {
    const descriptor = this.getRequiredSessionDescriptor(sessionAgentId);
    if (!this.isWorkPlansEnabled()) {
      return {
        type: "session_task_state_snapshot",
        sessionAgentId: descriptor.agentId,
        profileId: descriptor.profileId ?? descriptor.agentId,
        revision: 0,
        activeWorkPlan: null,
        recentWorkPlans: [],
        recentWorkPlanCount: 0,
        recentWorkPlansTruncated: false,
        diagnostics: { state: "defaulted" },
        ...(requestId !== undefined ? { requestId } : {}),
      };
    }

    const snapshot = await this.createWorkPlanServiceForDescriptor(descriptor).loadSnapshot();
    return {
      type: "session_task_state_snapshot",
      ...snapshot,
      ...(requestId !== undefined ? { requestId } : {}),
    };
  }

  recordToolSideEffect(callerAgentId: string, event: SwarmToolSideEffectEvent): void {
    const descriptor = this.descriptors.get(callerAgentId);
    if (!descriptor || !this.observability) {
      return;
    }

    this.observability.recordToolSideEffect({
      agentId: descriptor.agentId,
      managerId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      profileId: descriptor.profileId,
      role: descriptor.role,
      runtimeType: this.getObservabilityRuntimeType(descriptor),
      runtimeToken: this.runtimeController.getRuntimeToken(descriptor.agentId),
      agentName: descriptor.displayName,
      ...event,
      metadata: {
        modelProvider: descriptor.model.provider,
        modelId: descriptor.model.modelId,
        ...event.metadata,
      },
    });
  }

  async runTaskTool(
    callerAgentId: string,
    _toolCallId: string,
    input: TaskToolInput,
  ): Promise<TaskToolResult> {
    if (!this.isWorkPlansEnabled()) {
      throw new Error("Active Work Plans are disabled in Settings.");
    }

    this.assertExternalProjectAgentTurnCapabilityAllowed(callerAgentId, "task");

    const descriptor = this.descriptors.get(callerAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error("task is only available to manager sessions.");
    }

    if (normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID) {
      throw new Error("task is not available for Cortex sessions.");
    }

    if (!this.isSessionAgent(descriptor)) {
      throw new Error("task requires a manager session with profile context.");
    }

    this.assertDescriptorNotEffectivelyArchived(descriptor);
    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Manager is not running: ${callerAgentId}`);
    }

    const service = this.createWorkPlanServiceForDescriptor(descriptor);
    let normalizedInput: TaskToolInput | undefined;

    try {
      normalizedInput = normalizeTaskToolInput(input);
      if (normalizedInput.action === "get") {
        const result = await service.get({
          agentId: descriptor.agentId,
          role: descriptor.role,
          profileId: descriptor.profileId,
          sessionAgentId: descriptor.agentId,
        });
        const toolResult = {
          action: "get" as const,
          stateRevision: result.stateRevision,
          snapshot: result.snapshot,
        };
        this.recordToolSideEffect(callerAgentId, {
          toolName: "task",
          toolCallId: _toolCallId,
          phase: "side_effect",
          input: normalizedInput,
          output: toolResult,
          metadata: { action: normalizedInput.action },
        });
        return toolResult;
      }

      const mutationResult = await this.runTaskToolMutation(service, descriptor, normalizedInput);
      if (normalizedInput.action === "upsert_plan" && !normalizedInput.planId) {
        this.emitWorkPlanCreated({
          type: "work_plan_created",
          agentId: descriptor.agentId,
          id: randomUUID(),
          timestamp: mutationResult.workPlan.createdAt,
          planId: mutationResult.workPlan.planId,
          stateRevision: mutationResult.stateRevision,
          planRevision: mutationResult.workPlan.revision,
          plan: mutationResult.workPlan,
        });
      }
      await this.emitSessionTaskStateSnapshotForSession(descriptor.agentId).catch((error) => {
        this.logDebug("coordination:task_snapshot_emit:error", {
          agentId: descriptor.agentId,
          profileId: descriptor.profileId,
          action: mutationResult.action,
          planId: mutationResult.planId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      const toolResult = {
        action: mutationResult.action,
        stateRevision: mutationResult.stateRevision,
        planId: mutationResult.planId,
        planRevision: mutationResult.planRevision,
        status: mutationResult.workPlan.status,
        ...(mutationResult.createdItemIds ? { createdItemIds: mutationResult.createdItemIds } : {}),
        ...(mutationResult.updatedItemId ? { updatedItemId: mutationResult.updatedItemId } : {}),
        ...(mutationResult.linkedItemId ? { linkedItemId: mutationResult.linkedItemId } : {}),
      };
      this.recordToolSideEffect(callerAgentId, {
        toolName: "task",
        toolCallId: _toolCallId,
        phase: "side_effect",
        input: normalizedInput,
        output: toolResult,
        metadata: { action: normalizedInput.action, planId: mutationResult.planId },
      });
      return toolResult;
    } catch (error) {
      const taskInput = normalizedInput ?? input;
      const recoverableResult = await this.toRecoverableTaskToolResult(service, error, taskInput);
      if (recoverableResult) {
        this.recordToolSideEffect(callerAgentId, {
          toolName: "task",
          toolCallId: _toolCallId,
          phase: "side_effect",
          input: taskInput,
          output: recoverableResult,
          isError: true,
          metadata: { action: this.getTaskToolResultAction(taskInput), recoverable: true },
        });
        return recoverableResult;
      }
      throw new Error(this.mapTaskToolErrorMessage(error, taskInput));
    }
  }

  private async toRecoverableTaskToolResult(
    service: WorkPlanService,
    error: unknown,
    input: TaskToolInput,
  ): Promise<TaskToolRecoverableErrorResult | null> {
    const descriptor = toWorkPlanServiceErrorDescriptor(error, this.getKnownTaskToolServiceAction(input));
    if (!this.isRecoverableTaskToolErrorCode(descriptor.code)) {
      return null;
    }

    const stateSummary = await this.loadRecoverableTaskToolStateSummary(service, descriptor.actualStateRevision);
    const suggestedAction = this.getRecoverableTaskToolSuggestedAction(descriptor.code, descriptor.message);
    return {
      action: this.getTaskToolResultAction(input),
      ok: false,
      error: {
        code: descriptor.code,
        message: this.mapTaskToolErrorMessage(error, input),
        recoverable: true,
        ...(suggestedAction ? { suggestedAction } : {}),
      },
      ...stateSummary,
    };
  }

  private isRecoverableTaskToolErrorCode(code: string): boolean {
    return code === "work_plan_not_found"
      || code === "item_resolution_failed"
      || code === "state_revision_conflict"
      || code === "work_plan_immutable"
      || code === "active_plan_exists"
      || code === "validation_error";
  }

  private getRecoverableTaskToolSuggestedAction(
    code: string,
    message: string,
  ): TaskToolRecoverableErrorResult["error"]["suggestedAction"] {
    switch (code) {
      case "work_plan_not_found":
      case "item_resolution_failed":
      case "state_revision_conflict":
      case "work_plan_immutable":
      case "active_plan_exists":
        return "task.get";
      case "validation_error":
        return /\bworkPlans\b|session coordination state/iu.test(message) ? "continue_without_plan" : "retry";
      default:
        return undefined;
    }
  }

  private async loadRecoverableTaskToolStateSummary(
    service: WorkPlanService,
    fallbackStateRevision?: number,
  ): Promise<Pick<TaskToolRecoverableErrorResult, "stateRevision" | "activePlan">> {
    const result: Pick<TaskToolRecoverableErrorResult, "stateRevision" | "activePlan"> = {
      ...(fallbackStateRevision !== undefined ? { stateRevision: fallbackStateRevision } : {}),
    };

    try {
      const snapshot = await service.loadSnapshot();
      if (snapshot.diagnostics?.state === "unavailable") {
        return result;
      }

      const activePlan = snapshot.activeWorkPlan;
      return {
        stateRevision: snapshot.revision,
        ...(activePlan
          ? {
              activePlan: {
                planId: activePlan.planId,
                planRevision: activePlan.revision,
                status: activePlan.status,
                itemCount: activePlan.itemCount,
              },
            }
          : {}),
      };
    } catch {
      return result;
    }
  }

  private getTaskToolResultAction(input: TaskToolInput): string {
    const action = (input as { action?: unknown } | undefined)?.action;
    return typeof action === "string" && action.length > 0 ? action : "unknown";
  }

  private getKnownTaskToolServiceAction(input: TaskToolInput): WorkPlanServiceAction | undefined {
    const action = this.getTaskToolResultAction(input);
    return action === "get"
      || action === "upsert_plan"
      || action === "update_item_status"
      || action === "link"
      || action === "finish_plan"
      ? action
      : undefined;
  }

  private async runTaskToolMutation(
    service: WorkPlanService,
    descriptor: AgentDescriptor & { role: "manager"; profileId: string },
    input: Exclude<TaskToolInput, TaskToolGetInput>,
  ): Promise<WorkPlanMutationResult> {
    const actor = {
      agentId: descriptor.agentId,
      role: descriptor.role,
      profileId: descriptor.profileId,
      sessionAgentId: descriptor.agentId,
    } as const;

    switch (input.action) {
      case "upsert_plan":
        return service.upsertPlan(actor, input);
      case "update_item_status":
        return service.updateItemStatus(actor, input);
      case "link":
        return service.link(actor, input);
      case "finish_plan":
        if (input.status === "completed_with_warnings" && (!input.warnings || input.warnings.length === 0)) {
          throw new WorkPlanServiceValidationError("warnings must include at least one entry when status is completed_with_warnings")
        }
        return service.finishPlan(actor, input);
    }

    const unsupportedInput: never = input;
    throw new Error(`Unsupported task action: ${JSON.stringify(unsupportedInput)}`);
  }

  private createWorkPlanServiceForDescriptor(
    descriptor: AgentDescriptor & { role: "manager"; profileId: string },
  ): WorkPlanService {
    return new WorkPlanService({
      profileId: descriptor.profileId,
      sessionAgentId: descriptor.agentId,
      deps: {
        store: new SessionCoordinationStore({
          dataDir: this.config.paths.dataDir,
          profileId: descriptor.profileId,
          sessionAgentId: descriptor.agentId,
        }),
        listAgents: () => this.listAgents(),
      },
    });
  }

  private mapTaskToolErrorMessage(error: unknown, input: TaskToolInput): string {
    const descriptor = toWorkPlanServiceErrorDescriptor(error, input.action);
    const genericUnknownMessage = "Active Work failed unexpectedly. No changes were applied.";

    switch (descriptor.code) {
      case "state_unavailable":
        return "Active Work is temporarily unavailable because Forge could not safely read or preserve the saved task state. No changes were applied.";
      case "work_plan_not_found":
        return "The requested work plan no longer exists. Call `task.get` to refresh before retrying.";
      case "active_plan_exists":
        return "A non-terminal work plan already exists for this session. Update or finish it before creating another.";
      case "work_plan_immutable":
        return "This work plan is already terminal and cannot be modified.";
      case "item_resolution_failed":
        if (input.action === "link" && input.itemId === undefined) {
          return "link.itemId is required when the work plan has multiple items.";
        }
        return "The requested work plan item could not be resolved. Call `task.get` to refresh before retrying.";
      case "invalid_link":
        if (input.action === "link") {
          const link = input.link as Record<string, unknown>;
          if (link.type !== "worker" || hasUnsupportedTaskRefFields(link)) {
            return "Only worker links are supported in Active Work v1.";
          }
          if (typeof link.agentId === "string" && link.agentId.trim().length > 0) {
            return "Worker links must target an existing worker owned by this manager session.";
          }
        }
        return "Only worker links are supported in Active Work v1.";
      case "state_revision_conflict":
      case "validation_error":
        return descriptor.message;
      case "unknown_error":
      default:
        return genericUnknownMessage;
    }
  }

  listProfiles(): ManagerProfile[] {
    return this.sortedProfiles().map((profile) => ({
      ...profile,
      defaultModel: { ...profile.defaultModel }
    }));
  }

  listUserProfiles(): ManagerProfile[] {
    return this.listProfiles().filter((profile) => !isSystemProfile(profile));
  }

  getAgentsSnapshotVersion(): number {
    return this.agentsSnapshotVersion;
  }

  getProfilesSnapshotVersion(): number {
    return this.profilesSnapshotVersion;
  }

  hasCollaborationStorageProfile(): boolean {
    return this.profiles.has(COLLABORATION_PROFILE_ID);
  }

  hasCollaborationStorageRootSession(): boolean {
    const descriptor = this.descriptors.get(COLLABORATION_PROFILE_ID);
    return Boolean(descriptor && descriptor.role === "manager" && descriptor.profileId === COLLABORATION_PROFILE_ID);
  }

  async ensureCollaborationStorageProfile(): Promise<void> {
    const existingDescriptor = this.descriptors.get(COLLABORATION_PROFILE_ID);
    if (existingDescriptor && existingDescriptor.role !== "manager") {
      throw new Error(
        `Cannot provision collaboration profile because agentId "${COLLABORATION_PROFILE_ID}" is already in use`,
      );
    }

    const now = this.now();
    const existingManagerDescriptor = existingDescriptor as (AgentDescriptor & { role: "manager" }) | undefined;
    const existingProfile = this.profiles.get(COLLABORATION_PROFILE_ID);
    const createdAt = existingManagerDescriptor?.createdAt ?? existingProfile?.createdAt ?? now;

    const descriptor: AgentDescriptor = {
      agentId: COLLABORATION_PROFILE_ID,
      displayName: COLLABORATION_DISPLAY_NAME,
      role: "manager",
      managerId: COLLABORATION_PROFILE_ID,
      profileId: COLLABORATION_PROFILE_ID,
      sessionLabel: COLLABORATION_DISPLAY_NAME,
      status: "idle",
      createdAt,
      updatedAt: existingManagerDescriptor?.updatedAt ?? now,
      cwd: existingManagerDescriptor?.cwd ?? this.config.defaultCwd,
      model: { ...(existingManagerDescriptor?.model ?? this.config.defaultModel) },
      modelOrigin: "profile_default",
      sessionFile: getSessionFilePath(
        this.config.paths.dataDir,
        COLLABORATION_PROFILE_ID,
        COLLABORATION_PROFILE_ID,
      ),
      archetypeId: existingManagerDescriptor?.archetypeId ?? MANAGER_ARCHETYPE_ID,
      ...(existingManagerDescriptor?.sessionSystemPrompt
        ? { sessionSystemPrompt: existingManagerDescriptor.sessionSystemPrompt }
        : {}),
    };

    const profile: ManagerProfile = {
      profileId: COLLABORATION_PROFILE_ID,
      displayName: COLLABORATION_DISPLAY_NAME,
      defaultSessionAgentId: COLLABORATION_PROFILE_ID,
      defaultModel: { ...(existingProfile?.defaultModel ?? descriptor.model) },
      createdAt: existingProfile?.createdAt ?? createdAt,
      updatedAt: existingProfile?.updatedAt ?? now,
      profileType: "system",
      ...(existingProfile?.sortOrder !== undefined ? { sortOrder: existingProfile.sortOrder } : {}),
    };

    const hadProfile = Boolean(existingProfile);
    const hadDescriptor = Boolean(existingManagerDescriptor);
    const changed =
      !existingProfile ||
      existingProfile.displayName !== profile.displayName ||
      existingProfile.defaultSessionAgentId !== profile.defaultSessionAgentId ||
      existingProfile.profileType !== profile.profileType ||
      !existingManagerDescriptor ||
      existingManagerDescriptor.profileId !== descriptor.profileId ||
      existingManagerDescriptor.managerId !== descriptor.managerId ||
      existingManagerDescriptor.displayName !== descriptor.displayName ||
      existingManagerDescriptor.sessionLabel !== descriptor.sessionLabel ||
      existingManagerDescriptor.status !== descriptor.status ||
      existingManagerDescriptor.creatorAgentId !== undefined ||
      existingManagerDescriptor.sessionPurpose !== undefined ||
      existingManagerDescriptor.sessionSurface !== undefined ||
      existingManagerDescriptor.collab !== undefined ||
      existingManagerDescriptor.projectAgent !== undefined ||
      existingManagerDescriptor.sessionFile !== descriptor.sessionFile ||
      existingManagerDescriptor.cwd !== descriptor.cwd ||
      existingManagerDescriptor.archetypeId !== descriptor.archetypeId ||
      existingManagerDescriptor.sessionSystemPrompt !== descriptor.sessionSystemPrompt ||
      existingManagerDescriptor.model.provider !== descriptor.model.provider ||
      existingManagerDescriptor.model.modelId !== descriptor.model.modelId ||
      existingManagerDescriptor.model.thinkingLevel !== descriptor.model.thinkingLevel;

    if (changed) {
      descriptor.updatedAt = now;
      profile.updatedAt = now;
    }

    this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile);
    this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);

    await this.ensureProfilePiDirectories(profile.profileId);
    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.ensureAgentMemoryFile(this.getAgentMemoryPath(descriptor.agentId), profile.profileId);
    await this.ensureAgentMemoryFile(getProfileMemoryPath(this.config.paths.dataDir, profile.profileId), profile.profileId);
    await this.writeInitialSessionMeta(descriptor);
    await this.refreshSessionMetaStats(descriptor);

    if (changed) {
      await this.saveStore();
    }

    if (!hadProfile || !hadDescriptor) {
      this.logDebug("collaboration:storage-profile:ensured", {
        profileId: COLLABORATION_PROFILE_ID,
      });
      return;
    }

    if (changed) {
      this.logDebug("collaboration:storage-profile:synced", {
        profileId: COLLABORATION_PROFILE_ID,
      });
    }
  }

  async listCortexReviewRuns(): Promise<CortexReviewRunRecord[]> {
    return this.cortexService.listReviewRuns();
  }

  async startCortexReviewRun(input: {
    scope: CortexReviewRunScope;
    trigger: CortexReviewRunTrigger;
    sourceContext?: MessageSourceContext;
    requestText?: string;
    scheduleName?: string | null;
  }): Promise<CortexReviewRunRecord | null> {
    return this.cortexService.startReviewRun(input);
  }

  getConversationHistory(agentId?: string): ConversationEntryEvent[] {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return [];
    }

    return this.conversationProjector.getConversationHistory(resolvedAgentId);
  }

  getConversationHistoryWithDiagnostics(agentId?: string): {
    history: ConversationEntryEvent[];
    diagnostics: SidebarConversationHistoryDiagnostics;
  } {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return {
        history: [],
        diagnostics: {
          cacheState: "memory",
          historySource: "memory",
          coldLoad: false,
          fsReadOps: 0,
          fsReadBytes: 0,
          detail: "missing_agent"
        }
      };
    }

    return this.conversationProjector.getConversationHistoryWithDiagnostics(resolvedAgentId);
  }

  getSidebarPerfRecorder(): SidebarPerfRecorder {
    return this.sidebarPerfRecorder;
  }

  readSidebarPerfSummary(): SidebarPerfSummary {
    return this.sidebarPerfRecorder.readSummary();
  }

  readSidebarPerfSlowEvents(): SidebarPerfSlowEvent[] {
    return this.sidebarPerfRecorder.readRecentSlowEvents();
  }

  private async preloadPinnedMessageIndexes(): Promise<void> {
    const sessionDescriptors = Array.from(this.descriptors.values()).filter((descriptor) => this.isSessionAgent(descriptor));

    await Promise.all(
      sessionDescriptors.map(async (descriptor) => {
        const registry = await loadPins(this.getSessionDirForDescriptor(descriptor));
        this.setPinnedRegistryForAgent(descriptor.agentId, registry);
      })
    );
  }

  private setPinnedRegistryForAgent(agentId: string, registry: PinRegistry): void {
    const pinnedMessageIds = Object.keys(registry.pins);
    if (pinnedMessageIds.length === 0) {
      this.pinnedMessageIdsBySessionAgentId.delete(agentId);
      return;
    }

    this.pinnedMessageIdsBySessionAgentId.set(agentId, new Set(pinnedMessageIds));
  }

  private async syncPinnedContentForManagerRuntime(
    descriptor: AgentDescriptor & { role: "manager" },
    options?: {
      registry?: PinRegistry;
      runtime?: SwarmAgentRuntime;
      setPinnedContentOptions?: SetPinnedContentOptions;
    }
  ): Promise<PinRegistry> {
    const registry = options?.registry ?? await loadPins(this.getSessionDirForDescriptor(descriptor));
    this.setPinnedRegistryForAgent(descriptor.agentId, registry);

    const runtime = options?.runtime ?? this.runtimes.get(descriptor.agentId);
    if (runtime?.setPinnedContent) {
      await runtime.setPinnedContent(
        formatPinnedMessagesForCompaction(registry),
        options?.setPinnedContentOptions
      );
    }

    return registry;
  }

  private getSessionDirForDescriptor(descriptor: { agentId: string; profileId?: string }): string {
    return getSessionDir(
      this.config.paths.dataDir,
      descriptor.profileId ?? descriptor.agentId,
      descriptor.agentId
    );
  }

  async requestUserChoice(
    agentId: string,
    questions: ChoiceQuestion[],
  ): Promise<ChoiceAnswer[]> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(agentId, "present_choices");
    const pending = this.choiceService.requestUserChoiceWithId(agentId, questions);
    this.rememberPendingChoiceAssistantOutputContinuation(pending.choiceId, agentId);
    this.runtimeController.flushPreservedManagerAssistantOutputForTool(agentId, "present_choices");
    return pending.promise;
  }

  private rememberPendingChoiceAssistantOutputContinuation(choiceId: string, agentId: string): void {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    const target = this.activeAssistantOutputTargetByManagerId.get(agentId);
    if (!target || target.kind !== "session_transcript" || target.channel !== "web") {
      return;
    }

    this.pendingChoiceAssistantOutputContinuationByChoiceId.set(choiceId, {
      managerId: agentId,
      target: cloneSessionTranscriptAssistantOutputTarget(target),
    });
  }

  private activatePendingChoiceAssistantOutputContinuation(choiceId: string, ownerAgentId: string): void {
    const continuation = this.pendingChoiceAssistantOutputContinuationByChoiceId.get(choiceId);
    this.pendingChoiceAssistantOutputContinuationByChoiceId.delete(choiceId);
    if (!continuation || continuation.managerId !== ownerAgentId) {
      return;
    }

    const descriptor = this.descriptors.get(continuation.managerId);
    if (!descriptor || descriptor.role !== "manager" || descriptor.collab) {
      return;
    }

    this.inboundTurnContextActivatedByAgentId.add(continuation.managerId);
    this.activeAssistantOutputTargetByManagerId.set(continuation.managerId, continuation.target);
    this.runtimeController.activateManagerAssistantOutputTurn(continuation.managerId, continuation.target);
  }

  private clearPendingChoiceAssistantOutputContinuationsForAgent(agentId: string): void {
    for (const [choiceId, continuation] of Array.from(this.pendingChoiceAssistantOutputContinuationByChoiceId.entries())) {
      if (continuation.managerId === agentId) {
        this.pendingChoiceAssistantOutputContinuationByChoiceId.delete(choiceId);
      }
    }
  }

  private scheduleProjectExecutableTrustPromptsForAllManagers(): void {
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role === "manager") {
        this.scheduleProjectExecutableTrustPrompt(descriptor as AgentDescriptor & { role: "manager" });
      }
    }
  }

  private scheduleProjectExecutableTrustPrompt(descriptor: AgentDescriptor & { role: "manager" }): void {
    if (descriptor.collab) return;
    void this.maybePromptForProjectExecutableTrust(descriptor).catch((error) => {
      this.logDebug("project_resources:trust_prompt:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async maybePromptForProjectExecutableTrust(descriptor: AgentDescriptor & { role: "manager" }): Promise<void> {
    const settingsStore = new ProjectResourceSettingsStore(this.config.paths.dataDir);
    const resolution = await new ProjectWorkspaceResolver({
      dataDir: this.config.paths.dataDir,
      settingsStore
    }).resolve({
      profileId: descriptor.profileId ?? descriptor.agentId,
      sessionAgentId: descriptor.agentId,
      cwd: descriptor.cwd
    });
    if (!resolution.trust.key || resolution.trust.state !== "untrusted") return;
    if (!hasExistingExecutableSurface(resolution)) return;

    const dismissed = await settingsStore.getDismissedExecutablePrompt(resolution.trust.key);
    if (dismissed?.signature === resolution.signature) return;
    if (this.pendingProjectExecutableTrustPromptsByKey.has(resolution.trust.key)) return;

    this.pendingProjectExecutableTrustPromptsByKey.add(resolution.trust.key);
    try {
      const answers = await this.choiceService.requestUserChoice(descriptor.agentId, [
        {
          id: "repo_executable_trust",
          header: "Repository executable resources",
          question: `This repository has executable Forge/Pi resources under ${resolution.effectiveForgeDirRealpath}. Trust them for this repository?`,
          options: [
            { id: "trust", label: "Trust", description: "Enable repository .forge extensions and Pi package extensions." },
            { id: "block", label: "Block", description: "Keep executable repository resources disabled. Skills and reference docs stay available." },
            { id: "manage_later", label: "Manage later", description: "Keep disabled for now and ask again if executable resources change." }
          ]
        }
      ]);
      const selected = answers[0]?.selectedOptionIds[0];
      const currentResolution = await new ProjectWorkspaceResolver({
        dataDir: this.config.paths.dataDir,
        settingsStore
      }).resolve({
        profileId: descriptor.profileId ?? descriptor.agentId,
        sessionAgentId: descriptor.agentId,
        cwd: descriptor.cwd
      });
      const currentDismissed = currentResolution.trust.key
        ? await settingsStore.getDismissedExecutablePrompt(currentResolution.trust.key)
        : undefined;
      const promptStillCurrent =
        this.pendingProjectExecutableTrustPromptsByKey.has(resolution.trust.key) &&
        currentResolution.trust.key === resolution.trust.key &&
        currentResolution.trust.state === "untrusted" &&
        currentResolution.signature === resolution.signature &&
        currentDismissed?.signature !== currentResolution.signature;
      if (!promptStillCurrent) return;
      if (selected === "trust") {
        const preActivationPlan = buildProjectExecutableTrustPlan({ resolution, cwd: descriptor.cwd });
        this.beginDeferredProjectExecutableTrustActivation(resolution.trust.key, preActivationPlan);
        let trustWritten = false;
        try {
          await settingsStore.setTrust(resolution.trust.key, "trust");
          trustWritten = true;
          await this.markProjectExecutableTrustActivationPending(resolution.trust.key, preActivationPlan);
        } catch (error) {
          if (!trustWritten) {
            this.clearDeferredProjectExecutableTrustActivationForKey(resolution.trust.key);
          }
          throw error;
        }
      } else if (selected === "block") {
        await settingsStore.setTrust(resolution.trust.key, "block");
      } else if (selected === "manage_later") {
        await settingsStore.dismissExecutablePrompt(resolution.trust.key, resolution.signature);
      }
    } finally {
      this.pendingProjectExecutableTrustPromptsByKey.delete(resolution.trust.key);
    }
  }

  async applyProjectResourceTrustChange(trustKey: string): Promise<void> {
    this.pendingProjectExecutableTrustPromptsByKey.delete(trustKey);
    this.clearDeferredProjectExecutableTrustActivationForKey(trustKey);
    await this.applyProjectResourceRuntimeBoundaryChange(async (resolution) => resolution.trust.key === trustKey);
  }

  async applyProjectResourceWorkspaceChange(workspaceKey: string): Promise<void> {
    const affectedManagerIds = await this.resolveProjectResourceWorkspaceManagerIds(workspaceKey);
    await this.applyProjectResourceRuntimeBoundaryChange(async (resolution) => resolution.workspaceKey === workspaceKey);
    this.clearDeferredProjectExecutableTrustActivationsForManagers(affectedManagerIds);
  }

  private beginDeferredProjectExecutableTrustActivation(
    trustKey: string,
    preActivationPlan: ProjectExecutableTrustPlan
  ): void {
    const existing = this.deferredProjectExecutableTrustActivationsByKey.get(trustKey);
    if (existing) {
      existing.preActivationPlan = preActivationPlan;
      existing.protectAllRuntimeCreations = true;
      this.forgeExtensionHost.setDeferredProjectExecutableTrustPlan(trustKey, preActivationPlan);
      return;
    }

    this.deferredProjectExecutableTrustActivationsByKey.set(trustKey, {
      trustKey,
      preActivationPlan,
      pendingManagerIds: new Set(),
      protectAllRuntimeCreations: true
    });
    this.forgeExtensionHost.setDeferredProjectExecutableTrustPlan(trustKey, preActivationPlan);
  }

  private clearDeferredProjectExecutableTrustActivationForKey(trustKey: string): void {
    this.deferredProjectExecutableTrustActivationsByKey.delete(trustKey);
    this.forgeExtensionHost.clearDeferredProjectExecutableTrustPlan(trustKey);

    for (const [managerId, pendingTrustKey] of Array.from(this.pendingProjectExecutableTrustActivationByManagerId.entries())) {
      if (pendingTrustKey === trustKey) {
        this.pendingProjectExecutableTrustActivationByManagerId.delete(managerId);
        if (this.runtimeRecoveryState.getPendingManagerRuntimeRecycleReason(managerId) === "project_resource_trust_change") {
          this.runtimeRecoveryState.clearPendingManagerRuntimeRecycle(managerId);
        }
      }
    }

    for (const [managerId, pendingTrustKey] of Array.from(this.pendingProjectExecutableWorkerInvalidationByManagerId.entries())) {
      if (pendingTrustKey === trustKey) {
        this.pendingProjectExecutableWorkerInvalidationByManagerId.delete(managerId);
      }
    }
  }

  private clearDeferredProjectExecutableTrustActivationsForManagers(managerIds: Iterable<string>): void {
    for (const managerId of managerIds) {
      this.pendingProjectExecutableWorkerInvalidationByManagerId.delete(managerId);
      this.clearPendingProjectExecutableTrustActivationForManager(managerId);
      if (this.runtimeRecoveryState.getPendingManagerRuntimeRecycleReason(managerId) === "project_resource_trust_change") {
        this.runtimeRecoveryState.clearPendingManagerRuntimeRecycle(managerId);
      }
    }
  }

  private async resolveProjectResourceWorkspaceManagerIds(workspaceKey: string): Promise<Set<string>> {
    const managerIds = new Set<string>();
    const resolver = new ProjectWorkspaceResolver({
      dataDir: this.config.paths.dataDir,
      settingsStore: new ProjectResourceSettingsStore(this.config.paths.dataDir)
    });

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager" || descriptor.collab) continue;
      try {
        const resolution = await resolver.resolve({
          profileId: descriptor.profileId ?? descriptor.agentId,
          sessionAgentId: descriptor.agentId,
          cwd: descriptor.cwd
        });
        if (resolution.workspaceKey === workspaceKey) {
          managerIds.add(descriptor.agentId);
        }
      } catch (error) {
        this.logDebug("project_resources:workspace_change:resolve_error", {
          agentId: descriptor.agentId,
          workspaceKey,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return managerIds;
  }

  private setPendingProjectExecutableTrustActivationForManager(managerId: string, trustKey: string): void {
    this.pendingProjectExecutableTrustActivationByManagerId.set(managerId, trustKey);
    this.pendingProjectExecutableWorkerInvalidationByManagerId.set(managerId, trustKey);
    this.deferredProjectExecutableTrustActivationsByKey.get(trustKey)?.pendingManagerIds.add(managerId);
  }

  private clearPendingProjectExecutableTrustActivationForManager(managerId: string): void {
    const trustKey = this.pendingProjectExecutableTrustActivationByManagerId.get(managerId);
    if (!trustKey) return;

    this.pendingProjectExecutableTrustActivationByManagerId.delete(managerId);
    const activation = this.deferredProjectExecutableTrustActivationsByKey.get(trustKey);
    activation?.pendingManagerIds.delete(managerId);
    if (activation && activation.pendingManagerIds.size === 0) {
      this.deferredProjectExecutableTrustActivationsByKey.delete(trustKey);
      this.forgeExtensionHost.clearDeferredProjectExecutableTrustPlan(trustKey);
    }
  }

  private async markProjectExecutableTrustActivationPending(
    trustKey: string,
    preActivationPlan: ProjectExecutableTrustPlan
  ): Promise<void> {
    // Trust prompts only appear while repository executable resources are still inactive, so
    // accepting trust here can be deferred safely until the current runtime reaches an idle
    // boundary instead of interrupting an in-flight user turn. While pending, new manager/worker
    // runtime creations continue using the pre-activation executable trust plan.
    this.beginDeferredProjectExecutableTrustActivation(trustKey, preActivationPlan);
    const settingsStore = new ProjectResourceSettingsStore(this.config.paths.dataDir);
    const resolver = new ProjectWorkspaceResolver({
      dataDir: this.config.paths.dataDir,
      settingsStore
    });

    const activation = this.deferredProjectExecutableTrustActivationsByKey.get(trustKey);
    if (activation) {
      activation.protectAllRuntimeCreations = true;
    }

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager" || descriptor.collab) continue;
      try {
        const resolution = await resolver.resolve({
          profileId: descriptor.profileId ?? descriptor.agentId,
          sessionAgentId: descriptor.agentId,
          cwd: descriptor.cwd
        });
        if (resolution.trust.key !== trustKey) continue;
        this.runtimeRecoveryState.setPendingManagerRuntimeRecycle(descriptor.agentId, "project_resource_trust_change");
        this.setPendingProjectExecutableTrustActivationForManager(descriptor.agentId, trustKey);
      } catch (error) {
        this.logDebug("project_resources:trust_activation:resolve_error", {
          agentId: descriptor.agentId,
          trustKey,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const markedActivation = this.deferredProjectExecutableTrustActivationsByKey.get(trustKey);
    if (markedActivation) {
      markedActivation.protectAllRuntimeCreations = false;
      if (markedActivation.pendingManagerIds.size === 0) {
        this.deferredProjectExecutableTrustActivationsByKey.delete(trustKey);
        this.forgeExtensionHost.clearDeferredProjectExecutableTrustPlan(trustKey);
      }
    }
  }

  private async applyProjectResourceRuntimeBoundaryChange(
    matches: (resolution: Awaited<ReturnType<ProjectWorkspaceResolver["resolve"]>>) => boolean | Promise<boolean>
  ): Promise<void> {
    const affectedSessions: Array<AgentDescriptor & { role: "manager" }> = [];
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager" || descriptor.collab) continue;
      const resolution = await new ProjectWorkspaceResolver({
        dataDir: this.config.paths.dataDir,
        settingsStore: new ProjectResourceSettingsStore(this.config.paths.dataDir)
      }).resolve({
        profileId: descriptor.profileId ?? descriptor.agentId,
        sessionAgentId: descriptor.agentId,
        cwd: descriptor.cwd
      });
      if (await matches(resolution)) {
        affectedSessions.push(descriptor as AgentDescriptor & { role: "manager" });
      }
    }

    const affectedSessionIds = new Set(affectedSessions.map((session) => session.agentId));
    const affectedWorkers = Array.from(this.descriptors.values()).filter(
      (descriptor) => descriptor.role === "worker" && affectedSessionIds.has(descriptor.managerId)
    );

    const workerResults = await Promise.allSettled(
      affectedWorkers.map((worker) => this.terminateDescriptor(worker, { abort: true, emitStatus: true }))
    );
    const managerResults = await Promise.allSettled(
      affectedSessions.map((session) => this.forceEvictManagerRuntimeForProjectTrustChange(session))
    );
    this.logProjectTrustPropagationFailures(affectedWorkers, workerResults, affectedSessions, managerResults);
    await this.saveStore();
    this.emitAgentsSnapshot();
  }

  private async forceEvictManagerRuntimeForProjectTrustChange(
    descriptor: AgentDescriptor & { role: "manager" }
  ): Promise<void> {
    // Trust flips are a security boundary: invalidate any current or in-flight manager runtime
    // immediately, without projecting a terminal session state. A fresh runtime will be created
    // on the next user message with the new trust policy.
    this.runtimeRecoveryState.clearPendingManagerRuntimeRecycle(descriptor.agentId);
    const inFlightCreation = this.runtimeCreationPromisesByAgentId.get(descriptor.agentId);
    if (inFlightCreation) {
      this.runtimeCreationPromisesByAgentId.delete(descriptor.agentId);
      this.runtimeController.clearRuntimeToken(descriptor.agentId);
      void inFlightCreation.catch(() => undefined);
    }

    const runtime = this.runtimes.get(descriptor.agentId);
    const runtimeToken = this.runtimeTokensByAgentId.get(descriptor.agentId);
    if (!runtime) {
      this.runtimeController.clearRuntimeToken(descriptor.agentId);
      if (descriptor.status === "streaming") {
        descriptor.status = "idle";
        descriptor.streamingStartedAt = undefined;
        descriptor.updatedAt = this.now();
        this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
        this.emitStatus(descriptor.agentId, "idle", 0, descriptor.contextUsage);
      }
      return;
    }

    this.runtimeController.suppressIntentionalStopRuntimeCallbacks(descriptor.agentId, runtimeToken);
    this.detachRuntime(descriptor.agentId, runtimeToken);
    if (descriptor.status === "streaming") {
      descriptor.status = "idle";
      descriptor.streamingStartedAt = undefined;
      descriptor.updatedAt = this.now();
      this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
      this.emitStatus(descriptor.agentId, "idle", 0, descriptor.contextUsage);
      this.emitConversationMessage({
        type: "conversation_message",
        agentId: descriptor.agentId,
        role: "system",
        text: "Repository executable trust changed. Manager runtime was restarted to apply the new trust policy.",
        timestamp: this.now(),
        source: "system",
        sourceContext: { channel: "web" }
      });
    }

    try {
      await withBoundedTrustRuntimeTermination(
        runtime.terminate({ abort: true, shutdownTimeoutMs: 2_000, drainTimeoutMs: 250 }),
        2_250
      );
    } finally {
      this.runtimeController.clearIntentionalStopRuntimeCallbackSuppression(descriptor.agentId, runtimeToken);
    }
  }

  private logProjectTrustPropagationFailures(
    workers: AgentDescriptor[],
    workerResults: Array<PromiseSettledResult<unknown>>,
    managers: Array<AgentDescriptor & { role: "manager" }>,
    managerResults: Array<PromiseSettledResult<unknown>>
  ): void {
    const workerFailures = collectPropagationFailures(workers, workerResults);
    const managerFailures = collectPropagationFailures(managers, managerResults);
    if (workerFailures.length === 0 && managerFailures.length === 0) return;
    this.logDebug("project_resources:trust_change:propagation_errors", {
      workerFailures: workerFailures.map((entry) => ({
        agentId: entry.agentId,
        message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
      })),
      managerFailures: managerFailures.map((entry) => ({
        agentId: entry.agentId,
        message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
      }))
    });
  }

  resolveChoiceRequest(choiceId: string, answers: ChoiceAnswer[]): void {
    const owner = this.choiceService.getPendingChoiceOwner(choiceId);
    if (owner) {
      this.activatePendingChoiceAssistantOutputContinuation(choiceId, owner.agentId);
    } else {
      this.pendingChoiceAssistantOutputContinuationByChoiceId.delete(choiceId);
    }
    this.choiceService.resolveChoiceRequest(choiceId, answers);
  }

  cancelChoiceRequest(choiceId: string, reason: Extract<ChoiceRequestStatus, "cancelled" | "expired">): void {
    this.pendingChoiceAssistantOutputContinuationByChoiceId.delete(choiceId);
    this.choiceService.cancelChoiceRequest(choiceId, reason);
  }

  cancelAllPendingChoicesForAgent(agentId: string): void {
    this.clearPendingChoiceAssistantOutputContinuationsForAgent(agentId);
    this.choiceService.cancelAllPendingChoicesForAgent(agentId);
  }

  hasPendingChoicesForSession(sessionAgentId: string): boolean {
    return this.choiceService.hasPendingChoicesForSession(sessionAgentId);
  }

  getPendingChoiceIdsForSession(sessionAgentId: string): string[] {
    return this.choiceService.getPendingChoiceIdsForSession(sessionAgentId);
  }

  getPendingChoiceRequestsForSession(sessionAgentId: string): ChoiceRequestEvent[] {
    return this.choiceService.getPendingChoiceRequestsForSession(sessionAgentId);
  }

  getPendingChoiceOwner(choiceId: string): { agentId: string; sessionAgentId: string } | undefined {
    return this.choiceService.getPendingChoiceOwner(choiceId);
  }

  getPendingChoice(choiceId: string): {
    agentId: string;
    sessionAgentId: string;
    questions: ChoiceQuestion[];
  } | undefined {
    return this.choiceService.getPendingChoice(choiceId);
  }

  async createSession(
    profileId: string,
    options?: {
      label?: string;
      name?: string;
      sessionAgentId?: string;
      sessionPurpose?: AgentDescriptor["sessionPurpose"];
      cli?: AgentDescriptor["cli"];
    }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    this.assertProfileNotArchived(profileId);
    const createdSession = await this.sessionService.createSession(profileId, options);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: createdSession.sessionAgent
    });
    return createdSession;
  }

  async createSessionWithOverrides(
    profileId: string,
    options: {
      label?: string;
      name?: string;
      sessionAgentId?: string;
      sessionPurpose?: AgentDescriptor["sessionPurpose"];
      cli?: AgentDescriptor["cli"];
    } = {},
    overrides: {
      model?: AgentModelDescriptor;
      cwd?: string;
      sessionSystemPrompt?: string;
      sessionSurface?: AgentDescriptor["sessionSurface"];
      collab?: AgentDescriptor["collab"];
    } = {}
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    this.assertProfileNotArchived(profileId);
    const createdSession = await this.sessionService.createSessionWithOverrides(
      profileId,
      options,
      overrides,
    );
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: createdSession.sessionAgent
    });
    return createdSession;
  }

  async createSessionFromBaseDescriptor(
    profileId: string,
    base: {
      model: AgentModelDescriptor;
      cwd: string;
      archetypeId?: AgentDescriptor["archetypeId"];
      sessionSystemPrompt?: string;
    },
    options: {
      label?: string;
      name?: string;
      sessionAgentId?: string;
      sessionPurpose?: AgentDescriptor["sessionPurpose"];
      cli?: AgentDescriptor["cli"];
    } = {},
    overrides: {
      sessionSurface?: AgentDescriptor["sessionSurface"];
      collab?: AgentDescriptor["collab"];
    } = {}
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    this.assertProfileNotArchived(profileId);
    const createdSession = await this.sessionService.createSessionFromBaseDescriptor(
      profileId,
      base,
      options,
      overrides,
    );
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: createdSession.sessionAgent
    });
    return createdSession;
  }

  async createSessionFromAgent(
    creatorAgentId: string,
    params: {
      sessionName: string;
      cwd?: string;
      model?: unknown;
      reasoningLevel?: unknown;
      systemPrompt?: string;
      initialMessage?: string;
    }
  ): Promise<{ sessionAgentId: string; sessionLabel: string; profileId: string }> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(creatorAgentId, "create_session");

    const creatorDescriptor = this.getRequiredSessionDescriptor(creatorAgentId);
    this.assertDescriptorNotEffectivelyArchived(creatorDescriptor);

    if (creatorDescriptor.role !== "manager") {
      throw new Error(`Only manager sessions can create child sessions: ${creatorAgentId}`);
    }

    if (!creatorDescriptor.projectAgent?.capabilities?.includes("create_session")) {
      throw new Error("Session creation is not allowed for this project agent");
    }

    const profileId = creatorDescriptor.profileId ?? creatorDescriptor.agentId;
    const normalizedSessionName = params.sessionName.trim();
    if (!normalizedSessionName) {
      throw new Error("sessionName must be a non-empty string");
    }

    const preset = parseSwarmModelPreset(params.model, "create_session.model");
    const parsedReasoningLevel = parseSwarmReasoningLevel(params.reasoningLevel, "create_session.reasoningLevel");
    const shouldOverrideModel = Boolean(
      preset || parsedReasoningLevel || creatorDescriptor.modelOrigin === "session_override"
    );

    const normalizedModel = shouldOverrideModel
      ? (() => {
          const resolvedModel = preset
            ? resolveModelDescriptorFromPreset(preset)
            : { ...creatorDescriptor.model };

          if (parsedReasoningLevel) {
            resolvedModel.thinkingLevel = parsedReasoningLevel;
          }

          return {
            ...resolvedModel,
            provider: normalizeOptionalAgentId(resolvedModel.provider)?.toLowerCase() ?? resolvedModel.provider,
            modelId: normalizeOptionalModelId(resolvedModel.modelId)?.toLowerCase() ?? resolvedModel.modelId,
            thinkingLevel: normalizeThinkingLevelForProvider(
              resolvedModel.provider,
              resolvedModel.thinkingLevel
            )
          };
        })()
      : undefined;

    const normalizedSystemPrompt = params.systemPrompt?.trim();
    const normalizedCwd = params.cwd?.trim();
    const createdSession = await this.sessionService.createSessionWithOverrides(
      profileId,
      {
        name: normalizedSessionName,
        label: normalizedSessionName,
        sessionPurpose: undefined,
      },
      {
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(normalizedCwd ? { cwd: await this.resolveAndValidateCwd(normalizedCwd) } : {}),
        ...(normalizedSystemPrompt !== undefined ? { sessionSystemPrompt: normalizedSystemPrompt } : {})
      }
    );

    const targetAgentId = createdSession.sessionAgent.agentId;
    createdSession.sessionAgent.creatorAgentId = creatorDescriptor.agentId;

    const targetDescriptor = await this.descriptorStoreAdapter.patchDescriptor(targetAgentId, {
      creatorAgentId: creatorDescriptor.agentId,
    });
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    if (params.initialMessage?.trim()) {
      try {
        await this.sendMessage(creatorAgentId, targetAgentId, params.initialMessage.trim(), "auto");
      } catch (error) {
        // Roll back the half-created session so a failed initial-message delivery
        // does not leak a session the caller cannot reach.
        try {
          await this.sessionService.deleteSession(targetAgentId);
        } catch (rollbackError) {
          this.logDebug("createSessionFromAgent rollback failed", {
            creatorAgentId,
            targetAgentId,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          });
        }
        throw error;
      }
    }

    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: cloneDescriptor(targetDescriptor)
    });

    return {
      sessionAgentId: targetAgentId,
      sessionLabel: targetDescriptor.sessionLabel ?? targetDescriptor.displayName,
      profileId
    };
  }

  async createAndPromoteProjectAgent(
    creatorAgentId: string,
    params: {
      sessionName: string;
      handle?: string;
      whenToUse: string;
      systemPrompt: string;
      capabilities?: NonNullable<AgentDescriptor["projectAgent"]>["capabilities"];
    }
  ): Promise<{ agentId: string; handle: string; profileId: string }> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(creatorAgentId, "create_project_agent");

    const createdProjectAgent = await this.projectAgentService.createAndPromoteProjectAgent(creatorAgentId, params);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: cloneDescriptor(this.getRequiredSessionDescriptor(createdProjectAgent.agentId))
    });
    return createdProjectAgent;
  }

  async archiveSession(agentId: string): Promise<{ agentId: string; profileId: string; archivedAt: string; terminatedWorkerIds: string[] }> {
    this.codexPluginScopeService.closeScopesForManager(agentId);
    this.clearCodexPluginRetryContextForManager(agentId);
    const result = await this.archiveService.archiveSession(agentId);
    this.emitSessionActiveToolsSnapshot(this.sessionActiveTools.clearSession(agentId));
    this.emitAgentsSnapshot();
    return result;
  }

  async restoreSession(agentId: string): Promise<{ agentId: string; profileId: string; openAgentId?: string }> {
    const result = await this.archiveService.restoreSession(agentId);
    this.emitAgentsSnapshot();
    return result;
  }

  async hydrateArchivedLastUsed(): Promise<ArchiveLastUsedHydrationResult> {
    const result = await this.archiveLastUsedHydrator.hydrateArchivedRowsIfMissing();
    if (result.hydratedSessionCount > 0) {
      this.emitAgentsSnapshot();
    }
    return result;
  }

  async archiveProfile(profileId: string): Promise<{ profileId: string; archivedAt: string; terminatedWorkerIds: string[] }> {
    for (const session of this.getSessionsForProfile(profileId)) {
      this.codexPluginScopeService.closeScopesForManager(session.agentId);
      this.clearCodexPluginRetryContextForManager(session.agentId);
    }
    const result = await this.archiveService.archiveProfile(profileId);
    for (const session of this.getSessionsForProfile(profileId)) {
      this.emitSessionActiveToolsSnapshot(this.sessionActiveTools.clearSession(session.agentId));
    }
    try {
      await this.terminalArchiveHooks?.suspendProfileTerminals(profileId);
    } catch (error) {
      this.logDebug("archive:terminal_suspend:error", {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.emitProfilesSnapshot();
    this.emitAgentsSnapshot();
    this.emitSessionLifecycle({
      action: "archived",
      sessionAgentId: profileId,
      profileId,
    });
    return result;
  }

  async restoreProfile(profileId: string): Promise<{ profileId: string; openAgentId: string }> {
    const result = await this.archiveService.restoreProfile(profileId);
    try {
      await this.terminalArchiveHooks?.restoreProfileTerminals(profileId);
    } catch (error) {
      this.logDebug("archive:terminal_restore:error", {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.emitProfilesSnapshot();
    this.emitSessionLifecycle({
      action: "restored",
      sessionAgentId: profileId,
      profileId,
    });
    return result;
  }

  async stopSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    this.getRequiredBuilderSessionDescriptor(agentId, "stop Builder sessions");
    this.codexPluginScopeService.closeScopesForManager(agentId);
    this.clearCodexPluginRetryContextForManager(agentId);
    const result = await this.lifecycleService.stopSession(agentId);
    this.emitSessionActiveToolsSnapshot(this.sessionActiveTools.clearSession(agentId));
    return result;
  }

  async stopCollaborationSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    this.getRequiredCollaborationSessionDescriptor(agentId, "stop collaboration sessions");
    this.codexPluginScopeService.closeScopesForManager(agentId);
    this.clearCodexPluginRetryContextForManager(agentId);
    const result = await this.lifecycleService.stopSession(agentId);
    this.emitSessionActiveToolsSnapshot(this.sessionActiveTools.clearSession(agentId));
    return result;
  }

  async resumeSession(agentId: string): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "resume Builder sessions");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    await this.applyPendingManagerRuntimeRecycleBeforeRuntimeUse(descriptor as AgentDescriptor & { role: "manager" });
    await this.lifecycleService.resumeSession(agentId);
  }

  async deleteCollaborationSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    this.codexPluginScopeService.closeScopesForManager(agentId);
    this.clearCodexPluginRetryContextForManager(agentId);
    const deletedSessionDescriptor = cloneDescriptor(
      this.getRequiredCollaborationSessionDescriptor(agentId, "delete collaboration sessions")
    );
    const result = await this.sessionService.deleteCollaborationSession(agentId);
    this.emitSessionActiveToolsSnapshot(this.sessionActiveTools.clearSession(agentId));
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "deleted",
      sessionDescriptor: deletedSessionDescriptor
    });
    return result;
  }

  async deleteSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    this.codexPluginScopeService.closeScopesForManager(agentId);
    this.clearCodexPluginRetryContextForManager(agentId);
    const deletedSessionDescriptor = cloneDescriptor(
      this.getRequiredBuilderSessionDescriptor(agentId, "delete Builder sessions")
    );
    const result = await this.sessionService.deleteSession(agentId);
    this.emitSessionActiveToolsSnapshot(this.sessionActiveTools.clearSession(agentId));
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "deleted",
      sessionDescriptor: deletedSessionDescriptor
    });
    return result;
  }

  async pinMessage(
    agentId: string,
    messageId: string,
    pinned: boolean
  ): Promise<{ pinned: boolean; timestamp: string }> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    const sessionDir = this.getSessionDirForDescriptor(descriptor);
    const history = this.getConversationHistory(agentId);
    const message = history.find(
      (entry): entry is ConversationMessageEvent & { role: "user" | "assistant" } => (
        entry.type === "conversation_message" &&
        entry.id === messageId &&
        (entry.role === "user" || entry.role === "assistant")
      )
    );

    if (pinned && !message) {
      throw new Error(`Message not found or not pinnable: ${messageId}`);
    }

    const registry = await togglePin(
      sessionDir,
      messageId,
      pinned,
      message
        ? {
            role: message.role,
            text: message.text,
            timestamp: message.timestamp,
            attachments: message.attachments
          }
        : undefined
    );

    await this.syncPinnedContentForManagerRuntime(descriptor, { registry });
    this.conversationProjector.setConversationMessagePinned(agentId, messageId, pinned);

    const runtime = this.runtimes.get(agentId);
    if (runtime) {
      await this.captureSessionRuntimePromptMeta(descriptor, runtime.getSystemPrompt?.());
    }

    const timestamp = this.now();
    this.logDebug("message:pin", {
      agentId,
      messageId,
      pinned
    });

    return {
      pinned,
      timestamp
    };
  }

  async clearAllPins(agentId: string): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "clear Builder pins");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    const sessionDir = this.getSessionDirForDescriptor(descriptor);
    const previouslyPinnedMessageIds = await clearAllSessionPins(sessionDir);

    const emptyRegistry: PinRegistry = { version: 1, pins: {} };
    await this.syncPinnedContentForManagerRuntime(descriptor, { registry: emptyRegistry });

    const runtime = this.runtimes.get(agentId);
    if (runtime) {
      await this.captureSessionRuntimePromptMeta(descriptor, runtime.getSystemPrompt?.());
    }

    if (previouslyPinnedMessageIds.length === 0) {
      return;
    }

    for (const messageId of previouslyPinnedMessageIds) {
      this.conversationProjector.setConversationMessagePinned(agentId, messageId, false);
      this.emitMessagePinned(agentId, messageId, false, this.now());
    }

    this.logDebug("message:clear_all_pins", {
      agentId,
      clearedCount: previouslyPinnedMessageIds.length
    });
  }

  async clearSessionConversation(agentId: string): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "clear Builder conversations");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    await this.sessionService.clearSessionConversation(agentId);
    this.emitSessionActiveToolsSnapshot(this.sessionActiveTools.clearSession(agentId));
  }

  async pinSession(agentId: string, pinned: boolean): Promise<{ pinnedAt: string | null }> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "pin Builder sessions");
    this.assertDescriptorNotEffectivelyArchived(descriptor);

    const updatedDescriptor = await this.descriptorStoreAdapter.patchDescriptor(agentId, (current) => {
      if (pinned) {
        current.pinnedAt = current.pinnedAt ?? this.now();
      } else {
        delete current.pinnedAt;
      }
      return current;
    });
    this.emitAgentsSnapshot();

    return {
      pinnedAt: updatedDescriptor.pinnedAt ?? null
    };
  }

  async activateRepoProjectAgent(
    request: ActivateRepoProjectAgentRequest
  ): Promise<{ profileId: string; agentId: string; projectAgent: NonNullable<AgentDescriptor["projectAgent"]> }> {
    const sourceDescriptor = this.getRequiredBuilderSessionDescriptor(
      request.sessionAgentId,
      "activate repository project agents"
    );
    this.assertDescriptorNotEffectivelyArchived(sourceDescriptor);
    const profileId = sourceDescriptor.profileId ?? sourceDescriptor.agentId;
    if (request.profileId !== profileId) {
      throw new Error("Session does not belong to the requested profile.");
    }

    const settingsStore = new ProjectResourceSettingsStore(this.config.paths.dataDir);
    const resolver = new ProjectWorkspaceResolver({ dataDir: this.config.paths.dataDir, settingsStore });
    const resolution = await resolver.resolve({
      profileId,
      sessionAgentId: sourceDescriptor.agentId,
      cwd: sourceDescriptor.cwd
    });
    if (resolution.warning) {
      throw new Error(resolution.warning);
    }
    if (!resolution.effectiveForgeDirRealpath || !resolution.repoRootResources.projectAgentsDir) {
      throw new Error("No repository project-agent definitions directory is available for this workspace.");
    }

    const inventory = await scanRepoProjectAgentDefinitions(resolution.repoRootResources.projectAgentsDir);
    if (inventory.problems?.length) {
      throw new Error(`Repository project-agent definitions are unavailable: ${inventory.problems.map((problem) => problem.message).join("; ")}`);
    }
    const item = inventory.items.find((candidate) => candidate.definitionId === request.definitionId);
    if (!item) {
      throw new Error(`Repository project-agent definition not found: ${request.definitionId}`);
    }
    if (item.status !== "valid") {
      throw new Error(`Repository project-agent definition ${request.definitionId} is ${item.status}: ${item.problems.map((problem) => problem.message).join("; ")}`);
    }
    const definition = inventory.definitions.find((candidate) => candidate.definitionId === request.definitionId);
    if (!definition) {
      throw new Error(`Repository project-agent definition ${request.definitionId} is not activatable.`);
    }

    const result = await this.projectAgentService.activateRepoProjectAgent({
      profileId,
      sourceSessionAgentId: sourceDescriptor.agentId,
      mode: request.mode,
      definition,
      source: {
        type: "repo",
        workspaceKey: resolution.workspaceKey,
        forgeDirRealpath: resolution.effectiveForgeDirRealpath,
        definitionId: definition.definitionId,
        activatedAt: this.now(),
        signature: definition.signature
      },
      ...(request.targetAgentId ? { targetAgentId: request.targetAgentId } : {}),
      applyRecommendedModel: request.applyRecommendedModel,
      approvedCapabilities: request.approvedCapabilities,
      explicitBindToSourceWorkspace: request.explicitBindToSourceWorkspace,
      resolveSessionWorkspaceSource: async (descriptor) => {
        const targetResolution = await resolver.resolve({
          profileId: descriptor.profileId ?? descriptor.agentId,
          sessionAgentId: descriptor.agentId,
          cwd: descriptor.cwd
        });
        return {
          workspaceKey: targetResolution.workspaceKey,
          ...(targetResolution.effectiveForgeDirRealpath ? { forgeDirRealpath: targetResolution.effectiveForgeDirRealpath } : {})
        };
      }
    });

    await this.notifySharedProjectAgentTargetsChanged(result.agentId);

    return {
      ...result,
      projectAgent: cloneProjectAgentInfoValue(result.projectAgent) as NonNullable<AgentDescriptor["projectAgent"]>
    };
  }

  async setSessionProjectAgent(
    agentId: string,
    projectAgent:
      | {
          whenToUse: string;
          systemPrompt?: string;
          handle?: string;
          capabilities?: NonNullable<AgentDescriptor["projectAgent"]>["capabilities"];
        }
      | null
  ): Promise<{ profileId: string; projectAgent: NonNullable<AgentDescriptor["projectAgent"]> | null }> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "promote Builder sessions to project agents");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    this.assertSessionSupportsProjectAgent(descriptor);
    const previousProjectAgent = descriptor.projectAgent;
    const result = await this.projectAgentService.setSessionProjectAgent(agentId, projectAgent);
    const nextProjectAgent = this.descriptors.get(agentId)?.projectAgent;
    const promptChanged = previousProjectAgent?.systemPrompt !== nextProjectAgent?.systemPrompt;
    const directoryChanged =
      previousProjectAgent?.handle !== nextProjectAgent?.handle ||
      previousProjectAgent?.whenToUse !== nextProjectAgent?.whenToUse ||
      JSON.stringify(previousProjectAgent?.capabilities ?? []) !== JSON.stringify(nextProjectAgent?.capabilities ?? []);
    if (promptChanged && !directoryChanged) {
      await this.notifyProjectAgentPromptSourceChanged(agentId);
    }
    if (directoryChanged) {
      await this.notifySharedProjectAgentTargetsChanged(agentId);
    }
    return result;
  }

  async requestProjectAgentRecommendations(agentId: string): Promise<ProjectAgentRecommendations> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(
      agentId,
      "request project-agent recommendations for Builder sessions"
    );
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    this.assertSessionSupportsProjectAgent(descriptor);

    const [conversationHistory, currentSystemPrompt, analysisModel] = await Promise.all([
      Promise.resolve(this.getConversationHistory(agentId)),
      this.buildResolvedManagerPrompt(descriptor, { ignoreProjectAgentSystemPrompt: true }),
      this.resolveProjectAgentAnalysisModel()
    ]);

    return this.executeProjectAgentAnalysis(analysisModel.model, {
      conversationHistory,
      currentSystemPrompt,
      sessionAgentId: descriptor.agentId,
      sessionLabel: descriptor.sessionLabel ?? descriptor.displayName ?? descriptor.agentId,
      displayName: descriptor.displayName,
      profileId: descriptor.profileId,
      sessionCwd: descriptor.cwd,
      apiKey: analysisModel.apiKey,
      headers: analysisModel.headers
    });
  }

  async renameSession(agentId: string, label: string): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "rename Builder sessions");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    const wasProjectAgent = Boolean(descriptor.projectAgent);
    await this.sessionService.renameSession(agentId, label);
    if (wasProjectAgent) {
      await this.notifySharedProjectAgentTargetsChanged(agentId);
    }
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "renamed",
      sessionDescriptor: cloneDescriptor(this.getRequiredSessionDescriptor(agentId))
    });
  }

  async renameProfile(profileId: string, displayName: string): Promise<void> {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }
    const sharedProjectAgentIds = Array.from(this.descriptors.values())
      .filter((descriptor) => descriptor.role === "manager" && descriptor.profileId === profileId && descriptor.projectAgent)
      .map((descriptor) => descriptor.agentId);
    this.assertProfileNotArchived(profileId);
    const normalizedName = displayName.trim();
    if (!normalizedName) {
      throw new Error("Profile display name must be non-empty");
    }
    await this.descriptorStoreAdapter.patchProfile(profileId, {
      displayName: normalizedName,
      updatedAt: this.now(),
    });
    if (sharedProjectAgentIds.length > 0) {
      await Promise.all(sharedProjectAgentIds.map((agentId) => this.notifySharedProjectAgentTargetsChanged(agentId)));
    }
    this.emitProfilesSnapshot();
    this.emitAgentsSnapshot();
  }

  async mergeSessionMemory(agentId: string): Promise<SessionMemoryMergeResult> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "merge Builder session memory");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    return this.memoryMergeService.mergeSessionMemory(agentId);
  }

  async forkSession(
    sourceAgentId: string,
    options?: { label?: string; fromMessageId?: string }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const sourceDescriptor = cloneDescriptor(
      this.getRequiredBuilderSessionDescriptor(sourceAgentId, "fork Builder sessions")
    );
    this.assertDescriptorNotEffectivelyArchived(sourceDescriptor);
    const forkedSession = await this.sessionService.forkSession(sourceAgentId, options);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "forked",
      sessionDescriptor: forkedSession.sessionAgent,
      sourceDescriptor
    });
    return forkedSession;
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(callerAgentId, "spawn_agent");
    const requestedSpecialistId = input.specialist ? specialistNormalizeSpecialistHandle(input.specialist) : "";
    if (requestedSpecialistId === CODEX_PLUGIN_SPECIALIST_ID) {
      return this.spawnCodexPluginSpecialistWorker(callerAgentId, input);
    }

    return this.lifecycleService.spawnAgent(callerAgentId, input);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    this.assertExternalProjectAgentTurnCapabilityAllowed(callerAgentId, "kill_agent");
    await this.lifecycleService.killAgent(callerAgentId, targetAgentId);
  }

  async stopWorker(agentId: string): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (isCodexPluginWorkerDescriptor(descriptor)) {
      this.stoppedCodexPluginWorkersById.add(agentId);
    }

    this.codexPluginScopeService.closeScopeForWorker(agentId);
    await this.lifecycleService.stopWorker(agentId);
  }

  async resumeWorker(agentId: string): Promise<void> {
    await this.lifecycleService.resumeWorker(agentId);
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
    terminatedWorkerIds: string[];
    managerTerminated: boolean;
  }> {
    this.codexPluginScopeService.closeScopesForManager(targetManagerId);
    this.clearCodexPluginRetryContextForManager(targetManagerId);
    return this.lifecycleService.stopAllAgents(callerAgentId, targetManagerId);
  }

  async createManager(
    callerAgentId: string,
    input: { name: string; cwd: string; model?: SwarmModelPreset; modelSelection?: ManagerExactModelSelection; reasoningLevel?: SwarmReasoningLevel }
  ): Promise<AgentDescriptor> {
    const createdManager = await this.lifecycleService.createManager(callerAgentId, input);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: createdManager
    });
    return createdManager;
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    const profile = this.profiles.get(targetManagerId);
    const sessionDescriptors: AgentDescriptor[] = profile ? this.getSessionsForProfile(profile.profileId) : [];

    if (sessionDescriptors.length === 0) {
      const target = this.descriptors.get(targetManagerId);
      if (target?.role === "manager") {
        sessionDescriptors.push(target);
      }
    }

    for (const sessionDescriptor of sessionDescriptors) {
      this.codexPluginScopeService.closeScopesForManager(sessionDescriptor.agentId);
      this.clearCodexPluginRetryContextForManager(sessionDescriptor.agentId);
    }

    const deletedSessionDescriptors = sessionDescriptors.map((sessionDescriptor) => cloneDescriptor(sessionDescriptor));
    const result = await this.lifecycleService.deleteManager(callerAgentId, targetManagerId);

    for (const sessionDescriptor of deletedSessionDescriptors) {
      await this.forgeExtensionHost.dispatchSessionLifecycle({
        action: "deleted",
        sessionDescriptor
      });
    }

    return result;
  }

  async updateManagerModel(
    managerId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    this.assertManagerSettingsTargetNotArchived(managerId, "update manager model");
    await this.settingsService.updateManagerModel(managerId, modelPreset, reasoningLevel);
  }

  async updateCollaborationSessionModel(
    sessionAgentId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    const descriptor = this.getRequiredCollaborationSessionDescriptor(sessionAgentId, "update collaboration session model");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    await this.settingsService.updateManagerModel(sessionAgentId, modelPreset, reasoningLevel);
  }

  async updateManagerExactModel(
    managerId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<AgentDescriptor["model"]> {
    this.assertManagerSettingsTargetNotArchived(managerId, "update manager model");
    return this.settingsService.updateManagerExactModel(managerId, modelSelection, reasoningLevel);
  }

  async updateProfileDefaultModel(
    profileId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    this.assertProfileNotArchived(profileId);
    await this.settingsService.updateProfileDefaultModel(profileId, modelPreset, reasoningLevel);
  }

  async updateProfileDefaultExactModel(
    profileId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<AgentDescriptor["model"]> {
    this.assertProfileNotArchived(profileId);
    return this.settingsService.updateProfileDefaultExactModel(profileId, modelSelection, reasoningLevel);
  }

  async updateSessionModel(
    sessionAgentId: string,
    mode: "inherit" | "override",
    modelPreset?: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(sessionAgentId, "update Builder session model");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    await this.settingsService.updateSessionModel(sessionAgentId, mode, modelPreset, reasoningLevel);
  }

  async updateSessionExactModel(
    sessionAgentId: string,
    modelSelection: ManagerExactModelSelection,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<AgentDescriptor["model"]> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(sessionAgentId, "update Builder session model");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    return this.settingsService.updateSessionExactModel(sessionAgentId, modelSelection, reasoningLevel);
  }

  async updateManagerCwd(managerId: string, newCwd: string): Promise<string> {
    this.assertProfileNotArchived(managerId);
    return this.settingsService.updateManagerCwd(managerId, newCwd);
  }

  async notifyModelSpecificInstructionsChanged(modelKeys: string[]): Promise<void> {
    await this.settingsService.notifyModelSpecificInstructionsChanged(modelKeys);
  }

  private assertCanChangeManagerCwd(
    profileId: string,
    sessions: Array<AgentDescriptor & { role: "manager"; profileId: string }>
  ): void {
    if (
      profileId === CORTEX_PROFILE_ID ||
      sessions.some((descriptor) => normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID)
    ) {
      throw new Error("Cannot change working directory for Cortex profile");
    }
  }

  async notifySpecialistRosterChanged(profileId: string, options?: { sessionAgentId?: string }): Promise<void> {
    await this.lifecycleService.notifySpecialistRosterChanged(profileId, options);
  }

  async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    const sessions = this.getSessionsForProfile(profileId);
    const results = await Promise.allSettled(
      sessions.map((session) => this.applyManagerRuntimeRecyclePolicy(session.agentId, "project_agent_directory_change")),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.logDebug("project_agents:directory_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  private async notifyProjectAgentPromptSourceChanged(agentId: string): Promise<void> {
    try {
      await this.applyManagerRuntimeRecyclePolicy(agentId, "prompt_mode_change");
    } catch (error) {
      this.logDebug("project_agent:prompt_source_change:recycle:error", {
        agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason
  ): Promise<"recycled" | "deferred" | "none"> {
    const disposition = await this.lifecycleService.applyManagerRuntimeRecyclePolicy(agentId, reason);
    if (disposition !== "deferred") {
      const finalized = await this.finalizePendingProjectExecutableTrustActivationBoundary(agentId);
      if (finalized) {
        await this.saveStore();
        this.emitAgentsSnapshot();
      }
    }
    return disposition;
  }

  private async applyPendingManagerRuntimeRecycleBeforeRuntimeUse(
    descriptor: AgentDescriptor & { role: "manager" }
  ): Promise<void> {
    if (!this.runtimeRecoveryState.hasPendingManagerRuntimeRecycle(descriptor.agentId)) {
      return;
    }

    await this.applyManagerRuntimeRecyclePolicy(descriptor.agentId, "idle_transition");
  }

  private async finalizePendingProjectExecutableTrustActivationBoundary(agentId: string): Promise<boolean> {
    const hadPendingActivation = this.pendingProjectExecutableTrustActivationByManagerId.has(agentId);
    const workersInvalidated = await this.invalidatePendingProjectExecutableTrustWorkers(agentId);
    if (hadPendingActivation) {
      this.clearPendingProjectExecutableTrustActivationForManager(agentId);
    }
    return hadPendingActivation || workersInvalidated;
  }

  private async invalidatePendingProjectExecutableTrustWorkers(agentId: string): Promise<boolean> {
    const trustKey = this.pendingProjectExecutableWorkerInvalidationByManagerId.get(agentId);
    if (!trustKey) {
      return false;
    }

    const workers = Array.from(this.descriptors.values()).filter(
      (descriptor) => descriptor.role === "worker" && descriptor.managerId === agentId
    );
    if (workers.length === 0) {
      this.pendingProjectExecutableWorkerInvalidationByManagerId.delete(agentId);
      return false;
    }

    const workerResults = await Promise.allSettled(
      workers.map((worker) => this.terminateDescriptor(worker, { abort: true, emitStatus: true }))
    );
    this.logProjectTrustPropagationFailures(workers, workerResults, [], []);

    if (workerResults.every((result) => result.status === "fulfilled")) {
      this.pendingProjectExecutableWorkerInvalidationByManagerId.delete(agentId);
    }

    return workerResults.some((result) => result.status === "fulfilled");
  }

  async previewManagerSystemPrompt(profileId: string): Promise<PromptPreviewResponse> {
    return this.promptService.previewManagerSystemPrompt(profileId);
  }

  async previewManagerSystemPromptForAgent(agentId: string): Promise<PromptPreviewResponse> {
    return this.promptService.previewManagerSystemPromptForAgent(agentId);
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return undefined;
    }

    return cloneDescriptor(descriptor);
  }

  getAgentForInternalUse(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return undefined;
    }

    return cloneDescriptorForPersistence(descriptor);
  }

  async getProjectAgentConfig(agentId: string): Promise<{
    config: import("@forge/protocol").PersistedProjectAgentConfig;
    systemPrompt: string | null;
    references: string[];
    source?: import("@forge/protocol").ProjectAgentConfigSourceSnapshot;
  }> {
    this.getRequiredBuilderSessionDescriptor(agentId, "inspect Builder project-agent settings");
    return this.projectAgentService.getProjectAgentConfig(agentId);
  }

  async getProjectAgentSharing(agentId: string) {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "manage project-agent sharing");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    if (!descriptor.projectAgent) {
      throw new Error("Session is not a project agent");
    }
    return this.projectAgentSharingService.getSharingSnapshot(agentId);
  }

  async setProjectAgentSharing(agentId: string, targetProfileIds: readonly string[]) {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "manage project-agent sharing");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    if (!descriptor.projectAgent) {
      throw new Error("Session is not a project agent");
    }
    const result = await this.projectAgentSharingService.replaceSharingTargets(agentId, targetProfileIds);
    const affectedTargetProfileIds = [...result.addedTargetProfileIds, ...result.removedTargetProfileIds];
    await this.notifySharedProjectAgentTargetsChanged(agentId, affectedTargetProfileIds);
    return result;
  }

  async getProjectAgentExternalDirectory(profileId: string) {
    const profile = this.profiles.get(profileId);
    if (profile && isSystemProfile(profile)) {
      return [];
    }
    return this.getSourceAwareExternalProjectAgentDirectoryEntries(profileId);
  }

  private async getSourceAwareExternalProjectAgentDirectoryEntries(
    profileId: string,
  ): Promise<ProjectAgentExternalDirectoryEntry[]> {
    const entries = this.projectAgentSharingService.getExternalDirectoryEntries(profileId);
    const filteredEntries: ProjectAgentExternalDirectoryEntry[] = [];

    for (const entry of entries) {
      const sourceDescriptor = this.descriptors.get(entry.agentId);
      if (!sourceDescriptor || sourceDescriptor.role !== "manager" || !isRepoProjectAgentSource(sourceDescriptor.projectAgent?.source)) {
        filteredEntries.push(entry);
        continue;
      }

      try {
        await this.assertRepoProjectAgentSourceAvailableForDirectory(sourceDescriptor as AgentDescriptor & {
          role: "manager";
          projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
        });
        filteredEntries.push(entry);
      } catch (error) {
        this.logDebug("project_agent:external_directory:exclude_unavailable_repo_source", {
          profileId,
          sourceAgentId: entry.agentId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return filteredEntries;
  }

  private async resolveRepoProjectAgentSourceForDescriptor(
    descriptor: AgentDescriptor & {
      role: "manager";
      profileId?: string;
      projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
    },
  ): Promise<RepoProjectAgentSourceResolution> {
    return resolveRepoProjectAgentSource({
      descriptor: descriptor as AgentDescriptor & {
        role: "manager";
        profileId: string;
        projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
      },
      profileId: descriptor.profileId ?? descriptor.agentId,
      handle: descriptor.projectAgent.handle,
    }, { dataDir: this.config.paths.dataDir });
  }

  private async assertRepoProjectAgentSourceAvailableForDirectory(
    descriptor: AgentDescriptor & {
      role: "manager";
      projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
    },
  ): Promise<void> {
    const resolution = await this.resolveRepoProjectAgentSourceForDescriptor(descriptor);
    try {
      assertRepoProjectAgentSourceAvailable(resolution);
    } catch (error) {
      await this.notifyUnavailableSharedRepoProjectAgentSource(descriptor, resolution);
      throw error;
    }
  }

  private async assertRepoProjectAgentSourceAvailableForExternalDelivery(
    descriptor: AgentDescriptor & {
      role: "manager";
      projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
    },
  ): Promise<void> {
    let resolution: RepoProjectAgentSourceResolution | undefined;
    try {
      resolution = await this.resolveRepoProjectAgentSourceForDescriptor(descriptor);
      assertRepoProjectAgentSourceAvailable(resolution);
    } catch {
      if (resolution) {
        await this.notifyUnavailableSharedRepoProjectAgentSource(descriptor, resolution);
      } else {
        await this.notifySharedProjectAgentTargetsChanged(descriptor.agentId);
      }
      throw new Error(this.formatUnavailableSharedRepoProjectAgentSourceError(descriptor, resolution));
    }
  }

  private async notifyUnavailableSharedRepoProjectAgentSource(
    descriptor: AgentDescriptor & {
      role: "manager";
      projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
    },
    resolution: RepoProjectAgentSourceResolution,
  ): Promise<void> {
    if (resolution.source.status === "valid") {
      return;
    }

    await this.notifySharedProjectAgentTargetsChanged(descriptor.agentId);
  }

  private formatUnavailableSharedRepoProjectAgentSourceError(
    descriptor: AgentDescriptor & {
      role: "manager";
      projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
    },
    resolution?: RepoProjectAgentSourceResolution,
  ): string {
    const handle = descriptor.projectAgent.handle ? ` @${descriptor.projectAgent.handle}` : "";
    const status = resolution?.source.status ?? "unavailable";
    return `Shared project agent${handle} is unavailable because its repository source is ${status}. Ask the source project to restore or refresh the repository project-agent definition.`;
  }

  async listProjectAgentReferences(agentId: string): Promise<string[]> {
    this.getRequiredBuilderSessionDescriptor(agentId, "list Builder project-agent references");
    return this.projectAgentService.listProjectAgentReferences(agentId);
  }

  async getProjectAgentReference(agentId: string, fileName: string): Promise<string> {
    this.getRequiredBuilderSessionDescriptor(agentId, "read Builder project-agent references");
    return this.projectAgentService.getProjectAgentReference(agentId, fileName);
  }

  async setProjectAgentReference(agentId: string, fileName: string, content: string): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "edit Builder project-agent references");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    const flags = await this.projectAgentService.setProjectAgentReference(agentId, fileName, content);
    if (flags.referenceChanged) {
      await this.notifyProjectAgentPromptSourceChanged(agentId);
    }
  }

  async deleteProjectAgentReference(agentId: string, fileName: string): Promise<void> {
    const descriptor = this.getRequiredBuilderSessionDescriptor(agentId, "delete Builder project-agent references");
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    const flags = await this.projectAgentService.deleteProjectAgentReference(agentId, fileName);
    if (flags.referenceChanged) {
      await this.notifyProjectAgentPromptSourceChanged(agentId);
    }
  }

  async listDirectories(path?: string): Promise<DirectoryListingResult> {
    return this.settingsService.listDirectories(path);
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return this.settingsService.validateDirectory(path);
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    return this.settingsService.pickDirectory(defaultPath);
  }

  private isSessionAgent(
    descriptor: AgentDescriptor | undefined
  ): descriptor is AgentDescriptor & { role: "manager"; profileId: string } {
    return (
      !!descriptor &&
      descriptor.role === "manager" &&
      typeof descriptor.profileId === "string" &&
      descriptor.profileId.trim().length > 0
    );
  }

  private getRequiredSessionDescriptor(
    agentId: string
  ): AgentDescriptor & { role: "manager"; profileId: string } {
    const descriptor = this.descriptors.get(agentId);
    if (!this.isSessionAgent(descriptor)) {
      throw new Error(`Unknown session agent: ${agentId}`);
    }

    return descriptor;
  }

  private getRequiredBuilderSessionDescriptor(
    agentId: string,
    action: string
  ): AgentDescriptor & { role: "manager"; profileId: string } {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    assertBuilderSession(descriptor, action);
    return descriptor;
  }

  private getRequiredCollaborationSessionDescriptor(
    agentId: string,
    action: string
  ): AgentDescriptor & { role: "manager"; profileId: string } {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    assertCollabSession(descriptor, action);
    return descriptor;
  }

  private assertSessionSupportsProjectAgent(
    descriptor: AgentDescriptor & { role: "manager"; profileId: string }
  ): void {
    assertBuilderSession(descriptor, "promote Builder sessions to project agents");

    if (descriptor.agentId === CORTEX_PROFILE_ID && descriptor.profileId === CORTEX_PROFILE_ID) {
      throw new Error("Cortex root cannot be promoted to a project agent");
    }

    if (descriptor.sessionPurpose === "cortex_review") {
      throw new Error("Cortex review sessions cannot be promoted to project agents");
    }

    if (descriptor.sessionPurpose === "agent_creator") {
      throw new Error("Agent creator sessions cannot be promoted to project agents");
    }
  }


  private getSessionsForProfile(profileId: string): Array<AgentDescriptor & { role: "manager"; profileId: string }> {
    return Array.from(this.descriptors.values()).filter(
      (descriptor): descriptor is AgentDescriptor & { role: "manager"; profileId: string } =>
        descriptor.role === "manager" && descriptor.profileId === profileId
    );
  }

  private getBuilderSessionsForProfile(profileId: string): Array<AgentDescriptor & { role: "manager"; profileId: string }> {
    return this.getSessionsForProfile(profileId).filter((descriptor) => descriptor.sessionSurface !== "collab");
  }

  private getWorkersForManager(managerId: string): AgentDescriptor[] {
    return this.buildWorkerVisibilityGroups().workersByManagerId.get(managerId) ?? [];
  }

  private buildWorkerVisibilityGroups(): {
    managers: AgentDescriptor[];
    workersByManagerId: Map<string, AgentDescriptor[]>;
  } {
    const managers: AgentDescriptor[] = [];
    const workersByManagerId = new Map<string, AgentDescriptor[]>();

    for (const descriptor of this.sortedDescriptors()) {
      if (descriptor.role === "manager") {
        if (descriptor.sessionSurface !== "collab") {
          managers.push(descriptor);
        }
        continue;
      }

      const workers = workersByManagerId.get(descriptor.managerId);
      if (workers) {
        workers.push(descriptor);
      } else {
        workersByManagerId.set(descriptor.managerId, [descriptor]);
      }
    }

    return {
      managers,
      workersByManagerId
    };
  }

  private cloneManagerDescriptorWithWorkerCounts(descriptor: AgentDescriptor, workers: AgentDescriptor[]): AgentDescriptor {
    const clone = cloneDescriptor(descriptor);
    clone.workerCount = workers.length;
    clone.activeWorkerCount = workers.filter((worker) => worker.status === "streaming").length;
    clone.pendingChoiceCount = this.getPendingChoiceIdsForSession(clone.agentId).length;
    return clone;
  }

  private isSessionAgentIdReserved(profileId: string, agentId: string): boolean {
    if (this.descriptors.has(agentId)) {
      return true;
    }

    return existsSync(getSessionDir(this.config.paths.dataDir, profileId, agentId));
  }

  private generateSessionAgentIdentity(profileId: string): { agentId: string; sessionNumber: number } {
    const existingSessions = this.getBuilderSessionsForProfile(profileId);
    let highestSessionNumber = existingSessions.some((descriptor) => descriptor.agentId === profileId)
      ? ROOT_SESSION_NUMBER
      : 0;

    for (const descriptor of existingSessions) {
      const parsedSessionNumber = parseSessionNumberFromAgentId(descriptor.agentId, profileId);
      if (parsedSessionNumber !== undefined) {
        highestSessionNumber = Math.max(highestSessionNumber, parsedSessionNumber);
      }
    }

    let nextSessionNumber = Math.max(ROOT_SESSION_NUMBER + 1, highestSessionNumber + 1);
    let sessionAgentId = `${profileId}${SESSION_ID_SUFFIX_SEPARATOR}${nextSessionNumber}`;

    while (this.isSessionAgentIdReserved(profileId, sessionAgentId)) {
      nextSessionNumber += 1;
      sessionAgentId = `${profileId}${SESSION_ID_SUFFIX_SEPARATOR}${nextSessionNumber}`;
    }

    return {
      agentId: sessionAgentId,
      sessionNumber: nextSessionNumber
    };
  }

  private generateUniqueSessionAgentId(profileId: string, baseAgentId: string): string {
    let candidate = baseAgentId;
    let suffix = 2;

    while (this.isSessionAgentIdReserved(profileId, candidate)) {
      candidate = `${baseAgentId}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  private prepareSessionCreation(
    profileId: string,
    options?: {
      label?: string;
      name?: string;
      sessionAgentId?: string;
      sessionPurpose?: AgentDescriptor["sessionPurpose"];
      cli?: AgentDescriptor["cli"];
    }
  ): { profile: ManagerProfile; sessionDescriptor: AgentDescriptor; sessionNumber: number } {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const templateDescriptor = this.descriptors.get(profile.defaultSessionAgentId);
    if (!templateDescriptor || templateDescriptor.role !== "manager") {
      throw new Error(`Profile default session is missing: ${profile.defaultSessionAgentId}`);
    }

    if (templateDescriptor.sessionSurface === "collab") {
      throw new Error(`Profile default session must remain Builder-only: ${templateDescriptor.agentId}`);
    }

    return this.prepareSessionCreationFromBase(
      profileId,
      {
        model: cloneModelDescriptor(profile.defaultModel),
        modelOrigin: "profile_default",
        cwd: templateDescriptor.cwd,
        archetypeId: templateDescriptor.archetypeId,
        ...(templateDescriptor.sessionSystemPrompt !== undefined
          ? { sessionSystemPrompt: templateDescriptor.sessionSystemPrompt }
          : {})
      },
      options,
    );
  }

  private prepareSessionCreationFromBase(
    profileId: string,
    base: {
      model: AgentModelDescriptor;
      modelOrigin?: AgentDescriptor["modelOrigin"];
      cwd: string;
      archetypeId?: AgentDescriptor["archetypeId"];
      sessionSystemPrompt?: string;
    },
    options?: {
      label?: string;
      name?: string;
      sessionAgentId?: string;
      sessionPurpose?: AgentDescriptor["sessionPurpose"];
      cli?: AgentDescriptor["cli"];
    }
  ): { profile: ManagerProfile; sessionDescriptor: AgentDescriptor; sessionNumber: number } {
    const preparedIdentity = this.prepareSessionIdentity(profileId, options);
    const shouldApplyBaseSessionSystemPrompt =
      options?.sessionPurpose !== "agent_creator" && base.sessionSystemPrompt !== undefined;

    const sessionDescriptor: AgentDescriptor = {
      agentId: preparedIdentity.sessionAgentId,
      displayName: preparedIdentity.displayName,
      role: "manager",
      managerId: preparedIdentity.sessionAgentId,
      profileId: preparedIdentity.profile.profileId,
      sessionLabel: preparedIdentity.sessionLabel,
      sessionPurpose: options?.sessionPurpose,
      cli: sanitizeCliSessionMetadata(options?.cli),
      status: "idle",
      createdAt: preparedIdentity.createdAt,
      updatedAt: preparedIdentity.createdAt,
      cwd: base.cwd,
      model: { ...base.model },
      ...(base.modelOrigin !== undefined ? { modelOrigin: base.modelOrigin } : {}),
      sessionFile: getSessionFilePath(
        this.config.paths.dataDir,
        preparedIdentity.profile.profileId,
        preparedIdentity.sessionAgentId,
      ),
      ...(base.archetypeId !== undefined ? { archetypeId: base.archetypeId } : {}),
      ...(shouldApplyBaseSessionSystemPrompt ? { sessionSystemPrompt: base.sessionSystemPrompt } : {})
    };

    if (sessionDescriptor.sessionPurpose === "agent_creator") {
      sessionDescriptor.archetypeId = "agent-architect";
      if (
        !sessionDescriptor.sessionLabel ||
        sessionDescriptor.sessionLabel === `Session ${preparedIdentity.sessionNumber}`
      ) {
        sessionDescriptor.sessionLabel = "Agent Creator";
        sessionDescriptor.displayName = "Agent Creator";
      }
    }

    return {
      profile: preparedIdentity.profile,
      sessionDescriptor,
      sessionNumber: preparedIdentity.sessionNumber
    };
  }

  private prepareSessionIdentity(
    profileId: string,
    options?: {
      label?: string;
      name?: string;
      sessionAgentId?: string;
      sessionPurpose?: AgentDescriptor["sessionPurpose"];
      cli?: AgentDescriptor["cli"];
    }
  ): {
    profile: ManagerProfile;
    sessionAgentId: string;
    sessionLabel: string;
    displayName: string;
    sessionNumber: number;
    createdAt: string;
  } {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    if (options?.sessionPurpose === "agent_creator" && profileId === CORTEX_PROFILE_ID) {
      throw new Error("Agent creator sessions cannot be created in the Cortex profile");
    }

    const { agentId: autoSessionAgentId, sessionNumber } = this.generateSessionAgentIdentity(profileId);
    const normalizedName = options?.name?.trim();
    const normalizedLabel = options?.label?.trim();
    const normalizedSessionAgentId = options?.sessionAgentId?.trim();

    let sessionAgentId = autoSessionAgentId;
    let sessionLabel = normalizedLabel && normalizedLabel.length > 0 ? normalizedLabel : `Session ${sessionNumber}`;
    let displayName = normalizedLabel && normalizedLabel.length > 0 ? normalizedLabel : sessionAgentId;

    if (normalizedName && normalizedName.length > 0) {
      const slug = slugifySessionName(normalizedName);
      if (!slug) {
        throw new Error("Session name must include at least one letter, number, or dash");
      }

      sessionAgentId = this.generateUniqueSessionAgentId(profileId, slug);
      sessionLabel = normalizedName;
      displayName = normalizedName;
    }

    if (normalizedSessionAgentId && normalizedSessionAgentId.length > 0) {
      if (this.isSessionAgentIdReserved(profileId, normalizedSessionAgentId)) {
        throw new Error(`Session agent id already exists: ${normalizedSessionAgentId}`);
      }

      sessionAgentId = normalizedSessionAgentId;
      if (!normalizedLabel || normalizedLabel.length === 0) {
        displayName = normalizedName && normalizedName.length > 0 ? normalizedName : normalizedSessionAgentId;
      }
    }

    return {
      profile,
      sessionAgentId,
      sessionLabel,
      displayName,
      sessionNumber,
      createdAt: this.now()
    };
  }

  private async appendSessionRenameHistoryEntry(
    descriptor: AgentDescriptor & { role: "manager"; profileId: string },
    entry: SessionRenameHistoryEntry
  ): Promise<void> {
    const sessionDir = getSessionDir(this.config.paths.dataDir, descriptor.profileId, descriptor.agentId);
    const historyPath = join(sessionDir, "rename-history.json");
    const entries: SessionRenameHistoryEntry[] = [];

    try {
      const existing = await readFile(historyPath, "utf8");
      const parsed = JSON.parse(existing) as unknown;

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isSessionRenameHistoryEntry(item)) {
            entries.push(item);
          }
        }
      } else if (existing.trim().length > 0) {
        throw new Error(`Invalid rename history format for session ${descriptor.agentId}`);
      }
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    entries.push(entry);

    await mkdir(sessionDir, { recursive: true });
    await writeFile(historyPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  }

  private assertSessionIsDeletable(descriptor: AgentDescriptor): void {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const profile = this.profiles.get(profileId);
    const defaultSessionAgentId = profile?.defaultSessionAgentId ?? profileId;

    if (descriptor.agentId === defaultSessionAgentId) {
      throw new Error(`Cannot delete default session: ${descriptor.agentId}`);
    }
  }

  private async stopSessionInternal(
    agentId: string,
    options: AgentLifecycleStopSessionOptions
  ): Promise<{ terminatedWorkerIds: string[] }> {
    return this.lifecycleService.stopSessionInternal(agentId, options);
  }

  private async transitionSessionWorkPlansForLifecycle(
    _descriptor: AgentDescriptor & { role: "manager"; profileId: string },
    _reason: "manual_stop" | "archived" | "conversation_cleared"
  ): Promise<void> {
    // Active Work Plans are parked on this rollback/test branch. Do not read,
    // write, transition, or rebroadcast tasks.json during lifecycle changes.
  }

  private async emitSessionTaskStateSnapshotForSession(_sessionAgentId: string): Promise<void> {
    // Active Work Plans are parked on this rollback/test branch.
  }

  private async copySessionWorkPlansForFork(
    _sourceDescriptor: AgentDescriptor & { role: "manager"; profileId: string },
    _forkedDescriptor: AgentDescriptor & { role: "manager"; profileId: string },
    _fromMessageId?: string
  ): Promise<void> {
    // Active Work Plans are parked on this rollback/test branch. Do not copy tasks.json into forks.
  }

  private async copyPinnedMessagesForFork(
    sourceDescriptor: AgentDescriptor & { role: "manager"; profileId: string },
    forkedDescriptor: AgentDescriptor & { role: "manager"; profileId: string }
  ): Promise<void> {
    const sourceRegistry = await loadPins(this.getSessionDirForDescriptor(sourceDescriptor));
    if (Object.keys(sourceRegistry.pins).length === 0) {
      this.setPinnedRegistryForAgent(forkedDescriptor.agentId, { version: 1, pins: {} });
      return;
    }

    const forkedMessageIds = await collectConversationMessageIdsFromSessionFile(forkedDescriptor.sessionFile);
    const filteredRegistry: PinRegistry = {
      version: 1,
      pins: Object.fromEntries(
        Object.entries(sourceRegistry.pins).filter(([messageId]) => forkedMessageIds.has(messageId))
      )
    };

    if (Object.keys(filteredRegistry.pins).length === 0) {
      this.setPinnedRegistryForAgent(forkedDescriptor.agentId, filteredRegistry);
      return;
    }

    await savePins(this.getSessionDirForDescriptor(forkedDescriptor), filteredRegistry);
    this.setPinnedRegistryForAgent(forkedDescriptor.agentId, filteredRegistry);
  }

  private async writeForkedSessionMemoryHeader(
    sourceDescriptor: AgentDescriptor,
    forkedSessionAgentId: string,
    fromMessageId?: string
  ): Promise<void> {
    const sourceLabel = sourceDescriptor.sessionLabel ?? sourceDescriptor.agentId;
    const profileId = sourceDescriptor.profileId ?? sourceDescriptor.agentId;
    const forkHistoryNote = fromMessageId
      ? `Parent session conversation history was copied through message ${fromMessageId} at fork time.`
      : "Parent session conversation history was duplicated at fork time.";
    const headerTemplate = await this.resolvePromptWithFallback(
      "operational",
      "forked-session-header",
      profileId,
      FORKED_SESSION_MEMORY_HEADER_TEMPLATE
    );
    let header = resolvePromptVariables(headerTemplate, {
      SOURCE_LABEL: sourceLabel,
      SOURCE_AGENT_ID: sourceDescriptor.agentId,
      FORK_TIMESTAMP: this.now(),
      FORK_HISTORY_NOTE: forkHistoryNote,
      FROM_MESSAGE_ID: fromMessageId ?? ""
    });

    if (fromMessageId && !header.includes(fromMessageId)) {
      header = `${header.trimEnd()}\n> ${forkHistoryNote}\n`;
    }

    const forkedMemoryPath = this.getAgentMemoryPath(forkedSessionAgentId);
    await mkdir(dirname(forkedMemoryPath), { recursive: true });
    await writeFile(forkedMemoryPath, header, "utf8");
    await this.refreshSessionMetaStatsBySessionId(forkedSessionAgentId);
  }

  private resolveActivityManagerContextIds(...agents: AgentDescriptor[]): string[] {
    const managerContextIds = new Set<string>();

    for (const descriptor of agents) {
      if (descriptor.role === "manager") {
        managerContextIds.add(descriptor.agentId);
        continue;
      }

      const managerId = descriptor.managerId.trim();
      if (managerId.length > 0) {
        managerContextIds.add(managerId);
      }
    }

    return Array.from(managerContextIds);
  }

  async sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode = "auto",
    options?: {
      origin?: "user" | "internal";
      attachments?: ConversationAttachment[];
      internalDeliveryKind?: "codex_plugin_bootstrap" | "bootstrap" | "agent_creator_bootstrap";
      observabilityParentTool?: {
        agentId: string;
        runtimeToken?: number;
        toolCallId: string;
        toolName?: string;
      };
      workerReportSourceAgentId?: string;
    }
  ): Promise<SendMessageReceipt> {
    const sender = this.descriptors.get(fromAgentId);
    if (!sender) {
      throw new Error(`Unknown or unavailable sender agent: ${fromAgentId}`);
    }
    this.assertDescriptorNotEffectivelyArchived(sender);
    if (isNonRunningAgentStatus(sender.status)) {
      throw new Error(`Unknown or unavailable sender agent: ${fromAgentId}`);
    }

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    this.assertDescriptorNotEffectivelyArchived(target);
    if (isNonRunningAgentStatus(target.status)) {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    if (sender.role === "manager" && target.role === "worker" && target.managerId !== sender.agentId) {
      throw new Error(`Manager ${sender.agentId} does not own worker ${targetAgentId}`);
    }

    if (sender.role === "worker" && target.role === "manager" && sender.managerId !== target.agentId) {
      throw new Error(
        `Worker ${sender.agentId} cannot message manager ${targetAgentId} (own manager is ${sender.managerId})`
      );
    }

    this.assertCodexPluginWorkerDeliveryAllowed(sender, target, options);

    const origin = options?.origin ?? "internal";
    const attachments = normalizeConversationAttachments(options?.attachments);
    const activeExternalTurn = this.getActiveExternalProjectAgentTurn(fromAgentId);
    if (activeExternalTurn && targetAgentId !== activeExternalTurn.fromAgentId) {
      throw new Error(
        `External project-agent messages are restricted to a direct reply back to ${activeExternalTurn.fromDisplayName} (${activeExternalTurn.fromAgentId}).`
      );
    }

    const senderProfileId = sender.profileId ?? sender.agentId;
    const projectAgentDeliveryAuthorization = await this.resolveProjectAgentDeliveryAuthorization(sender, target);

    if (projectAgentDeliveryAuthorization) {
      if (attachments.length > 0) {
        throw new Error("Project-agent deliveries do not support attachments.");
      }

      const projectAgentContext = {
        fromAgentId: sender.agentId,
        fromDisplayName: getProjectAgentPublicName(sender),
        external: projectAgentDeliveryAuthorization.allowCrossProfile,
        fromProfileId: senderProfileId,
        fromProjectName: this.profiles.get(senderProfileId)?.displayName ?? senderProfileId,
      };
      const assistantOutputTarget: AssistantOutputTarget = { kind: "peer_agent", fromAgentId: sender.agentId };
      const runtimeMessageText = appendAssistantOutputTargetMetadataToText(
        formatProjectAgentRuntimeMessage(projectAgentContext, message),
        assistantOutputTarget,
      );
      const parentRootTurnId = this.getActiveObservabilityRootTurnId(sender.agentId);
      const observabilityInput = this.beginObservabilityRuntimeInput({
        target,
        rootSource: "project_agent",
        originalInput: message,
        runtimeInput: runtimeMessageText,
        parentRootTurnId,
        requestedDelivery: delivery,
        metadata: {
          fromAgentId,
          targetAgentId,
          projectAgentExternal: projectAgentDeliveryAuthorization.allowCrossProfile,
        },
      });
      const rollbackInboundTurnContext = await this.enqueueInboundTurnContext(target.agentId, {
        source: "project_agent_input",
        rootTurnId: observabilityInput?.rootTurnId,
        parentRootTurnId,
        runtimeMessageText,
        codexMcpToolGate: this.buildCodexMcpToolTurnGate(
          target as AgentDescriptor & { role: "manager" },
          { channel: "web" },
          message,
          { kind: "none" },
          "project_agent_input",
        ),
        projectAgentContext,
        assistantOutputTarget,
      });

      let deliveryResult;
      try {
        deliveryResult = await deliverProjectAgentMessage(
          {
            now: this.now,
            getOrCreateRuntimeForDescriptor: (descriptor) => this.getOrCreateRuntimeForDescriptor(descriptor),
            rateLimitBuckets: this.projectAgentMessageTimestampsBySender
          },
          {
            sender,
            target,
            message,
            delivery,
            allowCrossProfile: projectAgentDeliveryAuthorization.allowCrossProfile,
            allowContactReplyTarget: projectAgentDeliveryAuthorization.allowContactReplyTarget,
            external: projectAgentDeliveryAuthorization.allowCrossProfile,
            sourceProfileId: senderProfileId,
            sourceProjectName: this.profiles.get(senderProfileId)?.displayName ?? senderProfileId,
            runtimeMessageText,
          }
        );
      } catch (error) {
        rollbackInboundTurnContext();
        this.cancelObservabilityRuntimeInput(observabilityInput, "project_agent_dispatch_failed");
        throw error;
      }

      const { receipt, inboundPayload } = deliveryResult;
      this.completeObservabilityRuntimeInput(observabilityInput, receipt, {
        fromAgentId,
        targetAgentId,
        projectAgentExternal: projectAgentDeliveryAuthorization.allowCrossProfile,
      });
      this.recordObservabilityAgentDelivery({
        sender,
        target,
        rootTurnId: observabilityInput?.rootTurnId,
        parentRootTurnId,
        message,
        runtimeInput: runtimeMessageText,
        delivery,
        receipt,
        source: "project_agent",
        parentTool: this.resolveObservabilityParentTool(options?.observabilityParentTool),
        metadata: {
          projectAgentExternal: projectAgentDeliveryAuthorization.allowCrossProfile,
          fromProfileId: senderProfileId,
          targetProfileId: target.profileId,
        },
      });
      await this.appendPreparedInboundConversationPayload(target, {
        text: inboundPayload.text,
        runtimeText: inboundPayload.runtimeText,
        timestamp: inboundPayload.timestamp,
        source: "project_agent_input",
        projectAgentContext: inboundPayload.projectAgentContext
      });

      if (projectAgentDeliveryAuthorization.externalAuthorization?.mode === "grant") {
        await this.projectAgentSharingService.recordExternalContact(target.agentId, senderProfileId, sender.agentId);
      }

      this.logDebug("agent:send_message", {
        fromAgentId,
        targetAgentId,
        origin,
        requestedDelivery: delivery,
        acceptedMode: receipt.acceptedMode,
        textPreview: previewForLog(message),
        attachmentCount: attachments.length,
        modelTextPreview: previewForLog(
          inboundPayload.runtimeText
        )
      });

      if (origin !== "user" && fromAgentId !== targetAgentId) {
        this.emitAgentMessage({
          type: "agent_message",
          agentId: sender.agentId,
          timestamp: this.now(),
          source: "agent_to_agent",
          fromAgentId,
          toAgentId: targetAgentId,
          text: message,
          requestedDelivery: delivery,
          acceptedMode: receipt.acceptedMode,
          attachmentCount: attachments.length > 0 ? attachments.length : undefined
        });
      }

      return receipt;
    }

    const managerContextIds = this.resolveActivityManagerContextIds(sender, target);
    const runtime = await this.getOrCreateRuntimeForDescriptor(target);

    const watchdogTurnSeqAtDispatch = this.workerHealthService.getWorkerReportDispatchTurnSeq(sender, target);

    let modelMessage = await this.prepareModelInboundMessage(
      targetAgentId,
      {
        text: message,
        attachments
      },
      origin
    );
    const assistantOutputInput = {
      sender,
      target,
      modelMessage,
      rawMessage: message,
      workerReportSourceAgentId: options?.workerReportSourceAgentId,
      sendMessageToolContinuation: options?.observabilityParentTool?.toolName === "send_message_to_agent",
    };
    const assistantOutputTarget = this.resolveAssistantOutputTargetForAgentMessage(assistantOutputInput);
    const isAssistantOutputEligibleWorkerReport = this.isAssistantOutputEligibleWorkerReportMessage(assistantOutputInput);
    // Keep the runtime input marker as routing guidance for the manager, but derive
    // assistant_output visibility from the target manager/session context.
    const assistantOutputProjectionTarget = this.resolveAssistantOutputProjectionTargetForAgentMessage(
      assistantOutputInput,
      assistantOutputTarget,
    );
    if (target.role === "manager") {
      modelMessage = appendAssistantOutputTargetMetadataToRuntimeMessage(modelMessage, assistantOutputTarget);
    }

    this.workerHealthService.markPendingWorkerReportDispatch(sender.agentId, watchdogTurnSeqAtDispatch);

    const rootSource = classifyObservabilityRootSource({
      origin,
      fromAgentId,
      targetAgentId,
      internalDeliveryKind: options?.internalDeliveryKind,
    });
    const parentRootTurnId = this.getActiveObservabilityRootTurnId(sender.agentId);
    const observabilityInput = this.beginObservabilityRuntimeInput({
      target,
      rootSource,
      originalInput: message,
      runtimeInput: modelMessage,
      parentRootTurnId,
      requestedDelivery: delivery,
      metadata: {
        fromAgentId,
        targetAgentId,
        attachmentCount: attachments.length,
      },
    });
    const shouldEnqueueAgentMessageTurnContext =
      target.role === "manager" &&
      (Boolean(observabilityInput) ||
        assistantOutputProjectionTarget.kind !== "internal_only" ||
        assistantOutputTarget.kind !== "internal_only" ||
        isAssistantOutputEligibleWorkerReport);
    const rollbackObservabilityInboundContext = await this.enqueueInboundTurnContext(target.agentId, {
      source: "agent_message",
      rootTurnId: observabilityInput?.rootTurnId,
      parentRootTurnId,
      runtimeMessageText: extractRuntimeMessageText(modelMessage),
      assistantOutputTarget,
      assistantOutputProjectionTarget,
      activationEligible: shouldEnqueueAgentMessageTurnContext,
    });

    let receipt: SendMessageReceipt;
    try {
      receipt = await runtime.sendMessage(modelMessage, delivery);
    } catch (error) {
      rollbackObservabilityInboundContext?.();
      this.cancelObservabilityRuntimeInput(observabilityInput, "runtime_send_message_failed");
      await this.workerHealthService.handleFailedWorkerReportDispatch(sender.agentId, watchdogTurnSeqAtDispatch);
      throw error;
    }

    await this.workerHealthService.handleSuccessfulWorkerReportDispatch(sender.agentId, watchdogTurnSeqAtDispatch);
    this.consumeWorkerAssistantOutputInheritanceAfterReportDispatch({
      sender,
      target,
      modelMessage,
      rawMessage: message,
      workerReportSourceAgentId: options?.workerReportSourceAgentId,
    });
    this.rememberWorkerAssistantOutputInheritanceAfterDispatch(sender, target);
    this.completeObservabilityRuntimeInput(observabilityInput, receipt, {
      fromAgentId,
      targetAgentId,
      attachmentCount: attachments.length,
    });
    this.recordObservabilityAgentDelivery({
      sender,
      target,
      rootTurnId: observabilityInput?.rootTurnId,
      parentRootTurnId,
      message,
      runtimeInput: modelMessage,
      delivery,
      receipt,
      source: origin === "internal" ? "internal" : "agent_message",
      parentTool: this.resolveObservabilityParentTool(options?.observabilityParentTool),
      metadata: {
        attachmentCount: attachments.length,
        rootSource,
      },
    });

    this.logDebug("agent:send_message", {
      fromAgentId,
      targetAgentId,
      origin,
      requestedDelivery: delivery,
      acceptedMode: receipt.acceptedMode,
      textPreview: previewForLog(message),
      attachmentCount: attachments.length,
      modelTextPreview: previewForLog(extractRuntimeMessageText(modelMessage))
    });

    if (origin !== "user" && fromAgentId !== targetAgentId) {
      for (const managerContextId of managerContextIds) {
        this.emitAgentMessage({
          type: "agent_message",
          agentId: managerContextId,
          timestamp: this.now(),
          source: "agent_to_agent",
          fromAgentId,
          toAgentId: targetAgentId,
          text: message,
          requestedDelivery: delivery,
          acceptedMode: receipt.acceptedMode,
          attachmentCount: attachments.length > 0 ? attachments.length : undefined
        });
      }
    }

    return receipt;
  }

  private async prepareModelInboundMessage(
    targetAgentId: string,
    input: { text: string; attachments: ConversationAttachment[] },
    origin: "user" | "internal"
  ): Promise<string | RuntimeUserMessage> {
    let text = input.text;

    if (origin !== "user") {
      const trimmedStart = text.trimStart();
      if (text.trim().length > 0 && !/^(?:system|worker report):/i.test(trimmedStart)) {
        text = TERMINAL_WORKER_REPORT_BODY_PATTERN.test(trimmedStart)
          ? `${WORKER_REPORT_MESSAGE_PREFIX}${text}`
          : `${INTERNAL_MODEL_MESSAGE_PREFIX}${text}`;
      }
    }

    const runtimeAttachments = await this.prepareRuntimeAttachments(targetAgentId, input.attachments);

    if (runtimeAttachments.attachmentMessage.length > 0) {
      text = text.trim().length > 0 ? `${text}\n\n${runtimeAttachments.attachmentMessage}` : runtimeAttachments.attachmentMessage;
    }

    if (runtimeAttachments.images.length === 0) {
      return text;
    }

    return {
      text,
      images: runtimeAttachments.images
    };
  }

  private async prepareRuntimeAttachments(
    targetAgentId: string,
    attachments: ConversationAttachment[]
  ): Promise<{ images: RuntimeImageAttachment[]; attachmentMessage: string }> {
    if (attachments.length === 0) {
      return {
        images: [],
        attachmentMessage: ""
      };
    }

    const images = toRuntimeImageAttachments(attachments);
    const fileMessages: string[] = [];
    const attachmentPathMessages: string[] = [];
    let binaryAttachmentDir: string | undefined;

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const persistedPath = normalizeOptionalAttachmentPath(attachment.filePath);

      if (persistedPath) {
        attachmentPathMessages.push(`[Attached file saved to: ${persistedPath}]`);
      }

      if (isConversationImageAttachment(attachment)) {
        continue;
      }

      if (isConversationTextAttachment(attachment)) {
        fileMessages.push(formatTextAttachmentForPrompt(attachment, index + 1));
        continue;
      }

      if (isConversationBinaryAttachment(attachment)) {
        let storedPath = persistedPath;
        if (!storedPath) {
          const directory = binaryAttachmentDir ?? (await this.createBinaryAttachmentDir(targetAgentId));
          binaryAttachmentDir = directory;
          storedPath = await this.writeBinaryAttachmentToDisk(directory, attachment, index + 1, "bin");
        }
        fileMessages.push(formatBinaryAttachmentForPrompt(attachment, storedPath, index + 1));
      }
    }

    if (fileMessages.length === 0 && attachmentPathMessages.length === 0) {
      return {
        images,
        attachmentMessage: ""
      };
    }

    const attachmentMessageSections: string[] = [];
    if (fileMessages.length > 0) {
      attachmentMessageSections.push("The user attached the following files:", "", ...fileMessages);
    }
    if (attachmentPathMessages.length > 0) {
      if (attachmentMessageSections.length > 0) {
        attachmentMessageSections.push("");
      }
      attachmentMessageSections.push(...attachmentPathMessages);
    }

    return {
      images,
      attachmentMessage: attachmentMessageSections.join("\n")
    };
  }

  private async createBinaryAttachmentDir(targetAgentId: string): Promise<string> {
    const agentSegment = sanitizePathSegment(targetAgentId, "agent");
    const batchId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const directory = join(this.config.paths.dataDir, "attachments", agentSegment, batchId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async writeBinaryAttachmentToDisk(
    directory: string,
    attachment: Pick<ConversationBinaryAttachment, "data" | "fileName">,
    attachmentIndex: number,
    fallbackExtension: string
  ): Promise<string> {
    const safeName = sanitizeAttachmentFileName(
      attachment.fileName,
      `attachment-${attachmentIndex}.${fallbackExtension}`
    );
    const filePath = join(directory, `${String(attachmentIndex).padStart(2, "0")}-${safeName}`);
    const buffer = Buffer.from(attachment.data, "base64");
    await writeFile(filePath, buffer);
    return filePath;
  }

  private async persistConversationAttachmentsIfNeeded(
    attachments: ConversationAttachment[]
  ): Promise<ConversationAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }

    return persistConversationAttachments(attachments, this.config.paths.uploadsDir);
  }

  async publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system" = "speak_to_user",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }> {
    if (source === "speak_to_user") {
      this.assertExternalProjectAgentTurnCapabilityAllowed(agentId, "speak_to_user");
    }

    let resolvedTargetContext: MessageSourceContext;
    let normalizedText = text;

    if (source === "speak_to_user") {
      const descriptor = this.assertManager(agentId, "speak to user");
      resolvedTargetContext = this.resolveReplyTargetContext(targetContext);

      if (normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID) {
        normalizedText = normalizeCortexUserVisiblePaths(text);
      }
    } else {
      resolvedTargetContext = normalizeMessageSourceContext(targetContext ?? { channel: "web" });
    }

    const payload: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      role: source === "system" ? "system" : "assistant",
      text: normalizedText,
      timestamp: this.now(),
      source,
      sourceContext: resolvedTargetContext
    };

    this.emitConversationMessage(payload);
    if (source === "speak_to_user") {
      this.runtimeController.markExplicitManagerAssistantOutput(agentId);
      this.markSessionActivity(agentId, payload.timestamp);
    }

    this.logDebug("manager:publish_to_user", {
      source,
      agentId,
      targetContext: resolvedTargetContext,
      textPreview: previewForLog(normalizedText)
    });

    return {
      targetContext: resolvedTargetContext
    };
  }

  private async resolveCompactionCustomInstructions(
    descriptor: AgentDescriptor & { role: "manager" },
    customInstructions?: string
  ): Promise<string | undefined> {
    const registry = await this.syncPinnedContentForManagerRuntime(descriptor);
    return combineCompactionCustomInstructions(customInstructions, registry);
  }

  async compactAgentContext(
    agentId: string,
    options?: {
      customInstructions?: string;
      sourceContext?: MessageSourceContext;
      trigger?: "api" | "slash_command" | "cli";
    }
  ): Promise<unknown> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Target agent is not running: ${agentId}`);
    }

    if (descriptor.role !== "manager") {
      throw new Error(`Compaction is only supported for manager agents: ${agentId}`);
    }

    assertBuilderSession(descriptor, "compact Builder sessions");

    const managerDescriptor = descriptor as AgentDescriptor & { role: "manager" };
    const runtime = await this.getOrCreateRuntimeForDescriptor(managerDescriptor);

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const customInstructions = await this.resolveCompactionCustomInstructions(
      managerDescriptor,
      options?.customInstructions?.trim() || undefined
    );

    this.logDebug("manager:compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? "")
    });

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: "Compacting manager context...",
      timestamp: this.now(),
      source: "system",
      sourceContext
    });

    try {
      const result = await runtime.compact(customInstructions);

      // Track successful compaction count
      const newCount = await this.incrementSessionCompactionCount(
        descriptor.profileId!,
        agentId,
        "manager:compact:count-increment-failed"
      );
      if (newCount !== undefined) {
        descriptor.compactionCount = newCount;
      }

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: "Compaction complete.",
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api"
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: `Compaction failed: ${message}`,
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message
      });

      throw error;
    }
  }

  async smartCompactAgentContext(
    agentId: string,
    options?: {
      customInstructions?: string;
      sourceContext?: MessageSourceContext;
      trigger?: "api" | "slash_command" | "cli";
    }
  ): Promise<SmartCompactResult> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Target agent is not running: ${agentId}`);
    }

    if (descriptor.role !== "manager") {
      throw new Error(`Smart compaction is only supported for manager agents: ${agentId}`);
    }

    assertBuilderSession(descriptor, "smart-compact Builder sessions");

    const managerDescriptor = descriptor as AgentDescriptor & { role: "manager" };
    const runtime = await this.getOrCreateRuntimeForDescriptor(managerDescriptor);

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const customInstructions = await this.resolveCompactionCustomInstructions(
      managerDescriptor,
      options?.customInstructions?.trim() || undefined
    );

    this.logDebug("manager:smart_compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? "")
    });

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: "Running smart compaction…",
      timestamp: this.now(),
      source: "system",
      sourceContext
    });

    try {
      const result = await runtime.smartCompact(customInstructions, { skipResumeIfIdle: true });

      if (result.compacted) {
        // Track successful smart compaction
        const smartCount = await this.incrementSessionCompactionCount(
          descriptor.profileId!,
          agentId,
          "manager:smart_compact:count-increment-failed"
        );
        if (smartCount !== undefined) {
          descriptor.compactionCount = smartCount;
        }

        const usage = runtime.getContextUsage();
        const usageSuffix = usage ? ` Context now at ${Math.round(usage.percent)}%.` : "";
        this.emitConversationMessage({
          type: "conversation_message",
          agentId,
          role: "system",
          text: `Smart compaction complete.${usageSuffix}`,
          timestamp: this.now(),
          source: "system",
          sourceContext
        });
      } else {
        const text =
          runtime.runtimeType === "claude" && result.reason === "claude_runtime_below_compaction_threshold"
            ? "Smart compaction skipped because context is already below the Claude compaction threshold."
            : "Smart compaction finished, but context was not reduced.";
        this.emitConversationMessage({
          type: "conversation_message",
          agentId,
          role: "system",
          text,
          timestamp: this.now(),
          source: "system",
          sourceContext
        });
      }

      this.logDebug("manager:smart_compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api",
        compacted: result.compacted,
        reason: result.compacted ? undefined : result.reason
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: /\btimeout\b|\btimed out\b/i.test(message)
          ? "Smart compaction timed out."
          : `Smart compaction failed: ${message}`,
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:smart_compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message
      });

      throw error;
    }
  }

  async appendConversationUserMessage(
    text: string,
    options?: AppendConversationUserMessageOptions
  ): Promise<AppendConversationUserMessageResult> {
    const trimmed = text.trim();
    const attachments = normalizeConversationAttachments(options?.attachments);
    if (!trimmed && attachments.length === 0) {
      throw new Error("Cannot append an empty user message.");
    }

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const target = this.resolveUserMessageTarget(options?.targetAgentId);
    return this.appendConversationUserMessageInternal(
      target,
      trimmed,
      attachments,
      sourceContext,
      options?.collaborationAuthor,
      options?.replyTo,
    );
  }

  async dispatchRuntimeUserMessage(options: DispatchRuntimeUserMessageOptions): Promise<void> {
    const target = this.resolveUserMessageTarget(options.targetAgentId);
    const sourceContext = normalizeMessageSourceContext(options.sourceContext);
    const runtimeAttachments = normalizeConversationAttachments(options.runtimeAttachments);
    await this.dispatchRuntimeUserMessageInternal(
      target,
      options.text.trim(),
      sourceContext,
      runtimeAttachments,
      Math.max(0, Math.trunc(options.persistedAttachmentCount ?? runtimeAttachments.length)),
      undefined,
      options.delivery,
      options.collaborationAuthor,
    );
  }

  async handleUserMessage(
    text: string,
    options?: {
      targetAgentId?: string;
      delivery?: RequestedDeliveryMode;
      attachments?: ConversationAttachment[];
      sourceContext?: MessageSourceContext;
      replyTo?: ConversationReplyTargetInput;
    }
  ): Promise<void> {
    const trimmed = text.trim();
    const attachments = normalizeConversationAttachments(options?.attachments);
    if (!trimmed && attachments.length === 0) return;

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const target = this.resolveUserMessageTarget(options?.targetAgentId);
    this.assertCodexPluginWorkerNotUserTargetable(target);

    const resolvedReplyTo = options?.replyTo
      ? resolveConversationReplyTarget(this.getConversationHistory(target.agentId), options.replyTo)
      : undefined;

    if (await this.maybeRouteCodexUserMessage(target, trimmed, attachments, sourceContext)) {
      return;
    }

    await this.preflightRepoProjectAgentRuntime(target);

    if (target.role === "manager" && attachments.length === 0) {
      const routedReviewRun = await this.maybeStartCortexReviewRunFromIncomingMessage(trimmed, target, sourceContext);
      if (routedReviewRun) {
        return;
      }
    }

    const compactCommand =
      target.role === "manager" && attachments.length === 0
        ? parseCompactSlashCommand(trimmed)
        : undefined;
    if (compactCommand) {
      this.markSessionActivity(target.agentId, this.now());
      this.logDebug("manager:user_message_compact_command", {
        targetAgentId: target.agentId,
        sourceContext,
        customInstructionsPreview: previewForLog(compactCommand.customInstructions ?? "")
      });
      await this.compactAgentContext(target.agentId, {
        customInstructions: compactCommand.customInstructions,
        sourceContext,
        trigger: "slash_command"
      });
      return;
    }

    const codexClassification = target.role === "manager"
      ? classifyCodexUserMessage(trimmed)
      : { kind: "none" as const };

    if (codexClassification.kind === "plugin_delegate") {
      const surfaceGate = evaluateCodexMcpToolGate({
        manager: target,
        sourceContext,
        messageText: trimmed,
        inboundSource: "user_input",
      });
      assertCodexMcpToolGateAllowed(surfaceGate);
      this.assertCodexMentionRoutingAvailable(target as AgentDescriptor & { role: "manager"; profileId: string });
    }

    const appendedMessage = await this.appendConversationUserMessageInternal(
      target,
      trimmed,
      attachments,
      sourceContext,
      undefined,
      resolvedReplyTo,
    );

    if (target.role === "manager") {
      this.scheduleProjectExecutableTrustPrompt(target as AgentDescriptor & { role: "manager" });
    }

    const codexPluginDelegationContext: CodexPluginDelegationTurnContext | undefined =
      target.role === "manager" && codexClassification.kind === "plugin_delegate"
        ? {
            contextId: createCodexPluginDelegationId(),
            managerAgentId: target.agentId,
            originalText: trimmed,
            strippedText: codexClassification.strippedText,
            selectors: [...codexClassification.selectors],
            sourceContext,
            userMessageId: appendedMessage.event.id,
          }
        : undefined;
    const codexPluginRetryAuthorizationContext =
      target.role === "manager" && codexClassification.kind !== "plugin_delegate"
        ? this.createCodexPluginRetryAuthorizationForUserTurn(
            target.agentId,
            trimmed,
            appendedMessage.event.id,
          )
        : undefined;

    await this.dispatchRuntimeUserMessageInternal(
      target,
      trimmed,
      sourceContext,
      appendedMessage.runtimeAttachments,
      appendedMessage.persistedAttachments.length,
      appendedMessage.event.id,
      options?.delivery,
      undefined,
      codexClassification,
      codexPluginDelegationContext,
      codexPluginRetryAuthorizationContext,
      resolvedReplyTo,
    );
  }

  private assertCodexPluginWorkerNotUserTargetable(target: AgentDescriptor): void {
    if (!isCodexPluginWorkerDescriptor(target)) {
      return;
    }

    throw new Error("Codex Plugin workers are scoped to the active Codex Plugin specialist worker. Ask the manager with a new @Codex selector to start a new scoped worker.");
  }

  private assertCodexPluginWorkerDeliveryAllowed(
    sender: AgentDescriptor,
    target: AgentDescriptor,
    options: {
      origin?: "user" | "internal";
      attachments?: ConversationAttachment[];
      internalDeliveryKind?: "codex_plugin_bootstrap" | "bootstrap" | "agent_creator_bootstrap";
    } | undefined,
  ): void {
    if (isCodexPluginWorkerDescriptor(sender)) {
      if (target.role === "manager" && target.agentId === sender.managerId) {
        return;
      }

      throw new Error("Codex Plugin workers can only report to their owning manager.");
    }

    if (!isCodexPluginWorkerDescriptor(target)) {
      return;
    }

    if (options?.origin === "user") {
      throw new Error("Codex Plugin workers are scoped to the active Codex Plugin specialist worker. Ask the manager with a new @Codex selector to start a new scoped worker.");
    }

    if (sender.role !== "manager" || sender.agentId !== target.managerId) {
      throw new Error("Codex Plugin workers only accept follow-ups from their owning manager while their scoped worker is active.");
    }

    if (!this.codexPluginScopeService.getScopeForWorker(target.agentId)) {
      throw new Error("Codex Plugin worker scope is no longer active. Start a new @Codex plugin selector turn to create a fresh scoped worker.");
    }

    if (normalizeConversationAttachments(options?.attachments).length > 0) {
      throw new Error(
        "Codex Plugin workers do not accept attachment payloads. Inspect or summarize attachments in the manager turn, then pass only relevant text context to the Codex Plugin specialist."
      );
    }
  }

  private resolveUserMessageTarget(targetAgentId?: string): AgentDescriptor {
    const resolvedTargetAgentId = targetAgentId ?? this.resolvePreferredManagerId();
    if (!resolvedTargetAgentId) {
      throw new Error("No manager is available. Create a manager first.");
    }

    const target = this.descriptors.get(resolvedTargetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${resolvedTargetAgentId}`);
    }

    this.assertDescriptorNotEffectivelyArchived(target);
    if (isNonRunningAgentStatus(target.status)) {
      const recoverableCodexRetry = isExternalThreadDescriptor(target) && target.status === "error";
      if (!recoverableCodexRetry) {
        throw new Error(`Target agent is not running: ${resolvedTargetAgentId}`);
      }
    }

    return target;
  }

  isExternalThreadSidecarDescriptor(descriptor: AgentDescriptor): boolean {
    return isExternalThreadDescriptor(descriptor);
  }

  private createCodexSidecarHost() {
    return createCodexSidecarHostAdapter({
      now: () => this.now(),
      logDebug: (message, details) => this.logDebug(message, details),
      getDescriptor: (agentId) => this.descriptors.get(agentId),
      upsertDescriptor: (descriptor) => {
        this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
      },
      saveStore: () => this.saveStore(),
      ensureSessionFileParentDirectory: async (sessionFile) => {
        await mkdir(dirname(sessionFile), { recursive: true });
      },
      appendConversationEntry: (_agentId, entry) => {
        if (entry.type !== "conversation_message") {
          this.logDebug("codex_sidecar:unsupported_append_entry", { entryType: entry.type });
          return;
        }

        this.emitConversationMessage(entry);
      },
      emitConversationMessage: (event) => this.emitConversationMessage(event),
      emitConversationLog: (event) => this.conversationProjector.emitConversationLog(event),
      emitAgentMessage: (event) => this.emitAgentMessage(event),
      emitAgentToolCall: (event) => this.conversationProjector.emitAgentToolCall(event),
      emitStatus: (agentId, status, pendingCount) => {
        this.emitStatus(agentId, status, pendingCount);
      },
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      emitProfilesSnapshot: () => {
        this.emitProfilesSnapshot();
      },
      listWorkersForSession: (sessionAgentId) => this.getWorkersForManager(sessionAgentId),
    });
  }

  private async maybeRouteCodexUserMessage(
    target: AgentDescriptor,
    trimmed: string,
    attachments: ConversationAttachment[],
    sourceContext: MessageSourceContext,
  ): Promise<boolean> {
    if (isExternalThreadDescriptor(target)) {
      const manager = this.descriptors.get(target.managerId);
      if (!manager || manager.role !== "manager") {
        throw new Error(`Codex sidecar ${target.agentId} is missing its parent manager session.`);
      }
      if (!isBuilderWebCodexRoutingSurface(sourceContext, manager)) {
        throw new Error("Selected Codex sidecar only accepts direct sends from Builder web sessions.");
      }

      if (attachments.length > 0) {
        throw new Error("Codex sidecar messages support text only in this version.");
      }

      if (!trimmed) {
        throw new Error("Codex sidecar message text must not be empty.");
      }

      this.scheduleProjectExecutableTrustPrompt(manager as AgentDescriptor & { role: "manager" });

      await this.routeCodexSidecarUserMessage(manager, target, trimmed, sourceContext, {
        emitParentRequestCard: false,
      });
      return true;
    }

    if (target.role !== "manager") {
      return false;
    }

    if (!isBuilderWebCodexRoutingSurface(sourceContext, target)) {
      return false;
    }

    const classification = classifyCodexUserMessage(trimmed);
    if (classification.kind === "plugin_delegate") {
      return false;
    }

    const mentionRoute = parseLeadingCodexMention(trimmed);
    if (!mentionRoute.routed) {
      return false;
    }

    this.assertCodexMentionRoutingAvailable(target as AgentDescriptor & { role: "manager"; profileId: string });

    if (attachments.length > 0) {
      throw new Error("Codex @mention routing supports text-only messages in this version.");
    }

    if (!mentionRoute.strippedText) {
      throw new Error("Add a message after @Codex to send it to Codex app-server.");
    }

    this.scheduleProjectExecutableTrustPrompt(target as AgentDescriptor & { role: "manager" });

    const sidecar = await this.codexAppServerService.getOrCreateSidecarDescriptor(target);
    await this.routeCodexSidecarUserMessage(target, sidecar, mentionRoute.strippedText, sourceContext, {
      emitParentRequestCard: true,
    });
    return true;
  }

  private async spawnCodexPluginSpecialistWorker(
    managerAgentId: string,
    input: SpawnAgentInput,
  ): Promise<AgentDescriptor> {
    const manager = this.descriptors.get(managerAgentId);
    if (!manager || manager.role !== "manager") {
      throw new Error(`Codex Plugin specialist requires a manager session: ${managerAgentId}`);
    }
    this.assertDescriptorNotEffectivelyArchived(manager);
    if (isNonRunningAgentStatus(manager.status)) {
      throw new Error(`Codex Plugin specialist requires a running manager session: ${managerAgentId}`);
    }

    const activeContext = this.activeCodexPluginDelegationByManagerId.get(managerAgentId);
    if (!activeContext) {
      throw new Error("Codex Plugin specialist is only available during an active user turn with Codex plugin selector tags.");
    }

    if (activeContext.managerAgentId !== manager.agentId) {
      throw new Error("Codex Plugin specialist context is bound to a different manager session.");
    }

    return this.spawnCodexPluginSpecialistWorkerForContext(manager, input, activeContext, "active_selector");
  }

  async retryCodexPluginWorker(
    managerAgentId: string,
    input: { initialMessage: string; retryContextId?: string },
  ): Promise<AgentDescriptor> {
    const manager = this.descriptors.get(managerAgentId);
    if (!manager || manager.role !== "manager") {
      throw new Error(`Codex Plugin retry requires a manager session: ${managerAgentId}`);
    }
    this.assertDescriptorNotEffectivelyArchived(manager);
    if (isNonRunningAgentStatus(manager.status)) {
      throw new Error(`Codex Plugin retry requires a running manager session: ${managerAgentId}`);
    }

    const retryContext = this.requireCodexPluginRetryContext(manager.agentId, input.retryContextId);
    this.requireActiveCodexPluginRetryAuthorization(manager.agentId, retryContext.retryContextId);
    const task = input.initialMessage.trim();
    if (!task) {
      throw new Error("retry_codex_plugin_worker requires a non-empty initialMessage.");
    }

    const spawned = await this.spawnCodexPluginSpecialistWorkerForContext(
      manager,
      {
        agentId: this.defaultCodexPluginWorkerAgentId(retryContext.activeContext),
        specialist: CODEX_PLUGIN_SPECIALIST_ID,
        initialMessage: task,
      },
      retryContext.activeContext,
      "retry",
    );
    this.activeCodexPluginRetryAuthorizationByManagerId.delete(manager.agentId);
    return spawned;
  }

  private async spawnCodexPluginSpecialistWorkerForContext(
    manager: AgentDescriptor,
    input: SpawnAgentInput,
    activeContext: CodexPluginDelegationTurnContext,
    source: "active_selector" | "retry",
  ): Promise<AgentDescriptor> {
    const task = input.initialMessage?.trim() || activeContext.strippedText.trim() || activeContext.originalText.trim();
    if (!task) {
      throw new Error("Codex Plugin specialist requires a non-empty initialMessage task.");
    }

    const requestedAgentId = input.agentId?.trim() || this.defaultCodexPluginWorkerAgentId(activeContext);
    const delegationId = createCodexPluginDelegationId();
    const materializedWorkerAgentIds = new Set<string>();
    const pendingSpawn: PendingCodexPluginSpawnContext = {
      delegationId,
      activeContext,
      task,
      materializedWorkerAgentIds,
    };
    const spawnInput: SpawnAgentInput = {
      ...input,
      agentId: requestedAgentId,
      specialist: CODEX_PLUGIN_SPECIALIST_ID,
      initialMessage: undefined,
    };
    this.pendingCodexPluginSpawnByManagerId.set(manager.agentId, pendingSpawn);
    this.pendingCodexPluginSpawnByInput.set(spawnInput, pendingSpawn);

    try {
      const descriptor = await this.lifecycleService.spawnAgent(manager.agentId, spawnInput);

      const initialTask = this.pendingCodexPluginInitialTaskByWorkerId.get(descriptor.agentId);
      if (initialTask) {
        await this.sendMessage(manager.agentId, descriptor.agentId, initialTask, "auto", {
          origin: "internal",
          internalDeliveryKind: "codex_plugin_bootstrap",
        });
        this.pendingCodexPluginInitialTaskByWorkerId.delete(descriptor.agentId);
      }

      this.rememberCodexPluginRetryContext(activeContext, descriptor.agentId);
      this.logDebug("codex_plugin:specialist_spawned", {
        managerAgentId: manager.agentId,
        workerAgentId: descriptor.agentId,
        delegationId,
        selectors: activeContext.selectors,
        toolCount: this.getCodexPluginScopeForWorker(descriptor.agentId)?.allowedTools.length ?? 0,
        userMessageId: activeContext.userMessageId,
        source,
      });

      return descriptor;
    } catch (error) {
      for (const workerAgentId of materializedWorkerAgentIds) {
        this.codexPluginScopeService.closeScopeForWorker(workerAgentId);
        this.pendingCodexPluginInitialTaskByWorkerId.delete(workerAgentId);
      }
      this.logDebug("codex_plugin:specialist_spawn_failed", {
        managerAgentId: manager.agentId,
        requestedAgentId,
        delegationId,
        selectors: activeContext.selectors,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (this.pendingCodexPluginSpawnByManagerId.get(manager.agentId)?.delegationId === delegationId) {
        this.pendingCodexPluginSpawnByManagerId.delete(manager.agentId);
      }
      this.pendingCodexPluginSpawnByInput.delete(spawnInput);
    }
  }

  private rememberCodexPluginRetryContext(
    context: CodexPluginDelegationTurnContext,
    lastWorkerAgentId?: string,
  ): void {
    const existing = this.lastCodexPluginDelegationByManagerId.get(context.managerAgentId);
    if (lastWorkerAgentId && existing?.lastWorkerAgentId && existing.lastWorkerAgentId !== lastWorkerAgentId) {
      this.stoppedCodexPluginWorkersById.delete(existing.lastWorkerAgentId);
    }
    this.lastCodexPluginDelegationByManagerId.set(context.managerAgentId, {
      retryContextId: context.contextId,
      activeContext: {
        ...context,
        selectors: [...context.selectors],
        sourceContext: { ...context.sourceContext },
      },
      createdAt: existing?.retryContextId === context.contextId ? existing.createdAt : Date.now(),
      lastWorkerAgentId: lastWorkerAgentId ?? existing?.lastWorkerAgentId,
    });
  }

  private clearCodexPluginRetryContextForManager(managerAgentId: string): void {
    const existing = this.lastCodexPluginDelegationByManagerId.get(managerAgentId);
    if (existing?.lastWorkerAgentId) {
      this.stoppedCodexPluginWorkersById.delete(existing.lastWorkerAgentId);
    }
    this.lastCodexPluginDelegationByManagerId.delete(managerAgentId);
    this.activeCodexPluginRetryAuthorizationByManagerId.delete(managerAgentId);
  }

  private requireCodexPluginRetryContext(
    managerAgentId: string,
    retryContextId?: string,
  ): CodexPluginRetryContext {
    const retryContext = this.lastCodexPluginDelegationByManagerId.get(managerAgentId);
    if (!retryContext) {
      throw new Error("No Codex Plugin retry context is available. Ask the user to re-tag the request with @Codex and the desired plugin selector.");
    }
    if (retryContext.activeContext.managerAgentId !== managerAgentId) {
      throw new Error("Codex Plugin retry context belongs to a different manager session. Ask the user to re-tag the request.");
    }
    if (retryContextId && retryContext.retryContextId !== retryContextId) {
      throw new Error("Codex Plugin retry context id is unavailable or expired. Ask the user to re-tag the request.");
    }
    if (Date.now() - retryContext.createdAt > CODEX_PLUGIN_RETRY_CONTEXT_TTL_MS) {
      this.clearCodexPluginRetryContextForManager(managerAgentId);
      throw new Error("Codex Plugin retry context expired. Ask the user to re-tag the request with @Codex and the desired plugin selector.");
    }

    return retryContext;
  }

  private createCodexPluginRetryAuthorizationForUserTurn(
    managerAgentId: string,
    userText: string,
    userMessageId?: string,
  ): CodexPluginRetryAuthorizationContext | undefined {
    const retryContext = this.lastCodexPluginDelegationByManagerId.get(managerAgentId);
    if (!retryContext) {
      return undefined;
    }
    const retryContextId = retryContext.retryContextId;
    let freshRetryContext: CodexPluginRetryContext;
    try {
      freshRetryContext = this.requireCodexPluginRetryContext(managerAgentId, retryContextId);
    } catch {
      return undefined;
    }

    const explicitContinuation = this.isExplicitCodexPluginRetryContinuationText(userText);
    const workerStoppedOrFailed = this.isCodexPluginRetryContextWorkerStoppedOrFailed(freshRetryContext);
    if (!explicitContinuation || !workerStoppedOrFailed) {
      this.clearCodexPluginRetryContextForManager(managerAgentId);
      return undefined;
    }

    return {
      retryContextId: freshRetryContext.retryContextId,
      activeContext: {
        ...freshRetryContext.activeContext,
        selectors: [...freshRetryContext.activeContext.selectors],
        sourceContext: { ...freshRetryContext.activeContext.sourceContext },
      },
      authorizedUserMessageId: userMessageId,
      createdAt: Date.now(),
      lastWorkerAgentId: freshRetryContext.lastWorkerAgentId,
    };
  }

  private isCodexPluginRetryContextWorkerStoppedOrFailed(retryContext: CodexPluginRetryContext): boolean {
    if (!retryContext.lastWorkerAgentId) {
      return false;
    }

    const worker = this.descriptors.get(retryContext.lastWorkerAgentId);
    if (!worker) {
      return true;
    }

    if (!isCodexPluginWorkerDescriptor(worker) || worker.managerId !== retryContext.activeContext.managerAgentId) {
      return false;
    }

    if (this.stoppedCodexPluginWorkersById.has(worker.agentId)) {
      return true;
    }

    return isNonRunningAgentStatus(worker.status);
  }

  private isExplicitCodexPluginRetryContinuationText(userText: string): boolean {
    const normalized = userText.toLowerCase().replace(/[^a-z0-9@:_/-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!normalized) {
      return false;
    }

    const hasContinuationAction = /\b(retry|rerun|resume|continue|finish|re-?try)\b/.test(normalized) ||
      /\btry\s+(it|that|this|again)\b/.test(normalized) ||
      /\b(run|do)\s+(it|that|this)\s+again\b/.test(normalized) ||
      /\bagain\b/.test(normalized) ||
      /\bkeep\s+going\b/.test(normalized) ||
      /\bpick\s+(it|that|this)?\s*back\s+up\b/.test(normalized);
    const hasGenericExportAction = /\b(export|download|save)\b/.test(normalized);
    if (!hasContinuationAction && !hasGenericExportAction) {
      return false;
    }

    const hasAnaphoricReference = /\b(same|previous|last|that|it|again)\b/.test(normalized);
    const hasConnectorReference = /\b(codex|plugin|fireflies|connector)\b/.test(normalized);

    if (hasContinuationAction) {
      return hasAnaphoricReference || hasConnectorReference;
    }

    // Generic export/download/save requests are common non-Codex turns. Broad nouns like
    // transcript/summary/meeting are not enough; require an explicit prior-work reference or
    // explicit connector/scope naming.
    return hasAnaphoricReference || hasConnectorReference;
  }

  private requireActiveCodexPluginRetryAuthorization(
    managerAgentId: string,
    retryContextId?: string,
  ): CodexPluginRetryAuthorizationContext {
    const authorization = this.activeCodexPluginRetryAuthorizationByManagerId.get(managerAgentId);
    if (!authorization) {
      throw new Error("Codex Plugin retry is only available during the current user turn when Forge has classified that turn as an explicit retry/continuation of a stopped or failed scoped Codex Plugin worker. Ask the user to re-tag @Codex if they want a new plugin scope.");
    }
    if (retryContextId && authorization.retryContextId !== retryContextId) {
      throw new Error("Codex Plugin retry context id is unavailable for this user turn. Ask the user to re-tag the request.");
    }
    if (Date.now() - authorization.createdAt > CODEX_PLUGIN_RETRY_AUTHORIZATION_TTL_MS) {
      this.activeCodexPluginRetryAuthorizationByManagerId.delete(managerAgentId);
      throw new Error("Codex Plugin retry authorization expired for this user turn. Ask the user to try again or re-tag @Codex.");
    }

    return authorization;
  }

  private defaultCodexPluginWorkerAgentId(context: CodexPluginDelegationTurnContext | undefined): string {
    const selectorSlug = context?.selectors[0]?.replace(/[^a-z0-9_-]+/gi, "-") || "plugin";
    return `codex-plugin-${selectorSlug}`;
  }

  async browseCodexMcpCatalog(managerAgentId: string): Promise<CodexCatalogSnapshot> {
    const manager = this.requireManagerForCodexTools(managerAgentId);
    assertCodexMcpToolGateAllowed(evaluateCodexMcpCatalogBrowseGate({ manager }));
    return this.codexAppServerService.listCodexMcpTools();
  }

  async listCodexMcpTools(_managerAgentId: string): Promise<CodexCatalogSnapshot> {
    throw new Error(
      "Raw Codex MCP tools are not available to manager runtimes. Use @Codex plugin selector mentions and spawn the visible codex-plugin specialist.",
    );
  }

  async callCodexMcpTool(
    _managerAgentId: string,
    _params: { selector: string; args?: Record<string, unknown> },
  ): Promise<CodexMcpToolCallResult> {
    throw new Error(
      "Raw Codex MCP tool calls are not available to manager runtimes. Use @Codex plugin selector mentions and spawn the visible codex-plugin specialist.",
    );
  }

  getCodexPluginScopeForWorker(workerAgentId: string): CodexPluginScopeRuntimeView | undefined {
    const descriptor = this.descriptors.get(workerAgentId);
    if (!isCodexPluginWorkerDescriptor(descriptor)) {
      return undefined;
    }

    return this.codexPluginScopeService.getScopeForWorker(workerAgentId);
  }

  async callCodexPluginScopedTool(
    workerAgentId: string,
    scopedToolName: string,
    args?: Record<string, unknown>,
  ): Promise<CodexMcpToolCallResult> {
    const { worker, manager, allowed } = this.authorizeCodexPluginScopedTool(workerAgentId, scopedToolName);
    return this.codexAppServerService.callCodexMcpToolByExactTool({
      managerAgentId: manager.agentId,
      ownerId: workerAgentId,
      cwd: manager.cwd ?? worker.cwd ?? process.cwd(),
      tool: {
        selector: `${allowed.serverName}/${allowed.toolName}`,
        serverName: allowed.serverName,
        toolName: allowed.toolName,
        description: allowed.description,
        inputSchema: allowed.inputSchema,
        readOnly: true,
        annotations: { readOnlyHint: true },
      },
      args,
    });
  }

  async exportCodexPluginScopedToolResult(
    workerAgentId: string,
    input: {
      scopedToolName: string;
      args?: Record<string, unknown>;
      fileName?: string;
      format: CodexPluginExportFormat;
      includePreview: boolean;
    },
  ): Promise<CodexPluginScopedExportResult> {
    const { manager, allowed, scope } = this.authorizeCodexPluginScopedTool(workerAgentId, input.scopedToolName);
    const result = await this.callCodexPluginScopedTool(workerAgentId, input.scopedToolName, input.args);
    if (!result.ok) {
      throw new Error(result.errorPreview ?? "Codex plugin scoped tool call failed; no export artifact was written.");
    }
    if (!result.redactedModelContent) {
      throw new Error(
        "Codex plugin scoped tool returned only a bounded preview; full export payload is unavailable, so no artifact was written.",
      );
    }
    if (result.redactedModelContentTruncated) {
      throw new Error(
        "Codex plugin scoped tool full payload was truncated before export; no artifact was written. Ask the user to narrow the request or use a plugin-native export if available.",
      );
    }

    const format = input.format;
    const artifactBody = JSON.stringify(JSON.parse(result.redactedModelContent), null, 2);
    const extension = "json";
    const baseName = sanitizePathSegment(
      input.fileName ?? `${allowed.toolName}-${Date.now()}`,
      allowed.toolName || "codex-plugin-result",
    ).replace(/\.(json|txt|text|md|markdown)$/i, "");
    const sessionDir = this.getSessionDirForDescriptor(manager);
    const artifactDir = join(
      sessionDir,
      "artifacts",
      "codex-plugin",
      sanitizePathSegment(scope.delegationId, "delegation"),
    );
    await mkdir(artifactDir, { recursive: true });
    // Codex Plugin export artifacts intentionally persist the full redacted connector payload
    // under session data. Only the path, metadata, and bounded preview are returned to chat/model context.
    const absolutePath = await writeUniqueArtifactFile(
      artifactDir,
      baseName,
      extension,
      artifactBody,
    );
    const bytes = Buffer.byteLength(artifactBody, "utf8");
    const manifestPath = `${absolutePath}.manifest.json`;
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: this.now(),
        managerAgentId: manager.agentId,
        workerAgentId,
        delegationId: scope.delegationId,
        selector: result.selector,
        serverName: result.serverName,
        toolName: result.toolName,
        scopedToolName: input.scopedToolName,
        format,
        bytes,
        argsSha256: hashCodexPluginExportArgs(input.args),
        redacted: true,
        truncated: false,
        sourceAuditId: result.auditId,
        artifactPath: absolutePath,
      }, null, 2),
      "utf8",
    );

    return {
      ok: true,
      absolutePath,
      manifestPath,
      artifactMarkdown: formatArtifactShortcode(absolutePath),
      manifestMarkdown: formatArtifactShortcode(manifestPath),
      bytes,
      selector: result.selector,
      serverName: result.serverName,
      toolName: result.toolName,
      scopedToolName: input.scopedToolName,
      format,
      auditId: result.auditId,
      truncated: false,
      ...(input.includePreview && result.redactedPreview
        ? { preview: truncateCodexPreview(result.redactedPreview) }
        : {}),
    };
  }

  private authorizeCodexPluginScopedTool(
    workerAgentId: string,
    scopedToolName: string,
  ): {
    worker: AgentDescriptor & { role: "worker" };
    manager: AgentDescriptor & { role: "manager" };
    allowed: ReturnType<CodexPluginScopeService["authorizeScopedToolCall"]>["tool"];
    scope: ReturnType<CodexPluginScopeService["authorizeScopedToolCall"]>["scope"];
  } {
    const worker = this.descriptors.get(workerAgentId);
    if (!isCodexPluginWorkerDescriptor(worker)) {
      throw new Error("Codex plugin scoped tools are only available to scoped Codex Plugin specialist workers.");
    }

    const authorization = this.codexPluginScopeService.authorizeScopedToolCall(
      workerAgentId,
      scopedToolName,
    );
    if (authorization.scope.workerAgentId !== workerAgentId) {
      throw new Error("Codex plugin scope worker mismatch.");
    }

    const manager = this.descriptors.get(authorization.scope.managerAgentId);
    if (!manager || manager.role !== "manager") {
      throw new Error("Codex plugin scoped tool is missing its owning manager session.");
    }

    if (worker.managerId !== manager.agentId) {
      throw new Error("Codex plugin worker is no longer owned by the scoped manager.");
    }

    return {
      worker,
      manager: manager as AgentDescriptor & { role: "manager" },
      allowed: authorization.tool,
      scope: authorization.scope,
    };
  }

  private requireManagerForCodexTools(
    managerAgentId: string,
  ): AgentDescriptor & { role: "manager"; profileId: string } {
    const manager = this.descriptors.get(managerAgentId);
    if (!manager || manager.role !== "manager") {
      throw new Error(`Codex MCP tools require a manager session: ${managerAgentId}`);
    }

    return manager as AgentDescriptor & { role: "manager"; profileId: string };
  }

  private hasActiveAuthorizedCodexMcpToolGate(managerAgentId: string): boolean {
    const gate = this.codexMcpToolTurnGateByManagerId.get(managerAgentId);
    return Boolean(gate?.allowed && gate.authorizedSelectors && gate.authorizedSelectors.length > 0);
  }

  private buildCodexMcpToolTurnGate(
    manager: AgentDescriptor,
    sourceContext: MessageSourceContext,
    messageText: string,
    codexClassification: ReturnType<typeof classifyCodexUserMessage>,
    inboundSource: PreparedInboundConversationPayload["source"] = "user_input",
  ): CodexMcpToolGateEvaluation {
    const surfaceGate = evaluateCodexMcpToolGate({
      manager,
      sourceContext,
      messageText,
      inboundSource,
    });
    return buildCodexMcpToolTurnAuthorization({
      surfaceGate,
      codexClassification,
    });
  }

  private assertCodexMentionRoutingAvailable(manager: AgentDescriptor & { role: "manager"; profileId: string }): void {
    const conflictingProjectAgent = this.getSessionsForProfile(manager.profileId).find(
      (descriptor) =>
        typeof descriptor.projectAgent?.handle === "string" &&
        isReservedProjectAgentHandle(descriptor.projectAgent.handle),
    );
    if (!conflictingProjectAgent) {
      return;
    }

    throw new Error(
      'Codex @mention routing is unavailable because project agent handle "codex" is already in use in this profile. Rename that project agent and try again.',
    );
  }

  private async routeCodexSidecarUserMessage(
    manager: AgentDescriptor,
    sidecar: AgentDescriptor,
    text: string,
    sourceContext: MessageSourceContext,
    options: { emitParentRequestCard: boolean },
  ): Promise<void> {
    this.logDebug("codex_sidecar:user_message_route", {
      managerAgentId: manager.agentId,
      sidecarAgentId: sidecar.agentId,
      sourceContext,
      emitParentRequestCard: options.emitParentRequestCard,
      textPreview: previewForLog(text),
    });

    try {
      await this.codexAppServerService.sendTextTurn(sidecar.agentId, text, {
        promptPreview: truncateCodexPreview(text),
        parentRouting: {
          managerAgentId: manager.agentId,
          emitParentRequestCard: options.emitParentRequestCard,
          sourceContext,
        },
      });
      const routedAt = this.now();
      this.markSessionActivity(manager.agentId, routedAt);
      this.markSessionUserMessageActivity(manager.agentId, routedAt);
    } catch (error) {
      if (error instanceof CodexSidecarBusyError) {
        throw new Error("Codex is busy with an active turn. Stop the current turn or wait for it to finish.");
      }

      throw error;
    }
  }

  private async appendConversationUserMessageInternal(
    target: AgentDescriptor,
    text: string,
    attachments: ConversationAttachment[],
    sourceContext: MessageSourceContext,
    collaborationAuthor?: CollaborationAuthor,
    replyTo?: ConversationReplyTarget,
  ): Promise<AppendConversationUserMessageResult> {
    const receivedAt = this.now();
    const managerContextId = target.role === "manager" ? target.agentId : target.managerId;

    this.logDebug("manager:user_message_received", {
      targetAgentId: target.agentId,
      managerContextId,
      sourceContext,
      textPreview: previewForLog(text),
      attachmentCount: attachments.length,
      collaborationAuthor: collaborationAuthor
        ? {
            userId: collaborationAuthor.userId,
            workspaceId: collaborationAuthor.workspaceId,
            channelId: collaborationAuthor.channelId,
            role: collaborationAuthor.role,
          }
        : undefined,
    });

    const appended = await this.appendPreparedInboundConversationPayload(target, {
      text,
      timestamp: receivedAt,
      source: "user_input",
      sourceContext,
      collaborationAuthor,
      attachments,
      replyTo,
    });

    return {
      target,
      text,
      sourceContext,
      receivedAt,
      event: appended.event,
      persistedAttachments: appended.persistedAttachments,
      runtimeAttachments: appended.runtimeAttachments
    };
  }

  private async appendPreparedInboundConversationPayload(
    target: AgentDescriptor,
    payload: PreparedInboundConversationPayload
  ): Promise<AppendPreparedInboundConversationPayloadResult> {
    const attachments = payload.source === "user_input"
      ? normalizeConversationAttachments(payload.attachments)
      : [];
    const persistedAttachments = await this.persistConversationAttachmentsIfNeeded(attachments);
    const attachmentMetadata = toConversationAttachmentMetadata(
      persistedAttachments,
      this.config.paths.uploadsDir
    );
    const runtimeAttachments = toRuntimeDispatchAttachments(attachments, persistedAttachments);
    const timestamp = payload.timestamp ?? this.now();
    const event: ConversationMessageEvent = {
      type: "conversation_message",
      agentId: target.agentId,
      role: "user",
      text: payload.text,
      attachments: attachmentMetadata.length > 0 ? attachmentMetadata : undefined,
      timestamp,
      source: payload.source,
      sourceContext: payload.source === "user_input" ? payload.sourceContext : undefined,
      collaborationAuthor: payload.source === "user_input" ? payload.collaborationAuthor : undefined,
      projectAgentContext: payload.source === "project_agent_input" ? payload.projectAgentContext : undefined,
      replyTo: payload.source === "user_input" ? payload.replyTo : undefined,
    };
    this.emitConversationMessage(event);
    this.markSessionActivity(target.agentId, timestamp);
    if (payload.source === "user_input") {
      this.markSessionUserMessageActivity(target.agentId, timestamp);
    }

    return {
      event,
      persistedAttachments,
      runtimeAttachments
    };
  }

  private appendCodexPluginManagerTurnGuidance(
    managerVisibleMessage: string,
    context: CodexPluginDelegationTurnContext,
  ): string {
    const strippedRequest = context.strippedText.trim() || "(No remaining request text after selector tokens.)";
    return [
      managerVisibleMessage,
      "",
      "[Codex Plugin selector context]",
      `Selected selector(s), bound server-side for this scoped Codex Plugin worker: ${context.selectors.join(", ")}`,
      `Request after removing selector tokens: ${strippedRequest}`,
      "If plugin data or work is needed, spawn the visible Codex Plugin specialist with spawn_agent({ specialist: \"codex-plugin\", initialMessage: \"<task and context>\" }). The server binds only the selected scope to that worker for its lifetime; do not include or invent selectors in the worker input.",
      `Retry context id if this scoped worker is later stopped or fails: ${context.contextId}. Retry is server-authorized only on a future user turn that explicitly asks to retry/continue this request; otherwise require a fresh @Codex selector tag.`,
      "If this user turn includes attachments, inspect them in the manager context and pass only relevant text summaries to the Codex Plugin specialist; attachment payloads are not forwarded to Codex Plugin workers.",
      "Do not relay full transcripts or long connector results in chunks. Tell Codex Plugin workers to use export_scoped_codex_plugin_result for full Fireflies transcript/summary downloads, then report only artifact metadata/path and a bounded preview.",
      "Do not call raw Codex MCP tools. Do not start a plain Codex sidecar unless the user specifically requested plain @Codex sidecar behavior.",
    ].join("\n");
  }

  private appendCodexPluginRetryManagerTurnGuidance(
    managerVisibleMessage: string,
    authorization: CodexPluginRetryAuthorizationContext,
  ): string {
    const strippedRequest = authorization.activeContext.strippedText.trim() || "(No remaining request text after selector tokens.)";
    return [
      managerVisibleMessage,
      "",
      "[Codex Plugin retry authorization]",
      `Forge classified this user turn as an explicit retry/continuation of a stopped or failed scoped Codex Plugin worker. Retry context id: ${authorization.retryContextId}`,
      `Stored selector(s), bound server-side for the retried scoped worker: ${authorization.activeContext.selectors.join(", ")}`,
      `Original request after removing selector tokens: ${strippedRequest}`,
      "Use retry_codex_plugin_worker({ initialMessage, retryContextId }) if Codex Plugin work is still needed. Do not use spawn_agent({ specialist: \"codex-plugin\" }) on this retry turn, and do not include, invent, or widen selectors in the retry input.",
      "If the user asks for a different plugin/scope, or this retry tool fails authorization, ask for a fresh @Codex plugin selector tag.",
      "Do not relay full transcripts or long connector results in chunks. Tell Codex Plugin workers to use export_scoped_codex_plugin_result for full Fireflies transcript/summary downloads, then report only artifact metadata/path and a bounded preview.",
    ].join("\n");
  }

  private async dispatchRuntimeUserMessageInternal(
    target: AgentDescriptor,
    text: string,
    sourceContext: MessageSourceContext,
    runtimeAttachments: ConversationAttachment[],
    persistedAttachmentCount: number,
    visibleMessageId?: string,
    delivery?: RequestedDeliveryMode,
    collaborationAuthor?: CollaborationAuthor,
    codexClassification: ReturnType<typeof classifyCodexUserMessage> = { kind: "none" },
    codexPluginDelegationContext?: CodexPluginDelegationTurnContext,
    codexPluginRetryAuthorizationContext?: CodexPluginRetryAuthorizationContext,
    replyTo?: ConversationReplyTarget,
  ): Promise<void> {
    const managerContextId = target.role === "manager" ? target.agentId : target.managerId;

    if (target.role !== "manager") {
      if (isExternalThreadDescriptor(target)) {
        throw new Error("Codex sidecar messages must route through the Codex sidecar path.");
      }

      const requestedDelivery = delivery ?? "auto";
      const workerRuntimeText = replyTo
        ? formatInboundUserMessageForManager(text, sourceContext, undefined, undefined, replyTo)
        : text;
      let receipt: SendMessageReceipt;
      try {
        receipt = await this.sendMessage(managerContextId, target.agentId, workerRuntimeText, requestedDelivery, {
          origin: "user",
          attachments: runtimeAttachments
        });
      } catch (error) {
        this.logDebug("manager:user_message_dispatch_error", {
          managerContextId,
          targetAgentId: target.agentId,
          targetRole: target.role,
          requestedDelivery,
          sourceContext,
          textPreview: previewForLog(text),
          attachmentCount: persistedAttachmentCount,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }

      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId: target.agentId,
        targetRole: target.role,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: persistedAttachmentCount
      });

      this.emitAgentMessage({
        type: "agent_message",
        agentId: managerContextId,
        timestamp: this.now(),
        source: "user_to_agent",
        toAgentId: target.agentId,
        text,
        sourceContext,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        attachmentCount: persistedAttachmentCount > 0 ? persistedAttachmentCount : undefined
      });
      return;
    }

    if (this.runtimeRecoveryState.hasPendingManagerRuntimeRecycle(target.agentId)) {
      const recycleDisposition = await this.applyManagerRuntimeRecyclePolicy(target.agentId, "idle_transition");
      if (recycleDisposition === "recycled") {
        await this.saveStore();
        this.emitAgentsSnapshot();
      }
    }

    let managerRuntime: SwarmAgentRuntime;
    try {
      managerRuntime = await this.getOrCreateRuntimeForDescriptor(target);
    } catch (error) {
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        sourceContext,
        textPreview: previewForLog(text),
        attachmentCount: persistedAttachmentCount,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }

    const assistantOutputTarget = this.resolveAssistantOutputTargetForUserInput(target, sourceContext, collaborationAuthor);
    const managerVisibleMessage = formatInboundUserMessageForManager(
      text,
      sourceContext,
      collaborationAuthor,
      assistantOutputTarget,
      replyTo,
    );
    const runtimeVisibleMessage = codexPluginDelegationContext
      ? this.appendCodexPluginManagerTurnGuidance(managerVisibleMessage, codexPluginDelegationContext)
      : codexPluginRetryAuthorizationContext
        ? this.appendCodexPluginRetryManagerTurnGuidance(managerVisibleMessage, codexPluginRetryAuthorizationContext)
        : managerVisibleMessage;

    const runtimeMessage = await this.prepareModelInboundMessage(
      managerContextId,
      {
        text: runtimeVisibleMessage,
        attachments: runtimeAttachments
      },
      "user"
    );

    this.logDebug("manager:user_message_dispatch_start", {
      managerContextId,
      targetAgentId: managerContextId,
      targetRole: target.role,
      requestedDelivery: "steer",
      sourceContext,
      textPreview: previewForLog(text),
      attachmentCount: persistedAttachmentCount,
      runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
      runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0)
    });

    const codexMcpToolGate =
      target.role === "manager"
        ? this.buildCodexMcpToolTurnGate(
            target as AgentDescriptor & { role: "manager" },
            sourceContext,
            text,
            codexClassification,
            "user_input",
          )
        : undefined;
    const observabilityInput = this.beginObservabilityRuntimeInput({
      target,
      rootSource: "user_input",
      originalInput: text,
      runtimeInput: runtimeMessage,
      visibleMessageId,
      requestedDelivery: "steer",
      sourceChannel: sourceContext.channel,
      metadata: {
        attachmentCount: persistedAttachmentCount,
        codexPluginDelegation: Boolean(codexPluginDelegationContext),
        collaboration: Boolean(collaborationAuthor),
      },
    });
    const rollbackInboundTurnContext = await this.enqueueInboundTurnContext(managerContextId, {
      source: "user_input",
      rootTurnId: observabilityInput?.rootTurnId,
      runtimeMessageText: extractRuntimeMessageText(runtimeMessage),
      sourceContext,
      collaborationAuthor,
      assistantOutputTarget,
      codexMcpToolGate,
      codexPluginDelegationContext,
      codexPluginRetryAuthorizationContext,
    });

    try {
      const receipt = await managerRuntime.sendMessage(runtimeMessage, "steer");
      this.completeObservabilityRuntimeInput(observabilityInput, receipt, {
        attachmentCount: persistedAttachmentCount,
        codexPluginDelegation: Boolean(codexPluginDelegationContext),
        collaboration: Boolean(collaborationAuthor),
      });
      if (codexMcpToolGate) {
        this.codexMcpToolTurnGateByManagerId.set(managerContextId, codexMcpToolGate);
      }
      if (codexPluginDelegationContext && receipt.acceptedMode === "prompt") {
        this.activeCodexPluginDelegationByManagerId.set(managerContextId, codexPluginDelegationContext);
        this.activeCodexPluginRetryAuthorizationByManagerId.delete(managerContextId);
        this.rememberCodexPluginRetryContext(codexPluginDelegationContext);
      } else if (codexPluginRetryAuthorizationContext && receipt.acceptedMode === "prompt") {
        this.activeCodexPluginDelegationByManagerId.delete(managerContextId);
        this.activeCodexPluginRetryAuthorizationByManagerId.set(
          managerContextId,
          codexPluginRetryAuthorizationContext,
        );
      }
      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: persistedAttachmentCount
      });
    } catch (error) {
      rollbackInboundTurnContext();
      this.cancelObservabilityRuntimeInput(observabilityInput, "manager_user_dispatch_failed");
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        sourceContext,
        textPreview: previewForLog(text),
        attachmentCount: persistedAttachmentCount,
        runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
        runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0),
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  private async maybeStartCortexReviewRunFromIncomingMessage(
    text: string,
    target: AgentDescriptor,
    sourceContext: MessageSourceContext
  ): Promise<boolean> {
    return this.cortexService.maybeStartReviewRunFromIncomingMessage(text, target, sourceContext);
  }

  async resetManagerSession(
    managerIdOrReason: string | "user_new_command" | "api_reset" = "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): Promise<void> {
    const parsed = this.parseResetManagerSessionArgs(managerIdOrReason, maybeReason);
    const managerId = parsed.managerId;
    const reason = parsed.reason;
    const managerDescriptor = this.getRequiredBuilderManagerDescriptor(managerId, "reset Builder conversations");
    const profileId = managerDescriptor.profileId ?? managerDescriptor.agentId;

    this.logDebug("manager:reset:start", {
      managerId,
      reason,
      profileId
    });

    const { sessionAgent } = await this.createSession(profileId, { label: "New chat" });

    this.emitConversationReset(managerId, reason);

    this.logDebug("manager:reset:ready", {
      managerId,
      reason,
      profileId,
      newSessionAgentId: sessionAgent.agentId
    });
  }

  getConfig(): SwarmConfig {
    return this.config;
  }

  getObservabilityService(): ObservabilityFacade | undefined {
    return this.observability;
  }

  beforeRuntimeEventProjection(agentId: string, _runtimeToken: number | undefined, event: RuntimeSessionEvent): void {
    this.applyInboundTurnContextRuntimeEvent(agentId, event, "before_projection");
  }

  afterRuntimeEventProjection(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void {
    this.applyInboundTurnContextRuntimeEvent(agentId, event, "after_projection");
    this.recordObservabilityRuntimeSessionEvent(agentId, runtimeToken, event);
  }

  onAcceptedRuntimeSessionEvent(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void {
    this.afterRuntimeEventProjection(agentId, runtimeToken, event);
  }

  private recordObservabilityRuntimeSessionEvent(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || !this.observability) {
      return;
    }

    this.observability.recordRuntimeSessionEvent({
      agentId,
      managerId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      profileId: descriptor.profileId,
      role: descriptor.role,
      runtimeType: this.getObservabilityRuntimeType(descriptor),
      runtimeToken,
      agentName: descriptor.displayName,
      event,
      metadata: {
        modelProvider: descriptor.model.provider,
        modelId: descriptor.model.modelId,
        status: descriptor.status,
      },
    });
  }

  private getObservabilityRuntimeType(descriptor: AgentDescriptor): "pi" | "claude-sdk" | "cursor-sdk" {
    if (descriptor.model.provider === "claude-sdk") return "claude-sdk";
    if (descriptor.model.provider === "cursor-sdk") return "cursor-sdk";
    return "pi";
  }

  private resolveObservabilityParentTool(input: {
    agentId: string;
    runtimeToken?: number;
    toolCallId: string;
    toolName?: string;
  } | undefined): { agentId: string; runtimeToken?: number; toolCallId: string; toolName?: string } | undefined {
    if (!input) {
      return undefined;
    }
    return {
      ...input,
      runtimeToken: input.runtimeToken ?? this.runtimeController.getRuntimeToken(input.agentId),
    };
  }

  private recordObservabilityAgentDelivery(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    rootTurnId?: string;
    parentRootTurnId?: string;
    message?: unknown;
    runtimeInput?: unknown;
    delivery: RequestedDeliveryMode;
    receipt: SendMessageReceipt;
    source: "agent_message" | "project_agent" | "internal";
    parentTool?: {
      agentId: string;
      runtimeToken?: number;
      toolCallId: string;
      toolName?: string;
    };
    metadata?: Record<string, unknown>;
  }): void {
    if (!this.observability) {
      return;
    }

    this.observability.recordAgentDelivery({
      fromAgentId: input.sender.agentId,
      targetAgentId: input.target.agentId,
      managerId: input.target.role === "manager" ? input.target.agentId : input.target.managerId,
      profileId: input.target.profileId,
      sourceAgentName: input.sender.displayName,
      targetAgentName: input.target.displayName,
      rootTurnId: input.rootTurnId,
      parentRootTurnId: input.parentRootTurnId,
      message: input.message,
      runtimeInput: input.runtimeInput,
      requestedDelivery: input.delivery,
      acceptedMode: input.receipt.acceptedMode,
      deliveryId: input.receipt.deliveryId,
      source: input.source,
      parentTool: input.parentTool,
      metadata: {
        senderRole: input.sender.role,
        targetRole: input.target.role,
        parentRootSemantics: input.parentRootTurnId ? "top_level_root_turn" : "self_root_turn",
        ...input.metadata,
      },
    });
  }

  private beginObservabilityRuntimeInput(input: {
    target: AgentDescriptor;
    rootSource: ObservabilityRootSource;
    originalInput?: unknown;
    runtimeInput: unknown;
    rootTurnId?: string;
    parentRootTurnId?: string;
    visibleMessageId?: string;
    requestedDelivery?: RequestedDeliveryMode;
    acceptedMode?: string;
    sourceChannel?: string;
    metadata?: Record<string, unknown>;
  }): ObservabilityRuntimeInputHandle | undefined {
    if (!this.observability) {
      return undefined;
    }

    const handle = this.observability.beginRuntimeInput({
      targetAgentId: input.target.agentId,
      managerId: input.target.role === "manager" ? input.target.agentId : input.target.managerId,
      profileId: input.target.profileId,
      role: input.target.role,
      runtimeType: this.getObservabilityRuntimeType(input.target),
      runtimeToken: this.runtimeController.getRuntimeToken(input.target.agentId),
      rootSource: input.rootSource,
      originalInput: input.originalInput,
      runtimeInput: input.runtimeInput,
      rootTurnId: input.rootTurnId,
      parentRootTurnId: input.parentRootTurnId,
      requestPayloadFidelity: "delta_only",
      visibleMessageId: input.visibleMessageId,
      requestedDelivery: input.requestedDelivery,
      acceptedMode: input.acceptedMode,
      sourceChannel: input.sourceChannel,
      agentName: input.target.displayName,
      metadata: {
        modelProvider: input.target.model.provider,
        modelId: input.target.model.modelId,
        ...input.metadata,
      },
    });
    if (handle) {
      this.activeObservabilityRootByAgentId.set(input.target.agentId, {
        rootTurnId: handle.rootTurnId,
        parentRootTurnId: input.parentRootTurnId,
      });
    }
    return handle;
  }

  private completeObservabilityRuntimeInput(
    handle: ObservabilityRuntimeInputHandle | undefined,
    receipt: SendMessageReceipt,
    metadata?: Record<string, unknown>,
  ): void {
    this.observability?.completeRuntimeInput(handle, {
      acceptedMode: receipt.acceptedMode,
      deliveryId: receipt.deliveryId,
      metadata,
    });
  }

  private cancelObservabilityRuntimeInput(handle: ObservabilityRuntimeInputHandle | undefined, reason: string): void {
    if (handle && this.activeObservabilityRootByAgentId.get(handle.targetAgentId)?.rootTurnId === handle.rootTurnId) {
      this.activeObservabilityRootByAgentId.delete(handle.targetAgentId);
    }
    this.observability?.cancelRuntimeInput(handle, reason);
  }

  getVersioningService(): VersioningMutationSink | undefined {
    return this.versioningService;
  }

  private resolveAssistantOutputTargetForUserInput(
    target: AgentDescriptor,
    sourceContext: MessageSourceContext,
    collaborationAuthor?: CollaborationAuthor,
  ): AssistantOutputTarget {
    if (collaborationAuthor) {
      return { kind: "explicit_tool_required", reason: "collaboration_channel" };
    }

    if (target.sessionPurpose === "cortex_review" || normalizeArchetypeId(target.archetypeId ?? "") === CORTEX_ARCHETYPE_ID) {
      return { kind: "explicit_tool_required", reason: "cortex_session" };
    }

    // Prompt migration is scoped to normal web session transcripts. Worker-report
    // closeouts may inherit this target through the manager-local delegation handoff;
    // collaboration, external channels, and secondary system archetypes remain explicit-tool-required.
    if (sourceContext.channel === "web") {
      return { kind: "session_transcript", channel: "web", sourceContext };
    }

    if (sourceContext.channel === "telegram") {
      return { kind: "external_channel", sourceContext };
    }

    return { kind: "explicit_tool_required", reason: `unsupported_direct_${sourceContext.channel}_source` };
  }

  getActiveTurnId(agentId: string, runtimeToken?: number): string | undefined {
    const activeTurn = this.activeTurnByAgentId.get(agentId);
    if (!activeTurn) {
      return undefined;
    }

    if (
      runtimeToken !== undefined &&
      activeTurn.runtimeToken !== undefined &&
      activeTurn.runtimeToken !== runtimeToken
    ) {
      return undefined;
    }

    return activeTurn.turnId;
  }

  private async enqueueInboundTurnContext(agentId: string, context: PendingInboundTurnContext): Promise<() => void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Cannot mint turn id for unknown agent: ${agentId}`);
    }

    const runtimeToken = this.runtimeController.getRuntimeToken(agentId);
    const queuedContext: PendingInboundTurnContext = {
      ...context,
      activationEligible: context.activationEligible ?? true,
      turnId: await this.sessionMetaService.mintTurnIdForDescriptor(descriptor),
      ...(runtimeToken !== undefined ? { runtimeToken } : {})
    };

    const queue = this.pendingInboundTurnContextsByAgentId.get(agentId) ?? [];
    queue.push(queuedContext);
    this.pendingInboundTurnContextsByAgentId.set(agentId, queue);
    if (!this.activeTurnByAgentId.has(agentId)) {
      this.activeTurnByAgentId.set(agentId, {
        turnId: queuedContext.turnId!,
        ...(runtimeToken !== undefined ? { runtimeToken } : {})
      });
    }

    return () => {
      const currentQueue = this.pendingInboundTurnContextsByAgentId.get(agentId);
      if (currentQueue) {
        const index = currentQueue.lastIndexOf(queuedContext);
        if (index >= 0) {
          currentQueue.splice(index, 1);
        }

        if (currentQueue.length === 0) {
          this.pendingInboundTurnContextsByAgentId.delete(agentId);
        }
      }

      if (this.activeTurnByAgentId.get(agentId)?.turnId === queuedContext.turnId) {
        this.activeTurnByAgentId.delete(agentId);
      }
    };
  }

  private setActiveTurnFromInboundContext(agentId: string, context: PendingInboundTurnContext): void {
    if (!context.turnId) {
      this.activeTurnByAgentId.delete(agentId);
      return;
    }

    this.activeTurnByAgentId.set(agentId, {
      turnId: context.turnId,
      ...(context.runtimeToken !== undefined ? { runtimeToken: context.runtimeToken } : {})
    });
  }

  private dequeueInboundTurnContextForRuntimeMessage(
    agentId: string,
    message: RuntimeSessionMessage,
  ): PendingInboundTurnContext | undefined {
    const queue = this.pendingInboundTurnContextsByAgentId.get(agentId);
    const nextContext = queue?.[0];
    if (!queue || !nextContext) {
      return undefined;
    }

    const messageText = extractMessageText(message);
    const contextIndex = queue.findIndex((context) => {
      if (context.runtimeMessageText === undefined) {
        return false;
      }
      return Boolean(messageText && runtimeMessageTextMatches(context.runtimeMessageText, messageText));
    });
    if (contextIndex < 0) {
      return undefined;
    }

    const [matchedContext] = queue.splice(contextIndex, 1);
    if (queue.length === 0) {
      this.pendingInboundTurnContextsByAgentId.delete(agentId);
    }

    return matchedContext;
  }

  private activateInboundTurnContext(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    nextContext: PendingInboundTurnContext | undefined,
    options?: { preserveActiveTurn?: boolean },
  ): void {
    if (nextContext?.turnId) {
      this.setActiveTurnFromInboundContext(agentId, nextContext);
    } else if (!options?.preserveActiveTurn) {
      this.activeTurnByAgentId.delete(agentId);
    }

    if (nextContext?.rootTurnId) {
      this.activeObservabilityRootByAgentId.set(agentId, {
        rootTurnId: nextContext.rootTurnId,
        parentRootTurnId: nextContext.parentRootTurnId,
      });
    } else if (nextContext) {
      this.activeObservabilityRootByAgentId.delete(agentId);
    }

    const externalProjectAgentContext = nextContext?.source === "project_agent_input" && nextContext.projectAgentContext?.external
      ? {
          fromAgentId: nextContext.projectAgentContext.fromAgentId,
          fromDisplayName: nextContext.projectAgentContext.fromDisplayName,
          ...(nextContext.projectAgentContext.fromProfileId
            ? { fromProfileId: nextContext.projectAgentContext.fromProfileId }
            : {}),
          ...(nextContext.projectAgentContext.fromProjectName
            ? { fromProjectName: nextContext.projectAgentContext.fromProjectName }
            : {}),
        }
      : undefined;

    if (externalProjectAgentContext) {
      this.activeExternalProjectAgentTurnByAgentId.set(agentId, externalProjectAgentContext);
    } else {
      this.activeExternalProjectAgentTurnByAgentId.delete(agentId);
    }

    const manager = descriptor ?? this.descriptors.get(agentId);
    if (manager?.role !== "manager") {
      return;
    }

    const assistantOutputProjectionTarget = nextContext?.assistantOutputProjectionTarget ?? nextContext?.assistantOutputTarget;
    if (assistantOutputProjectionTarget) {
      this.activeAssistantOutputTargetByManagerId.set(agentId, assistantOutputProjectionTarget);
      this.runtimeController.activateManagerAssistantOutputTurn(agentId, assistantOutputProjectionTarget, {
        turnId: nextContext?.turnId,
      });
      if (assistantOutputProjectionTarget.kind === "session_transcript" && assistantOutputProjectionTarget.channel === "web") {
        this.activeWebAssistantOutputTurnByManagerId.set(agentId, cloneSessionTranscriptAssistantOutputTarget(assistantOutputProjectionTarget));
      } else {
        this.activeWebAssistantOutputTurnByManagerId.delete(agentId);
      }
    } else {
      this.activeAssistantOutputTargetByManagerId.delete(agentId);
      this.activeWebAssistantOutputTurnByManagerId.delete(agentId);
      this.runtimeController.clearManagerAssistantOutputTurn(agentId);
    }

    if (nextContext?.codexMcpToolGate) {
      this.codexMcpToolTurnGateByManagerId.set(agentId, nextContext.codexMcpToolGate);
    } else if (!this.hasActiveAuthorizedCodexMcpToolGate(agentId)) {
      this.codexMcpToolTurnGateByManagerId.set(agentId, {
        allowed: false,
        reason: "Codex MCP tools are only available on turns with Codex tool mention tags.",
      });
    }

    if (nextContext?.codexPluginDelegationContext) {
      this.activeCodexPluginDelegationByManagerId.set(agentId, nextContext.codexPluginDelegationContext);
      this.rememberCodexPluginRetryContext(nextContext.codexPluginDelegationContext);
    } else {
      this.activeCodexPluginDelegationByManagerId.delete(agentId);
      this.activeCodexPluginRetryAuthorizationByManagerId.delete(agentId);
    }

    if (nextContext?.codexPluginRetryAuthorizationContext) {
      this.activeCodexPluginRetryAuthorizationByManagerId.set(agentId, nextContext.codexPluginRetryAuthorizationContext);
    } else {
      this.activeCodexPluginRetryAuthorizationByManagerId.delete(agentId);
    }
  }

  private activateDequeuedInboundTurnContext(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    nextContext: PendingInboundTurnContext,
  ): void {
    if (nextContext.activationEligible) {
      this.activateInboundTurnContext(agentId, descriptor, nextContext);
      return;
    }

    this.setActiveTurnFromInboundContext(agentId, nextContext);
    this.activateInboundTurnContext(agentId, descriptor, undefined, { preserveActiveTurn: true });
  }

  private dequeueNextInboundTurnContext(agentId: string): PendingInboundTurnContext | undefined {
    const queue = this.pendingInboundTurnContextsByAgentId.get(agentId);
    const nextContext = queue?.shift();
    if (!queue || !nextContext) {
      return undefined;
    }

    if (queue.length === 0) {
      this.pendingInboundTurnContextsByAgentId.delete(agentId);
    }

    return nextContext;
  }

  private applyInboundTurnContextRuntimeEvent(
    agentId: string,
    event: RuntimeSessionEvent,
    phase: "before_projection" | "after_projection",
  ): void {
    const descriptor = this.descriptors.get(agentId);
    if (phase === "before_projection" && isCodexPluginWorkerDescriptor(descriptor)) {
      if (event.type === "message_start" && extractRole(event.message) === "user") {
        this.codexPluginScopeService.noteWorkerTurnStarted(agentId);
      }
    }

    if (phase === "before_projection" && event.type === "turn_start") {
      return;
    }

    if (
      phase === "before_projection" &&
      (event.type === "message_start" || event.type === "message_end") &&
      extractRole(event.message) === "user"
    ) {
      // Providers that do not echo user messages may emit either a synthetic message_start
      // or only the completed user message for the selected runtime input; match by content
      // instead of assuming queued turn FIFO.
      const nextContext = this.dequeueInboundTurnContextForRuntimeMessage(agentId, event.message);
      if (nextContext) {
        this.inboundTurnContextActivatedByAgentId.add(agentId);
        this.activateDequeuedInboundTurnContext(agentId, descriptor, nextContext);
      } else if (!this.inboundTurnContextActivatedByAgentId.has(agentId)) {
        this.activateInboundTurnContext(agentId, descriptor, undefined);
      }
      return;
    }

    if (phase === "after_projection" && event.type === "turn_end") {
      if (!this.inboundTurnContextActivatedByAgentId.has(agentId)) {
        this.dequeueNextInboundTurnContext(agentId);
      }
      this.inboundTurnContextActivatedByAgentId.delete(agentId);
      this.activeTurnByAgentId.delete(agentId);
      this.activeExternalProjectAgentTurnByAgentId.delete(agentId);
      this.activeWebAssistantOutputTurnByManagerId.delete(agentId);
      this.expireActiveWebAssistantOutputTargetIfUncontinued(agentId);
      this.activeObservabilityRootByAgentId.delete(agentId);
      this.codexMcpToolTurnGateByManagerId.delete(agentId);
      this.activeCodexPluginDelegationByManagerId.delete(agentId);
      this.activeCodexPluginRetryAuthorizationByManagerId.delete(agentId);
      return;
    }

    if (phase === "after_projection" && event.type === "agent_end") {
      if (!this.inboundTurnContextActivatedByAgentId.has(agentId)) {
        this.dequeueNextInboundTurnContext(agentId);
      }
      this.inboundTurnContextActivatedByAgentId.delete(agentId);
      this.activeTurnByAgentId.delete(agentId);
      this.activeExternalProjectAgentTurnByAgentId.delete(agentId);
      this.activeAssistantOutputTargetByManagerId.delete(agentId);
      this.activeWebAssistantOutputTurnByManagerId.delete(agentId);
      this.activeObservabilityRootByAgentId.delete(agentId);
      this.codexMcpToolTurnGateByManagerId.delete(agentId);
      this.activeCodexPluginDelegationByManagerId.delete(agentId);
      this.activeCodexPluginRetryAuthorizationByManagerId.delete(agentId);
      this.runtimeController.clearManagerAssistantOutputTurn(agentId);
      return;
    }

    if (phase === "after_projection" && isCleanManagerAssistantFinalMessage(event)) {
      this.inboundTurnContextActivatedByAgentId.delete(agentId);
      this.activeWebAssistantOutputTurnByManagerId.delete(agentId);
      this.expireActiveWebAssistantOutputTargetIfUncontinued(agentId);
    }
  }

  private expireActiveWebAssistantOutputTargetIfUncontinued(agentId: string): void {
    const activeTarget = this.activeAssistantOutputTargetByManagerId.get(agentId);
    if (activeTarget?.kind !== "session_transcript" || activeTarget.channel !== "web") {
      return;
    }

    if (this.hasPendingWebAssistantOutputContinuation(agentId)) {
      return;
    }

    this.activeAssistantOutputTargetByManagerId.delete(agentId);
  }

  private hasPendingWebAssistantOutputContinuation(agentId: string): boolean {
    const queue = this.pendingInboundTurnContextsByAgentId.get(agentId);
    return Boolean(queue?.some((context) => {
      const target = context.assistantOutputProjectionTarget ?? context.assistantOutputTarget;
      return target?.kind === "session_transcript" && target.channel === "web";
    }));
  }

  private getActiveExternalProjectAgentTurn(agentId: string): ExternalProjectAgentTurnContext | undefined {
    return this.activeExternalProjectAgentTurnByAgentId.get(agentId);
  }

  private getActiveAssistantOutputTargetForDelegation(managerId: string): AssistantOutputTarget {
    const target = this.activeAssistantOutputTargetByManagerId.get(managerId);
    return target ? cloneAssistantOutputTarget(target) : { kind: "internal_only", reason: "no_active_root" };
  }

  resolveManagerAssistantFinalOutputTarget(
    agentId: string,
    activeTarget: AssistantOutputTarget | undefined,
  ): SessionTranscriptAssistantOutputTarget | undefined {
    const manager = this.descriptors.get(agentId);
    if (!manager || manager.role !== "manager") {
      return undefined;
    }

    const rememberedTarget = activeTarget ?? this.activeAssistantOutputTargetByManagerId.get(agentId);
    const fallbackTarget: AssistantOutputTarget = { kind: "explicit_tool_required", reason: "missing_active_target" };
    let candidate: SessionTranscriptAssistantOutputTarget | undefined;

    if (rememberedTarget?.kind === "session_transcript" && rememberedTarget.channel === "web") {
      candidate = cloneSessionTranscriptAssistantOutputTarget(rememberedTarget);
    } else if (
      rememberedTarget?.kind === "peer_agent" &&
      !this.activeExternalProjectAgentTurnByAgentId.has(agentId)
    ) {
      candidate = { kind: "session_transcript", channel: "web", sourceContext: { channel: "web" } };
    } else if (!rememberedTarget && !manager.projectAgent && !manager.creatorAgentId) {
      candidate = { kind: "session_transcript", channel: "web", sourceContext: { channel: "web" } };
    }

    if (!candidate) {
      return undefined;
    }

    if (!this.canProjectManagerFinalTextToWebByDefault(
      { sender: manager, target: manager },
      rememberedTarget ?? fallbackTarget,
    )) {
      return undefined;
    }

    return candidate;
  }

  private resolveAssistantOutputTargetForAgentMessage(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    modelMessage: string | RuntimeUserMessage;
    rawMessage?: string;
    workerReportSourceAgentId?: string;
    sendMessageToolContinuation?: boolean;
  }): AssistantOutputTarget {
    const reportLike =
      input.target.role === "manager" &&
      (isWorkerReportRuntimeMessage(input.modelMessage) || isWorkerStatusCloseoutMessage(input.rawMessage));
    if (!this.isAssistantOutputEligibleWorkerReportMessage(input)) {
      return reportLike
        ? { kind: "internal_only", reason: "missing_worker_report_provenance" }
        : { kind: "explicit_tool_required", reason: "agent_message" };
    }

    const sourceWorkerId = this.resolveAssistantOutputWorkerReportSourceId(input);
    if (!sourceWorkerId) {
      return { kind: "internal_only", reason: "missing_worker_report_provenance" };
    }

    const inheritedTarget = this.inheritedAssistantOutputTargetByWorkerId.get(sourceWorkerId);
    return inheritedTarget ? cloneAssistantOutputTarget(inheritedTarget) : { kind: "internal_only", reason: "missing_worker_report_handoff" };
  }

  private resolveAssistantOutputProjectionTargetForAgentMessage(
    input: {
      sender: AgentDescriptor;
      target: AgentDescriptor;
      modelMessage: string | RuntimeUserMessage;
      rawMessage?: string;
      workerReportSourceAgentId?: string;
      sendMessageToolContinuation?: boolean;
    },
    inputTarget: AssistantOutputTarget,
  ): AssistantOutputTarget {
    const inheritedRoutingTarget = this.resolveInheritedAssistantOutputRoutingTarget(input);
    if (inheritedRoutingTarget) {
      return inheritedRoutingTarget;
    }

    const activeWebContinuationTarget = this.resolveActiveWebAssistantOutputContinuationTarget(input, inputTarget);
    if (activeWebContinuationTarget) {
      return activeWebContinuationTarget;
    }

    const defaultWebTarget = this.resolveDefaultManagerFinalTextWebProjectionTarget(input, inputTarget);
    if (defaultWebTarget) {
      return defaultWebTarget;
    }

    return inputTarget;
  }

  private resolveActiveWebAssistantOutputContinuationTarget(
    input: {
      sender: AgentDescriptor;
      target: AgentDescriptor;
      workerReportSourceAgentId?: string;
      sendMessageToolContinuation?: boolean;
    },
    inputTarget: AssistantOutputTarget,
  ): SessionTranscriptAssistantOutputTarget | undefined {
    if (
      input.target.role !== "manager" ||
      inputTarget.kind !== "explicit_tool_required" ||
      inputTarget.reason !== "agent_message"
    ) {
      return undefined;
    }

    const sameManagerToolContinuation =
      input.sender.agentId === input.target.agentId && input.sendMessageToolContinuation === true;
    if (!sameManagerToolContinuation) {
      return undefined;
    }

    const activeTarget = this.activeWebAssistantOutputTurnByManagerId.get(input.target.agentId);
    if (!activeTarget) {
      return undefined;
    }

    if (!this.canProjectManagerFinalTextToWebByDefault(input, activeTarget)) {
      return undefined;
    }

    return cloneSessionTranscriptAssistantOutputTarget(activeTarget);
  }

  private resolveDefaultManagerFinalTextWebProjectionTarget(
    input: {
      sender: AgentDescriptor;
      target: AgentDescriptor;
      workerReportSourceAgentId?: string;
    },
    inputTarget: AssistantOutputTarget,
  ): SessionTranscriptAssistantOutputTarget | undefined {
    if (inputTarget.kind === "session_transcript") {
      if (inputTarget.channel === "web" && !this.canProjectManagerFinalTextToWebByDefault(input, inputTarget)) {
        return undefined;
      }
      return cloneSessionTranscriptAssistantOutputTarget(inputTarget);
    }

    if (!this.canProjectManagerFinalTextToWebByDefault(input, inputTarget)) {
      return undefined;
    }

    return { kind: "session_transcript", channel: "web", sourceContext: { channel: "web" } };
  }

  private resolveInheritedAssistantOutputRoutingTarget(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    workerReportSourceAgentId?: string;
  }): AssistantOutputTarget | undefined {
    const sourceWorkerId = this.resolveAssistantOutputWorkerReportSourceId(input);
    if (!sourceWorkerId) {
      return undefined;
    }

    const inheritedTarget = this.inheritedAssistantOutputTargetByWorkerId.get(sourceWorkerId);
    if (!inheritedTarget) {
      return undefined;
    }

    if (inheritedTarget.kind === "session_transcript") {
      if (inheritedTarget.channel === "web" && !this.canProjectManagerFinalTextToWebByDefault(input, inheritedTarget)) {
        return undefined;
      }
      return cloneAssistantOutputTarget(inheritedTarget);
    }

    if (this.isProtectedInheritedAssistantOutputRoutingTarget(input.target, inheritedTarget)) {
      return cloneAssistantOutputTarget(inheritedTarget);
    }

    return undefined;
  }

  private canProjectManagerFinalTextToWebByDefault(
    input: {
      sender: AgentDescriptor;
      target: AgentDescriptor;
      workerReportSourceAgentId?: string;
    },
    inputTarget: AssistantOutputTarget,
  ): boolean {
    const { sender, target } = input;
    if (target.role !== "manager") {
      return false;
    }

    if (
      (target.projectAgent !== undefined || target.creatorAgentId !== undefined) &&
      inputTarget.kind !== "session_transcript"
    ) {
      return false;
    }

    if (
      sender.role === "manager" &&
      sender.agentId !== target.agentId &&
      (target.projectAgent !== undefined || target.creatorAgentId === sender.agentId)
    ) {
      return false;
    }

    if (
      sender.role === "worker" &&
      (target.projectAgent !== undefined || target.creatorAgentId !== undefined) &&
      inputTarget.kind !== "session_transcript"
    ) {
      return false;
    }

    if (target.sessionSurface === "collab" || target.collab) {
      return false;
    }

    if (
      target.agentId === COLLABORATION_PROFILE_ID ||
      target.profileId === COLLABORATION_PROFILE_ID ||
      target.agentId === CORTEX_PROFILE_ID ||
      target.profileId === CORTEX_PROFILE_ID
    ) {
      return false;
    }

    const profile = target.profileId ? this.profiles.get(target.profileId) : undefined;
    if (profile && isSystemProfile(profile)) {
      return false;
    }

    const archetypeId = normalizeArchetypeId(target.archetypeId ?? "");
    if (target.sessionPurpose === "cortex_review" || archetypeId === CORTEX_ARCHETYPE_ID || archetypeId === "collaboration-channel") {
      return false;
    }

    return true;
  }

  private isProtectedInheritedAssistantOutputRoutingTarget(
    manager: AgentDescriptor,
    target: AssistantOutputTarget,
  ): boolean {
    if (target.kind === "external_channel") {
      return true;
    }

    if (target.kind === "peer_agent") {
      return manager.projectAgent !== undefined || manager.creatorAgentId === target.fromAgentId;
    }

    if (target.kind === "internal_only") {
      return false;
    }

    if (target.kind !== "explicit_tool_required") {
      return false;
    }

    return manager.projectAgent !== undefined || manager.creatorAgentId !== undefined || target.reason !== "agent_message";
  }

  private consumeWorkerAssistantOutputInheritanceAfterReportDispatch(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    modelMessage: string | RuntimeUserMessage;
    rawMessage?: string;
    workerReportSourceAgentId?: string;
  }): void {
    if (!this.isAssistantOutputEligibleWorkerReportMessage(input)) {
      return;
    }

    const sourceWorkerId = this.resolveAssistantOutputWorkerReportSourceId(input);
    if (sourceWorkerId) {
      this.clearWorkerReportConsumedAssistantOutputTarget(sourceWorkerId);
    }
  }

  private clearWorkerReportConsumedAssistantOutputTarget(agentId: string): void {
    const target = this.inheritedAssistantOutputTargetByWorkerId.get(agentId);
    if (!target) {
      return;
    }

    if (target.kind === "session_transcript") {
      this.inheritedAssistantOutputTargetByWorkerId.delete(agentId);
    }
  }

  private isAssistantOutputEligibleWorkerReportMessage(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    modelMessage: string | RuntimeUserMessage;
    rawMessage?: string;
    workerReportSourceAgentId?: string;
    sendMessageToolContinuation?: boolean;
  }): boolean {
    if (input.target.role !== "manager") {
      return false;
    }

    const sourceWorkerId = this.resolveAssistantOutputWorkerReportSourceId(input);
    if (!sourceWorkerId) {
      return false;
    }

    return isWorkerReportRuntimeMessage(input.modelMessage) || isWorkerStatusCloseoutMessage(input.rawMessage);
  }

  private resolveAssistantOutputWorkerReportSourceId(input: {
    sender: AgentDescriptor;
    target: AgentDescriptor;
    workerReportSourceAgentId?: string;
  }): string | undefined {
    if (input.sender.role === "worker" && input.sender.managerId === input.target.agentId) {
      return input.sender.agentId;
    }

    if (!input.workerReportSourceAgentId) {
      return undefined;
    }

    const worker = this.descriptors.get(input.workerReportSourceAgentId);
    return worker?.role === "worker" && worker.managerId === input.target.agentId ? worker.agentId : undefined;
  }

  private rememberWorkerAssistantOutputInheritanceAfterDispatch(
    sender: AgentDescriptor,
    target: AgentDescriptor,
  ): void {
    if (sender.role !== "manager" || target.role !== "worker" || target.managerId !== sender.agentId) {
      return;
    }

    // Keep this as server-owned input routing guidance for worker reports. The
    // manager's later clean final text is projected by the manager/session context,
    // not by this worker handoff; protected targets here still hard-deny projection.
    const inheritedTarget = this.getActiveAssistantOutputTargetForDelegation(sender.agentId);
    this.inheritedAssistantOutputTargetByWorkerId.set(target.agentId, inheritedTarget);
  }

  private getActiveObservabilityRootTurnId(agentId: string): string | undefined {
    const direct = this.activeObservabilityRootByAgentId.get(agentId);
    if (direct) {
      return direct.parentRootTurnId ?? direct.rootTurnId;
    }
    const descriptor = this.descriptors.get(agentId);
    if (descriptor?.role === "worker") {
      const managerRoot = this.activeObservabilityRootByAgentId.get(descriptor.managerId);
      return managerRoot?.parentRootTurnId ?? managerRoot?.rootTurnId;
    }
    return undefined;
  }

  private assertExternalProjectAgentTurnCapabilityAllowed(
    callerAgentId: string,
    capability:
      | "spawn_agent"
      | "kill_agent"
      | "create_session"
      | "create_project_agent"
      | "speak_to_user"
      | "present_choices"
      | "task",
  ): void {
    const context = this.getActiveExternalProjectAgentTurn(callerAgentId);
    if (!context) {
      return;
    }

    throw new Error(
      `External project-agent messages are restricted to a direct reply back to ${context.fromDisplayName} (${context.fromAgentId}). ${capability} is disabled for this turn.`
    );
  }

  private async resolveProjectAgentDeliveryAuthorization(
    sender: AgentDescriptor,
    target: AgentDescriptor,
  ): Promise<{
    allowCrossProfile: boolean;
    allowContactReplyTarget?: boolean;
    externalAuthorization?: ExternalProjectAgentDeliveryAuthorization;
  } | null> {
    if (sender.role !== "manager" || target.role !== "manager" || sender.agentId === target.agentId) {
      return null;
    }

    const senderProfileId = sender.profileId ?? sender.agentId;
    const targetProfileId = target.profileId ?? target.agentId;
    const localProjectAgentDelivery =
      senderProfileId === targetProfileId && (target.projectAgent !== undefined || target.creatorAgentId === sender.agentId);
    if (localProjectAgentDelivery) {
      return { allowCrossProfile: false };
    }

    if (senderProfileId === targetProfileId) {
      return null;
    }

    const externalAuthorization = await this.projectAgentSharingService.authorizeExternalDelivery({
      senderAgentId: sender.agentId,
      senderProfileId,
      targetAgentId: target.agentId,
    });
    if (!externalAuthorization) {
      return null;
    }

    if (!target.projectAgent && externalAuthorization.mode !== "contact_reply") {
      return null;
    }

    const sharedSourceDescriptor = this.descriptors.get(externalAuthorization.sourceAgentId);
    if (
      sharedSourceDescriptor?.role === "manager" &&
      isRepoProjectAgentSource(sharedSourceDescriptor.projectAgent?.source)
    ) {
      await this.assertRepoProjectAgentSourceAvailableForExternalDelivery(sharedSourceDescriptor as AgentDescriptor & {
        role: "manager";
        projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
      });
    }

    return {
      allowCrossProfile: true,
      allowContactReplyTarget: externalAuthorization.mode === "contact_reply",
      externalAuthorization,
    };
  }

  private async notifySharedProjectAgentTargetsChanged(
    sourceAgentId: string,
    targetProfileIds?: readonly string[],
  ): Promise<void> {
    const sourceDescriptor = this.descriptors.get(sourceAgentId);
    const fallbackTargetProfileIds = this.projectAgentSharingService
      .listGrantsForSourceAgent(sourceAgentId)
      .map((grant) => grant.targetProfileId);
    const uniqueTargetProfileIds = Array.from(new Set(targetProfileIds ?? fallbackTargetProfileIds));

    if (uniqueTargetProfileIds.length === 0) {
      return;
    }

    if (sourceDescriptor?.role === "manager" && sourceDescriptor.profileId) {
      this.emitSessionProjectAgentUpdated(
        sourceDescriptor.agentId,
        sourceDescriptor.profileId,
        sourceDescriptor.projectAgent ?? null,
      );
    }

    await Promise.allSettled(uniqueTargetProfileIds.map((profileId) => this.notifyProjectAgentsChanged(profileId)));
  }

  async reloadModelCatalogOverridesAndProjection(): Promise<void> {
    await modelCatalogService.loadOverrides(this.config.paths.dataDir);
    await this.refreshPiModelsJsonProjection();
  }

  async reloadOpenRouterModelsAndProjection(): Promise<void> {
    await modelCatalogService.reloadOpenRouterModels();
    await this.refreshPiModelsJsonProjection();
  }

  listRuntimeExtensionSnapshots(): AgentRuntimeExtensionSnapshot[] {
    return this.runtimeController.listRuntimeExtensionSnapshots();
  }

  async buildForgeExtensionSettingsSnapshot(options: { cwdValues: string[] }) {
    return this.forgeExtensionHost.buildSettingsSnapshot({
      ...options,
      sessions: this.listAgents().filter((descriptor) => descriptor.role === "manager")
    });
  }

  async dispatchForgeVersioningCommit(event: ForgeVersioningCommitEvent): Promise<void> {
    await this.forgeExtensionHost.dispatchVersioningCommit(event);
  }

  setIntegrationContextProvider(provider?: (profileId: string) => string): void {
    this.integrationContextProvider = provider;
  }

  setTerminalArchiveHooks(hooks?: {
    suspendProfileTerminals: (profileId: string) => Promise<unknown>;
    restoreProfileTerminals: (profileId: string) => Promise<unknown>;
  }): void {
    this.terminalArchiveHooks = hooks;
  }

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    return this.settingsService.listSettingsEnv();
  }

  async listSkillMetadata(profileId?: string, sessionAgentId?: string): Promise<SkillInventoryEntry[]> {
    return this.settingsService.listSkillMetadata(profileId, sessionAgentId);
  }

  getCollaborationGlobalSkillHandles(): Iterable<string> {
    return this.skillMetadataService.getSkillMetadata().map((skill) => skill.directoryName);
  }

  async listSkillFiles(
    skillId: string,
    relativePath = "",
    context?: { profileId?: string; sessionAgentId?: string }
  ): Promise<SkillFilesResponse> {
    return this.settingsService.listSkillFiles(skillId, relativePath, context);
  }

  async getSkillFileContent(
    skillId: string,
    relativePath: string,
    context?: { profileId?: string; sessionAgentId?: string }
  ): Promise<SkillFileContentResponse> {
    return this.settingsService.getSkillFileContent(skillId, relativePath, context);
  }

  async shareSkill(skillId: string): Promise<SkillShareResponse> {
    return this.settingsService.shareSkill(skillId);
  }

  async previewSkillImportFromUrl(url: string, target?: SkillImportTarget): Promise<SkillImportPreviewResponse> {
    return this.settingsService.previewSkillImportFromUrl(url, target);
  }

  async previewSkillImportBundle(bundle: SkillBundleManifestV1, target?: SkillImportTarget): Promise<SkillImportPreviewResponse> {
    return this.settingsService.previewSkillImportBundle(bundle, target);
  }

  async importSkill(options: ImportSkillOptions): Promise<SkillImportResultResponse> {
    return this.settingsService.importSkill(options);
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    await this.settingsService.updateSettingsEnv(values);
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    await this.settingsService.deleteSettingsEnv(name);
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    return this.settingsService.listSettingsAuth();
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    await this.settingsService.updateSettingsAuth(values);
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    await this.settingsService.deleteSettingsAuth(provider);
  }

  async updateSettingsAuthCredential(provider: string, credential: AuthCredential): Promise<void> {
    await this.settingsService.updateSettingsAuthCredential(provider, credential);
  }

  async getOpenAIAuthBrokerSettings(): Promise<OpenAIBrokerSettingsResponse> {
    return this.settingsService.getOpenAIAuthBrokerSettings();
  }

  async updateOpenAIAuthBrokerSettings(request: UpdateOpenAIBrokerSettingsRequest): Promise<OpenAIBrokerSettingsResponse> {
    return this.settingsService.updateOpenAIAuthBrokerSettings(request);
  }

  async redeemOpenAIAuthBrokerInvite(request: RedeemOpenAIBrokerInviteRequest): Promise<OpenAIBrokerInviteRedeemResponse> {
    return this.settingsService.redeemOpenAIAuthBrokerInvite(request);
  }

  async disableOpenAIAuthBroker(): Promise<OpenAIBrokerSettingsResponse> {
    return this.settingsService.disableOpenAIAuthBroker();
  }

  async clearOpenAIAuthBrokerSettings(): Promise<OpenAIBrokerSettingsResponse> {
    return this.settingsService.clearOpenAIAuthBrokerSettings();
  }

  async testOpenAIAuthBrokerSettings(request?: Partial<UpdateOpenAIBrokerSettingsRequest>): Promise<OpenAIBrokerTestResponse> {
    return this.settingsService.testOpenAIAuthBrokerSettings(request);
  }

  async isOpenAIAuthBrokerModeActive(): Promise<boolean> {
    return this.settingsService.isOpenAIAuthBrokerModeActive();
  }

  // ── Credential Pool pass-through ──

  getCredentialPoolService(): CredentialPoolService {
    return this.settingsService.getCredentialPoolService();
  }

  getOpenAIAuthBrokerRuntimeService() {
    return this.secretsEnvService.getOpenAIAuthBrokerRuntimeService();
  }

  async listCredentialPool(provider: string): Promise<CredentialPoolState> {
    return this.settingsService.listCredentialPool(provider);
  }

  async renamePooledCredential(provider: string, credentialId: string, label: string): Promise<void> {
    await this.settingsService.renamePooledCredential(provider, credentialId, label);
  }

  async removePooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.settingsService.removePooledCredential(provider, credentialId);
  }

  async setPrimaryPooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.settingsService.setPrimaryPooledCredential(provider, credentialId);
  }

  async setCredentialPoolStrategy(provider: string, strategy: CredentialPoolStrategy): Promise<void> {
    await this.settingsService.setCredentialPoolStrategy(provider, strategy);
  }

  async resetPooledCredentialCooldown(provider: string, credentialId: string): Promise<void> {
    await this.settingsService.resetPooledCredentialCooldown(provider, credentialId);
  }

  async addPooledCredential(
    provider: string,
    oauthCredential: AuthCredential,
    identity?: { label?: string; autoLabel?: string; accountId?: string }
  ): Promise<PooledCredentialInfo> {
    return this.settingsService.addPooledCredential(provider, oauthCredential, identity);
  }

  private emitConversationMessage(event: ConversationMessageEvent): void {
    this.conversationProjector.emitConversationMessage(event);
    this.recordObservabilityUserVisibleMessage(event);
  }

  private recordObservabilityUserVisibleMessage(event: ConversationMessageEvent): void {
    if (!this.observability || event.role !== "assistant" || event.source !== "assistant_output") {
      return;
    }

    const descriptor = this.descriptors.get(event.agentId);
    if (!descriptor) {
      return;
    }

    this.observability.recordUserVisibleMessage({
      agentId: descriptor.agentId,
      managerId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      profileId: descriptor.profileId,
      role: descriptor.role,
      runtimeType: this.getObservabilityRuntimeType(descriptor),
      runtimeToken: this.runtimeController.getRuntimeToken(descriptor.agentId),
      agentName: descriptor.displayName,
      rootTurnId: this.getActiveObservabilityRootTurnId(descriptor.agentId),
      messageId: event.id,
      source: event.source,
      sourceContext: event.sourceContext,
      text: event.text,
      metadata: {
        modelProvider: descriptor.model.provider,
        modelId: descriptor.model.modelId,
        status: descriptor.status,
      },
    });
  }

  private emitAgentMessage(event: AgentMessageEvent): void {
    this.conversationProjector.emitAgentMessage(event);
  }

  private emitChoiceRequest(event: ChoiceRequestEvent): void {
    const historyAgentId = event.sessionAgentId?.trim() || event.agentId;
    this.conversationProjector.emitChoiceRequest(event, { historyAgentId });
  }

  private emitWorkPlanCreated(event: WorkPlanCreatedEvent): void {
    this.conversationProjector.emitWorkPlanCreated(event);
  }

  emitModelCacheObservation(event: ModelCacheObservationEvent): void {
    this.conversationProjector.emitModelCacheObservation(event);
  }

  private emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.conversationProjector.emitConversationReset(agentId, reason);
  }

  private emitMessagePinned(agentId: string, messageId: string, pinned: boolean, timestamp: string): void {
    this.emit(
      "message_pinned",
      {
        type: "message_pinned",
        agentId,
        messageId,
        pinned,
        timestamp
      } satisfies ServerEvent
    );
  }

  private markSessionActivity(agentId: string, timestamp?: string): void {
    const sessionAgentId = this.resolveSessionActivityAgentId(agentId);
    if (!sessionAgentId) {
      return;
    }

    const descriptor = this.descriptors.get(sessionAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    const normalizedTimestamp = normalizeOptionalAgentId(timestamp) ?? this.now();
    if (descriptor.updatedAt.localeCompare(normalizedTimestamp) >= 0) {
      return;
    }

    descriptor.updatedAt = normalizedTimestamp;
    this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
    this.emitAgentsSnapshot();
  }

  private markSessionUserMessageActivity(agentId: string, timestamp: string): void {
    const sessionAgentId = this.resolveSessionActivityAgentId(agentId);
    if (!sessionAgentId) {
      return;
    }

    const descriptor = this.descriptors.get(sessionAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    if (descriptor.lastUserMessageAt && descriptor.lastUserMessageAt.localeCompare(timestamp) >= 0) {
      return;
    }

    descriptor.lastUserMessageAt = timestamp;
    this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
    this.emitAgentsSnapshot();
  }

  private resolveSessionActivityAgentId(agentId: string): string | undefined {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return undefined;
    }

    if (descriptor.role === "manager") {
      return descriptor.agentId;
    }

    const managerDescriptor = this.descriptors.get(descriptor.managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager") {
      return undefined;
    }

    return managerDescriptor.agentId;
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.config.debug) return;

    const prefix = `[swarm][${this.now()}] ${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }
    console.log(prefix, details);
  }

  private getConfiguredManagerId(): string | undefined {
    return normalizeOptionalAgentId(this.config.managerId);
  }

  private resolvePreferredManagerId(options?: { includeStoppedOnRestart?: boolean }): string | undefined {
    const includeStoppedOnRestart = options?.includeStoppedOnRestart ?? false;
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && this.isAvailableManagerDescriptor(configuredManager, includeStoppedOnRestart)) {
        return configuredManagerId;
      }
    }

    const firstManager = Array.from(this.descriptors.values())
      .filter((descriptor) => this.isAvailableManagerDescriptor(descriptor, includeStoppedOnRestart))
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.agentId.localeCompare(right.agentId);
      })[0];

    return firstManager?.agentId;
  }

  private isAvailableManagerDescriptor(
    descriptor: AgentDescriptor,
    includeStoppedOnRestart: boolean
  ): boolean {
    if (descriptor.role !== "manager") {
      return false;
    }

    if (this.isDescriptorEffectivelyArchived(descriptor)) {
      return false;
    }

    if (descriptor.status === "terminated" || descriptor.status === "error") {
      return false;
    }

    if (!includeStoppedOnRestart && descriptor.status === "stopped") {
      return false;
    }

    return true;
  }

  private sortedDescriptors(): AgentDescriptor[] {
    const configuredManagerId = this.getConfiguredManagerId();
    return Array.from(this.descriptors.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.agentId === configuredManagerId) return -1;
        if (b.agentId === configuredManagerId) return 1;
      }

      if (a.role === "manager" && b.role !== "manager") return -1;
      if (b.role === "manager" && a.role !== "manager") return 1;

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.agentId.localeCompare(b.agentId);
    });
  }

  /**
   * Ensures every profile has an explicit sortOrder.
   * Called on first profile creation after upgrade so legacy profiles
   * (which have sortOrder: undefined) get values matching their current
   * visible order before new profiles are inserted at the top.
   */
  private materializeSortOrder(): void {
    const needsMaterialization = Array.from(this.profiles.values()).some(
      (p) => p.sortOrder === undefined || p.sortOrder === null
    );
    if (!needsMaterialization) return;

    const sorted = this.sortedProfiles();
    for (let i = 0; i < sorted.length; i++) {
      const profile = this.profiles.get(sorted[i].profileId);
      if (profile) {
        profile.sortOrder = i;
        this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile);
      }
    }
  }

  async reorderProfiles(profileIds: string[]): Promise<void> {
    // Validate: profileIds must contain exactly the current active, user-visible profile IDs.
    // Archived projects are hidden from the Builder sidebar, so clients cannot include them in
    // drag payloads; keep their existing sorted slots below when assigning new sortOrder values.
    const currentProfiles = Array.from(this.profiles.values());

    const reorderableIds = new Set(
      currentProfiles
        .filter((profile) =>
          profile.profileId !== CORTEX_PROFILE_ID && !isSystemProfile(profile) && !profile.archivedAt
        )
        .map((profile) => profile.profileId)
    );

    const incomingIds = new Set(profileIds);
    if (incomingIds.size !== profileIds.length) {
      throw new Error("Duplicate profile IDs in reorder request");
    }
    if (incomingIds.size !== reorderableIds.size) {
      throw new Error("Profile ID count mismatch: expected " + reorderableIds.size + " but got " + incomingIds.size);
    }
    for (const id of profileIds) {
      if (!reorderableIds.has(id)) {
        throw new Error("Unknown or non-reorderable profile ID: " + id);
      }
    }

    const persistedOrderProfiles = [...currentProfiles].sort((a, b) => {
      const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.profileId.localeCompare(b.profileId);
    });
    const orderedProfiles: ManagerProfile[] = [];
    let nextReorderedIndex = 0;

    for (const profile of persistedOrderProfiles) {
      if (!reorderableIds.has(profile.profileId)) {
        orderedProfiles.push(profile);
        continue;
      }

      const reorderedProfile = this.profiles.get(profileIds[nextReorderedIndex]);
      if (reorderedProfile) {
        orderedProfiles.push(reorderedProfile);
      }
      nextReorderedIndex += 1;
    }

    // Assign unique sortOrder values across the full registry so hidden archived/system profiles
    // retain stable slots and restored projects do not collide with active project ordering.
    for (let i = 0; i < orderedProfiles.length; i++) {
      const profile = this.profiles.get(orderedProfiles[i].profileId);
      if (profile) {
        profile.sortOrder = i;
        this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile);
      }
    }

    await this.saveStore();
    this.emitProfilesSnapshot();
  }

  private sortedProfiles(): ManagerProfile[] {
    const configuredManagerId = this.getConfiguredManagerId();
    return Array.from(this.profiles.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.profileId === configuredManagerId) return -1;
        if (b.profileId === configuredManagerId) return 1;
      }

      // Sort by explicit sortOrder first (when present)
      const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.profileId.localeCompare(b.profileId);
    });
  }

  private async sendManagerBootstrapMessage(managerId: string): Promise<void> {
    const manager = this.descriptors.get(managerId);
    if (!manager || manager.role !== "manager") {
      return;
    }

    if (isNonRunningAgentStatus(manager.status)) {
      return;
    }

    if (!this.runtimes.has(managerId)) {
      return;
    }

    const profileId = manager.profileId ?? manager.agentId;

    await this.resolvePromptWithFallback(
      "operational",
      "idle-watchdog",
      profileId,
      IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE
    );

    try {
      const bootstrapMessage = await this.resolvePromptWithFallback(
        "operational",
        "bootstrap",
        profileId,
        MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE
      );
      await this.sendMessage(managerId, managerId, bootstrapMessage, "auto", {
        origin: "internal",
        internalDeliveryKind: "bootstrap"
      });
      this.logDebug("manager:bootstrap_message:sent", { managerId });
    } catch (error) {
      this.logDebug("manager:bootstrap_message:error", {
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async injectAgentCreatorContext(sessionAgentId: string, profileId: string): Promise<void> {
    try {
      const sources = await gatherAgentCreatorContext(
        this.config.paths.dataDir,
        profileId,
        this.descriptors.values(),
        sessionAgentId
      );
      const contextText = formatAgentCreatorContextMessage(sources);

      if (!contextText.trim()) {
        this.logDebug("agent_creator:context:empty", { sessionAgentId, profileId });
        return;
      }

      await this.sendMessage(sessionAgentId, sessionAgentId, contextText, "auto", {
        origin: "internal",
        internalDeliveryKind: "agent_creator_bootstrap"
      });
      this.logDebug("agent_creator:context:injected", {
        sessionAgentId,
        profileId,
        agentCount: sources.existingAgents.length,
        recentSessionCount: sources.recentSessions.length
      });
    } catch (error) {
      this.logDebug("agent_creator:context:error", {
        sessionAgentId,
        profileId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async resolvePromptWithFallback(
    category: PromptCategory,
    promptId: string,
    profileId: string | undefined,
    fallback: string
  ): Promise<string> {
    try {
      return await this.promptRegistry.resolve(category, promptId, profileId);
    } catch (error) {
      this.logDebug("prompt:resolve:fallback", {
        category,
        promptId,
        profileId,
        message: error instanceof Error ? error.message : String(error)
      });
      return fallback;
    }
  }

  private reconcileProfilesOnBoot(): boolean {
    let changed = false;
    const managerDescriptorsById = new Map<string, AgentDescriptor>();

    for (const descriptor of this.descriptors.values()) {
      const normalizedDescriptorModel = cloneModelDescriptor(descriptor.model);
      if (!sameModelDescriptor(descriptor.model, normalizedDescriptorModel)) {
        descriptor.model = normalizedDescriptorModel;
        this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
        changed = true;
      }

      if (descriptor.role !== "manager") {
        continue;
      }

      const reconciledProfileId = normalizeOptionalAgentId(descriptor.profileId) ?? descriptor.agentId;
      if (descriptor.profileId !== reconciledProfileId) {
        descriptor.profileId = reconciledProfileId;
        this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
        changed = true;
      }

      managerDescriptorsById.set(descriptor.agentId, descriptor);

      if (this.profiles.has(reconciledProfileId)) {
        continue;
      }

      this.descriptorStoreAdapter.upsertProfileInLiveMaps({
        profileId: reconciledProfileId,
        displayName: descriptor.displayName,
        defaultSessionAgentId: reconciledProfileId,
        defaultModel: { ...descriptor.model },
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.createdAt
      });
      changed = true;
    }

    for (const [profileId, profile] of Array.from(this.profiles.entries())) {
      let defaultSessionDescriptor = managerDescriptorsById.get(profile.defaultSessionAgentId);
      if (!defaultSessionDescriptor || defaultSessionDescriptor.role !== "manager") {
        const rootSessionDescriptor = managerDescriptorsById.get(profileId);
        if (!rootSessionDescriptor || rootSessionDescriptor.role !== "manager") {
          this.descriptorStoreAdapter.deleteProfileInLiveMaps(profileId);
          changed = true;
          continue;
        }

        profile.defaultSessionAgentId = rootSessionDescriptor.agentId;
        defaultSessionDescriptor = rootSessionDescriptor;
        changed = true;
      }

      const profileSessions = this.getBuilderSessionsForProfile(profileId);
      if (profileSessions.length === 0) {
        const rootSessionDescriptor = managerDescriptorsById.get(profileId);
        if (!rootSessionDescriptor || rootSessionDescriptor.role !== "manager") {
          this.descriptorStoreAdapter.deleteProfileInLiveMaps(profileId);
          changed = true;
          continue;
        }

        if (rootSessionDescriptor.profileId !== profileId) {
          rootSessionDescriptor.profileId = profileId;
          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(rootSessionDescriptor);
          changed = true;
        }
      }

      const defaultModelWasSynthesized = !isValidPersistedModelDescriptor(profile.defaultModel);
      const normalizedDefaultModel = defaultModelWasSynthesized
        ? cloneModelDescriptor(defaultSessionDescriptor?.model ?? this.config.defaultModel)
        : cloneModelDescriptor(profile.defaultModel);
      if (
        defaultModelWasSynthesized ||
        !sameModelDescriptor(profile.defaultModel, normalizedDefaultModel)
      ) {
        profile.defaultModel = normalizedDefaultModel;
        changed = true;
      }

      for (const session of this.getBuilderSessionsForProfile(profileId)) {
        if (session.modelOrigin !== undefined) {
          continue;
        }

        session.modelOrigin = inferLegacySessionModelOrigin(session, profile, {
          forceDefaultSessionInherited: defaultModelWasSynthesized
        });
        this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(session);
        changed = true;
      }

      this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile);
    }

    return changed;
  }

  private prunePersistedCortexStateForBoot(store: AgentsStoreFile): {
    store: AgentsStoreFile;
    pruned: boolean;
  } {
    if (this.config.cortexEnabled) {
      return { store, pruned: false };
    }

    const agents = Array.isArray(store.agents) ? store.agents : [];
    const profiles = Array.isArray(store.profiles) ? store.profiles : [];
    const removedManagerIds = new Set(
      agents
        .filter((descriptor) => (
          descriptor.role === "manager" && (
            descriptor.agentId === CORTEX_PROFILE_ID ||
            descriptor.profileId === CORTEX_PROFILE_ID ||
            descriptor.sessionPurpose === "cortex_review"
          )
        ))
        .map((descriptor) => descriptor.agentId)
    );
    const filteredAgents = agents.filter((descriptor) => !(
      descriptor.agentId === CORTEX_PROFILE_ID ||
      descriptor.profileId === CORTEX_PROFILE_ID ||
      descriptor.sessionPurpose === "cortex_review" ||
      removedManagerIds.has(descriptor.managerId)
    ));
    const filteredProfiles = profiles.filter((profile) => profile.profileId !== CORTEX_PROFILE_ID);
    const pruned = filteredAgents.length !== agents.length || filteredProfiles.length !== profiles.length;

    if (pruned) {
      this.logDebug("boot:cortex:pruned_disabled_state", {
        removedAgents: agents.length - filteredAgents.length,
        removedProfiles: profiles.length - filteredProfiles.length
      });
    }

    return {
      store: {
        ...store,
        agents: filteredAgents,
        profiles: filteredProfiles
      },
      pruned
    };
  }

  private prunePersistedWorkerSidecarDescriptorsForBoot(store: AgentsStoreFile): {
    store: AgentsStoreFile;
    pruned: boolean;
  } {
    const agents = Array.isArray(store.agents) ? store.agents : [];
    const filteredAgents = agents.filter((descriptor) => {
      if (descriptor.role !== "worker") {
        return true;
      }

      const agentIdLooksLikeSidecar = isWorkerTranscriptSidecarAgentId(descriptor.agentId);
      const sessionFileLooksLikeSidecar = typeof descriptor.sessionFile === "string"
        && isWorkerTranscriptSidecarSessionFile(descriptor.sessionFile);

      return !(agentIdLooksLikeSidecar || sessionFileLooksLikeSidecar);
    });
    const pruned = filteredAgents.length !== agents.length;

    if (pruned) {
      this.logDebug("boot:worker_sidecar_descriptors:pruned", {
        removedAgents: agents.length - filteredAgents.length
      });
    }

    return {
      store: {
        ...store,
        agents: filteredAgents
      },
      pruned
    };
  }

  private normalizeSystemProfileTypes(): boolean {
    let changed = false;
    const cortexProfile = this.profiles.get(CORTEX_PROFILE_ID);
    if (cortexProfile && cortexProfile.profileType !== "system") {
      this.descriptorStoreAdapter.upsertProfileInLiveMaps({
        ...cortexProfile,
        profileType: "system",
      });
      changed = true;
    }

    return changed;
  }

  private normalizeCodexPluginWorkersForVisibleSpecialistBoot(): boolean {
    let changed = false;
    for (const descriptor of this.descriptors.values()) {
      if (!isCodexPluginWorkerDescriptor(descriptor)) {
        continue;
      }

      if (descriptor.specialistId !== CODEX_PLUGIN_SPECIALIST_ID) {
        descriptor.specialistId = CODEX_PLUGIN_SPECIALIST_ID;
        changed = true;
      }
      if (descriptor.specialistDisplayName !== CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME) {
        descriptor.specialistDisplayName = CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME;
        changed = true;
      }
      if (descriptor.specialistColor !== CODEX_PLUGIN_SPECIALIST_COLOR) {
        descriptor.specialistColor = CODEX_PLUGIN_SPECIALIST_COLOR;
        changed = true;
      }
      if (descriptor.displayName !== CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME) {
        descriptor.displayName = CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME;
        changed = true;
      }
      if (descriptor.status === "idle" || descriptor.status === "streaming") {
        descriptor.status = "stopped";
        changed = true;
      }
    }

    return changed;
  }

  private async ensureCortexProfile(): Promise<void> {
    if (!this.config.cortexEnabled) {
      await this.ensureCommonKnowledgeFile();
      return;
    }

    if (this.hasCortexRootDescriptor()) {
      const existingProfile = this.profiles.get(CORTEX_PROFILE_ID);
      if (existingProfile && existingProfile.profileType !== "system") {
        this.descriptorStoreAdapter.upsertProfileInLiveMaps({
          ...existingProfile,
          profileType: "system",
        });
      }
      await this.ensureCommonKnowledgeFile();
      await this.ensureCortexWorkerPromptsFile();
      await this.ensureCortexOperationalFiles();
      return;
    }

    if (this.descriptors.has(CORTEX_PROFILE_ID)) {
      throw new Error(
        `Cannot auto-create Cortex profile because agentId "${CORTEX_PROFILE_ID}" is already in use`
      );
    }

    const createdAt = this.now();

    const existingProfile = this.profiles.get(CORTEX_PROFILE_ID);
    const defaultModel = existingProfile?.defaultModel
      ? { ...existingProfile.defaultModel }
      : resolveModelDescriptorFromPreset(this.defaultModelPreset);

    const descriptor: AgentDescriptor = {
      agentId: CORTEX_PROFILE_ID,
      displayName: CORTEX_DISPLAY_NAME,
      role: "manager",
      managerId: CORTEX_PROFILE_ID,
      profileId: CORTEX_PROFILE_ID,
      archetypeId: CORTEX_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: this.config.defaultCwd,
      model: { ...defaultModel },
      modelOrigin: "profile_default",
      sessionFile: getSessionFilePath(this.config.paths.dataDir, CORTEX_PROFILE_ID, CORTEX_PROFILE_ID)
    };

    const profile: ManagerProfile = existingProfile
      ? {
          ...existingProfile,
          defaultSessionAgentId: CORTEX_PROFILE_ID,
          defaultModel: { ...existingProfile.defaultModel },
          profileType: "system",
        }
      : {
          profileId: CORTEX_PROFILE_ID,
          displayName: CORTEX_DISPLAY_NAME,
          defaultSessionAgentId: CORTEX_PROFILE_ID,
          defaultModel: { ...defaultModel },
          createdAt,
          updatedAt: createdAt,
          profileType: "system"
        };

    this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
    this.descriptorStoreAdapter.upsertProfileInLiveMaps(profile);

    await this.ensureProfilePiDirectories(profile.profileId);
    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.ensureAgentMemoryFile(this.getAgentMemoryPath(descriptor.agentId), profile.profileId);
    await this.ensureAgentMemoryFile(getProfileMemoryPath(this.config.paths.dataDir, profile.profileId), profile.profileId);
    await this.writeInitialSessionMeta(descriptor);
    await this.refreshSessionMetaStats(descriptor);
    await this.ensureCommonKnowledgeFile();
    await this.ensureCortexWorkerPromptsFile();
    await this.ensureCortexOperationalFiles();

    this.logDebug("cortex:profile:auto_created", {
      profileId: CORTEX_PROFILE_ID,
      archetypeId: CORTEX_ARCHETYPE_ID
    });
  }

  private async ensureLegacyProfileKnowledgeReferenceDocs(): Promise<void> {
    await Promise.all(
      this.sortedProfiles().map(async (profile) => {
        await migrateLegacyProfileKnowledgeToReferenceDoc(this.config.paths.dataDir, profile.profileId, {
          versioning: this.versioningService
        });
      })
    );
  }

  private hasCortexRootDescriptor(): boolean {
    const descriptor = this.descriptors.get(CORTEX_PROFILE_ID);
    return Boolean(
      descriptor &&
      descriptor.role === "manager" &&
      descriptor.profileId === CORTEX_PROFILE_ID &&
      normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID &&
      descriptor.sessionPurpose !== "cortex_review" &&
      descriptor.sessionPurpose !== "agent_creator"
    );
  }

  private async ensureCommonKnowledgeFile(): Promise<void> {
    const commonKnowledgePath = getCommonKnowledgePath(this.config.paths.dataDir);

    try {
      await readFile(commonKnowledgePath, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    const commonKnowledgeTemplate = await this.resolvePromptWithFallback(
      "operational",
      "common-knowledge-template",
      CORTEX_PROFILE_ID,
      COMMON_KNOWLEDGE_INITIAL_TEMPLATE
    );

    await mkdir(dirname(commonKnowledgePath), { recursive: true });
    await writeFile(commonKnowledgePath, commonKnowledgeTemplate, "utf8");
    this.queueVersioningMutation({
      path: commonKnowledgePath,
      action: "write",
      source: "bootstrap",
      profileId: CORTEX_PROFILE_ID
    });
  }

  private async ensureCortexOperationalFiles(): Promise<void> {
    const knowledgeDir = dirname(getCortexReviewLogPath(this.config.paths.dataDir));
    const reviewLogPath = getCortexReviewLogPath(this.config.paths.dataDir);
    const reviewRunsPath = getCortexReviewRunsPath(this.config.paths.dataDir);
    const manifestsDir = getCortexPromotionManifestsDir(this.config.paths.dataDir);

    await mkdir(knowledgeDir, { recursive: true });

    try {
      await readFile(reviewLogPath, "utf8");
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }

      await writeFile(reviewLogPath, "", "utf8");
    }

    try {
      await readFile(reviewRunsPath, "utf8");
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }

      await writeFile(reviewRunsPath, `${JSON.stringify({ version: 1, runs: [] }, null, 2)}\n`, "utf8");
    }

    await mkdir(manifestsDir, { recursive: true });
  }

  private async ensureCortexWorkerPromptsFile(): Promise<void> {
    const workerPromptsPath = getCortexWorkerPromptsPath(this.config.paths.dataDir);
    const workerPromptTemplate = await this.resolvePromptWithFallback(
      "operational",
      "cortex-worker-prompts",
      CORTEX_PROFILE_ID,
      CORTEX_WORKER_PROMPTS_INITIAL_TEMPLATE
    );

    try {
      const existingContent = await readFile(workerPromptsPath, "utf8");
      if (!shouldUpgradeLegacyCortexWorkerPrompts(existingContent)) {
        return;
      }

      await backupLegacyCortexWorkerPrompts(workerPromptsPath, existingContent);
      await writeFile(workerPromptsPath, workerPromptTemplate, "utf8");
      this.queueVersioningMutation({
        path: workerPromptsPath,
        action: "write",
        source: "bootstrap",
        profileId: CORTEX_PROFILE_ID
      });
      this.logDebug("cortex:worker_prompts:auto_upgraded", {
        path: workerPromptsPath
      });
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await mkdir(dirname(workerPromptsPath), { recursive: true });
    await writeFile(workerPromptsPath, workerPromptTemplate, "utf8");
    this.queueVersioningMutation({
      path: workerPromptsPath,
      action: "write",
      source: "bootstrap",
      profileId: CORTEX_PROFILE_ID
    });
  }

  private collectStreamingAgentIdsForBoot(): Set<string> {
    const streamingAgentIds = new Set<string>();

    for (const descriptor of this.descriptors.values()) {
      if (shouldIncludeDescriptorInBootInterruptedToolReconciliation(descriptor)) {
        streamingAgentIds.add(descriptor.agentId);
      }
    }

    return streamingAgentIds;
  }

  private normalizeStreamingStatusesForBoot(): void {
    const normalizedAgentIds: string[] = [];

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.status !== "streaming" || isExternalThreadDescriptor(descriptor)) {
        continue;
      }

      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
      descriptor.updatedAt = this.now();
      this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
      normalizedAgentIds.push(descriptor.agentId);
    }

    if (normalizedAgentIds.length > 0) {
      this.logDebug("boot:normalize_streaming_statuses", { normalizedAgentIds });
    }
  }

  /**
   * Recover worker descriptors from on-disk worker JSONL files for sessions
   * whose workers are missing from agents.json.
   *
   * This handles the case where workers were previously deleted from agents.json
   * on session stop. We scan each session's workers/ directory and recreate
   * terminated descriptors for any worker files that have no matching descriptor.
   */
  private async recoverMissingWorkerDescriptorsForBoot(): Promise<void> {
    const recoveredIds: string[] = [];

    // Build set of known worker agentIds
    const knownWorkerIds = new Set<string>();
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role === "worker") {
        knownWorkerIds.add(descriptor.agentId);
      }
    }

    // Scan each session's workers directory
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager" || !descriptor.profileId) {
        continue;
      }

      const profileId = descriptor.profileId;
      const workersDir = getWorkersDir(this.config.paths.dataDir, profileId, descriptor.agentId);

      let workerFiles: string[];
      try {
        workerFiles = await readdir(workersDir);
      } catch {
        continue; // No workers directory
      }

      for (const filename of workerFiles) {
        const workerId = getWorkerIdFromCanonicalTranscriptFileName(filename);
        if (!workerId || knownWorkerIds.has(workerId)) {
          continue;
        }

        // Parse minimal metadata from the worker JSONL header
        const workerFilePath = getWorkerSessionFilePath(
          this.config.paths.dataDir, profileId, descriptor.agentId, workerId
        );

        try {
          const header = await this.readWorkerJSONLHeader(workerFilePath);

          const workerDescriptor: AgentDescriptor = {
            agentId: workerId,
            displayName: workerId,
            role: "worker",
            managerId: descriptor.agentId,
            profileId,
            status: "terminated",
            createdAt: header.createdAt ?? descriptor.createdAt,
            updatedAt: header.updatedAt ?? descriptor.updatedAt,
            cwd: header.cwd ?? descriptor.cwd,
            model: header.model ?? descriptor.model,
            sessionFile: workerFilePath
          };

          this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(workerDescriptor);
          knownWorkerIds.add(workerId);
          recoveredIds.push(workerId);
        } catch {
          // Skip unreadable worker files
        }
      }
    }

    if (recoveredIds.length > 0) {
      this.logDebug("boot:recover_missing_workers", {
        recoveredCount: recoveredIds.length,
        recoveredIds: recoveredIds.slice(0, 20),
        truncated: recoveredIds.length > 20
      });
    }
  }

  /**
   * Read the first few lines of a worker JSONL file to extract metadata.
   */
  private async readWorkerJSONLHeader(
    filePath: string
  ): Promise<{
    createdAt: string | null;
    updatedAt: string | null;
    cwd: string | null;
    model: AgentDescriptor["model"] | null;
  }> {
    // Only read first 4KB to parse header lines
    const headerChunk = await readFileHead(filePath, 4096);
    const lines = headerChunk.split("\n").filter((l) => l.trim());

    let createdAt: string | null = null;
    let updatedAt: string | null = null;
    let cwd: string | null = null;
    let model: AgentDescriptor["model"] | null = null;

    for (const line of lines.slice(0, 10)) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;

        if (entry.type === "session") {
          createdAt = typeof entry.timestamp === "string" ? entry.timestamp : null;
          cwd = typeof entry.cwd === "string" ? entry.cwd : null;
        }

        if (entry.type === "model_change") {
          const provider = typeof entry.provider === "string" ? entry.provider : null;
          const modelId = typeof entry.modelId === "string" ? entry.modelId : null;
          if (provider && modelId) {
            model = normalizePersistedSwarmModelDescriptor({ provider, modelId, thinkingLevel: "none" }) ?? { provider, modelId, thinkingLevel: "none" };
          }
          if (!updatedAt && typeof entry.timestamp === "string") {
            updatedAt = entry.timestamp;
          }
        }

        if (entry.type === "thinking_level_change" && model) {
          const thinkingLevel = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
          if (thinkingLevel) {
            model = normalizePersistedSwarmModelDescriptor({ ...model, thinkingLevel }) ?? { ...model, thinkingLevel };
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return { createdAt, updatedAt: updatedAt ?? createdAt, cwd, model };
  }

  private async restoreRuntimesForBoot(): Promise<void> {
    let shouldPersist = false;
    const configuredManagerId = this.getConfiguredManagerId();

    for (const descriptor of this.sortedDescriptors()) {
      if (!this.shouldRestoreRuntimeForDescriptor(descriptor)) {
        continue;
      }

      try {
        await this.getOrCreateRuntimeForDescriptor(descriptor);
      } catch (error) {
        if (
          descriptor.role === "manager" &&
          configuredManagerId &&
          descriptor.agentId === configuredManagerId
        ) {
          throw error;
        }

        const idleStatus = descriptor.status === "streaming"
          ? transitionAgentStatus(descriptor.status, "idle")
          : descriptor.status;
        descriptor.status = transitionAgentStatus(idleStatus, "stopped");
        descriptor.contextUsage = undefined;
        descriptor.updatedAt = this.now();
        this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
        shouldPersist = true;

        this.emitStatus(descriptor.agentId, descriptor.status, 0);
        this.logDebug("boot:restore_runtime:error", {
          agentId: descriptor.agentId,
          role: descriptor.role,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (shouldPersist) {
      await this.saveStore();
    }

    if (configuredManagerId) {
      const primaryManager = this.descriptors.get(configuredManagerId);
      if (
        primaryManager &&
        primaryManager.role === "manager" &&
        primaryManager.status === "streaming" &&
        !this.runtimes.has(configuredManagerId)
      ) {
        throw new Error("Primary manager runtime is not initialized");
      }
    }
  }

  private shouldRestoreRuntimeForDescriptor(descriptor: AgentDescriptor): boolean {
    return this.lifecycleService.shouldRestoreRuntimeForDescriptor(descriptor);
  }

  private async getOrCreateRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    this.assertDescriptorNotEffectivelyArchived(descriptor);
    if (descriptor.role === "manager") {
      await this.applyPendingManagerRuntimeRecycleBeforeRuntimeUse(descriptor as AgentDescriptor & { role: "manager" });
    }
    await this.preflightRepoProjectAgentRuntime(descriptor);
    return this.lifecycleService.getOrCreateRuntimeForDescriptor(descriptor);
  }

  private async preflightRepoProjectAgentRuntime(descriptor: AgentDescriptor): Promise<void> {
    if (descriptor.role !== "manager" || !isRepoProjectAgentSource(descriptor.projectAgent?.source)) {
      return;
    }

    const resolution = await this.resolveRepoProjectAgentSourceForDescriptor(descriptor as AgentDescriptor & {
      role: "manager";
      projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
    });
    let definition;
    try {
      definition = assertRepoProjectAgentSourceAvailable(resolution);
    } catch (error) {
      await this.notifyUnavailableSharedRepoProjectAgentSource(descriptor as AgentDescriptor & {
        role: "manager";
        projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
      }, resolution);
      throw error;
    }
    const currentSource = descriptor.projectAgent.source;
    const signatureChanged = currentSource.signature !== definition.signature;
    const whenToUseChanged = descriptor.projectAgent.whenToUse !== definition.config.whenToUse;

    if (!signatureChanged && !whenToUseChanged) {
      return;
    }

    const runtime = this.runtimes.get(descriptor.agentId);
    if (runtime) {
      const disposition = await this.applyManagerRuntimeRecyclePolicy(descriptor.agentId, "prompt_mode_change");
      if (disposition !== "recycled") {
        throw new Error(
          `Repository project-agent source ${currentSource.definitionId} changed while ${descriptor.agentId} has an active runtime. Wait for the current turn to finish before sending another message.`
        );
      }
    }

    descriptor.projectAgent = {
      ...descriptor.projectAgent,
      whenToUse: definition.config.whenToUse,
      source: {
        ...currentSource,
        signature: definition.signature
      }
    };
    descriptor.updatedAt = this.now();
    this.descriptorStoreAdapter.upsertDescriptorInLiveMaps(descriptor);
    await this.saveStore();
    this.emitAgentsSnapshot();
    await Promise.allSettled([
      this.notifyProjectAgentsChanged(descriptor.profileId ?? descriptor.agentId),
      this.notifySharedProjectAgentTargetsChanged(descriptor.agentId),
    ]);
  }

  async validateProjectAgentSourceForRead(agentId: string): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager" || !isRepoProjectAgentSource(descriptor.projectAgent?.source)) {
      return;
    }

    await this.preflightRepoProjectAgentRuntime(descriptor);
  }

  async resolveAgentSystemPromptForRead(agentId: string): Promise<string | null> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      return null;
    }

    if (isRepoProjectAgentSource(descriptor.projectAgent?.source)) {
      await this.preflightRepoProjectAgentRuntime(descriptor);
      return this.resolveSystemPromptForDescriptor(descriptor);
    }

    const meta = await this.sessionMetaService.readSessionMetaForDescriptor(descriptor);
    return meta?.resolvedSystemPrompt ?? null;
  }

  private assertProfileNotArchived(profileId: string): void {
    if (isProfileArchived(this.profiles.get(profileId))) {
      throw new Error(ARCHIVED_PROJECT_OPERATION_MESSAGE);
    }
  }

  private assertManagerSettingsTargetNotArchived(managerId: string, operation: string): void {
    if (this.profiles.has(managerId)) {
      this.assertProfileNotArchived(managerId);
      return;
    }

    const descriptor = this.getRequiredBuilderSessionDescriptor(managerId, operation);
    this.assertDescriptorNotEffectivelyArchived(descriptor);
  }

  private assertDescriptorNotEffectivelyArchived(descriptor: AgentDescriptor): void {
    const archivedReason = this.getDescriptorArchiveBlockReason(descriptor);
    if (archivedReason) {
      throw new Error(archivedReason);
    }
  }

  private isDescriptorEffectivelyArchived(descriptor: AgentDescriptor): boolean {
    return this.getDescriptorArchiveBlockReason(descriptor) !== undefined;
  }

  private getDescriptorArchiveBlockReason(descriptor: AgentDescriptor): string | undefined {
    if (descriptor.role !== "manager") {
      const owner = this.descriptors.get(descriptor.managerId);
      return owner ? this.getDescriptorArchiveBlockReason(owner) : undefined;
    }

    const profileId = descriptor.profileId ?? descriptor.managerId;
    const profile = this.profiles.get(profileId);
    if (isProfileArchived(profile)) {
      return ARCHIVED_PROJECT_OPERATION_MESSAGE;
    }
    if (isSessionDirectlyArchived(descriptor)) {
      return ARCHIVED_SESSION_OPERATION_MESSAGE;
    }
    return undefined;
  }

  private getBootLogManagerDescriptor(): AgentDescriptor | undefined {
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && configuredManager.role === "manager" && configuredManager.status !== "terminated") {
        return configuredManager;
      }
    }

    return Array.from(this.descriptors.values()).find(
      (descriptor) => descriptor.role === "manager" && descriptor.status !== "terminated"
    );
  }

  private getRequiredManagerDescriptor(managerId: string): AgentDescriptor {
    const descriptor = this.descriptors.get(managerId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Unknown manager: ${managerId}`);
    }

    return descriptor;
  }

  private getRequiredBuilderManagerDescriptor(managerId: string, action: string): AgentDescriptor {
    const descriptor = this.getRequiredManagerDescriptor(managerId);
    assertBuilderSession(descriptor, action);
    return descriptor;
  }

  private resolveDefaultModelDescriptor(): AgentModelDescriptor {
    return resolveModelDescriptorFromPreset(this.defaultModelPreset);
  }

  private resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor {
    return this.lifecycleService.resolveSpawnModelWithCapacityFallback(model);
  }

  maybeRecordModelCapacityBlock(agentId: string, descriptor: AgentDescriptor, error: RuntimeErrorEvent): void {
    if (descriptor.role !== "worker") {
      return;
    }

    if (error.phase !== "prompt_dispatch" && error.phase !== "prompt_start") {
      return;
    }

    const classification = classifyRuntimeCapacityError(formatRuntimeErrorForCapacityClassification(error));
    if (!classification.isQuotaOrRateLimit) {
      return;
    }

    const blockDurationMs = clampModelCapacityBlockDurationMs(
      classification.retryAfterMs ?? MODEL_CAPACITY_BLOCK_DEFAULT_MS
    );
    if (!blockDurationMs) {
      return;
    }

    const provider = normalizeOptionalAgentId(descriptor.model.provider)?.toLowerCase();
    const modelId = normalizeOptionalModelId(descriptor.model.modelId)?.toLowerCase();
    if (!provider || !modelId) {
      return;
    }

    const key = buildModelCapacityBlockKey(provider, modelId);
    if (!key) {
      return;
    }

    const blockedUntilMs = Date.now() + blockDurationMs;
    const existing = this.modelCapacityBlocks.get(key);
    if (existing && existing.blockedUntilMs >= blockedUntilMs) {
      return;
    }

    this.modelCapacityBlocks.set(key, {
      provider,
      modelId,
      blockedUntilMs,
      blockSetAt: this.now(),
      sourcePhase: error.phase,
      reason: error.message
    });

    this.logDebug("model_capacity:block_set", {
      agentId,
      provider,
      modelId,
      phase: error.phase,
      retryAfterMs: classification.retryAfterMs,
      blockDurationMs,
      blockedUntil: new Date(blockedUntilMs).toISOString(),
      messagePreview: previewForLog(error.message, 240)
    });
  }

  private async resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string,
    profileId: string
  ): Promise<string | undefined> {
    if (input.archetypeId !== undefined) {
      const explicit = normalizeArchetypeId(input.archetypeId);
      if (!explicit) {
        throw new Error("spawn_agent archetypeId must include at least one letter or number");
      }

      const entry = await this.promptRegistry.resolveEntry("archetype", explicit, profileId);
      if (!entry) {
        throw new Error(`Unknown archetypeId: ${explicit}`);
      }

      return explicit;
    }

    if (
      normalizedAgentId === MERGER_ARCHETYPE_ID ||
      normalizedAgentId.startsWith(`${MERGER_ARCHETYPE_ID}-`)
    ) {
      return MERGER_ARCHETYPE_ID;
    }

    return undefined;
  }

  private async loadSpecialistRegistryModule(): Promise<SpecialistRegistryModule> {
    if (!this.specialistRegistryModulePromise) {
      const dataDir = this.config.paths.dataDir;
      this.specialistRegistryModulePromise = Promise.resolve({
        resolveRoster: (profileId: string, targetSpace?: SpecialistTargetSpace) =>
          specialistResolveRoster(profileId, dataDir, targetSpace) as Promise<ResolvedSpecialistDefinitionLike[]>,
        generateRosterBlock: specialistGenerateRosterBlock as (roster: ResolvedSpecialistDefinitionLike[]) => string,
        normalizeSpecialistHandle: specialistNormalizeSpecialistHandle,
        getSpecialistsEnabled: () => specialistGetSpecialistsEnabled(dataDir),
        legacyModelRoutingGuidance: LEGACY_MODEL_ROUTING_GUIDANCE,
      });
    }

    return this.specialistRegistryModulePromise!;
  }

  private async resolveSpecialistRosterForProfile(
    profileId: string,
    targetSpace: SpecialistTargetSpace = "builder",
    workspaceSpecialistsDir?: string,
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    if (workspaceSpecialistsDir && targetSpace !== "collaboration") {
      return specialistResolveWorkspaceRoster(
        profileId,
        this.config.paths.dataDir,
        workspaceSpecialistsDir,
        targetSpace,
      ) as Promise<ResolvedSpecialistDefinitionLike[]>;
    }

    const specialistRegistry = await this.loadSpecialistRegistryModule();
    return specialistRegistry.resolveRoster(profileId, targetSpace);
  }

  private async resolveSpecialistRosterForManager(
    manager: AgentDescriptor,
    targetSpace: SpecialistTargetSpace = "builder"
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    if (targetSpace !== "collaboration" || !isCollabSession(manager)) {
      const workspace = await this.resolveProjectWorkspaceForManager(manager);
      const roster = await this.resolveSpecialistRosterForProfile(
        manager.profileId ?? manager.agentId,
        targetSpace,
        workspace?.repoRootResources.specialistsDir,
      );
      return this.applyCodexPluginSpecialistAvailability(roster, targetSpace, manager.agentId);
    }

    const channelId = manager.collab?.channelId;
    if (!channelId) {
      return this.resolveSpecialistRosterForProfile(manager.profileId ?? manager.agentId, targetSpace);
    }

    if (!isCollaborationServerRuntimeTarget(this.config.runtimeTarget)) {
      return specialistResolveCollaborationChannelRoster(this.config.paths.dataDir, {
        sessionAgentId: manager.agentId,
        selectedGlobalHandles: [],
      }) as Promise<ResolvedSpecialistDefinitionLike[]>;
    }

    try {
      const dbHelpers = await createCollaborationDbHelpers(this.config);
      const channel = dbHelpers.getChannel(channelId);
      if (!channel) {
        return specialistResolveCollaborationChannelRoster(this.config.paths.dataDir, {
          sessionAgentId: manager.agentId,
          selectedGlobalHandles: [],
        }) as Promise<ResolvedSpecialistDefinitionLike[]>;
      }

      return specialistResolveCollaborationChannelRoster(this.config.paths.dataDir, {
        sessionAgentId: channel.backingSessionAgentId,
        selectedGlobalHandles: parseCollaborationSpecialistHandlesJson(channel.activeSpecialistHandlesJson),
      }) as Promise<ResolvedSpecialistDefinitionLike[]>;
    } catch (error) {
      this.logDebug("collaboration:specialists:resolve_error", {
        agentId: manager.agentId,
        channelId,
        message: error instanceof Error ? error.message : String(error),
      });
      return specialistResolveCollaborationChannelRoster(this.config.paths.dataDir, {
        sessionAgentId: manager.agentId,
        selectedGlobalHandles: [],
      }) as Promise<ResolvedSpecialistDefinitionLike[]>;
    }
  }

  private async applyCodexPluginSpecialistAvailability(
    roster: ResolvedSpecialistDefinitionLike[],
    targetSpace: SpecialistTargetSpace,
    managerAgentId: string,
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    if (targetSpace !== "builder") {
      return roster;
    }

    const nonCodexRoster = roster.filter((entry) => entry.specialistId !== CODEX_PLUGIN_SPECIALIST_ID);
    if (
      !this.activeCodexPluginDelegationByManagerId.has(managerAgentId) &&
      !this.pendingCodexPluginSpawnByManagerId.has(managerAgentId)
    ) {
      return nonCodexRoster;
    }

    const configuredCodexPlugin = roster.find((entry) => entry.specialistId === CODEX_PLUGIN_SPECIALIST_ID);
    return [...nonCodexRoster, configuredCodexPlugin ?? this.createVirtualCodexPluginSpecialistDefinition()];
  }

  private createVirtualCodexPluginSpecialistDefinition(): ResolvedSpecialistDefinitionLike {
    return {
      specialistId: CODEX_PLUGIN_SPECIALIST_ID,
      displayName: CODEX_PLUGIN_SPECIALIST_DISPLAY_NAME,
      color: CODEX_PLUGIN_SPECIALIST_COLOR,
      enabled: true,
      whenToUse:
        "Contextual/automatic only. Forge exposes this specialist during @Codex plugin selector turns; managers spawn it to run scoped read-only Codex plugin tools for the bound worker lifetime, then report sanitized findings back.",
      modelId: "gpt-5.5",
      provider: "openai",
      reasoningLevel: "high",
      fallbackModelId: "gpt-5.5",
      fallbackProvider: "openai",
      fallbackReasoningLevel: "medium",
      webSearch: false,
      promptBody: buildCodexPluginWorkerPrompt(),
      available: true,
    };
  }

  private async resolveProjectWorkspaceForManager(manager: AgentDescriptor) {
    const profileId = manager.profileId ?? manager.agentId;
    try {
      return await new ProjectWorkspaceResolver({
        dataDir: this.config.paths.dataDir,
        settingsStore: new ProjectResourceSettingsStore(this.config.paths.dataDir),
      }).resolvePassive({
        profileId,
        sessionAgentId: manager.agentId,
        cwd: manager.cwd,
      });
    } catch (error) {
      this.logDebug("project_resources:resolve:error", {
        agentId: manager.agentId,
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private filterWorkPlanSkillsForDescriptor(
    descriptor: AgentDescriptor,
    skills: SkillMetadata[] | null,
  ): SkillMetadata[] | null {
    if (!skills || this.isWorkPlansEnabled()) {
      return skills;
    }

    const managerDescriptor = descriptor.role === "manager"
      ? descriptor
      : this.descriptors.get(descriptor.managerId);
    if (managerDescriptor?.role !== "manager") {
      return skills;
    }

    return skills.filter((skill) => skill.directoryName !== ACTIVE_WORK_PLANS_SKILL_HANDLE);
  }

  private async resolveSkillRosterForDescriptor(descriptor: AgentDescriptor): Promise<SkillMetadata[] | null> {
    const managerDescriptor = descriptor.role === "manager"
      ? descriptor
      : this.descriptors.get(descriptor.managerId);
    const collabInfo = getCollabSessionInfo(managerDescriptor);

    if (managerDescriptor?.role === "manager" && collabInfo) {
      try {
        const dbHelpers = await createCollaborationDbHelpers(this.config);
        const channel = dbHelpers.getChannel(collabInfo.channelId);
        if (!channel) {
          this.logDebug("collaboration:skills:channel_missing", {
            agentId: descriptor.agentId,
            managerId: managerDescriptor.agentId,
            channelId: collabInfo.channelId,
          });
          const closedRoster = await resolveCollaborationSkillRoster({
            selectionJson: "[]",
            skillMetadataService: this.skillMetadataService,
          });
          return this.filterWorkPlanSkillsForDescriptor(descriptor, closedRoster.skills);
        }

        const roster = await resolveCollaborationSkillRoster({
          selectionJson: channel.activeSkillHandlesJson,
          skillMetadataService: this.skillMetadataService,
        });
        return this.filterWorkPlanSkillsForDescriptor(descriptor, roster.skills);
      } catch (error) {
        this.logDebug("collaboration:skills:resolve_error", {
          agentId: descriptor.agentId,
          managerId: managerDescriptor.agentId,
          channelId: collabInfo.channelId,
          message: error instanceof Error ? error.message : String(error),
        });
        const closedRoster = await resolveCollaborationSkillRoster({
          selectionJson: "[]",
          skillMetadataService: this.skillMetadataService,
        });
        return this.filterWorkPlanSkillsForDescriptor(descriptor, closedRoster.skills);
      }
    }

    const profileId = managerDescriptor?.role === "manager"
      ? normalizeOptionalAgentId(managerDescriptor.profileId) ?? managerDescriptor.agentId
      : normalizeOptionalAgentId(descriptor.profileId);
    if (!profileId) {
      return null;
    }

    const workspace = managerDescriptor?.role === "manager"
      ? await this.resolveProjectWorkspaceForManager(managerDescriptor)
      : undefined;
    return this.filterWorkPlanSkillsForDescriptor(
      descriptor,
      await this.skillMetadataService.getProfileSkillMetadataForWorkspace(
        profileId,
        workspace?.effectiveForgeDirRealpath,
      ),
    );
  }

  async resolveProjectAgentSystemPromptOverride(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean }
  ): Promise<{ prompt: string | undefined; sourcePath: string | undefined }> {
    return this.promptService.resolveProjectAgentSystemPromptOverride(descriptor, options);
  }

  private async buildResolvedManagerPrompt(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean }
  ): Promise<string> {
    return this.promptService.buildResolvedManagerPrompt(descriptor, options);
  }

  private async resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string> {
    return this.promptService.resolveSystemPromptForDescriptor(descriptor);
  }

  private injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string {
    return this.promptService.injectWorkerIdentityContext(descriptor, systemPrompt);
  }

  private async resolveAndValidateCwd(cwd: string): Promise<string> {
    return validateDirectoryPath(cwd, this.getCwdPolicy());
  }

  private getCwdPolicy(): { rootDir: string; allowlistRoots: string[] } {
    return {
      rootDir: this.config.paths.rootDir,
      allowlistRoots: normalizeAllowlistRoots(this.config.cwdAllowlistRoots)
    };
  }

  private generateUniqueAgentId(source: string): string {
    const base = normalizeAgentId(source);

    if (!base) {
      throw new Error("spawn_agent agentId must include at least one letter or number");
    }

    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId && base === configuredManagerId) {
      throw new Error(`spawn_agent agentId \"${configuredManagerId}\" is reserved`);
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private generateUniqueManagerId(source: string): string {
    const base = normalizeAgentId(source);
    if (!base) {
      throw new Error("create_manager name must include at least one letter or number");
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private assertManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Only manager can ${action}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Manager is not running: ${agentId}`);
    }

    return descriptor;
  }

  private hasRunningManagers(options?: { excludeCortex?: boolean }): boolean {
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      if (options?.excludeCortex && normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID) {
        continue;
      }

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      return true;
    }

    return false;
  }

  private resolveReplyTargetContext(explicitTargetContext?: MessageTargetContext): MessageSourceContext {
    if (!explicitTargetContext) {
      return { channel: "web" };
    }

    const normalizedExplicitTarget = normalizeMessageTargetContext(explicitTargetContext);

    if (normalizedExplicitTarget.channel === "telegram" && !normalizedExplicitTarget.channelId) {
      throw new Error(
        'speak_to_user target.channelId is required when target.channel is "telegram"'
      );
    }

    return normalizeMessageSourceContext(normalizedExplicitTarget);
  }

  private parseResetManagerSessionArgs(
    managerIdOrReason: string | "user_new_command" | "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): { managerId: string; reason: "user_new_command" | "api_reset" } {
    if (managerIdOrReason === "user_new_command" || managerIdOrReason === "api_reset") {
      const managerId = this.resolvePreferredManagerId({ includeStoppedOnRestart: true });
      if (!managerId) {
        throw new Error("No manager is available.");
      }

      return {
        managerId,
        reason: managerIdOrReason
      };
    }

    return {
      managerId: managerIdOrReason,
      reason: maybeReason ?? "api_reset"
    };
  }

  private async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    if (descriptor.role === "manager") {
      this.codexPluginScopeService.closeScopesForManager(descriptor.agentId);
      this.clearCodexPluginRetryContextForManager(descriptor.agentId);
    } else if (isCodexPluginWorkerDescriptor(descriptor)) {
      this.codexPluginScopeService.closeScopeForWorker(descriptor.agentId);
    }

    await this.lifecycleService.terminateDescriptor(descriptor, options);
    if (descriptor.role === "manager") {
      this.clearPendingProjectExecutableTrustActivationForManager(descriptor.agentId);
      this.pendingProjectExecutableWorkerInvalidationByManagerId.delete(descriptor.agentId);
    }
  }

  protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }> {
    return this.promptService.getMemoryRuntimeResources(descriptor);
  }

  private async reloadSkillMetadata(): Promise<void> {
    await this.skillMetadataService.reloadSkillMetadata();
  }

  private async loadSecretsStore(): Promise<void> {
    await this.secretsEnvService.loadSecretsStore();
  }

  protected async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    return this.promptService.getSwarmContextFiles(cwd);
  }

  protected async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = this.allocateRuntimeToken(descriptor.agentId),
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    return this.runtimeController.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
  }

  protected async resolveProjectExecutableTrustPlanForRuntime(options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }): Promise<ProjectExecutableTrustPlan> {
    let plan: ProjectExecutableTrustPlan;
    try {
      plan = await resolveProjectExecutableTrustPlan({
        config: this.config,
        descriptor: options.descriptor,
        sessionDescriptor: options.sessionDescriptor
      });
    } catch (error) {
      this.logDebug("project_resources:runtime_trust_plan:error", {
        agentId: options.descriptor.agentId,
        role: options.descriptor.role,
        message: error instanceof Error ? error.message : String(error)
      });
      return {
        trusted: false,
        trustedForgeExtensionDirs: [],
        trustedPiExtensionDirs: [],
        trustedPiSettingsPaths: []
      };
    }

    const trustKey = plan.resolution?.trust.key;
    const activation = trustKey
      ? this.deferredProjectExecutableTrustActivationsByKey.get(trustKey)
      : undefined;
    if (!activation) {
      return plan;
    }

    const managerId = options.descriptor.role === "manager"
      ? options.descriptor.agentId
      : options.sessionDescriptor?.agentId ?? options.descriptor.managerId;
    const managerHasPendingActivation = this.pendingProjectExecutableTrustActivationByManagerId.get(managerId) === trustKey;
    return activation.protectAllRuntimeCreations || managerHasPendingActivation
      ? activation.preActivationPlan
      : plan;
  }

  private allocateRuntimeToken(agentId: string): number {
    return this.runtimeController.allocateRuntimeToken(agentId);
  }

  private clearRuntimeToken(agentId: string, runtimeToken?: number): void {
    this.runtimeController.clearRuntimeToken(agentId, runtimeToken);
  }

  private detachRuntime(agentId: string, runtimeToken?: number): boolean {
    const detached = this.runtimeController.detachRuntime(agentId, runtimeToken);
    if (detached) {
      this.discardPendingInboundTurnContexts(agentId);
      if (isCodexPluginWorkerDescriptor(this.descriptors.get(agentId))) {
        this.codexPluginScopeService.closeScopeForWorker(agentId);
      }
    }
    return detached;
  }

  private discardPendingInboundTurnContexts(agentId: string): void {
    this.pendingInboundTurnContextsByAgentId.delete(agentId);
    this.inboundTurnContextActivatedByAgentId.delete(agentId);
    this.activeTurnByAgentId.delete(agentId);
    this.activeAssistantOutputTargetByManagerId.delete(agentId);
    this.activeWebAssistantOutputTurnByManagerId.delete(agentId);
    this.clearPendingChoiceAssistantOutputContinuationsForAgent(agentId);
    this.inheritedAssistantOutputTargetByWorkerId.delete(agentId);
    this.clearInheritedAssistantOutputTargetsForManager(agentId);
    this.runtimeController.clearManagerAssistantOutputTurn(agentId);
    this.codexMcpToolTurnGateByManagerId.delete(agentId);
    this.activeCodexPluginDelegationByManagerId.delete(agentId);
    this.clearCodexPluginRetryContextForManager(agentId);
    this.codexPluginScopeService.closeScopesForManager(agentId);
  }

  private async runRuntimeShutdown(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ): Promise<{ timedOut: boolean; runtimeToken?: number }> {
    return this.runtimeController.runRuntimeShutdown(descriptor, action, options);
  }

  private async handleRuntimeStatus(
    runtimeToken: number,
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    await this.runtimeController.handleRuntimeStatus(runtimeToken, agentId, status, pendingCount, contextUsage);
  }

  async handleRuntimeSessionEvent(
    runtimeTokenOrAgentId: number | string,
    agentIdOrEvent: string | RuntimeSessionEvent,
    maybeEvent?: RuntimeSessionEvent
  ): Promise<void> {
    await this.runtimeController.handleRuntimeSessionEvent(runtimeTokenOrAgentId, agentIdOrEvent, maybeEvent);
  }

  async handleRuntimeError(
    runtimeTokenOrAgentId: number | string,
    agentIdOrError: string | RuntimeErrorEvent,
    maybeError?: RuntimeErrorEvent
  ): Promise<void> {
    const invokedWithExplicitToken = typeof runtimeTokenOrAgentId === "number";
    const agentId = invokedWithExplicitToken ? (agentIdOrError as string) : runtimeTokenOrAgentId;
    const descriptor = this.descriptors.get(agentId);
    if (descriptor?.role === "manager") {
      this.pendingInboundTurnContextsByAgentId.delete(agentId);
      this.inboundTurnContextActivatedByAgentId.delete(agentId);
      this.activeTurnByAgentId.delete(agentId);
      this.activeAssistantOutputTargetByManagerId.delete(agentId);
      this.activeWebAssistantOutputTurnByManagerId.delete(agentId);
      this.clearPendingChoiceAssistantOutputContinuationsForAgent(agentId);
      this.clearInheritedAssistantOutputTargetsForManager(agentId);
      this.runtimeController.clearManagerAssistantOutputTurn(agentId);
      this.activeCodexPluginDelegationByManagerId.delete(agentId);
      this.clearCodexPluginRetryContextForManager(agentId);
      this.codexPluginScopeService.closeScopesForManager(agentId);
    } else {
      this.clearRuntimeResettableInheritedAssistantOutputTarget(agentId);
      if (isCodexPluginWorkerDescriptor(descriptor)) {
        this.codexPluginScopeService.closeScopeForWorker(agentId);
      }
    }

    await this.runtimeController.handleRuntimeError(runtimeTokenOrAgentId, agentIdOrError, maybeError);
  }

  private clearInheritedAssistantOutputTargetsForManager(managerId: string): void {
    this.clearRuntimeResettableInheritedAssistantOutputTarget(managerId);
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role === "worker" && descriptor.managerId === managerId) {
        this.clearRuntimeResettableInheritedAssistantOutputTarget(descriptor.agentId);
      }
    }
  }

  private clearRuntimeResettableInheritedAssistantOutputTarget(agentId: string): void {
    const target = this.inheritedAssistantOutputTargetByWorkerId.get(agentId);
    if (target?.kind === "session_transcript") {
      this.inheritedAssistantOutputTargetByWorkerId.delete(agentId);
    }
  }

  private async handleRuntimeAgentEnd(runtimeTokenOrAgentId: number | string, maybeAgentId?: string): Promise<void> {
    const agentId = typeof runtimeTokenOrAgentId === "number" ? maybeAgentId : runtimeTokenOrAgentId;
    const descriptor = agentId ? this.descriptors.get(agentId) : undefined;
    if (agentId && descriptor?.role === "manager") {
      this.activeCodexPluginDelegationByManagerId.delete(agentId);
      this.activeCodexPluginRetryAuthorizationByManagerId.delete(agentId);
    }

    await this.runtimeController.handleRuntimeAgentEnd(runtimeTokenOrAgentId, maybeAgentId);
  }

  async queueVersionedToolMutation(
    descriptor: AgentDescriptor,
    mutation: VersioningMutation
  ): Promise<void> {
    this.queueVersioningMutation({
      ...mutation,
      reviewRunId: await this.resolveActiveCortexReviewRunIdForDescriptor(descriptor)
    });
  }

  private async resolveActiveCortexReviewRunIdForDescriptor(descriptor: AgentDescriptor): Promise<string | undefined> {
    return this.cortexService.resolveActiveReviewRunIdForDescriptor(descriptor);
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

  private emitSessionActiveToolsSnapshot(snapshot: SessionActiveToolsSnapshotEvent | null): void {
    if (!snapshot) {
      return;
    }

    this.emit("session_active_tools_snapshot", snapshot satisfies ServerEvent);
  }

  private emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void {
    const descriptor = this.descriptors.get(agentId);
    const resolvedContextUsage = normalizeContextUsage(contextUsage ?? descriptor?.contextUsage);
    const runtime = this.runtimes.get(agentId);
    const contextRecoveryInProgress = runtime?.isContextRecoveryInProgress?.() === true;
    const payload: AgentStatusEvent = {
      type: "agent_status",
      agentId,
      ...(descriptor?.role === "worker" ? { managerId: descriptor.managerId } : {}),
      status,
      pendingCount,
      ...(resolvedContextUsage ? { contextUsage: resolvedContextUsage } : {}),
      ...(contextRecoveryInProgress ? { contextRecoveryInProgress } : {}),
      ...(descriptor?.streamingStartedAt != null ? { streamingStartedAt: descriptor.streamingStartedAt } : {})
    };

    this.emit("agent_status", payload satisfies ServerEvent);
    for (const snapshot of this.sessionActiveTools.recordAgentStatus(payload, descriptor)) {
      this.emitSessionActiveToolsSnapshot(snapshot);
    }

    this.cortexService.handleAgentStatusEvent(descriptor, status);
  }

  private emitAgentsSnapshot(): void {
    if (this.pendingAgentsSnapshotEmit) {
      return;
    }

    this.pendingAgentsSnapshotEmit = true;
    queueMicrotask(() => {
      if (!this.pendingAgentsSnapshotEmit) {
        return;
      }

      this.pendingAgentsSnapshotEmit = false;
      const payload: AgentsSnapshotEvent = {
        type: "agents_snapshot",
        agents: this.listManagerAgents()
      };

      this.agentsSnapshotVersion += 1;
      this.emit("agents_snapshot", payload satisfies ServerEvent);
    });
  }

  private emitProfilesSnapshot(): void {
    const payload = {
      type: "profiles_snapshot",
      profiles: this.listProfiles()
    } satisfies ServerEvent;

    this.profilesSnapshotVersion += 1;
    this.emit("profiles_snapshot", payload);
  }

  private emitSessionProjectAgentUpdated(
    agentId: string,
    profileId: string,
    projectAgent: AgentDescriptor["projectAgent"] | null
  ): void {
    this.emit(
      "session_project_agent_updated",
      {
        type: "session_project_agent_updated",
        agentId,
        profileId,
        projectAgent: cloneProjectAgentInfoValue(projectAgent) ?? null
      } satisfies ServerEvent
    );
  }

  private emitSessionLifecycle(event: SessionLifecycleEvent): void {
    this.emit("session_lifecycle", event);
  }

  private async rebuildSessionManifestForBoot(): Promise<void> {
    await this.sessionMetaService.rebuildSessionManifestForBoot();
  }

  private async hydrateCompactionCountsForBoot(): Promise<void> {
    await this.sessionMetaService.hydrateCompactionCountsForBoot();
  }

  private startCompactionCountBackfill(): void {
    this.sessionMetaService.startCompactionCountBackfill();
  }

  private async writeInitialSessionMeta(descriptor: AgentDescriptor): Promise<void> {
    await this.sessionMetaService.writeInitialSessionMeta(descriptor);
  }

  private async captureSessionRuntimePromptMeta(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void> {
    await this.sessionMetaService.captureSessionRuntimePromptMeta(descriptor, resolvedSystemPrompt);
  }

  private async updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void> {
    await this.sessionMetaService.updateSessionMetaForWorkerDescriptor(descriptor, resolvedSystemPrompt);
  }

  private async refreshSessionMetaStats(
    descriptor: AgentDescriptor,
    sessionFileOverride?: string
  ): Promise<void> {
    await this.sessionMetaService.refreshSessionMetaStats(descriptor, sessionFileOverride);
  }

  private async refreshSessionMetaStatsBySessionId(
    sessionAgentId: string,
    sessionFileOverride?: string
  ): Promise<void> {
    await this.sessionMetaService.refreshSessionMetaStatsBySessionId(sessionAgentId, sessionFileOverride);
  }

  private async incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string
  ): Promise<number | undefined> {
    return this.sessionMetaService.incrementSessionCompactionCount(profileId, sessionId, failureLogKey);
  }

  private async readSessionMetaForDescriptor(descriptor: AgentDescriptor): Promise<SessionMeta | undefined> {
    return this.sessionMetaService.readSessionMetaForDescriptor(descriptor);
  }

  private isRuntimeInContextRecovery(agentId: string): boolean {
    const runtime = this.runtimes.get(agentId);
    return Boolean(runtime?.isContextRecoveryInProgress?.());
  }

  private isRuntimeRecoveryActive(agentId: string): boolean {
    return isRuntimeRecoveryActiveForRuntime(this.runtimes.get(agentId));
  }

  private markPendingManualManagerStopNotice(agentId: string): void {
    this.clearPendingManualManagerStopNoticeTimer(agentId);

    const timer = setTimeout(() => {
      this.pendingManualManagerStopNoticeTimersByAgentId.delete(agentId);
      this.runtimeController.clearInvalidatedManualStopMessageEndAllowance(agentId);
    }, PENDING_MANUAL_MANAGER_STOP_NOTICE_TTL_MS);
    timer.unref?.();

    this.pendingManualManagerStopNoticeTimersByAgentId.set(agentId, timer);
  }

  private clearPendingManualManagerStopNotice(agentId: string): void {
    this.clearPendingManualManagerStopNoticeTimer(agentId);
  }

  private emitImmediateManualManagerStopNotice(agentId: string): void {
    this.clearPendingManualManagerStopNotice(agentId);
    this.runtimeController.clearInvalidatedManualStopMessageEndAllowance(agentId);
    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: MANUAL_MANAGER_STOP_NOTICE,
      timestamp: this.now(),
      source: "system"
    });
  }

  private clearPendingManualManagerStopNoticeTimer(agentId: string): void {
    const timer = this.pendingManualManagerStopNoticeTimersByAgentId.get(agentId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.pendingManualManagerStopNoticeTimersByAgentId.delete(agentId);
  }

  consumePendingManualManagerStopNoticeIfApplicable(agentId: string, event: RuntimeSessionEvent): boolean {
    if (!this.pendingManualManagerStopNoticeTimersByAgentId.has(agentId) || event.type !== "message_end") {
      return false;
    }

    if (extractRole(event.message) !== "assistant") {
      return false;
    }

    const stopReason = extractMessageStopReason(event.message);
    const hasStructuredErrorMessage = hasMessageErrorMessageField(event.message);
    if (stopReason !== "error" && !hasStructuredErrorMessage) {
      return false;
    }

    const normalizedErrorMessage = normalizeProviderErrorMessage(
      extractMessageErrorMessage(event.message) ?? extractMessageText(event.message)
    );

    this.clearPendingManualManagerStopNotice(agentId);
    return isAbortLikeErrorMessage(normalizedErrorMessage);
  }

  stripManagerAbortErrorFromEvent(event: RuntimeSessionEvent): RuntimeSessionEvent {
    if (event.type !== "message_end") {
      return event;
    }

    const messageWithMetadata = event.message as typeof event.message & { errorMessage?: unknown; stopReason?: unknown };
    const { errorMessage: _errorMessage, ...messageWithoutError } = messageWithMetadata;

    return {
      ...event,
      message: {
        ...messageWithoutError,
        stopReason: "stop"
      } as typeof event.message
    };
  }

  async checkForStalledWorkers(): Promise<void> {
    return this.workerHealthService.checkForStalledWorkers();
  }

  async handleStallNudge(agentId: string, elapsedMs: number): Promise<void> {
    await this.workerHealthService.handleStallNudge(agentId, elapsedMs);
  }

  async handleStallDetailedReport(agentId: string, elapsedMs: number): Promise<void> {
    await this.workerHealthService.handleStallDetailedReport(agentId, elapsedMs);
  }

  async handleStallAutoKill(agentId: string, elapsedMs: number): Promise<void> {
    await this.workerHealthService.handleStallAutoKill(agentId, elapsedMs);
  }

  async finalizeWorkerIdleTurn(
    agentId: string,
    descriptor: AgentDescriptor,
    source: "agent_end" | "status_idle" | "deferred"
  ): Promise<void> {
    await this.workerHealthService.finalizeWorkerIdleTurn(agentId, descriptor, source);
  }

  private seedWorkerCompletionReportTimestamp(agentId: string): void {
    this.workerHealthService.seedWorkerCompletionReportTimestamp(agentId);
  }

  getOrCreateWorkerWatchdogState(agentId: string): WorkerWatchdogState {
    return this.workerHealthService.getOrCreateWorkerWatchdogState(agentId);
  }

  clearWatchdogTimer(agentId: string): void {
    this.workerHealthService.clearWatchdogTimer(agentId);
  }

  private clearWatchdogState(agentId: string): void {
    this.workerHealthService.clearWatchdogState(agentId);
  }

  removeWorkerFromWatchdogBatchQueues(agentId: string): void {
    this.workerHealthService.removeWorkerFromWatchdogBatchQueues(agentId);
  }

  beginPendingTransientWorkerTerminatedError(
    agentId: string,
    event: RuntimeSessionEvent,
    expire: (event: RuntimeSessionEvent) => void | Promise<void>
  ): boolean {
    return this.workerHealthService.beginPendingTransientWorkerTerminatedError(agentId, event, expire);
  }

  cancelPendingTransientWorkerTerminatedError(agentId: string, reason: "runtime_progress" | "worker_reported" | "clear_state"): void {
    this.workerHealthService.cancelPendingTransientWorkerTerminatedError(agentId, reason);
  }

  hasPendingTransientWorkerTerminatedError(agentId: string): boolean {
    return this.workerHealthService.hasPendingTransientWorkerTerminatedError(agentId);
  }

  get workerWatchdogState(): Map<string, WorkerWatchdogState> {
    return this.workerHealthService.workerWatchdogState;
  }

  get workerStallState(): Map<string, WorkerStallState> {
    return this.workerHealthService.workerStallState;
  }

  get workerActivityState(): Map<string, WorkerActivityState> {
    return this.workerHealthService.workerActivityState;
  }

  get watchdogTimers(): Map<string, NodeJS.Timeout> {
    return this.workerHealthService.watchdogTimers;
  }

  get watchdogTimerTokens(): Map<string, number> {
    return this.workerHealthService.watchdogTimerTokens;
  }

  get watchdogBatchQueueByManager(): Map<string, Map<string, WatchdogBatchEntry>> {
    return this.workerHealthService.watchdogBatchQueueByManager;
  }

  get watchdogBatchTimersByManager(): Map<string, NodeJS.Timeout> {
    return this.workerHealthService.watchdogBatchTimersByManager;
  }

  private async ensureDirectories(): Promise<void> {
    await this.persistenceService.ensureDirectories();
  }

  private getPiModelsJsonPathOrThrow(): string {
    if (!this.piModelsJsonPath) {
      throw new Error("Pi model projection path is unavailable before SwarmManager boot completes.");
    }

    return this.piModelsJsonPath;
  }

  getCompactionRuntimeSettingsProvider(): CompactionRuntimeSettingsProvider {
    return this.compactionRuntimeSettingsProvider;
  }

  getCompactionSettingsService(): CompactionSettingsService | null {
    return this.compactionSettingsService;
  }

  getKnowledgeV2SettingsService(): KnowledgeV2SettingsService {
    return this.knowledgeV2SettingsService;
  }

  getKnowledgeService(): KnowledgeService {
    return this.knowledgeService;
  }

  async searchKnowledge(
    callerAgentId: string,
    input: { query?: string; scope?: "global" | "profile" | "all"; limit?: number },
  ): Promise<KnowledgeSearchResult[]> {
    this.assertKnowledgeV2Enabled();
    const profileId = this.resolveKnowledgeCallerProfileId(callerAgentId);
    return this.knowledgeService.searchEntries({
      query: input.query,
      scope: input.scope ?? "all",
      profileId,
      limit: input.limit,
    });
  }

  async readKnowledgeEntry(callerAgentId: string, id: string): Promise<KnowledgeEntry> {
    this.assertKnowledgeV2Enabled();
    this.resolveKnowledgeCallerProfileId(callerAgentId);
    return this.knowledgeService.readEntry(id);
  }

  async saveLearning(
    callerAgentId: string,
    input: {
      type: KnowledgeEntryType;
      scope: KnowledgeEntryScope;
      title: string;
      body: string;
      evidence: "user-stated" | "observed";
    },
  ): Promise<KnowledgeEntry> {
    this.assertKnowledgeV2Enabled();
    const caller = this.descriptors.get(callerAgentId);
    if (!caller || caller.role !== "manager") {
      throw new Error("save_learning is manager-only.");
    }
    const profileId = this.resolveKnowledgeCallerProfileId(callerAgentId);
    if (!profileId && input.scope !== "global") {
      throw new Error("Profile-scoped knowledge requires a caller profile.");
    }
    const scope = input.scope === "global" ? "global" : input.scope || `profile:${profileId}`;
    return this.knowledgeService.saveLearning({
      ...input,
      scope,
      sessionId: caller.agentId,
    });
  }

  private async ensureCompactionSettingsLoadedForRuntime(): Promise<void> {
    if (!isBuilderRuntimeTarget(this.config.runtimeTarget)) {
      return;
    }

    if (this.compactionSettingsService) {
      return;
    }

    const service = new CompactionSettingsService({
      dataDir: this.config.paths.dataDir,
      getProviderAvailability: () =>
        getManagedModelProviderCredentialAvailability(this.config, {
          credentialPoolService: this.getCredentialPoolService(),
        }),
    });
    await service.load();
    this.compactionSettingsService = service;

    if (this.compactionRuntimeSettingsProvider === this.liveCompactionRuntimeSettingsProvider) {
      this.liveCompactionRuntimeSettingsProvider.attachSettingsService(service);
    }
  }

  private assertKnowledgeV2Enabled(): void {
    if (!this.knowledgeV2SettingsService.getSettings().enabled) {
      throw new Error("Knowledge v2 is disabled in Settings.");
    }
  }

  private resolveKnowledgeCallerProfileId(callerAgentId: string): string | undefined {
    const caller = this.descriptors.get(callerAgentId);
    if (!caller) {
      throw new Error(`Unknown agent: ${callerAgentId}`);
    }
    if (caller.profileId) {
      return caller.profileId;
    }
    const manager = this.descriptors.get(caller.managerId);
    return manager?.profileId;
  }

  private async refreshPiModelsJsonProjection(): Promise<void> {
    this.piModelsJsonPath = await generatePiProjection(this.config.paths.dataDir);
    this.logDebug("model_catalog:projection:generated", {
      path: this.piModelsJsonPath,
    });
  }

  private async ensureSessionFileParentDirectory(sessionFile: string): Promise<void> {
    await mkdir(dirname(sessionFile), { recursive: true });
  }

  private getAgentMemoryPath(agentId: string): string {
    const descriptor = this.descriptors.get(agentId);

    if (!descriptor) {
      const fallbackAgentId = normalizeOptionalAgentId(agentId) ?? agentId;
      return resolveMemoryFilePath(this.config.paths.dataDir, {
        agentId: fallbackAgentId,
        role: "manager",
        profileId: fallbackAgentId,
        managerId: fallbackAgentId
      });
    }

    const parentDescriptor = descriptor.role === "worker"
      ? this.descriptors.get(descriptor.managerId)
      : undefined;

    const parentProfileId =
      descriptor.role === "worker"
        ? normalizeOptionalAgentId(parentDescriptor?.profileId ?? descriptor.profileId)
        : undefined;

    return resolveMemoryFilePath(
      this.config.paths.dataDir,
      {
        agentId: descriptor.agentId,
        role: descriptor.role,
        profileId: descriptor.profileId,
        managerId: descriptor.managerId
      },
      parentProfileId ? { profileId: parentProfileId } : undefined
    );
  }

  private resolveMemoryOwnerAgentId(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return descriptor.agentId;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (managerId) {
      return managerId;
    }

    return this.resolvePreferredManagerId({ includeStoppedOnRestart: true }) ?? descriptor.agentId;
  }

  private resolveSessionProfileId(memoryOwnerAgentId: string): string | undefined {
    const memoryOwnerDescriptor = this.descriptors.get(memoryOwnerAgentId);
    if (!memoryOwnerDescriptor || memoryOwnerDescriptor.role !== "manager") {
      return undefined;
    }

    return normalizeOptionalAgentId(memoryOwnerDescriptor.profileId) ?? memoryOwnerDescriptor.agentId;
  }

  protected async executeProjectAgentAnalysis(
    model: Model<Api>,
    options: AnalyzeSessionForPromotionOptions
  ): Promise<ProjectAgentRecommendations> {
    return analyzeSessionForPromotion(model, options);
  }

  private async resolveProjectAgentAnalysisModel(): Promise<{
    model: Model<Api>;
    apiKey?: string;
    headers?: Record<string, string>;
    modelLabel: string;
  }> {
    const authFilePath = await ensureCanonicalAuthFilePath(this.config);
    const authStorage = AuthStorage.create(authFilePath);
    const piModelsJsonPath = this.getPiModelsJsonPathOrThrow();
    const modelRegistry = createPiModelRegistry(authStorage, piModelsJsonPath);

    const candidates = [
      { provider: "anthropic", modelId: "claude-opus-4-6" },
      { provider: "openai-codex", modelId: "gpt-5.4" },
      { provider: "openai-codex", modelId: "gpt-5.5" },
    ] as const;
    const failureMessages: string[] = [];

    for (const candidate of candidates) {
      const model =
        modelRegistry.find(candidate.provider, candidate.modelId) ??
        (getModel(candidate.provider as never, candidate.modelId as never) as Model<Api> | undefined);
      if (!model) {
        failureMessages.push(`Model ${candidate.provider}/${candidate.modelId} is unavailable.`);
        continue;
      }

      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        failureMessages.push(`${candidate.provider}/${candidate.modelId}: ${auth.error}`);
        continue;
      }

      return {
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        modelLabel: `${candidate.provider}/${candidate.modelId}`
      };
    }

    throw new Error(
      [
        "No configured model is available for project agent analysis.",
        "Tried anthropic/claude-opus-4-6 first, then openai-codex/gpt-5.5.",
        failureMessages.join(" ")
      ]
        .filter((part) => part.trim().length > 0)
        .join(" ")
    );
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

  private async writeSessionMemoryMergeAttemptMeta(
    descriptor: AgentDescriptor,
    attempt: SessionMemoryMergeAttemptMetaUpdate
  ): Promise<void> {
    await this.sessionMetaService.writeSessionMemoryMergeAttemptMeta(descriptor, attempt);
  }

  private async recordSessionMemoryMergeAttempt(
    descriptor: AgentDescriptor,
    attempt: {
      attemptId?: string | null;
      timestamp: string;
      status: SessionMemoryMergeAttemptStatus;
      strategy?: SessionMemoryMergeStrategy | null;
      failureStage?: SessionMemoryMergeFailureStage | null;
      sessionContentHash?: string | null;
      profileContentHashBefore?: string | null;
      profileContentHashAfter?: string | null;
      appliedSourceHash?: string | null;
      error?: string;
    }
  ): Promise<void> {
    await this.writeSessionMemoryMergeAttemptMeta(descriptor, attempt);
  }

  private async appendSessionMemoryMergeAuditEntry(entry: SessionMemoryMergeAuditEntry): Promise<void> {
    await appendFile(
      getProfileMergeAuditLogPath(this.config.paths.dataDir, entry.profileId),
      `${JSON.stringify(entry)}\n`,
      "utf8"
    );
  }

  private async refreshDefaultMemoryTemplateNormalizedLines(): Promise<void> {
    await this.memoryMergeService.refreshDefaultMemoryTemplateNormalizedLines();
  }

  private async ensureMemoryFilesForBoot(): Promise<void> {
    await this.memoryMergeService.ensureMemoryFilesForBoot();
  }

  private async ensureAgentMemoryFile(memoryFilePath: string, profileId?: string): Promise<void> {
    await this.memoryMergeService.ensureAgentMemoryFile(memoryFilePath, profileId);
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

  private async loadStore(): Promise<AgentsStoreFile> {
    return this.descriptorStoreAdapter.loadStore();
  }

  private loadConversationHistoriesFromStore(): void {
    this.conversationProjector.loadConversationHistoriesFromStore();
  }

  private async saveStore(): Promise<void> {
    await this.descriptorStoreAdapter.saveStore();
  }

  async patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>
  ): Promise<AgentDescriptor | undefined> {
    return this.descriptorStoreAdapter.patchDescriptorInLiveMaps(agentId, patch);
  }

  private createDescriptorStoreAdapter(): DescriptorStoreAdapter {
    const liveMaps = () => ({
      descriptors: this.descriptors,
      profiles: this.profiles
    });
    const transactionDescriptors: DescriptorStoreAdapter["transactionDescriptors"] = (callback, options) =>
      this.descriptorStore.transactionWithLiveMaps(liveMaps(), callback, options);

    return {
      loadStore: () => this.descriptorStore.load(),
      saveStore: () => this.descriptorStore.saveLiveMaps(liveMaps()),
      transactionDescriptors,
      persistBestEffort: () => this.descriptorStore.saveLiveMapsBestEffort(liveMaps(), (error) => {
        this.logDebug("descriptor-store:best-effort-save-failed", { error });
      }),
      upsertDescriptor: async (descriptor) => {
        await transactionDescriptors((store) => {
          store.upsertDescriptor(descriptor);
        });
      },
      upsertDescriptorInLiveMaps: (descriptor) => {
        this.descriptors.set(descriptor.agentId, descriptor);
      },
      patchDescriptor: (agentId, patch) => transactionDescriptors((store) => store.patchDescriptor(agentId, patch)),
      patchDescriptorInLiveMaps: (agentId, patch) => this.descriptorStore.patchDescriptorInLiveMaps(liveMaps(), agentId, patch),
      deleteDescriptor: (agentId) => transactionDescriptors((store) => store.deleteDescriptor(agentId)),
      deleteDescriptorInLiveMaps: (agentId) => this.descriptors.delete(agentId),
      upsertProfile: async (profile) => {
        await transactionDescriptors((store) => {
          store.upsertProfile(profile);
        });
      },
      upsertProfileInLiveMaps: (profile) => {
        this.profiles.set(profile.profileId, cloneManagerProfileForLiveMap(profile));
      },
      patchProfile: (profileId, patch) => transactionDescriptors((store) => store.patchProfile(profileId, patch)),
      deleteProfile: (profileId) => transactionDescriptors((store) => store.deleteProfile(profileId)),
      deleteProfileInLiveMaps: (profileId) => this.profiles.delete(profileId)
    };
  }
}

function cloneManagerProfileForLiveMap(profile: ManagerProfile): ManagerProfile {
  return {
    ...profile,
    defaultModel: { ...profile.defaultModel },
  };
}

function isOpenAICodexDescriptor(descriptor: AgentDescriptor): boolean {
  return String(descriptor.model?.provider ?? "").toLowerCase() === "openai-codex";
}

function selectedOpenAICodexTransport(): CodexTransportDebugAgentDiagnostics["selectedConfigTransport"] {
  const rawTransport = process.env.FORGE_OPENAI_CODEX_TRANSPORT?.trim().toLowerCase();
  switch (rawTransport) {
    case undefined:
    case "":
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

function normalizeRuntimeMessageTextForMatch(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function runtimeMessageTextMatches(expected: string, actual: string): boolean {
  return normalizeRuntimeMessageTextForMatch(expected) === normalizeRuntimeMessageTextForMatch(actual);
}

function cloneSessionTranscriptAssistantOutputTarget(
  target: SessionTranscriptAssistantOutputTarget,
): SessionTranscriptAssistantOutputTarget {
  return {
    kind: "session_transcript",
    channel: target.channel,
    ...(target.sourceContext ? { sourceContext: { ...target.sourceContext } } : {}),
  };
}

function cloneAssistantOutputTarget(target: AssistantOutputTarget): AssistantOutputTarget {
  switch (target.kind) {
    case "session_transcript":
      return cloneSessionTranscriptAssistantOutputTarget(target);
    case "external_channel":
      return { kind: "external_channel", sourceContext: { ...target.sourceContext } };
    case "peer_agent":
      return { kind: "peer_agent", fromAgentId: target.fromAgentId };
    case "explicit_tool_required":
      return { kind: "explicit_tool_required", reason: target.reason };
    case "internal_only":
      return { kind: "internal_only", ...(target.reason ? { reason: target.reason } : {}) };
  }
}

function isWorkerReportRuntimeMessage(message: string | RuntimeUserMessage): boolean {
  return extractRuntimeMessageText(message).trimStart().startsWith(WORKER_REPORT_MESSAGE_PREFIX);
}

function isWorkerStatusCloseoutMessage(message: string | undefined): boolean {
  return typeof message === "string" && TERMINAL_WORKER_REPORT_BODY_PATTERN.test(message.trimStart());
}

function appendAssistantOutputTargetMetadataToRuntimeMessage(
  message: string | RuntimeUserMessage,
  target: AssistantOutputTarget,
): string | RuntimeUserMessage {
  if (typeof message === "string") {
    return appendAssistantOutputTargetMetadataToText(message, target);
  }

  return {
    ...message,
    text: appendAssistantOutputTargetMetadataToText(message.text, target),
  };
}

function appendAssistantOutputTargetMetadataToText(
  text: string,
  target: AssistantOutputTarget,
): string {
  const marker = formatAssistantOutputTargetMetadata(target);
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd < 0) {
    return `${text}\n${marker}`;
  }

  return `${text.slice(0, firstLineEnd)}\n${marker}${text.slice(firstLineEnd)}`;
}

function hashDebugAgentId(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 16);
}

async function withBoundedTrustRuntimeTermination(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void operation.catch(() => undefined);
  }
}

function collectPropagationFailures(
  descriptors: Array<{ agentId: string }>,
  results: Array<PromiseSettledResult<unknown>>
): Array<{ agentId: string | undefined; reason: unknown }> {
  const failures: Array<{ agentId: string | undefined; reason: unknown }> = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failures.push({ agentId: descriptors[index]?.agentId, reason: result.reason });
    }
  });
  return failures;
}

function classifyObservabilityRootSource(input: {
  origin: "user" | "internal";
  fromAgentId: string;
  targetAgentId: string;
  internalDeliveryKind?: "codex_plugin_bootstrap" | "bootstrap" | "agent_creator_bootstrap";
}): "user_input" | "bootstrap" | "agent_creator_bootstrap" | "codex_plugin_bootstrap" | "internal_self_send" | "internal_agent_message" {
  if (input.origin === "user") {
    return "user_input";
  }
  if (input.internalDeliveryKind === "codex_plugin_bootstrap") {
    return "codex_plugin_bootstrap";
  }
  if (input.internalDeliveryKind === "bootstrap") {
    return "bootstrap";
  }
  if (input.internalDeliveryKind === "agent_creator_bootstrap") {
    return "agent_creator_bootstrap";
  }
  if (input.fromAgentId === input.targetAgentId) {
    return "internal_self_send";
  }
  return "internal_agent_message";
}

function hasExistingExecutableSurface(resolution: { repoRootResources: { forgeExtensionsDir?: string; piExtensionsDir?: string; piSettingsPath?: string }; legacyExecutableSurfaces: Array<{ path: string; activeToday?: boolean }> }): boolean {
  return [
    resolution.repoRootResources.forgeExtensionsDir,
    resolution.repoRootResources.piExtensionsDir,
    resolution.repoRootResources.piSettingsPath,
    ...resolution.legacyExecutableSurfaces.filter((surface) => surface.activeToday).map((surface) => surface.path)
  ].some((pathValue) => Boolean(pathValue && existsSync(pathValue)));
}

function formatArtifactShortcode(artifactPath: string): string {
  return `[artifact:${artifactPath}]`;
}

async function writeUniqueArtifactFile(
  artifactDir: string,
  baseName: string,
  extension: string,
  body: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidate = join(artifactDir, `${baseName}${suffix}.${extension}`);
    try {
      await writeFile(candidate, body, { encoding: "utf8", flag: "wx" });
      return candidate;
    } catch (error) {
      if (isNodeErrorCode(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Unable to allocate a unique Codex plugin artifact file name.");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

function hashCodexPluginExportArgs(args: Record<string, unknown> | undefined): string {
  return createHash("sha256").update(stableStringifyCodexPluginExportValue(args ?? {})).digest("hex");
}

function stableStringifyCodexPluginExportValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyCodexPluginExportValue(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringifyCodexPluginExportValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isSessionRenameHistoryEntry(value: unknown): value is SessionRenameHistoryEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    typeof value.renamedAt === "string"
  );
}

function inferLegacySessionModelOrigin(
  descriptor: AgentDescriptor & { role: "manager"; profileId?: string },
  profile: ManagerProfile,
  options?: { forceDefaultSessionInherited?: boolean }
): "profile_default" | "session_override" {
  if (options?.forceDefaultSessionInherited && descriptor.agentId === profile.defaultSessionAgentId) {
    return "profile_default";
  }

  return sameModelDescriptor(descriptor.model, profile.defaultModel)
    ? "profile_default"
    : "session_override";
}

function isValidPersistedModelDescriptor(value: unknown): value is AgentDescriptor["model"] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    typeof (value as { modelId?: unknown }).modelId === "string" &&
    typeof (value as { thinkingLevel?: unknown }).thinkingLevel === "string"
  );
}

function cloneModelDescriptor(model: AgentDescriptor["model"]): AgentDescriptor["model"] {
  return normalizePersistedSwarmModelDescriptor(model) ?? {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: model.thinkingLevel
  };
}

function sameModelDescriptor(left: AgentDescriptor["model"], right: AgentDescriptor["model"]): boolean {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    normalizeModelThinkingLevel(left.thinkingLevel) === normalizeModelThinkingLevel(right.thinkingLevel)
  );
}

function normalizeModelThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}

function hasUnsupportedTaskRefFields(value: Record<string, unknown>): boolean {
  for (const key of ["choiceId", "messageId", "artifactId", "path", "filePath", "artifactPath", "url", "href"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return true;
    }
  }

  return false;
}
