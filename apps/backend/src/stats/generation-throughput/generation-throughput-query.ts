import type {
  GenerationQualityFilter,
  GenerationRoleFilter,
  GenerationThroughputQuery,
  GenerationThroughputResolvedQuery,
  ManagerProfile,
  TokenAnalyticsAttributionFilter,
} from "@forge/protocol";
import { dayKeyToStartMs, normalizeTimezone, shiftDayKey, toDayKey } from "../stats-time.js";
import type { GenerationMeasurementRecord } from "./generation-throughput-types.js";
import { DEFAULT_GENERATION_CALLS_PAGE_LIMIT, MAX_GENERATION_CALLS_PAGE_LIMIT } from "./generation-throughput-types.js";

export class GenerationThroughputError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "GenerationThroughputError";
  }
}

export interface ResolvedGenerationThroughputQuery {
  query: GenerationThroughputResolvedQuery;
  startMs: number | null;
  endExclusiveMs: number | null;
}

export function resolveGenerationThroughputQuery(
  input: GenerationThroughputQuery,
  profiles: ManagerProfile[],
): ResolvedGenerationThroughputQuery {
  const timezone = normalizeTimezone(input.timezone);
  const rangePreset = parseRangePreset(input.rangePreset);
  const profileId = normalizeOptionalString(input.profileId);
  const role = parseRole(input.role);
  const provider = normalizeOptionalString(input.provider);
  const modelId = normalizeOptionalString(input.modelId);
  const quality = parseQuality(input.quality);
  const attribution = parseAttribution(input.attribution);
  const specialistId = normalizeOptionalString(input.specialistId);

  if (profileId && !profiles.some((profile) => profile.profileId === profileId)) {
    throw new GenerationThroughputError(400, `Unknown profileId: ${profileId}`);
  }
  if (specialistId && (attribution === "ad_hoc" || attribution === "unknown")) {
    throw new GenerationThroughputError(
      400,
      `specialistId cannot be combined with attribution=${attribution}; use attribution=all or attribution=specialist`,
    );
  }

  const shared = { profileId: profileId ?? null, role, provider: provider ?? null, modelId: modelId ?? null, quality, attribution, specialistId };
  if (rangePreset === "custom") {
    const startDate = normalizeDateString(input.startDate);
    const endDate = normalizeDateString(input.endDate);
    if (!startDate || !endDate) {
      throw new GenerationThroughputError(400, "custom rangePreset requires startDate and endDate");
    }
    if (endDate < startDate) {
      throw new GenerationThroughputError(400, "endDate must be on or after startDate");
    }
    return {
      query: { rangePreset, startDate, endDate, timezone, ...shared },
      startMs: dayKeyToStartMs(startDate, timezone),
      endExclusiveMs: dayKeyToStartMs(shiftDayKey(endDate, 1), timezone),
    };
  }

  if (rangePreset === "all") {
    return {
      query: { rangePreset, startDate: null, endDate: null, timezone, ...shared },
      startMs: null,
      endExclusiveMs: null,
    };
  }

  const today = toDayKey(Date.now(), timezone);
  const startDate = rangePreset === "7d" ? shiftDayKey(today, -6) : shiftDayKey(today, -29);
  return {
    query: { rangePreset, startDate, endDate: today, timezone, ...shared },
    startMs: dayKeyToStartMs(startDate, timezone),
    endExclusiveMs: dayKeyToStartMs(shiftDayKey(today, 1), timezone),
  };
}

export function filterGenerationMeasurements(
  records: GenerationMeasurementRecord[],
  resolved: ResolvedGenerationThroughputQuery,
  options: { includeProvider: boolean; includeModel: boolean; includeAttribution: boolean; includeSpecialist: boolean; includeQuality: boolean },
): GenerationMeasurementRecord[] {
  return records.filter((record) => {
    if (resolved.query.profileId && record.identity.profileId !== resolved.query.profileId) return false;
    if (resolved.query.role !== "all" && record.identity.role !== resolved.query.role) return false;
    // Terminal buckets use completedAt; start-only capture diagnostics use startedAt.
    const rangeTimestampMs = record.completedAtMs ?? Date.parse(record.startedAt);
    if (Number.isFinite(rangeTimestampMs)) {
      if (resolved.startMs !== null && rangeTimestampMs < resolved.startMs) return false;
      if (resolved.endExclusiveMs !== null && rangeTimestampMs >= resolved.endExclusiveMs) return false;
    } else if (resolved.startMs !== null) {
      return false;
    }
    if (options.includeProvider && resolved.query.provider && record.model.provider !== resolved.query.provider) return false;
    if (options.includeModel && resolved.query.modelId && record.effectiveModelId !== resolved.query.modelId) return false;
    if (options.includeAttribution && resolved.query.attribution !== "all" && record.attributionKind !== resolved.query.attribution) return false;
    if (options.includeSpecialist && resolved.query.specialistId && record.identity.specialistId !== resolved.query.specialistId) return false;
    if (options.includeQuality && !matchesQuality(record, resolved.query.quality)) return false;
    return true;
  });
}

export function matchesQuality(record: GenerationMeasurementRecord, quality: GenerationQualityFilter): boolean {
  if (quality === "all") return true;
  if (!isMeasuredGeneration(record)) return false;
  return quality === "all_measured" || isStrictGeneration(record);
}

export function isMeasuredGeneration(record: GenerationMeasurementRecord): boolean {
  return record.recordState === "terminal"
    && record.usage.tokenSource === "provider_final"
    && record.timing.boundarySource !== "unavailable"
    && record.timing.firstOutputAt !== null
    && record.timing.generationDurationMs !== null
    && record.timing.generationDurationMs > 0
    && record.usage.outputTokens !== null;
}

export function isStrictGeneration(record: GenerationMeasurementRecord): boolean {
  return isMeasuredGeneration(record) && record.timing.boundarySource === "content_delta_to_stream_end";
}

export function parseGenerationCallsLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GENERATION_CALLS_PAGE_LIMIT;
  return Math.min(MAX_GENERATION_CALLS_PAGE_LIMIT, Math.max(1, Math.trunc(parsed)));
}

export function encodeGenerationCallsCursor(cursor: { completedAt: string; measurementId: string }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeGenerationCallsCursor(value: unknown): { completedAt: string; measurementId: string } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.completedAt !== "string" || !Number.isFinite(Date.parse(parsed.completedAt))) return null;
    if (typeof parsed.measurementId !== "string" || !parsed.measurementId.trim()) return null;
    return { completedAt: parsed.completedAt, measurementId: parsed.measurementId };
  } catch {
    return null;
  }
}

function parseRangePreset(value: unknown): GenerationThroughputResolvedQuery["rangePreset"] {
  return value === "7d" || value === "30d" || value === "all" || value === "custom" ? value : "7d";
}

function parseRole(value: unknown): GenerationRoleFilter {
  return value === "manager" || value === "worker" ? value : "all";
}

function parseQuality(value: unknown): GenerationQualityFilter {
  return value === "strict" || value === "all" ? value : "all_measured";
}

function parseAttribution(value: unknown): TokenAnalyticsAttributionFilter {
  return value === "specialist" || value === "ad_hoc" || value === "unknown" ? value : "all";
}

export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeDateString(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized && /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : null;
}
