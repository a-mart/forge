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

export type GenerationReasoningBoundaryCoverage =
  | "observed"
  | "hidden_or_unobserved"
  | "not_reported";

/** Facts used to qualify a recorded provider generation without exposing content. */
export interface GenerationMeasurementQuality {
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

  timing: {
    responseStreamStartedAt: string | null;
    firstOutputAt: string | null;
    lastOutputAt: string | null;
    requestWallMs: number | null;
    timeToFirstOutputMs: number | null;
    responseStreamOpenMs: number | null;
    generationDurationMs: number | null;
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
  firstOutputAt: string | null;
  elapsedGenerationMs: number | null;
  outputTokens: number | null;
  instantaneousTokensPerSecond: number | null;
  generationAverageTokensPerSecond: number | null;
  valueKind: "estimated" | "provider_final" | "unavailable";
  quality: GenerationMeasurementQuality;
}

export interface GenerationThroughputSessionSummary {
  sessionAgentId: string;
  window: "last_20_terminal_generations";
  measuredGenerationCount: number;
  weightedTokensPerSecond: number | null;
  samples: Array<{
    completedAt: string;
    role: "manager" | "worker";
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
  generationDurationMs: number;
  weightedTokensPerSecond: number | null;
  p50TokensPerSecond: number | null;
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
  outputTokens: number | null;
  reasoningTokens: number | null;
  generationDurationMs: number | null;
  timeToFirstOutputMs: number | null;
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
