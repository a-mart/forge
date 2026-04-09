import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StatsRange, StatsSnapshot, TokenStats } from "@forge/protocol";
import { isEnoentError, isRecord, STATS_CACHE_TTL_MS } from "./stats-shared.js";
import { normalizeTimezone } from "./stats-time.js";
import type { CacheEntry, PersistedStatsCache } from "./stats-types.js";

const STATS_CACHE_VERSION = 7;

export function getStatsCacheKey(range: StatsRange): string {
  return `stats:${range}`;
}

export function getStatsInFlightKey(range: StatsRange, timezone: string): string {
  return `stats:${range}:${timezone}`;
}

export function createStatsCacheEntry(snapshot: StatsSnapshot, timezone: string): CacheEntry {
  return {
    expiresAt: Date.now() + STATS_CACHE_TTL_MS,
    timezone,
    snapshot,
  };
}

export async function loadPersistedStatsCache(
  cacheFilePath: string,
  cache: Map<string, CacheEntry>
): Promise<void> {
  try {
    const raw = await readFile(cacheFilePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedStatsCache;
    if (!isRecord(parsed) || parsed.version !== STATS_CACHE_VERSION || !isRecord(parsed.entries)) {
      return;
    }

    const ranges: StatsRange[] = ["7d", "30d", "all"];
    for (const range of ranges) {
      const entry = parsed.entries[range];
      if (!entry || !isRecord(entry)) {
        continue;
      }

      const expiresAt = toSafeNumber(entry.expiresAt);
      const timezone = normalizeTimezone(entry.timezone);
      if (expiresAt <= 0 || !entry.snapshot || !isRecord(entry.snapshot)) {
        continue;
      }

      cache.set(getStatsCacheKey(range), {
        expiresAt,
        timezone,
        snapshot: entry.snapshot as StatsSnapshot,
      });
    }
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }
}

export async function persistStatsCache(
  cacheFilePath: string,
  cache: Map<string, CacheEntry>
): Promise<void> {
  const entries: Partial<Record<StatsRange, CacheEntry>> = {};
  const entry7d = cache.get(getStatsCacheKey("7d"));
  const entry30d = cache.get(getStatsCacheKey("30d"));
  const entryAll = cache.get(getStatsCacheKey("all"));

  if (entry7d) {
    entries["7d"] = entry7d;
  }
  if (entry30d) {
    entries["30d"] = entry30d;
  }
  if (entryAll) {
    entries.all = entryAll;
  }

  const payload: PersistedStatsCache = {
    version: STATS_CACHE_VERSION,
    entries,
  };

  await mkdir(dirname(cacheFilePath), { recursive: true });
  await writeFile(cacheFilePath, JSON.stringify(payload), "utf8");
}

export function getLatestTokenStatsForTimezone(
  cache: Map<string, CacheEntry>,
  timezone: string
): TokenStats | null {
  const ranges: StatsRange[] = ["7d", "30d", "all"];
  let latestTokens: TokenStats | null = null;
  let latestComputedAtMs = Number.NEGATIVE_INFINITY;

  for (const range of ranges) {
    const entry = cache.get(getStatsCacheKey(range));
    if (!entry || entry.timezone !== timezone) {
      continue;
    }

    const computedAtMs = Date.parse(entry.snapshot.computedAt);
    if (!Number.isFinite(computedAtMs) || computedAtMs < latestComputedAtMs) {
      continue;
    }

    latestComputedAtMs = computedAtMs;
    latestTokens = entry.snapshot.tokens;
  }

  return latestTokens;
}

function toSafeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return fallback;
}
