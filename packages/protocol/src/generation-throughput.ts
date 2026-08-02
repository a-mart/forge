import type { TokenAnalyticsAttributionFilter } from "./stats-types.js";

export type GenerationOutcome =
  | "completed"
  | "length"
  | "tool_use"
  | "aborted"
  | "error"
  | "unknown";

export type GenerationTokenSource =
  | "provider_final"
  | "estimated_local"
  | "unavailable";

export type GenerationBoundarySource =
  | "content_delta_to_stream_end"
  | "response_stream_proxy"
  | "unavailable";

/** The only denominator accepted for response-throughput measurements. */
export type ResponseThroughputDurationBasis = "request_wall_monotonic";

export type GenerationReasoningBoundaryCoverage =
  | "observed"
  | "hidden_or_unobserved"
  | "not_reported";

/**
 * A measurement spans one Pi Agent `streamFn` invocation. Pi's agent-level
 * retries invoke that seam again and therefore receive independent lifecycles.
 */
export type GenerationMeasurementScope = "agent_model_call";

/**
 * The narrower provider activity that Forge can count inside a model call.
 * `openai_codex_websocket_request` counts sent `response.create` frames only;
 * it does not imply timing boundaries for each frame or cover SSE/SDK retries.
 */
export type GenerationProviderAttemptScope =
  | "openai_codex_websocket_request"
  | "unavailable";

export interface GenerationMeasurementAttempt {
  measurementScope: GenerationMeasurementScope;
  /** Zero for the initial agent call, positive for a Pi agent-level retry. */
  agentRetryAttempt: number | null;
  providerAttemptScope: GenerationProviderAttemptScope;
  /** Count within providerAttemptScope; never a claim about all physical attempts. */
  observedProviderAttemptCount: number | null;
}

/** Facts used to qualify a recorded provider generation without exposing content. */
export interface GenerationMeasurementQuality extends GenerationMeasurementAttempt {
  tokenSource: GenerationTokenSource;
  boundarySource: GenerationBoundarySource;
  reasoningBoundaryCoverage: GenerationReasoningBoundaryCoverage;
}

/**
 * Compact Pi generation lifecycle record persisted in a session JSONL custom entry.
 * The schema intentionally has no runtime discriminator: Pi is the only supported
 * producer in v1, and consumers must not infer support for other runtimes.
 */
export interface GenerationMeasurementRecordV1 {
  version: 1;
  measurementId: string;
  recordState: "started" | "terminal";
  recordSequence: 1 | 2;

  startedAt: string;
  completedAt: string | null;

  identity: {
    profileId: string;
    sessionId: string;
    agentId: string;
    managerId: string;
    role: "manager" | "worker";
    specialistId: string | null;
    specialistAttributionKnown: boolean | null;
  };

  model: {
    provider: string;
    requestedModelId: string;
    responseModelId: string | null;
    api: string | null;
    reasoningLevel: string | null;
  };

  correlation: {
    turnId: string | null;
  };

  /** Added additively in v1; absent historical records use conservative unknown-attempt defaults. */
  attempt?: GenerationMeasurementAttempt;

  timing: {
    responseStreamStartedAt: string | null;
    firstOutputAt: string | null;
    lastOutputAt: string | null;
    /** Complete monotonic request-start → terminal duration; the response-throughput denominator. */
    requestWallMs: number | null;
    /** Additive marker. Absent records are re-derived from requestWallMs, never stored TPS. */
    responseThroughputDurationBasis?: ResponseThroughputDurationBasis;
    timeToFirstOutputMs: number | null;
    responseStreamOpenMs: number | null;
    /** @deprecated Diagnostic former generation-tail duration (first output → terminal), never a TPS denominator. */
    generationDurationMs: number | null;
    /** Diagnostic first-output → last-output span. */
    interOutputSpanMs: number | null;
    boundarySource: GenerationBoundarySource;
  };

  usage: {
    outputTokens: number | null;
    reasoningTokens: number | null;
    tokenSource: GenerationTokenSource;
  };

  outcome: GenerationOutcome;
  reasoningBoundaryCoverage: GenerationReasoningBoundaryCoverage;
  /**
   * Legacy records may contain a local character-based estimate. New producers
   * never write it: provider-final output usage is the sole TPS authority.
   */
  estimator?: {
    method: "characters_div_4_v1";
    estimatedOutputTokens: number;
  };
}

export interface GenerationThroughputLiveMeasurement {
  measurementId: string;
  sequence: number;
  phase: "starting" | "generating" | "completed" | "aborted";
  profileId: string;
  sessionId: string;
  agentId: string;
  managerId: string;
  role: "manager" | "worker";
  provider: string;
  modelId: string;
  sampledAt: string;
  /** Additive lifecycle diagnostics. Current senders populate these without output content. */
  requestStartedAt?: string;
  completedAt?: string | null;
  firstOutputAt: string | null;
  lastOutputAt?: string | null;
  /** Additive terminal/live detail for the header popover; absent from older senders. */
  timeToFirstOutputMs?: number | null;
  /** Complete request-start → sampled/terminal monotonic duration. */
  responseDurationMs?: number | null;
  responseThroughputDurationBasis?: ResponseThroughputDurationBasis;
  /** Diagnostic first-output → last-output span. */
  outputSpanMs?: number | null;
  /** Diagnostic former generation-tail duration (first output → sampled/terminal). */
  generationTailDurationMs?: number | null;
  /** @deprecated Use responseDurationMs for the primary metric; this remains an output-tail diagnostic. */
  elapsedGenerationMs: number | null;
  /** Null until provider-final output usage is available. */
  outputTokens: number | null;
  /** @deprecated Live estimates are no longer produced; this is always null from current producers. */
  instantaneousTokensPerSecond: number | null;
  /** Primary provider-final output tokens / complete request-start → terminal duration. */
  responseThroughputTokensPerSecond?: number | null;
  /** @deprecated Use responseThroughputTokensPerSecond. Current producers mirror the corrected value for compatibility. */
  generationAverageTokensPerSecond: number | null;
  /** `estimated` remains readable for older senders but current producers never emit it. */
  valueKind: "estimated" | "provider_final" | "unavailable";
  quality: GenerationMeasurementQuality;
}

export interface GenerationThroughputSessionSummary {
  sessionAgentId: string;
  window: "last_20_terminal_generations";
  measuredGenerationCount: number;
  /** Primary weighted provider output / complete request duration. */
  weightedResponseTokensPerSecond?: number | null;
  /** @deprecated Use weightedResponseTokensPerSecond. Current producers mirror the corrected value. */
  weightedTokensPerSecond: number | null;
  samples: Array<{
    completedAt: string;
    role: "manager" | "worker";
    responseTokensPerSecond?: number;
    /** @deprecated Use responseTokensPerSecond. Current producers mirror the corrected value. */
    tokensPerSecond: number;
  }>;
}

export interface GenerationThroughputEvent {
  type: "generation_throughput";
  measurement: GenerationThroughputLiveMeasurement;
  sessionSummary?: GenerationThroughputSessionSummary;
}

export interface GenerationThroughputSnapshotEvent {
  type: "generation_throughput_snapshot";
  sessionAgentId: string;
  measurements: GenerationThroughputLiveMeasurement[];
  sessionSummary: GenerationThroughputSessionSummary;
}

export type GenerationRoleFilter = "all" | "manager" | "worker";
export type GenerationQualityFilter = "strict" | "all_measured" | "all";
export type GenerationThroughputRangePreset = "7d" | "30d" | "all" | "custom";

export interface GenerationThroughputQuery {
  rangePreset: GenerationThroughputRangePreset;
  startDate?: string;
  endDate?: string;
  timezone?: string | null;
  profileId?: string;
  role?: GenerationRoleFilter;
  provider?: string;
  modelId?: string;
  quality?: GenerationQualityFilter;
  attribution?: TokenAnalyticsAttributionFilter;
  specialistId?: string;
}

export interface GenerationThroughputResolvedQuery {
  rangePreset: GenerationThroughputRangePreset;
  startDate: string | null;
  endDate: string | null;
  timezone: string;
  profileId: string | null;
  role: GenerationRoleFilter;
  provider: string | null;
  modelId: string | null;
  quality: GenerationQualityFilter;
  attribution: TokenAnalyticsAttributionFilter;
  specialistId: string | null;
}

export interface GenerationThroughputMetrics {
  allCallCount: number;
  terminalCallCount: number;
  measuredCallCount: number;
  incompleteCallCount: number;
  outputTokens: number;
  /** Sum of complete monotonic request-start → terminal durations for measured calls. */
  responseDurationMs?: number;
  /** @deprecated Sum of former first-output → terminal diagnostics, not a TPS denominator. */
  generationDurationMs: number;
  weightedResponseTokensPerSecond?: number | null;
  p50ResponseTokensPerSecond?: number | null;
  p90ResponseTokensPerSecond?: number | null;
  /** @deprecated Use weightedResponseTokensPerSecond. Current producers mirror the corrected value. */
  weightedTokensPerSecond: number | null;
  /** @deprecated Use p50ResponseTokensPerSecond. Current producers mirror the corrected value. */
  p50TokensPerSecond: number | null;
  /** @deprecated Use p90ResponseTokensPerSecond. Current producers mirror the corrected value. */
  p90TokensPerSecond: number | null;
  p50TimeToFirstOutputMs: number | null;
  coverage: number;
  timeToFirstOutputCoverage: number;
  hiddenReasoningBoundaryCallCount: number;
}

export interface GenerationThroughputRoleSummary extends GenerationThroughputMetrics {
  role: "manager" | "worker";
}

export interface GenerationThroughputModelSummary extends GenerationThroughputMetrics {
  provider: string;
  modelId: string;
  displayName: string;
  truncated?: boolean;
}

export interface GenerationThroughputTrendBucket extends GenerationThroughputMetrics {
  date: string;
  dateLabel: string;
}

export interface GenerationThroughputModelTrend {
  provider: string;
  modelId: string;
  displayName: string;
  points: GenerationThroughputTrendBucket[];
}

export interface GenerationThroughputFilterProfile {
  profileId: string;
  displayName: string;
  callCount: number;
}

export interface GenerationThroughputFilterProvider {
  provider: string;
  callCount: number;
}

export interface GenerationThroughputFilterModel {
  provider: string;
  modelId: string;
  displayName: string;
  callCount: number;
}

export interface GenerationThroughputFilterSpecialist {
  specialistId: string;
  displayName: string;
  color: string | null;
  callCount: number;
}

export interface GenerationThroughputAvailableFilters {
  profiles: GenerationThroughputFilterProfile[];
  providers: GenerationThroughputFilterProvider[];
  models: GenerationThroughputFilterModel[];
  specialists: GenerationThroughputFilterSpecialist[];
}

export interface GenerationThroughputDiagnostics {
  malformedRecordCount: number;
  duplicateRecordCount: number;
  conflictRecordCount: number;
  startOnlyCallCount: number;
  /** Started records in the selected scope that have no terminal lifecycle record. */
  incompleteCallCount: number;
}

export interface GenerationThroughputSnapshot {
  computedAt: string;
  query: GenerationThroughputResolvedQuery;
  availableFilters: GenerationThroughputAvailableFilters;
  totals: GenerationThroughputMetrics;
  byRole: GenerationThroughputRoleSummary[];
  models: GenerationThroughputModelSummary[];
  modelTableTruncated: boolean;
  trends: GenerationThroughputModelTrend[];
  diagnostics: GenerationThroughputDiagnostics;
}

export interface GenerationThroughputCallsQuery extends GenerationThroughputQuery {
  limit?: number;
  cursor?: string;
}

export interface GenerationThroughputCall {
  measurementId: string;
  completedAt: string | null;
  profileId: string;
  profileDisplayName: string;
  sessionId: string;
  sessionLabel: string;
  agentId: string;
  managerId: string;
  role: "manager" | "worker";
  specialistId: string | null;
  specialistDisplayName: string | null;
  attribution: TokenAnalyticsAttributionFilter;
  provider: string;
  requestedModelId: string;
  responseModelId: string | null;
  modelId: string;
  /** Count-only lifecycle diagnostics retained for auditability without response content. */
  requestStartedAt?: string;
  firstOutputAt?: string | null;
  lastOutputAt?: string | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Complete request-start → terminal duration used for response throughput. */
  responseDurationMs?: number | null;
  responseThroughputDurationBasis?: ResponseThroughputDurationBasis;
  /** Diagnostic former first-output → terminal duration. */
  generationDurationMs: number | null;
  /** Diagnostic first-output → last-output span. */
  outputSpanMs?: number | null;
  timeToFirstOutputMs: number | null;
  responseTokensPerSecond?: number | null;
  /** @deprecated Use responseTokensPerSecond. Current producers mirror the corrected value. */
  tokensPerSecond: number | null;
  outcome: GenerationOutcome;
  quality: GenerationMeasurementQuality;
}

export interface GenerationThroughputCallsPage {
  computedAt: string;
  query: GenerationThroughputResolvedQuery;
  totalCount: number;
  nextCursor: string | null;
  items: GenerationThroughputCall[];
}
