import type {
  ManagerProfile,
  TokenAnalyticsAttributionFilter,
  TokenAnalyticsQuery,
  TokenAnalyticsResolvedQuery,
  TokenAnalyticsSortDirection,
  TokenAnalyticsWorkerRunSummary,
  TokenAnalyticsWorkerSort,
} from "@forge/protocol";
import { dayKeyToStartMs, normalizeTimezone, shiftDayKey, toDayKey } from "../stats-time.js";
import type { DecodedCursor, ResolvedQueryWindow, TokenAnalyticsEventRecord } from "./token-analytics-types.js";
import { DEFAULT_WORKER_PAGE_LIMIT, MAX_WORKER_PAGE_LIMIT } from "./token-analytics-types.js";
import { toWorkerKey } from "./token-analytics-math.js";

export class TokenAnalyticsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "TokenAnalyticsError";
  }
}

export function resolveTokenAnalyticsQuery(
  input: TokenAnalyticsQuery,
  profiles: ManagerProfile[]
): ResolvedQueryWindow {
  const knownProfileIds = new Set(profiles.map((profile) => profile.profileId));
  const timezone = normalizeTimezone(input.timezone);
  const rangePreset = parseRangePreset(input.rangePreset);
  const profileId = normalizeOptionalString(input.profileId);
  const provider = normalizeOptionalString(input.provider);
  const modelId = normalizeOptionalString(input.modelId);
  const attribution = parseAttributionFilter(input.attribution);
  const specialistId = normalizeOptionalString(input.specialistId);

  if (profileId && !knownProfileIds.has(profileId)) {
    throw new TokenAnalyticsError(400, `Unknown profileId: ${profileId}`);
  }

  if (rangePreset === "custom") {
    const startDate = normalizeDateString(input.startDate);
    const endDate = normalizeDateString(input.endDate);
    if (!startDate || !endDate) {
      throw new TokenAnalyticsError(400, "custom rangePreset requires startDate and endDate");
    }
    if (endDate < startDate) {
      throw new TokenAnalyticsError(400, "endDate must be on or after startDate");
    }

    return {
      query: {
        rangePreset,
        startDate,
        endDate,
        timezone,
        profileId: profileId ?? null,
        provider: provider ?? null,
        modelId: modelId ?? null,
        attribution,
        specialistId,
      },
      startMs: dayKeyToStartMs(startDate, timezone),
      endExclusiveMs: dayKeyToStartMs(shiftDayKey(endDate, 1), timezone),
    };
  }

  if (rangePreset === "all") {
    return {
      query: {
        rangePreset,
        startDate: null,
        endDate: null,
        timezone,
        profileId: profileId ?? null,
        provider: provider ?? null,
        modelId: modelId ?? null,
        attribution,
        specialistId,
      },
      startMs: null,
      endExclusiveMs: null,
    };
  }

  const todayKey = toDayKey(Date.now(), timezone);
  const startDate = rangePreset === "7d" ? shiftDayKey(todayKey, -6) : shiftDayKey(todayKey, -29);

  return {
    query: {
      rangePreset,
      startDate,
      endDate: todayKey,
      timezone,
      profileId: profileId ?? null,
      provider: provider ?? null,
      modelId: modelId ?? null,
      attribution,
      specialistId,
    },
    startMs: dayKeyToStartMs(startDate, timezone),
    endExclusiveMs: dayKeyToStartMs(shiftDayKey(todayKey, 1), timezone),
  };
}

export function filterEvents(
  events: TokenAnalyticsEventRecord[],
  resolved: ResolvedQueryWindow,
  options: {
    includeProvider: boolean;
    includeModel: boolean;
    includeAttribution: boolean;
    includeSpecialist: boolean;
  }
): TokenAnalyticsEventRecord[] {
  return events.filter((event) => {
    if (resolved.query.profileId && event.profileId !== resolved.query.profileId) {
      return false;
    }
    if (resolved.startMs !== null && event.timestampMs < resolved.startMs) {
      return false;
    }
    if (resolved.endExclusiveMs !== null && event.timestampMs >= resolved.endExclusiveMs) {
      return false;
    }
    if (options.includeProvider && resolved.query.provider && event.provider !== resolved.query.provider) {
      return false;
    }
    if (options.includeModel && resolved.query.modelId && event.modelId !== resolved.query.modelId) {
      return false;
    }
    if (options.includeAttribution && resolved.query.attribution !== "all" && event.attributionKind !== resolved.query.attribution) {
      return false;
    }
    if (options.includeSpecialist && resolved.query.specialistId && event.specialistId !== resolved.query.specialistId) {
      return false;
    }
    return true;
  });
}

export function parseWorkerSort(value: unknown): TokenAnalyticsWorkerSort {
  if (value === "startedAt" || value === "durationMs" || value === "totalTokens" || value === "cost") {
    return value;
  }
  return "startedAt";
}

export function parseSortDirection(value: unknown): TokenAnalyticsSortDirection {
  return value === "asc" ? "asc" : "desc";
}

export function parsePageLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WORKER_PAGE_LIMIT;
  }
  return Math.min(MAX_WORKER_PAGE_LIMIT, Math.max(1, Math.trunc(parsed)));
}

export function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: unknown): DecodedCursor | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const offset = typeof parsed.offset === "number" ? Math.trunc(parsed.offset) : Number.NaN;
    const sort = parseWorkerSort(parsed.sort);
    const direction = parseSortDirection(parsed.direction);
    if (!Number.isFinite(offset) || offset < 0) {
      return null;
    }
    return { offset, sort, direction };
  } catch {
    return null;
  }
}

export function compareWorkerSummaries(
  left: TokenAnalyticsWorkerRunSummary,
  right: TokenAnalyticsWorkerRunSummary,
  sort: TokenAnalyticsWorkerSort,
  direction: TokenAnalyticsSortDirection
): number {
  const directionMultiplier = direction === "asc" ? 1 : -1;
  const leftValue = getWorkerSortValue(left, sort);
  const rightValue = getWorkerSortValue(right, sort);

  if (leftValue < rightValue) {
    return -1 * directionMultiplier;
  }
  if (leftValue > rightValue) {
    return 1 * directionMultiplier;
  }

  const leftKey = toWorkerKey(left.profileId, left.sessionId, left.workerId);
  const rightKey = toWorkerKey(right.profileId, right.sessionId, right.workerId);
  return leftKey.localeCompare(rightKey) * directionMultiplier;
}

export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDateString(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : null;
}

function parseRangePreset(value: unknown): TokenAnalyticsResolvedQuery["rangePreset"] {
  if (value === "7d" || value === "30d" || value === "all" || value === "custom") {
    return value;
  }
  return "7d";
}

function parseAttributionFilter(value: unknown): TokenAnalyticsAttributionFilter {
  if (value === "all" || value === "specialist" || value === "ad_hoc" || value === "unknown") {
    return value;
  }
  return "all";
}

function getWorkerSortValue(item: TokenAnalyticsWorkerRunSummary, sort: TokenAnalyticsWorkerSort): number {
  if (sort === "durationMs") {
    return item.durationMs ?? Number.NEGATIVE_INFINITY;
  }
  if (sort === "totalTokens") {
    return item.usage.total;
  }
  if (sort === "cost") {
    return item.cost.totals?.total ?? Number.NEGATIVE_INFINITY;
  }
  return Date.parse(item.startedAt);
}
