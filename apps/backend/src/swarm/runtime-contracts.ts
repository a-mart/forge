import type {
  GenerationMeasurementScope,
  GenerationOutcome,
  GenerationProviderAttemptScope,
} from "@forge/protocol";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "./types.js";
import type { SecureRuntimeBinding } from "./secure-sessions/runtime/secure-runtime-binding.js";

export interface RuntimeImageAttachment {
  mimeType: string;
  data: string;
}

export interface RuntimeUserMessage {
  text: string;
  images?: RuntimeImageAttachment[];
}

export type RuntimeUserMessageInput = string | RuntimeUserMessage;

export interface RuntimeSessionMessage {
  role: "user" | "assistant" | "system";
  content: unknown;
}

export interface RuntimeTokenUsageMeta {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
}

export interface RuntimeCostUsdMeta {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

export type RuntimeRequestPayloadFidelity = "full" | "partial" | "delta_only" | "unavailable";

export interface RuntimeModelCallMeta {
  usage?: RuntimeTokenUsageMeta;
  costUsd?: RuntimeCostUsdMeta;
  modelId?: string;
  responseModelId?: string;
  provider?: string;
  api?: string;
  stopReason?: string;
  providerRequestId?: string;
  durationMs?: number;
  requestPayloadFidelity?: RuntimeRequestPayloadFidelity;
  requestMessages?: unknown;
  invocationParameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTurnMeta extends RuntimeModelCallMeta {
  durationApiMs?: number;
  providerSessionId?: string;
  outcome?: string;
}

/**
 * Content-safe subset of a model call. Generation lifecycle callbacks must
 * never carry prompt messages, tool arguments, invocation parameters, or
 * provider metadata because they cross the durable telemetry boundary.
 */
export type RuntimeGenerationCallMeta = Pick<
  RuntimeModelCallMeta,
  "usage" | "modelId" | "responseModelId" | "provider" | "api" | "stopReason" | "durationMs"
>;

/**
 * Count-only provider-generation lifecycle signal. This is intentionally
 * runtime-neutral so recording does not depend on conversation projection;
 * Pi is the sole producer in the initial implementation.
 */
export type RuntimeGenerationEvent =
  | {
      phase: "request_started";
      measurementId: string;
      wallTimeMs: number;
      monotonicTimeMs: number;
      requestedProvider: string;
      requestedModelId: string;
      reasoningLevel: string | null;
      measurementScope: GenerationMeasurementScope;
      agentRetryAttempt: number;
      providerAttemptScope: GenerationProviderAttemptScope;
    }
  | {
      phase: "response_stream_started";
      measurementId: string;
      wallTimeMs: number;
      monotonicTimeMs: number;
    }
  | {
      phase: "output_delta";
      measurementId: string;
      wallTimeMs: number;
      monotonicTimeMs: number;
      deltaKind: "text" | "thinking" | "tool_call";
      deltaUtf16CodeUnits: number;
      deltaUtf8Bytes: number;
      partialOutputTokens?: number;
    }
  | {
      phase: "completed";
      measurementId: string;
      wallTimeMs: number;
      monotonicTimeMs: number;
      outcome: GenerationOutcome;
      /** Count is scoped by the matching request_started event, not all physical provider attempts. */
      observedProviderAttemptCount: number | null;
      meta?: RuntimeGenerationCallMeta;
    };

export interface SpecialistFallbackReplaySnapshot {
  messages: RuntimeUserMessage[];
}

export interface RuntimeStartupRecoveryContext {
  reason: "model_change";
  blockText: string;
  requestId?: string;
}

export interface RuntimeCodexTransportDebugStats {
  requests: number;
  connectionsCreated: number;
  connectionsReused: number;
  cachedContextRequests: number;
  storeTrueRequests: number;
  fullContextRequests: number;
  deltaRequests: number;
  lastInputItems: number;
  lastDeltaInputItems?: number;
}

export interface RuntimeCodexTransportDebugDiagnostics {
  transport?: string;
  modelProvider?: string;
  modelApi?: string;
  piSessionIdPresent: boolean;
  websocketStatsStatus: "not_applicable" | "no_session" | "no_stats" | "available" | "error";
  directPiSessionStatsStatus: "not_implemented" | "no_session" | "no_stats" | "available" | "error";
  websocketStats?: RuntimeCodexTransportDebugStats;
}

export interface RuntimeAcquisitionRequirements {
  /** The returned runtime must be backed by the current Secure Session. */
  secureRuntimeRequired?: boolean;
}

export interface RuntimeCreationOptions {
  startupRecoveryContext?: RuntimeStartupRecoveryContext;
  /** Invoked after startup recovery context is committed on the first accepted prompt dispatch. */
  onStartupRecoveryConsumed?: () => void | Promise<void>;
  /** Fail closed unless this runtime is backed by the current Secure Session. */
  secureRuntimeRequired?: boolean;
  /**
   * Backend-process-only capability resolved by RuntimeFactory. It must never
   * be copied into runtime descriptors, protocol records, or session history.
   */
  secureRuntimeBinding?: SecureRuntimeBinding;
}

export type RuntimeSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end"; toolResults: unknown[]; meta?: RuntimeTurnMeta }
  | { type: "message_start"; message: RuntimeSessionMessage }
  | { type: "message_update"; message: RuntimeSessionMessage }
  | { type: "message_end"; message: RuntimeSessionMessage; meta?: RuntimeModelCallMeta }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolName: string;
      toolCallId: string;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolName: string;
      toolCallId: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "auto_compaction_start";
      reason: "threshold" | "overflow";
    }
  | {
      type: "auto_compaction_end";
      result: unknown;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    };

export interface RuntimeErrorEvent {
  phase:
    | "prompt_dispatch"
    | "prompt_start"
    | "steer_delivery"
    | "compaction"
    | "context_guard"
    | "extension"
    | "interrupt"
    | "thread_resume"
    | "startup"
    | "runtime_exit"
    | "silent_turn";
  message: string;
  stack?: string;
  details?: Record<string, unknown>;
}

export interface SwarmRuntimeCallbacks {
  onStatusChange: (
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ) => void | Promise<void>;
  onSessionEvent?: (agentId: string, event: RuntimeSessionEvent) => void | Promise<void>;
  onAgentEnd?: (agentId: string) => void | Promise<void>;
  onRuntimeError?: (agentId: string, error: RuntimeErrorEvent) => void | Promise<void>;
  /** Count-only per-provider-generation lifecycle; not a conversation event. */
  onGenerationEvent?: (agentId: string, event: RuntimeGenerationEvent) => void | Promise<void>;
  /**
   * Epoch-ms of the last user-facing manager output actually PROJECTED to the
   * conversation (assistant text on any cycle, a choices prompt, a backstop
   * delivery) — ground truth from the runtime event projector.  Runtimes must
   * consult this before treating a run as silent/hidden: the projector, not a
   * runtime-side text-marker policy, decides what the user saw.  Undefined when
   * nothing user-facing has been projected for the agent yet.
   */
  getLastUserFacingManagerOutputAt?: (agentId: string) => number | undefined;
}

export type SmartCompactResult =
  | {
      /** Whether the smart-compaction flow actually reduced context by calling compact(). */
      compacted: true;
    }
  | {
      /** Whether smart compaction was skipped or finished without reducing context. */
      compacted: false;
      /** Machine-readable or human-readable reason why no compaction occurred. */
      reason: string;
    };

export interface SmartCompactOptions {
  resumeAfterCompaction?: boolean;
  skipResumeIfIdle?: boolean;
}

export interface RuntimeShutdownOptions {
  abort?: boolean;
  shutdownTimeoutMs?: number;
  drainTimeoutMs?: number;
}

export interface SetPinnedContentOptions {
  suppressRecycle?: boolean;
}

export interface SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;
  readonly runtimeType?: "pi" | "cursor-sdk";

  getStatus(): AgentStatus;
  getPendingCount(): number;
  getContextUsage(): AgentContextUsage | undefined;
  getSystemPrompt?(): string;
  getCodexTransportDebugDiagnostics?(): RuntimeCodexTransportDebugDiagnostics;
  /** True while accepted input is not yet represented by pending-count or status state. */
  hasPendingInputDispatch?(): boolean;
  setPinnedContent?(content: string | undefined, options?: SetPinnedContentOptions): void | Promise<void>;
  isContextRecoveryInProgress?(): boolean;
  isContextRecoveryActive?(): boolean;
  prepareForSpecialistFallbackReplay?(): Promise<SpecialistFallbackReplaySnapshot | undefined>;
  restorePreparedSpecialistFallbackReplay?(): Promise<void>;

  sendMessage(
    input: RuntimeUserMessageInput,
    requestedMode?: RequestedDeliveryMode
  ): Promise<SendMessageReceipt>;

  compact(customInstructions?: string): Promise<unknown>;

  smartCompact(customInstructions?: string, options?: SmartCompactOptions): Promise<SmartCompactResult>;

  stopInFlight(options?: RuntimeShutdownOptions): Promise<void>;

  terminate(options?: RuntimeShutdownOptions): Promise<void>;

  shutdownForReplacement(options?: RuntimeShutdownOptions): Promise<void>;

  recycle(): Promise<void>;

  getCustomEntries(customType: string): unknown[];
  appendCustomEntry(customType: string, data?: unknown): string;
}
