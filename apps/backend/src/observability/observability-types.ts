import type {
  FeedbackSubmitEvent,
  PhoenixObservabilitySettings,
  PhoenixObservabilitySettingsPatch,
  PhoenixObservabilityStatus,
  PhoenixObservabilityTestResponse,
} from "@forge/protocol";
import type { RuntimeSessionEvent } from "../swarm/runtime-contracts.js";

export interface ObservabilityFacade {
  initialize(): Promise<void>;
  getSettings(): Promise<PhoenixObservabilitySettings>;
  updateSettings(patch: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilitySettings>;
  getStatus(): PhoenixObservabilityStatus;
  testConnection(patch?: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilityTestResponse>;
  recordPromptResolved(input: ObservabilityPromptResolvedInput): void;
  recordRuntimeCreated(input: ObservabilityRuntimeCreatedInput): void;
  beginRuntimeInput(input: ObservabilityRuntimeInputInput): ObservabilityRuntimeInputHandle | undefined;
  completeRuntimeInput(handle: ObservabilityRuntimeInputHandle | undefined, patch: ObservabilityRuntimeInputCompletion): void;
  cancelRuntimeInput(handle: ObservabilityRuntimeInputHandle | undefined, reason: string): void;
  recordRuntimeInput(input: ObservabilityRuntimeInputInput): string | undefined;
  recordRuntimeSessionEvent(input: ObservabilityRuntimeSessionEventInput): void;
  recordRuntimeError(input: ObservabilityRuntimeErrorInput): void;
  recordToolSideEffect(input: ObservabilityToolSideEffectInput): void;
  recordAgentDelivery(input: ObservabilityAgentDeliveryInput): void;
  recordFeedback(event: FeedbackSubmitEvent): void;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

export interface ObservabilityPromptResolvedInput {
  agentId: string;
  managerId?: string;
  profileId?: string;
  role?: string;
  runtimeType: ObservabilityRuntimeType;
  runtimeToken: number;
  source: "forge_resolved" | "runtime_final" | "startup_recovery";
  prompt: string;
  cwd?: string;
  modelProvider?: string;
  modelId?: string;
  agentName?: string;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityRuntimeCreatedInput {
  agentId: string;
  managerId?: string;
  profileId?: string;
  role?: string;
  runtimeType: ObservabilityRuntimeType;
  runtimeToken: number;
  status: "ready" | "failed" | "superseded";
  cwd?: string;
  modelProvider?: string;
  modelId?: string;
  reasoningLevel?: string;
  archetypeId?: string;
  agentName?: string;
  finalSystemPrompt?: string;
  startupSystemPromptOverride?: string;
  activeTools?: ObservabilityToolDefinition[];
  mcpServers?: string[];
  metadata?: Record<string, unknown>;
}

export interface ObservabilityToolDefinition {
  name: string;
  description?: string;
  jsonSchema?: unknown;
  source?: string;
}

export type ObservabilityRootSource =
  | "user_input"
  | "project_agent"
  | "bootstrap"
  | "agent_creator_bootstrap"
  | "codex_plugin_bootstrap"
  | "cortex"
  | "internal_self_send"
  | "internal_agent_message"
  | "collaboration_excluded"
  | "internal_other";

export interface ObservabilityRuntimeInputHandle {
  rootTurnId: string;
  targetAgentId: string;
  runtimeToken?: number;
}

export interface ObservabilityRuntimeInputCompletion {
  acceptedMode?: string;
  deliveryId?: string;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityRuntimeInputInput {
  targetAgentId: string;
  managerId?: string;
  profileId?: string;
  role?: string;
  runtimeType?: ObservabilityRuntimeType;
  runtimeToken?: number;
  rootSource: ObservabilityRootSource;
  originalInput?: unknown;
  runtimeInput: unknown;
  rootTurnId?: string;
  parentRootTurnId?: string;
  requestPayloadFidelity?: "full" | "partial" | "delta_only" | "unavailable";
  visibleMessageId?: string;
  requestedDelivery?: string;
  acceptedMode?: string;
  sourceChannel?: string;
  agentName?: string;
  activeTools?: ObservabilityToolDefinition[];
  metadata?: Record<string, unknown>;
}

export interface ObservabilityRuntimeSessionEventInput {
  agentId: string;
  managerId?: string;
  profileId?: string;
  role?: string;
  runtimeType?: ObservabilityRuntimeType;
  runtimeToken?: number;
  agentName?: string;
  event: RuntimeSessionEvent;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityRuntimeErrorInput {
  agentId: string;
  managerId?: string;
  profileId?: string;
  role?: string;
  runtimeType?: ObservabilityRuntimeType;
  runtimeToken?: number;
  agentName?: string;
  phase: string;
  message: string;
  stack?: string;
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityToolSideEffectInput {
  agentId: string;
  managerId?: string;
  profileId?: string;
  role?: string;
  runtimeType?: ObservabilityRuntimeType;
  runtimeToken?: number;
  agentName?: string;
  toolName: string;
  toolCallId: string;
  phase: "before" | "after" | "side_effect";
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  userVisible?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityAgentDeliveryInput {
  fromAgentId: string;
  targetAgentId: string;
  managerId?: string;
  profileId?: string;
  sourceAgentName?: string;
  targetAgentName?: string;
  rootTurnId?: string;
  parentRootTurnId?: string;
  message?: unknown;
  runtimeInput?: unknown;
  requestedDelivery?: string;
  acceptedMode?: string;
  deliveryId?: string;
  source?: "agent_message" | "project_agent" | "internal" | "tool_side_effect";
  parentTool?: {
    agentId: string;
    runtimeToken?: number;
    toolCallId: string;
    toolName?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface ObservabilityRecordFeedbackInput {
  event: FeedbackSubmitEvent;
}

export type ObservabilityRuntimeTarget = PhoenixObservabilityStatus["runtimeTarget"];
export type ObservabilityRuntimeType = "pi" | "claude-sdk" | "cursor-sdk";
