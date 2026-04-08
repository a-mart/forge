import type {
  TokenAnalyticsCostCoverage,
  TokenAnalyticsCostSummary,
  TokenCostTotals,
  TokenUsageTotals,
} from "@forge/protocol";

export function toWorkerKey(profileId: string, sessionId: string, workerId: string): string {
  return `${profileId}/${sessionId}/${workerId}`;
}

export function toModelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

export function splitModelKey(value: string): [string, string] {
  const separatorIndex = value.indexOf("\u0000");
  if (separatorIndex < 0) {
    return ["unknown", value];
  }
  return [value.slice(0, separatorIndex), value.slice(separatorIndex + 1)];
}

export function addWorkerKey<K>(map: Map<K, Set<string>>, key: K, workerKey: string): void {
  const existing = map.get(key) ?? new Set<string>();
  existing.add(workerKey);
  map.set(key, existing);
}

export function addUsage<K>(map: Map<K, TokenUsageTotals>, key: K, usage: TokenUsageTotals): void {
  const existing = map.get(key) ?? createEmptyUsageTotals();
  mergeUsageTotals(existing, usage);
  map.set(key, existing);
}

export function sumEventUsage(events: Array<{ usage: TokenUsageTotals }>): TokenUsageTotals {
  return events.reduce((sum, event) => {
    mergeUsageTotals(sum, event.usage);
    return sum;
  }, createEmptyUsageTotals());
}

export function createEmptyUsageTotals(): TokenUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
}

export function cloneUsageTotals(usage: TokenUsageTotals): TokenUsageTotals {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.total,
  };
}

export function createEmptyCostTotals(): TokenCostTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
}

export function mergeUsageTotals(target: TokenUsageTotals, source: TokenUsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

export function addCostTotals(left: TokenCostTotals | null, right: TokenCostTotals | null): TokenCostTotals | null {
  if (!left && !right) {
    return null;
  }

  const result = left ? { ...left } : createEmptyCostTotals();
  if (right) {
    result.input = round2(result.input + right.input);
    result.output = round2(result.output + right.output);
    result.cacheRead = round2(result.cacheRead + right.cacheRead);
    result.cacheWrite = round2(result.cacheWrite + right.cacheWrite);
    result.total = round2(result.total + right.total);
  }
  return result;
}

export function mergeCostTotalsInto(
  target: { costTotals: TokenCostTotals | null; costCoveredEventCount: number },
  source: TokenCostTotals | null,
  costCoveredEventCount: number
): void {
  target.costTotals = addCostTotals(target.costTotals, source);
  target.costCoveredEventCount += costCoveredEventCount;
}

export function buildCostSummary(
  totals: TokenCostTotals | null,
  costCoveredEventCount: number,
  totalEventCount: number
): TokenAnalyticsCostSummary {
  const costCoverage = computeCostCoverage(costCoveredEventCount, totalEventCount);
  return {
    totals: totals ? { ...totals } : null,
    costCoverage,
    costCoveredEventCount,
  };
}

export function computeCostCoverage(
  costCoveredEventCount: number,
  totalEventCount: number
): TokenAnalyticsCostCoverage {
  if (costCoveredEventCount <= 0) {
    return "none";
  }
  if (costCoveredEventCount >= totalEventCount) {
    return "full";
  }
  return "partial";
}

export function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return round2(value);
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

export function toSafeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function pickTopEntry(map: Map<string, number>): { key: string; value: number } | null {
  let best: { key: string; value: number } | null = null;
  for (const [key, value] of map.entries()) {
    if (!best || value > best.value) {
      best = { key, value };
    }
  }
  return best;
}
