import {
  MANAGER_MODEL_PRESETS,
  type EffortTier,
  type AgentCollaborationLink,
  type AgentCreatorResult,
  type CliSessionMetadata,
  type ConversationMessageSource,
  type ConversationTimelineEntryMetadata,
  type AgentModelOrigin,
  type AgentSessionSurface,
  type ChoiceRequestEvent,
  type CollaborationAuthor,
  type ConversationReplyTarget,
  type PersistedMessageChannel as ProtocolPersistedMessageChannel,
  type ManagerProfile,
  type ExternalThreadInfo,
  type ExternalThreadMessageContext,
  type ProjectAgentInfo,
  type ProjectAgentMessageContext,
  type PlanSummaryEvent,
} from "@forge/protocol";
import type { AgentStatus } from "./agent-state-machine.js";
import type Database from "better-sqlite3";
import type { RuntimeTarget } from "../runtime-target.js";

export type AgentRole = "manager" | "worker";

export type AgentArchetypeId = string;

export type { AgentStatus };
export type { AgentCollaborationLink, AgentModelOrigin, AgentSessionSurface, CliSessionMetadata, ManagerProfile };
export type { ExternalThreadInfo, ExternalThreadMessageContext, ProjectAgentMessageContext };
export type { PlanSummaryEvent } from "@forge/protocol";
export {
  isCodexAppServerExternalThreadDescriptor,
  isExternalThreadDescriptor,
  shouldExcludeConversationMessageFromModelContext,
} from "@forge/protocol";
export type {
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceRequestEvent,
  ChoiceRequestStatus,
} from "@forge/protocol";

export const SWARM_MODEL_PRESETS = MANAGER_MODEL_PRESETS;

export type SwarmModelPreset = string;

export const SWARM_REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type SwarmReasoningLevel = (typeof SWARM_REASONING_LEVELS)[number];

export interface AgentModelDescriptor {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

/** Active context-window occupancy, not per-request or billing usage. */
export interface AgentContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export type AgentSessionPurpose = "cortex_review" | "agent_creator" | "capture_check";

export type InternalWorkerKind = "codex_plugin";

export interface AgentDescriptor {
  agentId: string;
  displayName: string;
  role: AgentRole;
  managerId: string;
  creatorAgentId?: string;
  archetypeId?: AgentArchetypeId;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: AgentModelDescriptor;
  modelOrigin?: AgentModelOrigin;
  sessionFile: string;
  contextUsage?: AgentContextUsage;
  profileId?: string;
  sessionLabel?: string;
  sessionPurpose?: AgentSessionPurpose;
  sessionSurface?: AgentSessionSurface;
  collab?: AgentCollaborationLink;
  cli?: CliSessionMetadata;
  sessionSystemPrompt?: string;
  pinnedAt?: string;
  archivedAt?: string;
  lastUserMessageAt?: string;
  mergedAt?: string;
  compactionCount?: number;
  workerCount?: number;
  activeWorkerCount?: number;
  streamingStartedAt?: number;
  pendingChoiceCount?: number;
  specialistId?: string;
  specialistTier?: EffortTier;
  specialistLens?: string;
  specialistDisplayName?: string;
  specialistColor?: string;
  internalWorkerKind?: InternalWorkerKind;
  /**
   * Private persisted ownership for the worker's current assignment. This is
   * intentionally omitted from public agent snapshots.
   */
  workerParentContext?: WorkerParentContext;
  projectAgent?: ProjectAgentInfo;
  agentCreatorResult?: AgentCreatorResult;
  webSearch?: boolean;
  externalThread?: ExternalThreadInfo;
}

export interface AgentsStoreFile {
  agents: AgentDescriptor[];
  profiles?: ManagerProfile[];
}

export type RequestedDeliveryMode = "auto" | "followUp" | "steer";

export type AcceptedDeliveryMode = "prompt" | "followUp" | "steer";

export interface MessageSourceContext {
  /** Includes a retired value solely so old JSONL and worker metadata remain parseable. */
  channel: ProtocolPersistedMessageChannel;
  channelId?: string;
  userId?: string;
  messageId?: string;
  threadTs?: string;
  integrationProfileId?: string;
  channelType?: "dm" | "channel" | "group" | "mpim";
  teamId?: string;
}

export type SessionTranscriptAssistantOutputTarget = {
  kind: "session_transcript";
  channel: "web" | "cli";
  sourceContext?: MessageSourceContext;
};

export type AssistantOutputTarget =
  | SessionTranscriptAssistantOutputTarget
  | { kind: "explicit_tool_required"; reason: string }
  | { kind: "peer_agent"; fromAgentId: string }
  | { kind: "external_channel"; sourceContext: MessageSourceContext }
  | { kind: "internal_only"; reason?: string };

/** Durable private link from one worker assignment back to its manager work. */
export interface WorkerParentContext {
  schemaVersion: 1;
  assignmentId: string;
  managerId: string;
  assignedAt: string;
  /** Set before result delivery so a completed assignment survives delivery failure/restart. */
  completedAt?: string;
  outputTarget: AssistantOutputTarget;
  rootTurnId?: string;
  parentRootTurnId?: string;
}

export interface MessageTargetContext {
  channel: "web";
  channelId?: string;
  userId?: string;
  threadTs?: string;
  integrationProfileId?: string;
}

export interface SendMessageReceipt {
  targetAgentId: string;
  deliveryId: string;
  acceptedMode: AcceptedDeliveryMode;
}

export interface SpawnAgentInput {
  agentId: string;
  planStep?: string;
  specialist?: string;
  tier?: EffortTier;
  lens?: string;
  /** Internal marker set by the manager-facing mode/policy adapter. */
  policyControlledModel?: boolean;
  archetypeId?: AgentArchetypeId;
  systemPrompt?: string;
  model?: SwarmModelPreset;
  modelId?: string;
  reasoningLevel?: SwarmReasoningLevel;
  cwd?: string;
  initialMessage?: string;
  webSearch?: boolean;
}

export interface SwarmPaths {
  rootDir: string;
  resourcesDir?: string;
  dataDir: string;
  swarmDir: string;
  uploadsDir: string;
  agentsStoreFile: string;

  // New hierarchical layout fields
  profilesDir: string;
  sharedDir: string;
  sharedConfigDir: string;
  sharedCacheDir: string;
  sharedStateDir: string;
  sharedAuthDir: string;
  sharedAuthFile: string;
  sharedSecretsFile: string;
  collaborationConfigDir?: string;
  collaborationAuthDbPath?: string;
  collaborationAuthSecretPath?: string;
  remoteUpdateAwarenessDbPath?: string;

  // Legacy compatibility fields (flat layout)
  /** @deprecated Use profilesDir-based paths instead. */
  sessionsDir: string;
  /** @deprecated Use profilesDir-based paths instead. */
  memoryDir: string;
  /** @deprecated Use sharedAuthDir/sharedAuthFile instead. */
  authDir: string;
  /** @deprecated Use sharedAuthFile instead. */
  authFile: string;
  /** @deprecated Use sharedSecretsFile instead. */
  secretsFile: string;

  agentDir: string;
  managerAgentDir: string;
  repoArchetypesDir: string;
  memoryFile?: string;
  repoMemorySkillFile: string;
  schedulesFile?: string;
}

export type {
  SettingsAuthProvider,
  SettingsAuthProviderId as SettingsAuthProviderName,
  SettingsEnvVariable as SkillEnvRequirement,
} from "@forge/protocol";

export interface SqliteDatabaseConstructor {
  new (path: string, options?: Database.Options): Database.Database;
}

export type CollaborationDatabaseConstructor = SqliteDatabaseConstructor;

export interface RemoteUpdateAwarenessModuleLoaders {
  loadDatabaseModule: () => Promise<SqliteDatabaseConstructor>;
}

export interface CollaborationModuleLoaders {
  loadAuthModule: () => Promise<typeof import("better-auth")>;
  loadDatabaseModule: () => Promise<CollaborationDatabaseConstructor>;
}

export interface SwarmConfig {
  host: string;
  port: number;
  debug: boolean;
  isDesktop: boolean;
  runtimeTarget: RuntimeTarget;
  cortexEnabled: boolean;
  adminEmail?: string;
  adminPassword?: string;
  collaborationAuthSecret?: string;
  collaborationAuthCookieName?: string;
  collaborationBaseUrl?: string;
  collaborationTrustedOrigins?: string[];
  collaborationModules?: CollaborationModuleLoaders;
  /** Feature-owned SQLite loader available in every runtime target. */
  remoteUpdateAwarenessModules?: RemoteUpdateAwarenessModuleLoaders;
  /**
   * Collaboration-server startup overlay for Remote Projects policy.
   * Absent on Builder. Parsed once from FORGE_REMOTE_PROJECTS_* env vars.
   */
  remoteProjectsEnv?: {
    enabled?: boolean;
    terminalsEnabled?: boolean;
    instanceName?: string;
  };
  allowNonManagerSubscriptions: boolean;
  managerId?: string;
  managerDisplayName: string;
  defaultModel: AgentModelDescriptor;
  defaultCwd: string;
  cwdAllowlistRoots: string[];
  paths: SwarmPaths;
}

export interface ConversationImageAttachment {
  type?: "image";
  mimeType: string;
  data: string;
  fileName?: string;
  filePath?: string;
}

export interface ConversationTextAttachment {
  type: "text";
  mimeType: string;
  text: string;
  fileName?: string;
  filePath?: string;
}

export interface ConversationBinaryAttachment {
  type: "binary";
  mimeType: string;
  data: string;
  fileName?: string;
  filePath?: string;
}

export type ConversationAttachment =
  | ConversationImageAttachment
  | ConversationTextAttachment
  | ConversationBinaryAttachment;

export interface ConversationAttachmentMetadata {
  type?: "image" | "text" | "binary";
  mimeType: string;
  fileName?: string;
  filePath?: string;
  fileRef?: string;
  sizeBytes?: number;
}

export type ConversationMessageAttachment = ConversationAttachment | ConversationAttachmentMetadata;

export interface ConversationMessageEvent extends ConversationTimelineEntryMetadata {
  type: "conversation_message";
  agentId: string;
  turnId?: string;
  id?: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ConversationMessageAttachment[];
  timestamp: string;
  source: ConversationMessageSource;
  sourceContext?: MessageSourceContext;
  collaborationAuthor?: CollaborationAuthor;
  /** Echo of the sender-provided `user_message.clientRequestId` (Wave R). */
  clientRequestId?: string;
  projectAgentContext?: ProjectAgentMessageContext;
  externalThreadContext?: ExternalThreadMessageContext;
  terminal?: boolean;
  sourceWorkerId?: string;
  excludeFromModelContext?: true;
  pinned?: boolean;
  replyTo?: ConversationReplyTarget;
  /** Presentation discriminator for system notices (see protocol SystemNoticeKind). */
  systemNoticeKind?: "worker_outcome_backstop";
}

export type ConversationLogKind =
  | "message_start"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end";

export interface ConversationLogEvent extends ConversationTimelineEntryMetadata {
  type: "conversation_log";
  agentId: string;
  timestamp: string;
  source: "runtime_log";
  kind: ConversationLogKind;
  role?: "user" | "assistant" | "system";
  toolName?: string;
  toolCallId?: string;
  text: string;
  isError?: boolean;
}

export interface AgentMessageEvent extends ConversationTimelineEntryMetadata {
  type: "agent_message";
  agentId: string;
  timestamp: string;
  source: "user_to_agent" | "agent_to_agent";
  fromAgentId?: string;
  toAgentId: string;
  text: string;
  sourceContext?: MessageSourceContext;
  requestedDelivery?: RequestedDeliveryMode;
  acceptedMode?: AcceptedDeliveryMode;
  attachmentCount?: number;
  /** Marks peer-manager activity that belongs in the normal project-agent conversation. */
  projectAgentExchange?: true;
}

export type AgentToolCallKind = Extract<
  ConversationLogKind,
  "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
>;

export interface AgentToolCallEvent extends ConversationTimelineEntryMetadata {
  type: "agent_tool_call";
  agentId: string;
  actorAgentId: string;
  turnId?: string;
  timestamp: string;
  kind: AgentToolCallKind;
  toolName?: string;
  toolCallId?: string;
  text: string;
  isError?: boolean;
}

export interface ActivitySummaryEvent extends ConversationTimelineEntryMetadata {
  type: "activity_summary";
  schemaVersion: 1;
  itemId: string;
  agentId: string;
  actorAgentId: string;
  turnId?: string;
  timestamp: string;
  kind: "tool_activity";
  status: "completed" | "failed" | "interrupted";
  toolName?: string;
  correlationId?: string;
  displaySummary: string;
  isError?: boolean;
}

export interface ModelCacheObservationEvent {
  type: "model_cache_observation";
  agentId: string;
  id?: string;
  timestamp: string;
  runtimeType: "pi";
  provider: "openai" | "openai-codex";
  modelId: string;
  api?: string;
  turnId?: string;
  tokens: {
    promptInputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    normalization: "raw_input_tokens_total" | "normalized_components";
  };
  classification: {
    version: 1;
    status: "hit" | "partial" | "miss";
    cachedRatio: number;
    thresholdTokens: 1024;
    hitRatioThreshold: 0.8;
  };
}

export type ConversationEntryEvent = (
  | ConversationMessageEvent
  | ConversationLogEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | ActivitySummaryEvent
  | ChoiceRequestEvent
  | PlanSummaryEvent
  | ModelCacheObservationEvent
) & ConversationTimelineEntryMetadata;

export interface AgentStatusEvent {
  type: "agent_status";
  agentId: string;
  managerId?: string;
  status: AgentStatus;
  pendingCount: number;
  contextUsage?: AgentContextUsage;
  contextRecoveryInProgress?: boolean;
  streamingStartedAt?: number;
}

export interface SessionLifecycleEvent {
  action: "created" | "deleted" | "renamed" | "forked" | "archived" | "restored";
  sessionAgentId: string;
  profileId: string;
  label?: string;
  sourceAgentId?: string;
}
