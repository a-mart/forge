import type { ModelDistributionEntry } from "@forge/protocol";
import { inferProviderFromModelId } from "../telemetry/provider-inference.js";
import type { DailyTotals, UsageRecord } from "./stats-types.js";

export function emptyDailyTotals(): DailyTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
}

export function sumDailyEntries(values: DailyTotals[]): DailyTotals {
  return values.reduce(
    (sum, value) => ({
      input: sum.input + value.input,
      output: sum.output + value.output,
      cacheRead: sum.cacheRead + value.cacheRead,
      cacheWrite: sum.cacheWrite + value.cacheWrite,
      total: sum.total + value.total,
    }),
    emptyDailyTotals()
  );
}

export function computeModelDistribution(usageRecords: UsageRecord[]): ModelDistributionEntry[] {
  const totalsByModel = new Map<string, number>();
  const reasoningTotalsByModel = new Map<string, Map<string, number>>();

  for (const record of usageRecords) {
    const current = totalsByModel.get(record.modelId) ?? 0;
    totalsByModel.set(record.modelId, current + record.total);

    const byReasoning = reasoningTotalsByModel.get(record.modelId) ?? new Map<string, number>();
    const reasoningCurrent = byReasoning.get(record.reasoningLevel) ?? 0;
    byReasoning.set(record.reasoningLevel, reasoningCurrent + record.total);
    reasoningTotalsByModel.set(record.modelId, byReasoning);
  }

  const grandTotal = Array.from(totalsByModel.values()).reduce((sum, value) => sum + value, 0);
  if (grandTotal <= 0) {
    return [];
  }

  return Array.from(totalsByModel.entries())
    .map(([modelId, tokenCount]) => {
      const reasoningBreakdownRaw = reasoningTotalsByModel.get(modelId) ?? new Map<string, number>();
      const reasoningBreakdown = Array.from(reasoningBreakdownRaw.entries())
        .map(([level, levelTokenCount]) => ({
          level,
          tokenCount: levelTokenCount,
          percentage: tokenCount > 0 ? round2((levelTokenCount / tokenCount) * 100) : 0,
        }))
        .sort((left, right) => right.tokenCount - left.tokenCount);

      return {
        modelId,
        displayName: modelId,
        percentage: round2((tokenCount / grandTotal) * 100),
        tokenCount,
        reasoningBreakdown,
      };
    })
    .sort((left, right) => right.tokenCount - left.tokenCount)
    .slice(0, 10);
}

export function computeProvidersUsed(usageRecords: UsageRecord[]): string[] {
  const providers = new Set<string>();

  for (const record of usageRecords) {
    const provider = inferProviderFromModelId(record.modelId);
    if (provider) {
      providers.add(provider);
    }
  }

  return Array.from(providers).sort((left, right) => left.localeCompare(right));
}

export function trimmedMean(values: number[]): number {
  const normalized = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value))
    .sort((left, right) => left - right);

  if (normalized.length === 0) {
    return 0;
  }

  const q1Index = Math.floor((normalized.length - 1) * 0.25);
  const q3Index = Math.floor((normalized.length - 1) * 0.75);
  const q1 = normalized[q1Index] ?? normalized[0];
  const q3 = normalized[q3Index] ?? normalized[normalized.length - 1];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;

  const filtered = normalized.filter((value) => value >= lower && value <= upper);
  if (filtered.length === 0) {
    return 0;
  }

  const sum = filtered.reduce((runningTotal, value) => runningTotal + value, 0);
  return Math.round(sum / filtered.length);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
