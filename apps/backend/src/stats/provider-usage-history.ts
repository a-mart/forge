import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderUsagePace, ProviderUsageWindow } from "@forge/protocol";

export type ProviderUsageHistoryProvider = "anthropic" | "openai";

interface ProviderUsageHistoryRecord {
  v: number;
  provider: ProviderUsageHistoryProvider;
  windowKind: "weekly";
  accountKey?: string;
  sampledAtMs: number;
  percent: number;
  resetAtMs: number;
  windowSeconds: number;
}

export interface ProviderUsageHistoricalWeek {
  resetAtMs: number;
  windowSeconds: number;
  curve: number[];
}

export interface ProviderUsageHistoricalDataset {
  weeks: ProviderUsageHistoricalWeek[];
}

interface RecordWeeklyWindowInput {
  provider: ProviderUsageHistoryProvider;
  window: ProviderUsageWindow;
  sampledAtMs: number;
  accountKey?: string;
}

const SCHEMA_VERSION = 1;
const GRID_POINT_COUNT = 169;
const WRITE_INTERVAL_MS = 30 * 60 * 1000;
const WRITE_DELTA_THRESHOLD = 1;
const RETENTION_MS = 56 * 24 * 60 * 60 * 1000;
const MINIMUM_WEEK_SAMPLES = 6;
const BOUNDARY_COVERAGE_MS = 24 * 60 * 60 * 1000;
const RESET_BUCKET_MS = 60 * 1000;
const MINIMUM_COMPLETE_WEEKS_FOR_HISTORICAL = 3;
const MINIMUM_WEEKS_FOR_RISK = 5;
const RECENCY_TAU_WEEKS = 3;
const EPSILON = 1e-9;

export class ProviderUsageHistoryStore {
  private readonly filePath: string;
  private readonly tempFilePath: string;
  private records: ProviderUsageHistoryRecord[] = [];
  private loaded = false;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.tempFilePath = `${filePath}.tmp`;
  }

  async loadDataset(
    provider: ProviderUsageHistoryProvider,
    accountKey?: string
  ): Promise<ProviderUsageHistoricalDataset | null> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.buildDataset(provider, normalizeAccountKey(accountKey));
    });
  }

  async recordWeeklyWindow(input: RecordWeeklyWindowInput): Promise<ProviderUsageHistoricalDataset | null> {
    return this.enqueue(async () => {
      await this.ensureLoaded();

      const accountKey = normalizeAccountKey(input.accountKey);
      const resetAtMs = normalizeResetAtMs(input.window.resetAtMs);
      const windowSeconds = normalizeWindowSeconds(input.window.windowSeconds);
      if (resetAtMs === null || windowSeconds === null) {
        return this.buildDataset(input.provider, accountKey);
      }

      const sample: ProviderUsageHistoryRecord = {
        v: SCHEMA_VERSION,
        provider: input.provider,
        windowKind: "weekly",
        accountKey,
        sampledAtMs: normalizeTimestampMs(input.sampledAtMs),
        percent: clamp(input.window.percent, 0, 100),
        resetAtMs,
        windowSeconds
      };

      if (this.shouldAccept(sample)) {
        this.records.push(sample);
        this.pruneOldRecords(sample.sampledAtMs);
        this.sortRecords();
        await this.persist();
      }

      return this.buildDataset(input.provider, accountKey);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation);
    this.operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loaded = true;
    this.records = await this.readRecordsFromDisk();
    this.pruneOldRecords(Date.now());
    this.sortRecords();
  }

  private async readRecordsFromDisk(): Promise<ProviderUsageHistoryRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const lines = raw.split(/\r?\n/u);
      const decoded: ProviderUsageHistoryRecord[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as Partial<ProviderUsageHistoryRecord>;
          const provider = parsed.provider === "openai" || parsed.provider === "anthropic" ? parsed.provider : null;
          const resetAtMs = normalizeResetAtMs(parsed.resetAtMs);
          const windowSeconds = normalizeWindowSeconds(parsed.windowSeconds);
          const sampledAtMs = normalizeTimestampMs(parsed.sampledAtMs);

          if (!provider || parsed.windowKind !== "weekly" || resetAtMs === null || windowSeconds === null) {
            continue;
          }

          decoded.push({
            v: typeof parsed.v === "number" ? parsed.v : SCHEMA_VERSION,
            provider,
            windowKind: "weekly",
            accountKey: normalizeAccountKey(parsed.accountKey),
            sampledAtMs,
            percent: clamp(parsed.percent ?? 0, 0, 100),
            resetAtMs,
            windowSeconds
          });
        } catch {
          // Ignore malformed history lines.
        }
      }

      return decoded;
    } catch {
      return [];
    }
  }

  private shouldAccept(sample: ProviderUsageHistoryRecord): boolean {
    const prior = [...this.records]
      .reverse()
      .find((record) =>
        record.provider === sample.provider &&
        record.windowKind === sample.windowKind &&
        record.windowSeconds === sample.windowSeconds &&
        record.accountKey === sample.accountKey
      );

    if (!prior) {
      return true;
    }

    if (prior.resetAtMs !== sample.resetAtMs) {
      return true;
    }

    if (sample.sampledAtMs - prior.sampledAtMs >= WRITE_INTERVAL_MS) {
      return true;
    }

    if (Math.abs(sample.percent - prior.percent) >= WRITE_DELTA_THRESHOLD) {
      return true;
    }

    return false;
  }

  private pruneOldRecords(nowMs: number): void {
    const cutoffMs = nowMs - RETENTION_MS;
    this.records = this.records.filter((record) => record.sampledAtMs >= cutoffMs);
  }

  private sortRecords(): void {
    this.records.sort((left, right) => {
      if (left.sampledAtMs === right.sampledAtMs) {
        if (left.resetAtMs === right.resetAtMs) {
          return left.percent - right.percent;
        }
        return left.resetAtMs - right.resetAtMs;
      }
      return left.sampledAtMs - right.sampledAtMs;
    });
  }

  private async persist(): Promise<void> {
    const payload = `${this.records.map((record) => JSON.stringify(record)).join("\n")}\n`;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.tempFilePath, payload, "utf8");
      await rename(this.tempFilePath, this.filePath);
    } catch {
      // Best-effort history file; ignore write failures.
    }
  }

  private buildDataset(
    provider: ProviderUsageHistoryProvider,
    accountKey?: string
  ): ProviderUsageHistoricalDataset | null {
    const scoped = this.records.filter((record) => {
      if (record.provider !== provider || record.windowKind !== "weekly" || record.windowSeconds <= 0) {
        return false;
      }

      return accountKey ? record.accountKey === accountKey : record.accountKey === undefined;
    });

    if (scoped.length === 0) {
      return null;
    }

    const groups = new Map<string, ProviderUsageHistoryRecord[]>();
    for (const record of scoped) {
      const key = `${record.resetAtMs}:${record.windowSeconds}`;
      const existing = groups.get(key) ?? [];
      existing.push(record);
      groups.set(key, existing);
    }

    const weeks: ProviderUsageHistoricalWeek[] = [];
    for (const group of groups.values()) {
      const first = group[0];
      if (!first) {
        continue;
      }

      const windowDurationMs = first.windowSeconds * 1000;
      if (!Number.isFinite(windowDurationMs) || windowDurationMs <= 0) {
        continue;
      }

      const windowStartMs = first.resetAtMs - windowDurationMs;
      if (!isCompleteWeek(group, windowStartMs, first.resetAtMs)) {
        continue;
      }

      const curve = reconstructWeekCurve(group, windowStartMs, windowDurationMs, GRID_POINT_COUNT);
      if (!curve) {
        continue;
      }

      weeks.push({
        resetAtMs: first.resetAtMs,
        windowSeconds: first.windowSeconds,
        curve
      });
    }

    weeks.sort((left, right) => left.resetAtMs - right.resetAtMs);
    return weeks.length > 0 ? { weeks } : null;
  }
}

export function evaluateHistoricalProviderUsagePace(
  window: ProviderUsageWindow,
  nowMs: number,
  dataset: ProviderUsageHistoricalDataset | null | undefined
): ProviderUsagePace | undefined {
  if (!dataset) {
    return undefined;
  }

  const resetAtMs = normalizeResetAtMs(window.resetAtMs);
  const windowSeconds = normalizeWindowSeconds(window.windowSeconds);
  if (resetAtMs === null || windowSeconds === null) {
    return undefined;
  }

  const durationMs = windowSeconds * 1000;
  const timeUntilResetMs = resetAtMs - nowMs;
  if (timeUntilResetMs <= 0 || timeUntilResetMs > durationMs) {
    return undefined;
  }

  const elapsedMs = clamp(durationMs - timeUntilResetMs, 0, durationMs);
  const actual = clamp(window.percent, 0, 100);
  if (elapsedMs === 0 && actual > 0) {
    return undefined;
  }

  const uNow = clamp(elapsedMs / durationMs, 0, 1);
  const scopedWeeks = dataset.weeks.filter((week) => week.windowSeconds === windowSeconds && week.resetAtMs < resetAtMs);
  if (scopedWeeks.length < MINIMUM_COMPLETE_WEEKS_FOR_HISTORICAL) {
    return undefined;
  }

  const weightedWeeks = scopedWeeks.map((week) => {
    const ageWeeks = clamp((resetAtMs - week.resetAtMs) / durationMs, 0, Number.POSITIVE_INFINITY);
    const weight = Math.exp(-ageWeeks / RECENCY_TAU_WEEKS);
    return { week, weight };
  });

  const totalWeight = weightedWeeks.reduce((sum, weighted) => sum + weighted.weight, 0);
  if (totalWeight <= EPSILON) {
    return undefined;
  }

  const totalWeightSquared = weightedWeeks.reduce((sum, weighted) => sum + (weighted.weight * weighted.weight), 0);
  const effectiveSampleCount = totalWeightSquared > EPSILON ? (totalWeight * totalWeight) / totalWeightSquared : 0;
  const blend = clamp((effectiveSampleCount - 2) / 6, 0, 1);

  const denominator = GRID_POINT_COUNT - 1;
  const expectedCurve = Array.from({ length: GRID_POINT_COUNT }, (_, index) => {
    const u = index / denominator;
    const historicalMedian = weightedMedian(
      weightedWeeks.map((weighted) => weighted.week.curve[index] ?? 0),
      weightedWeeks.map((weighted) => weighted.weight)
    );
    const linearBaseline = 100 * u;
    return clamp((blend * historicalMedian) + ((1 - blend) * linearBaseline), 0, 100);
  });

  let runningExpected = 0;
  for (let index = 0; index < expectedCurve.length; index += 1) {
    runningExpected = Math.max(runningExpected, expectedCurve[index] ?? 0);
    expectedCurve[index] = runningExpected;
  }

  const expectedPercent = interpolateCurve(expectedCurve, uNow);

  let weightedRunOutMass = 0;
  const crossingCandidates: Array<{ etaMs: number; weight: number }> = [];

  for (const weighted of weightedWeeks) {
    const weekNow = interpolateCurve(weighted.week.curve, uNow);
    const shift = actual - weekNow;
    const shiftedEnd = clamp((weighted.week.curve[weighted.week.curve.length - 1] ?? 0) + shift, 0, 100);
    const runsOut = shiftedEnd >= 100 - EPSILON;

    if (!runsOut) {
      continue;
    }

    weightedRunOutMass += weighted.weight;
    const crossingU = firstCrossingAfter(uNow, weighted.week.curve, shift, actual);
    if (crossingU !== undefined) {
      crossingCandidates.push({
        etaMs: Math.max(0, (crossingU - uNow) * durationMs),
        weight: weighted.weight
      });
    }
  }

  const smoothedProbability = clamp((weightedRunOutMass + 0.5) / (totalWeight + 1), 0, 1);
  const runOutProbability = scopedWeeks.length >= MINIMUM_WEEKS_FOR_RISK ? smoothedProbability : undefined;

  let willLastToReset = smoothedProbability < 0.5;
  let etaSeconds: number | undefined;

  if (!willLastToReset) {
    const etaMs = weightedMedian(
      crossingCandidates.map((candidate) => candidate.etaMs),
      crossingCandidates.map((candidate) => candidate.weight)
    );

    if (!Number.isFinite(etaMs) || crossingCandidates.length === 0) {
      willLastToReset = true;
    } else {
      etaSeconds = Math.max(0, etaMs / 1000);
    }
  }

  return {
    mode: "historical",
    expectedPercent: roundToSingleDecimal(expectedPercent),
    deltaPercent: roundToSingleDecimal(actual - expectedPercent),
    etaSeconds: etaSeconds === undefined ? undefined : roundToSingleDecimal(etaSeconds),
    willLastToReset,
    runOutProbability: runOutProbability === undefined ? undefined : roundToTwoDecimals(runOutProbability)
  };
}

function reconstructWeekCurve(
  samples: ProviderUsageHistoryRecord[],
  windowStartMs: number,
  windowDurationMs: number,
  gridPointCount: number
): number[] | null {
  if (gridPointCount < 2 || windowDurationMs <= 0) {
    return null;
  }

  const points = samples
    .map((sample) => ({
      u: clamp((sample.sampledAtMs - windowStartMs) / windowDurationMs, 0, 1),
      value: clamp(sample.percent, 0, 100)
    }))
    .sort((left, right) => {
      if (left.u === right.u) {
        return left.value - right.value;
      }
      return left.u - right.u;
    });

  if (points.length === 0) {
    return null;
  }

  const monotonePoints: Array<{ u: number; value: number }> = [];
  let runningMax = 0;
  for (const point of points) {
    runningMax = Math.max(runningMax, point.value);
    monotonePoints.push({ u: point.u, value: runningMax });
  }

  const endValue = monotonePoints[monotonePoints.length - 1]?.value ?? 0;
  monotonePoints.push({ u: 0, value: 0 });
  monotonePoints.push({ u: 1, value: endValue });
  monotonePoints.sort((left, right) => {
    if (left.u === right.u) {
      return left.value - right.value;
    }
    return left.u - right.u;
  });

  runningMax = 0;
  for (const point of monotonePoints) {
    runningMax = Math.max(runningMax, point.value);
    point.value = runningMax;
  }

  const curve = Array.from({ length: gridPointCount }, () => 0);
  const firstPoint = monotonePoints[0];
  const lastPoint = monotonePoints[monotonePoints.length - 1];
  if (!firstPoint || !lastPoint) {
    return null;
  }

  let upperIndex = 1;
  const denominator = gridPointCount - 1;

  for (let index = 0; index < gridPointCount; index += 1) {
    const u = index / denominator;
    if (u <= firstPoint.u) {
      curve[index] = firstPoint.value;
      continue;
    }

    if (u >= lastPoint.u) {
      curve[index] = lastPoint.value;
      continue;
    }

    while (upperIndex < monotonePoints.length && (monotonePoints[upperIndex]?.u ?? 0) < u) {
      upperIndex += 1;
    }

    const hi = monotonePoints[Math.min(upperIndex, monotonePoints.length - 1)] ?? lastPoint;
    const lo = monotonePoints[Math.max(0, upperIndex - 1)] ?? firstPoint;

    if (hi.u <= lo.u) {
      curve[index] = Math.max(lo.value, hi.value);
      continue;
    }

    const ratio = clamp((u - lo.u) / (hi.u - lo.u), 0, 1);
    curve[index] = lo.value + ((hi.value - lo.value) * ratio);
  }

  let curveMax = 0;
  for (let index = 0; index < curve.length; index += 1) {
    curve[index] = clamp(curve[index] ?? 0, 0, 100);
    curveMax = Math.max(curveMax, curve[index] ?? 0);
    curve[index] = curveMax;
  }

  return curve;
}

function isCompleteWeek(samples: ProviderUsageHistoryRecord[], windowStartMs: number, resetAtMs: number): boolean {
  if (samples.length < MINIMUM_WEEK_SAMPLES) {
    return false;
  }

  const startBoundaryMs = windowStartMs + BOUNDARY_COVERAGE_MS;
  const endBoundaryMs = resetAtMs - BOUNDARY_COVERAGE_MS;
  const hasStartCoverage = samples.some((sample) => sample.sampledAtMs >= windowStartMs && sample.sampledAtMs <= startBoundaryMs);
  const hasEndCoverage = samples.some((sample) => sample.sampledAtMs >= endBoundaryMs && sample.sampledAtMs <= resetAtMs);
  return hasStartCoverage && hasEndCoverage;
}

function firstCrossingAfter(
  uNow: number,
  curve: number[],
  shift: number,
  actualAtNow: number
): number | undefined {
  if (curve.length < 2) {
    return undefined;
  }

  const denominator = curve.length - 1;
  let previousU = uNow;
  let previousValue = actualAtNow;
  const startIndex = Math.min(curve.length - 1, Math.max(1, Math.floor(uNow * denominator) + 1));

  for (let index = startIndex; index < curve.length; index += 1) {
    const u = index / denominator;
    if (u <= uNow + EPSILON) {
      continue;
    }

    const value = clamp((curve[index] ?? 0) + shift, 0, 100);
    if (previousValue < 100 - EPSILON && value >= 100 - EPSILON) {
      const delta = value - previousValue;
      if (Math.abs(delta) <= EPSILON) {
        return u;
      }

      const ratio = clamp((100 - previousValue) / delta, 0, 1);
      return clamp(previousU + (ratio * (u - previousU)), uNow, 1);
    }

    previousU = u;
    previousValue = value;
  }

  return undefined;
}

function interpolateCurve(curve: number[], u: number): number {
  if (curve.length === 0) {
    return 0;
  }

  if (curve.length === 1) {
    return curve[0] ?? 0;
  }

  const clipped = clamp(u, 0, 1);
  const scaled = clipped * (curve.length - 1);
  const lowerIndex = Math.floor(scaled);
  const upperIndex = Math.min(curve.length - 1, lowerIndex + 1);
  if (lowerIndex === upperIndex) {
    return curve[lowerIndex] ?? 0;
  }

  const ratio = scaled - lowerIndex;
  const lowerValue = curve[lowerIndex] ?? 0;
  const upperValue = curve[upperIndex] ?? lowerValue;
  return lowerValue + ((upperValue - lowerValue) * ratio);
}

function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0 || values.length !== weights.length) {
    return Number.NaN;
  }

  const pairs = values
    .map((value, index) => ({
      value,
      weight: Math.max(0, weights[index] ?? 0)
    }))
    .sort((left, right) => left.value - right.value);

  const totalWeight = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  if (totalWeight <= EPSILON) {
    const sortedValues = [...values].sort((left, right) => left - right);
    return sortedValues[Math.floor(sortedValues.length / 2)] ?? Number.NaN;
  }

  const threshold = totalWeight / 2;
  let cumulative = 0;
  for (const pair of pairs) {
    cumulative += pair.weight;
    if (cumulative >= threshold) {
      return pair.value;
    }
  }

  return pairs[pairs.length - 1]?.value ?? Number.NaN;
}

function normalizeResetAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value / RESET_BUCKET_MS) * RESET_BUCKET_MS;
}

function normalizeWindowSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value);
}

function normalizeTimestampMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Date.now();
  }

  return Math.round(value);
}

function normalizeAccountKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
