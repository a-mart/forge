import type {
  GenerationBoundarySource,
  GenerationMeasurementAttempt,
  GenerationMeasurementRecordV1,
  GenerationOutcome,
  GenerationReasoningBoundaryCoverage,
  GenerationTokenSource,
  ResponseThroughputDurationBasis,
} from "@forge/protocol";

export const GENERATION_MEASUREMENT_ENTRY_TYPE = "swarm_generation_measurement";

const OUTCOMES = new Set<GenerationOutcome>([
  "completed",
  "length",
  "tool_use",
  "aborted",
  "error",
  "unknown",
]);
const TOKEN_SOURCES = new Set<GenerationTokenSource>([
  "provider_final",
  "estimated_local",
  "unavailable",
]);
const BOUNDARY_SOURCES = new Set<GenerationBoundarySource>([
  "content_delta_to_stream_end",
  "response_stream_proxy",
  "unavailable",
]);
const REASONING_BOUNDARY_COVERAGE = new Set<GenerationReasoningBoundaryCoverage>([
  "observed",
  "hidden_or_unobserved",
  "not_reported",
]);
const RESPONSE_THROUGHPUT_DURATION_BASES = new Set<ResponseThroughputDurationBasis>([
  "request_wall_monotonic",
]);

export interface GenerationMeasurementRecordSource {
  record: GenerationMeasurementRecordV1;
  sourcePath: string;
  byteOffset: number;
}

export interface GenerationMeasurementFoldDiagnostics {
  duplicateCount: number;
  conflictCount: number;
}

/**
 * Validates a complete JSONL custom wrapper and returns only the compact,
 * count-only generation lifecycle payload. Invalid records are deliberately
 * ignored by analytics callers rather than poisoning the full scan.
 */
export function parseGenerationMeasurementCustomEntry(entry: unknown): GenerationMeasurementRecordV1 | null {
  const wrapper = readObject(entry);
  if (
    !wrapper ||
    wrapper.type !== "custom" ||
    wrapper.customType !== GENERATION_MEASUREMENT_ENTRY_TYPE
  ) {
    return null;
  }

  const data = readObject(wrapper.data);
  if (!data || data.version !== 1) {
    return null;
  }

  const measurementId = readNonEmptyString(data.measurementId);
  const recordState = data.recordState;
  const recordSequence = data.recordSequence;
  const startedAt = readIsoTimestamp(data.startedAt);
  const completedAt = readNullableIsoTimestamp(data.completedAt);
  const identity = parseIdentity(data.identity);
  const model = parseModel(data.model);
  const correlation = parseCorrelation(data.correlation);
  const attempt = parseAttempt(data.attempt);
  const timing = parseTiming(data.timing);
  const usage = parseUsage(data.usage);
  const outcome = readOutcome(data.outcome);
  const reasoningBoundaryCoverage = readReasoningBoundaryCoverage(data.reasoningBoundaryCoverage);
  const estimator = parseEstimator(data.estimator);

  if (
    !measurementId ||
    (recordState !== "started" && recordState !== "terminal") ||
    (recordSequence !== 1 && recordSequence !== 2) ||
    !startedAt ||
    completedAt === undefined ||
    !identity ||
    !model ||
    !correlation ||
    attempt === null ||
    !timing ||
    !usage ||
    !outcome ||
    !reasoningBoundaryCoverage ||
    estimator === null
  ) {
    return null;
  }

  if (
    (recordState === "started" && (recordSequence !== 1 || completedAt !== null)) ||
    (recordState === "terminal" && (recordSequence !== 2 || completedAt === null))
  ) {
    return null;
  }

  return {
    version: 1,
    measurementId,
    recordState,
    recordSequence,
    startedAt,
    completedAt,
    identity,
    model,
    correlation,
    ...(attempt ? { attempt } : {}),
    timing,
    usage,
    outcome,
    reasoningBoundaryCoverage,
    ...(estimator ? { estimator } : {}),
  };
}

/**
 * Folds lifecycle copies across session and worker files. Terminal records win;
 * equal-sequence ties are deterministic so fork-copied records cannot double
 * count when the historical scanner is added.
 */
export function foldGenerationMeasurementRecords(
  sources: readonly GenerationMeasurementRecordSource[],
): { records: GenerationMeasurementRecordV1[]; diagnostics: GenerationMeasurementFoldDiagnostics } {
  const selectedByMeasurementId = new Map<string, GenerationMeasurementRecordSource>();
  let duplicateCount = 0;
  let conflictCount = 0;

  for (const source of sources) {
    const selected = selectedByMeasurementId.get(source.record.measurementId);
    if (!selected) {
      selectedByMeasurementId.set(source.record.measurementId, source);
      continue;
    }

    const comparison = compareLifecycleSources(source, selected);
    // A started record followed by its terminal record is the normal durable
    // lifecycle, not a copied duplicate or equal-sequence conflict.
    if (source.record.recordSequence === selected.record.recordSequence) {
      duplicateCount += 1;
      if (!areEquivalentLifecycleRecords(source.record, selected.record)) {
        conflictCount += 1;
      }
    }
    if (comparison > 0) selectedByMeasurementId.set(source.record.measurementId, source);
  }

  return {
    records: Array.from(selectedByMeasurementId.values())
      .sort((left, right) => left.record.measurementId.localeCompare(right.record.measurementId))
      .map((source) => source.record),
    diagnostics: { duplicateCount, conflictCount },
  };
}

function compareLifecycleSources(
  candidate: GenerationMeasurementRecordSource,
  selected: GenerationMeasurementRecordSource,
): number {
  if (candidate.record.recordSequence !== selected.record.recordSequence) {
    return candidate.record.recordSequence - selected.record.recordSequence;
  }

  if (candidate.sourcePath === selected.sourcePath) {
    return candidate.byteOffset - selected.byteOffset;
  }

  const completeness = terminalCompleteness(candidate.record) - terminalCompleteness(selected.record);
  if (completeness !== 0) {
    return completeness;
  }

  const pathComparison = candidate.sourcePath.localeCompare(selected.sourcePath);
  if (pathComparison !== 0) {
    return pathComparison;
  }
  return candidate.byteOffset - selected.byteOffset;
}

function terminalCompleteness(record: GenerationMeasurementRecordV1): number {
  if (record.recordState !== "terminal") {
    return 0;
  }

  return [
    record.completedAt,
    record.model.responseModelId,
    record.model.api,
    record.timing.responseStreamStartedAt,
    record.timing.firstOutputAt,
    record.timing.lastOutputAt,
    record.timing.generationDurationMs,
    record.usage.outputTokens,
    record.usage.reasoningTokens,
  ].filter((value) => value !== null).length;
}

function areEquivalentLifecycleRecords(
  left: GenerationMeasurementRecordV1,
  right: GenerationMeasurementRecordV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseIdentity(value: unknown): GenerationMeasurementRecordV1["identity"] | null {
  const object = readObject(value);
  const profileId = object && readNonEmptyString(object.profileId);
  const sessionId = object && readNonEmptyString(object.sessionId);
  const agentId = object && readNonEmptyString(object.agentId);
  const managerId = object && readNonEmptyString(object.managerId);
  const role = object?.role;
  const specialistId = object && readNullableString(object.specialistId);
  const specialistAttributionKnown = object && readNullableBoolean(object.specialistAttributionKnown);
  if (
    !profileId ||
    !sessionId ||
    !agentId ||
    !managerId ||
    (role !== "manager" && role !== "worker") ||
    specialistId === undefined ||
    specialistAttributionKnown === undefined
  ) {
    return null;
  }
  if (role === "manager" && (specialistId !== null || specialistAttributionKnown !== null)) {
    return null;
  }
  return { profileId, sessionId, agentId, managerId, role, specialistId, specialistAttributionKnown };
}

function parseModel(value: unknown): GenerationMeasurementRecordV1["model"] | null {
  const object = readObject(value);
  const provider = object && readNonEmptyString(object.provider);
  const requestedModelId = object && readNonEmptyString(object.requestedModelId);
  const responseModelId = object && readNullableString(object.responseModelId);
  const api = object && readNullableString(object.api);
  const reasoningLevel = object && readNullableString(object.reasoningLevel);
  if (!provider || !requestedModelId || responseModelId === undefined || api === undefined || reasoningLevel === undefined) {
    return null;
  }
  return { provider, requestedModelId, responseModelId, api, reasoningLevel };
}

function parseCorrelation(value: unknown): GenerationMeasurementRecordV1["correlation"] | null {
  const object = readObject(value);
  const turnId = object && readNullableString(object.turnId);
  return turnId === undefined ? null : { turnId };
}

function parseAttempt(value: unknown): GenerationMeasurementAttempt | undefined | null {
  if (value === undefined) return undefined;
  const object = readObject(value);
  if (!object || object.measurementScope !== "agent_model_call") return null;
  const agentRetryAttempt = readNullableNonNegativeInteger(object.agentRetryAttempt);
  const providerAttemptScope = object.providerAttemptScope;
  const observedProviderAttemptCount = readNullableNonNegativeInteger(object.observedProviderAttemptCount);
  if (
    agentRetryAttempt === undefined
    || (providerAttemptScope !== "openai_codex_websocket_request" && providerAttemptScope !== "unavailable")
    || observedProviderAttemptCount === undefined
    || (providerAttemptScope === "unavailable" && observedProviderAttemptCount !== null)
  ) {
    return null;
  }
  return {
    measurementScope: "agent_model_call",
    agentRetryAttempt,
    providerAttemptScope,
    observedProviderAttemptCount,
  };
}

function parseTiming(value: unknown): GenerationMeasurementRecordV1["timing"] | null {
  const object = readObject(value);
  if (!object) return null;
  const responseStreamStartedAt = readNullableIsoTimestamp(object.responseStreamStartedAt);
  const firstOutputAt = readNullableIsoTimestamp(object.firstOutputAt);
  const lastOutputAt = readNullableIsoTimestamp(object.lastOutputAt);
  const requestWallMs = readNullableNonNegativeFiniteNumber(object.requestWallMs);
  const responseThroughputDurationBasis = readOptionalResponseThroughputDurationBasis(object.responseThroughputDurationBasis);
  const timeToFirstOutputMs = readNullableNonNegativeFiniteNumber(object.timeToFirstOutputMs);
  const responseStreamOpenMs = readNullableNonNegativeFiniteNumber(object.responseStreamOpenMs);
  const generationDurationMs = readNullableNonNegativeFiniteNumber(object.generationDurationMs);
  const interOutputSpanMs = readNullableNonNegativeFiniteNumber(object.interOutputSpanMs);
  const boundarySource = readBoundarySource(object.boundarySource);
  if (
    responseStreamStartedAt === undefined ||
    firstOutputAt === undefined ||
    lastOutputAt === undefined ||
    requestWallMs === undefined ||
    responseThroughputDurationBasis === null ||
    timeToFirstOutputMs === undefined ||
    responseStreamOpenMs === undefined ||
    generationDurationMs === undefined ||
    interOutputSpanMs === undefined ||
    !boundarySource
  ) {
    return null;
  }
  return {
    responseStreamStartedAt,
    firstOutputAt,
    lastOutputAt,
    requestWallMs,
    ...(responseThroughputDurationBasis ? { responseThroughputDurationBasis } : {}),
    timeToFirstOutputMs,
    responseStreamOpenMs,
    generationDurationMs,
    interOutputSpanMs,
    boundarySource,
  };
}

function parseUsage(value: unknown): GenerationMeasurementRecordV1["usage"] | null {
  const object = readObject(value);
  if (!object) return null;
  const outputTokens = readNullableNonNegativeFiniteNumber(object.outputTokens);
  const reasoningTokens = readNullableNonNegativeFiniteNumber(object.reasoningTokens);
  const tokenSource = readTokenSource(object.tokenSource);
  if (outputTokens === undefined || reasoningTokens === undefined || !tokenSource) {
    return null;
  }
  return { outputTokens, reasoningTokens, tokenSource };
}

function parseEstimator(value: unknown): GenerationMeasurementRecordV1["estimator"] | undefined | null {
  if (value === undefined) return undefined;
  const object = readObject(value);
  if (!object || object.method !== "characters_div_4_v1") {
    return null;
  }
  const estimatedOutputTokens = readNonNegativeFiniteNumber(object.estimatedOutputTokens);
  if (estimatedOutputTokens === undefined) {
    return null;
  }
  return { method: "characters_div_4_v1", estimatedOutputTokens };
}

function readOutcome(value: unknown): GenerationOutcome | null {
  return typeof value === "string" && OUTCOMES.has(value as GenerationOutcome)
    ? value as GenerationOutcome
    : null;
}

function readTokenSource(value: unknown): GenerationTokenSource | null {
  return typeof value === "string" && TOKEN_SOURCES.has(value as GenerationTokenSource)
    ? value as GenerationTokenSource
    : null;
}

function readBoundarySource(value: unknown): GenerationBoundarySource | null {
  return typeof value === "string" && BOUNDARY_SOURCES.has(value as GenerationBoundarySource)
    ? value as GenerationBoundarySource
    : null;
}

function readReasoningBoundaryCoverage(value: unknown): GenerationReasoningBoundaryCoverage | null {
  return typeof value === "string" && REASONING_BOUNDARY_COVERAGE.has(value as GenerationReasoningBoundaryCoverage)
    ? value as GenerationReasoningBoundaryCoverage
    : null;
}

/** undefined is the valid v1 compatibility path; no alternative basis is accepted. */
function readOptionalResponseThroughputDurationBasis(
  value: unknown,
): ResponseThroughputDurationBasis | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && RESPONSE_THROUGHPUT_DURATION_BASES.has(value as ResponseThroughputDurationBasis)
    ? value as ResponseThroughputDurationBasis
    : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readNonEmptyString(value) ?? undefined;
}

function readNullableBoolean(value: unknown): boolean | null | undefined {
  return value === null || typeof value === "boolean" ? value : undefined;
}

function readIsoTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function readNullableIsoTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readIsoTimestamp(value) ?? undefined;
}

function readNonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readNullableNonNegativeFiniteNumber(value: unknown): number | null | undefined {
  return value === null ? null : readNonNegativeFiniteNumber(value);
}

function readNullableNonNegativeInteger(value: unknown): number | null | undefined {
  return value === null
    ? null
    : typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
