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
