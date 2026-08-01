import type {
  GenerationThroughputAvailableFilters,
  GenerationThroughputCall,
  GenerationThroughputMetrics,
  GenerationThroughputModelSummary,
  GenerationThroughputModelTrend,
  GenerationThroughputRoleSummary,
} from "@forge/protocol";
import { modelCatalogService } from "../../swarm/model-catalog-service.js";
import { formatDayLabel, toDayKey } from "../stats-time.js";
import { isMeasuredGeneration } from "./generation-throughput-query.js";
import type { GenerationMeasurementRecord } from "./generation-throughput-types.js";
import { MAX_GENERATION_MODEL_TABLE_ROWS, MAX_GENERATION_TREND_SERIES } from "./generation-throughput-types.js";

export function buildGenerationMetrics(
  records: GenerationMeasurementRecord[],
  coverageRecords: GenerationMeasurementRecord[] = records,
): GenerationThroughputMetrics {
  const terminal = coverageRecords.filter((record) => record.recordState === "terminal");
  const measured = records.filter(isMeasuredGeneration);
  const rates = measured.map(tokensPerSecond).filter((value): value is number => value !== null);
  const ttft = terminal
    .map((record) => record.timing.timeToFirstOutputMs)
    .filter((value): value is number => value !== null);
  const outputTokens = measured.reduce((sum, record) => sum + (record.usage.outputTokens ?? 0), 0);
  const generationDurationMs = measured.reduce((sum, record) => sum + (record.timing.generationDurationMs ?? 0), 0);

  return {
    allCallCount: coverageRecords.length,
    terminalCallCount: terminal.length,
    measuredCallCount: measured.length,
    incompleteCallCount: coverageRecords.length - terminal.length,
    outputTokens,
    generationDurationMs,
    weightedTokensPerSecond: generationDurationMs > 0 ? outputTokens * 1000 / generationDurationMs : null,
    p50TokensPerSecond: nearestRank(rates, 0.5),
    p90TokensPerSecond: nearestRank(rates, 0.9),
    p50TimeToFirstOutputMs: nearestRank(ttft, 0.5),
    coverage: terminal.length > 0 ? measured.length / terminal.length : 0,
    timeToFirstOutputCoverage: terminal.length > 0 ? ttft.length / terminal.length : 0,
    hiddenReasoningBoundaryCallCount: terminal.filter(
      (record) => record.reasoningBoundaryCoverage === "hidden_or_unobserved",
    ).length,
  };
}

export function buildGenerationRoleSummaries(
  records: GenerationMeasurementRecord[],
  coverageRecords: GenerationMeasurementRecord[] = records,
): GenerationThroughputRoleSummary[] {
  return (["manager", "worker"] as const).map((role) => ({
    role,
    ...buildGenerationMetrics(
      records.filter((record) => record.identity.role === role),
      coverageRecords.filter((record) => record.identity.role === role),
    ),
  }));
}

export function buildGenerationModelSummaries(
  records: GenerationMeasurementRecord[],
  coverageRecords: GenerationMeasurementRecord[] = records,
): {
  models: GenerationThroughputModelSummary[];
  truncated: boolean;
} {
  const byModel = groupBy(records, (record) => modelKey(record));
  const models = Array.from(byModel.values())
    .map((group) => {
      const first = group[0]!;
      return {
        provider: first.model.provider,
        modelId: first.effectiveModelId,
        displayName: displayModelName(first),
        ...buildGenerationMetrics(group, coverageRecords.filter((record) => modelKey(record) === modelKey(first))),
      } satisfies GenerationThroughputModelSummary;
    })
    .sort((left, right) => right.outputTokens - left.outputTokens || left.displayName.localeCompare(right.displayName));

  return {
    models: models.slice(0, MAX_GENERATION_MODEL_TABLE_ROWS),
    truncated: models.length > MAX_GENERATION_MODEL_TABLE_ROWS,
  };
}

export function buildGenerationTrends(
  records: GenerationMeasurementRecord[],
  timezone: string,
  coverageRecords: GenerationMeasurementRecord[] = records,
): GenerationThroughputModelTrend[] {
  const measured = records.filter(isMeasuredGeneration);
  const byModel = groupBy(measured, modelKey);
  const topModels = Array.from(byModel.values())
    .sort((left, right) => measuredOutput(right) - measuredOutput(left) || modelKey(left[0]!).localeCompare(modelKey(right[0]!)))
    .slice(0, MAX_GENERATION_TREND_SERIES);

  return topModels.map((modelRecords) => {
    const byDay = groupBy(modelRecords, (record) => toDayKey(record.completedAtMs!, timezone));
    const first = modelRecords[0]!;
    return {
      provider: first.model.provider,
      modelId: first.effectiveModelId,
      displayName: displayModelName(first),
      points: Array.from(byDay.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, dayRecords]) => ({
          date,
          dateLabel: formatDayLabel(date),
          ...buildGenerationMetrics(
            dayRecords,
            coverageRecords.filter((record) =>
              record.completedAtMs !== null
              && modelKey(record) === modelKey(first)
              && toDayKey(record.completedAtMs, timezone) === date,
            ),
          ),
        })),
    };
  });
}

export function buildGenerationAvailableFilters(records: GenerationMeasurementRecord[]): GenerationThroughputAvailableFilters {
  const terminal = records.filter((record) => record.recordState === "terminal");
  const profileCounts = new Map<string, { displayName: string; callCount: number }>();
  const providerCounts = new Map<string, number>();
  const modelCounts = new Map<string, { provider: string; modelId: string; displayName: string; callCount: number }>();
  const specialistCounts = new Map<string, { displayName: string; color: string | null; callCount: number }>();

  for (const record of terminal) {
    incrementMap(profileCounts, record.identity.profileId, {
      displayName: record.profileDisplayName,
      callCount: 0,
    }).callCount += 1;
    providerCounts.set(record.model.provider, (providerCounts.get(record.model.provider) ?? 0) + 1);
    incrementMap(modelCounts, modelKey(record), {
      provider: record.model.provider,
      modelId: record.effectiveModelId,
      displayName: displayModelName(record),
      callCount: 0,
    }).callCount += 1;
    if (record.identity.specialistId) {
      incrementMap(specialistCounts, record.identity.specialistId, {
        displayName: record.specialistDisplayName ?? record.identity.specialistId,
        color: record.specialistColor,
        callCount: 0,
      }).callCount += 1;
    }
  }

  return {
    profiles: Array.from(profileCounts.entries())
      .map(([profileId, value]) => ({ profileId, ...value }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    providers: Array.from(providerCounts.entries())
      .map(([provider, callCount]) => ({ provider, callCount }))
      .sort((left, right) => left.provider.localeCompare(right.provider)),
    models: Array.from(modelCounts.values())
      .sort((left, right) => right.callCount - left.callCount || left.displayName.localeCompare(right.displayName)),
    specialists: Array.from(specialistCounts.entries())
      .map(([specialistId, value]) => ({ specialistId, ...value }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
  };
}

export function toGenerationCall(record: GenerationMeasurementRecord): GenerationThroughputCall {
  return {
    measurementId: record.measurementId,
    completedAt: record.completedAt,
    profileId: record.identity.profileId,
    profileDisplayName: record.profileDisplayName,
    sessionId: record.identity.sessionId,
    sessionLabel: record.sessionLabel,
    agentId: record.identity.agentId,
    managerId: record.identity.managerId,
    role: record.identity.role,
    specialistId: record.identity.specialistId,
    specialistDisplayName: record.specialistDisplayName,
    attribution: record.attributionKind,
    provider: record.model.provider,
    requestedModelId: record.model.requestedModelId,
    responseModelId: record.model.responseModelId,
    modelId: record.effectiveModelId,
    outputTokens: record.usage.outputTokens,
    reasoningTokens: record.usage.reasoningTokens,
    generationDurationMs: record.timing.generationDurationMs,
    timeToFirstOutputMs: record.timing.timeToFirstOutputMs,
    tokensPerSecond: tokensPerSecond(record),
    outcome: record.outcome,
    quality: {
      measurementScope: record.attempt?.measurementScope ?? "agent_model_call",
      agentRetryAttempt: record.attempt?.agentRetryAttempt ?? null,
      providerAttemptScope: record.attempt?.providerAttemptScope ?? "unavailable",
      observedProviderAttemptCount: record.attempt?.observedProviderAttemptCount ?? null,
      tokenSource: record.usage.tokenSource,
      boundarySource: record.timing.boundarySource,
      reasoningBoundaryCoverage: record.reasoningBoundaryCoverage,
    },
  };
}

export function tokensPerSecond(record: GenerationMeasurementRecord): number | null {
  if (!isMeasuredGeneration(record)) return null;
  return record.usage.outputTokens! * 1000 / record.timing.generationDurationMs!;
}

function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null;
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function incrementMap<T>(map: Map<string, T>, key: string, initial: T): T {
  const existing = map.get(key);
  if (existing) return existing;
  map.set(key, initial);
  return initial;
}

function modelKey(record: GenerationMeasurementRecord): string {
  return `${record.model.provider}\u0000${record.effectiveModelId}`;
}

function displayModelName(record: GenerationMeasurementRecord): string {
  return modelCatalogService.getModelDisplayName(record.effectiveModelId, record.model.provider);
}

function measuredOutput(records: GenerationMeasurementRecord[]): number {
  return records.reduce((sum, record) => sum + (record.usage.outputTokens ?? 0), 0);
}
