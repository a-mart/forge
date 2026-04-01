import {
  MANAGER_MODEL_PRESETS,
  type AgentCreatorResult,
  type ChoiceRequestEvent,
  type ManagerProfile,
  type ProjectAgentInfo,
  type ProjectAgentMessageContext,
} from "@forge/protocol";
import type { AgentStatus } from "./agent-state-machine.js";

export type AgentRole = "manager" | "worker";

export type AgentArchetypeId = string;

export type { AgentStatus };
export type { ManagerProfile };
export type { ProjectAgentMessageContext };
export type {
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceRequestEvent,
  ChoiceRequestStatus,
} from "@forge/protocol";

export const SWARM_MODEL_PRESETS = MANAGER_MODEL_PRESETS;

export type SwarmModelPreset = string;

export const SWARM_REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh"] as const;

export type SwarmReasoningLevel = (typeof SWARM_REASONING_LEVELS)[number];

export interface AgentModelDescriptor {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface AgentContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export type AgentSessionPurpose = "cortex_review" | "agent_creator";

export interface AgentDescriptor {
  agentId: string;
  displayName: string;
  role: AgentRole;
  managerId: string;
  archetypeId?: AgentArchetypeId;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: AgentModelDescriptor;
  sessionFile: string;
  contextUsage?: AgentContextUsage;
  profileId?: string;
  sessionLabel?: string;
  sessionPurpose?: AgentSessionPurpose;
  pinnedAt?: string;
  mergedAt?: string;
  compactionCount?: number;
  workerCount?: number;
  activeWorkerCount?: number;
  streamingStartedAt?: number;
  pendingChoiceCount?: number;
  specialistId?: string;
  specialistDisplayName?: string;
  specialistColor?: string;
  projectAgent?: ProjectAgentInfo;
  agentCreatorResult?: AgentCreatorResult;
  webSearch?: boolean;
}

export interface AgentsStoreFile {
  agents: AgentDescriptor[];
  profiles?: ManagerProfile[];
}

export type RequestedDeliveryMode = "auto" | "followUp" | "steer";

export type AcceptedDeliveryMode = "prompt" | "followUp" | "steer";

export type MessageChannel = "web" | "telegram";

export interface MessageSourceContext {
  channel: MessageChannel;
  channelId?: string;
  userId?: string;
  messageId?: string;
  threadTs?: string;
  integrationProfileId?: string;
  channelType?: "dm" | "channel" | "group" | "mpim";
  teamId?: string;
}

export type MessageTargetContext = Pick<
  MessageSourceContext,
  "channel" | "channelId" | "userId" | "threadTs" | "integrationProfileId"
>;

export interface SendMessageReceipt {
  targetAgentId: string;
  deliveryId: string;
  acceptedMode: AcceptedDeliveryMode;
}

export interface SpawnAgentInput {
  agentId: string;
  specialist?: string;
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
  sharedAuthDir: string;
  sharedAuthFile: string;
  sharedSecretsFile: string;
  sharedIntegrationsDir: string;

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

export interface SkillEnvRequirement {
  name: string;
  description?: string;
  required: boolean;
  helpUrl?: string;
  skillName: string;
  isSet: boolean;
  maskedValue?: string;
}

export type SettingsAuthProviderName = "anthropic" | "openai-codex" | "xai";

export interface SettingsAuthProvider {
  provider: SettingsAuthProviderName;
  configured: boolean;
  authType?: "api_key" | "oauth" | "unknown";
  maskedValue?: string;
}

export interface SwarmConfig {
  host: string;
  port: number;
  debug: boolean;
  isDesktop: boolean;
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

export interface ConversationMessageEvent {
  type: "conversation_message";
  agentId: string;
  id?: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ConversationMessageAttachment[];
  timestamp: string;
  source: "user_input" | "speak_to_user" | "system" | "project_agent_input";
  sourceContext?: MessageSourceContext;
  projectAgentContext?: ProjectAgentMessageContext;
  pinned?: boolean;
}

export type ConversationLogKind =
  | "message_start"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end";

export interface ConversationLogEvent {
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

export interface AgentMessageEvent {
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
}

export type AgentToolCallKind = Extract<
  ConversationLogKind,
  "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
>;

export interface AgentToolCallEvent {
  type: "agent_tool_call";
  agentId: string;
  actorAgentId: string;
  timestamp: string;
  kind: AgentToolCallKind;
  toolName?: string;
  toolCallId?: string;
  text: string;
  isError?: boolean;
}

export type ConversationEntryEvent =
  | ConversationMessageEvent
  | ConversationLogEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | ChoiceRequestEvent;

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

export interface AgentsSnapshotEvent {
  type: "agents_snapshot";
  agents: AgentDescriptor[];
}

export interface SessionWorkersSnapshotEvent {
  type: "session_workers_snapshot";
  sessionAgentId: string;
  workers: AgentDescriptor[];
  requestId?: string;
}

export interface SessionLifecycleEvent {
  action: "created" | "deleted" | "renamed" | "forked";
  sessionAgentId: string;
  profileId: string;
  label?: string;
  sourceAgentId?: string;
}
