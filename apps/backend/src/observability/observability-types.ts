import type {
  FeedbackSubmitEvent,
  PhoenixObservabilitySettings,
  PhoenixObservabilitySettingsPatch,
  PhoenixObservabilityStatus,
  PhoenixObservabilityTestResponse,
} from "@forge/protocol";

export interface ObservabilityFacade {
  initialize(): Promise<void>;
  getSettings(): Promise<PhoenixObservabilitySettings>;
  updateSettings(patch: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilitySettings>;
  getStatus(): PhoenixObservabilityStatus;
  testConnection(patch?: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilityTestResponse>;
  recordPromptResolved(input: ObservabilityPromptResolvedInput): void;
  recordRuntimeCreated(input: ObservabilityRuntimeCreatedInput): void;
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

export interface ObservabilityRecordFeedbackInput {
  event: FeedbackSubmitEvent;
}

export type ObservabilityRuntimeTarget = PhoenixObservabilityStatus["runtimeTarget"];
export type ObservabilityRuntimeType = "pi" | "claude-sdk" | "cursor-sdk";
