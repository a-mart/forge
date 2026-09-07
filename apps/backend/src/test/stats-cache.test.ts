import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsSnapshot } from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATS_CACHE_VERSION,
  getStatsCacheKey,
  loadPersistedStatsCache,
  persistStatsCache,
} from "../stats/stats-cache.js";
import type { CacheEntry } from "../stats/stats-types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("persisted stats cache", () => {
  it("bumps to version 8 and ignores older cache files that lack fuckMeter", async () => {
    expect(STATS_CACHE_VERSION).toBe(8);

    const cacheFilePath = await createCacheFilePath();
    await writeFile(cacheFilePath, JSON.stringify({
      version: 7,
      entries: {
        "7d": {
          expiresAt: Date.now() + 60_000,
          timezone: "UTC",
          snapshot: createSnapshot(),
        },
      },
    }), "utf8");

    const cache = new Map<string, CacheEntry>();
    await loadPersistedStatsCache(cacheFilePath, cache);
    expect(cache.size).toBe(0);
  });

  it("round-trips version 8 snapshots including fuckMeter daily buckets", async () => {
    const cacheFilePath = await createCacheFilePath();
    const snapshot = {
      ...createSnapshot(),
      fuckMeter: {
        daily: [
          { date: "2026-05-20", count: 3 },
          { date: "2026-05-21", count: 0 },
        ],
      },
    };
    const cache = new Map<string, CacheEntry>([
      [getStatsCacheKey("7d"), {
        expiresAt: Date.now() + 60_000,
        timezone: "UTC",
        snapshot,
      }],
    ]);

    await persistStatsCache(cacheFilePath, cache);

    const loaded = new Map<string, CacheEntry>();
    await loadPersistedStatsCache(cacheFilePath, loaded);
    expect(loaded.get(getStatsCacheKey("7d"))?.snapshot.fuckMeter).toEqual(snapshot.fuckMeter);
  });
});

async function createCacheFilePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forge-stats-cache-"));
  tempDirs.push(dir);
  return join(dir, "stats-cache.json");
}

function createSnapshot(): StatsSnapshot {
  return {
    computedAt: "2026-05-21T00:00:00.000Z",
    uptimeMs: 1,
    tokens: {
      today: 0,
      yesterday: 0,
      todayDate: "May 21",
      todayInputTokens: 0,
      todayOutputTokens: 0,
      last7Days: 0,
      last7DaysAvgPerDay: 0,
      last30Days: 0,
      allTime: 0,
    },
    cache: {
      hitRate: 0,
      hitRatePeriod: "Last 7 days",
      cachedTokensSaved: 0,
    },
    workers: {
      totalWorkersRun: 0,
      totalWorkersRunPeriod: "Last 7 days",
      averageTokensPerRun: 0,
      averageRuntimeMs: 0,
      currentlyActive: 0,
    },
    code: {
      linesAdded: 0,
      linesDeleted: 0,
      commits: 0,
      repos: 0,
    },
    sessions: {
      totalSessions: 0,
      activeSessions: 0,
      totalMessagesSent: 0,
      totalMessagesPeriod: "Last 7 days",
    },
    activity: {
      longestStreak: 0,
      streakLabel: "Across current usage range",
      activeDays: 0,
      activeDaysInRange: 0,
      totalDaysInRange: 7,
      peakDay: "—",
      peakDayTokens: 0,
    },
    models: [],
    dailyUsage: [],
    providers: {},
    system: {
      uptimeFormatted: "0m",
      totalProfiles: 0,
      serverVersion: "0.0.0",
      nodeVersion: "v22.0.0",
      platform: "darwin",
      arch: "arm64",
      isDesktop: false,
      electronVersion: null,
    },
  };
}
