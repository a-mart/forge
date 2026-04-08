import { join } from "node:path";
import type { ProviderUsageStats, StatsRange, StatsSnapshot, TokenStats } from "@forge/protocol";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { getProfilesDir, getSharedStatsCachePath } from "../swarm/data-paths.js";
import { ProviderUsageService } from "./provider-usage-service.js";
import {
  createStatsCacheEntry,
  getLatestTokenStatsForTimezone,
  getStatsCacheKey,
  getStatsInFlightKey,
  loadPersistedStatsCache,
  persistStatsCache,
} from "./stats-cache.js";
import { computeCodeStats, readServerVersion } from "./stats-git.js";
import {
  isEnoentError,
  isRecord,
  extractReasoningLevel,
  extractThinkingLevelChange,
  extractUsage,
  listDirectoryNames,
  STATS_CACHE_TTL_MS,
  toTimestampMs,
} from "./stats-shared.js";
import { buildDailyEntriesForRange, scanProfilesData, sumDailyWindow } from "./stats-scan.js";
import {
  computeLongestStreak,
  computeRangeDayCount,
  dayKeyToStartMs,
  formatDayLabel,
  formatUptime,
  getRangeStartMs,
  normalizeTimezone,
  rangePeriodLabel,
  shiftDayKey,
  toDayKey,
} from "./stats-time.js";
import type { CacheEntry, StatsServiceOptions } from "./stats-types.js";
import { computeModelDistribution, computeProvidersUsed, emptyDailyTotals, round2, sumDailyEntries, trimmedMean } from "./stats-usage.js";

export { STATS_CACHE_TTL_MS, extractReasoningLevel, extractThinkingLevelChange, extractUsage, isEnoentError, isRecord, toTimestampMs } from "./stats-shared.js";
export { dayKeyToStartMs, normalizeTimezone, shiftDayKey, toDayKey } from "./stats-time.js";
export type { StatsServiceOptions } from "./stats-types.js";

export class StatsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlightComputations = new Map<string, Promise<StatsSnapshot>>();
  private readonly cacheFilePath: string;
  private readonly providerUsageService: ProviderUsageService;

  private persistentCacheLoaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private refreshAllPromise: Promise<StatsSnapshot | null> | null = null;
  private readonly onRefreshAllCompleted: ((snapshot: StatsSnapshot | null) => void | Promise<void>) | null;

  constructor(private readonly swarmManager: SwarmManager, options: StatsServiceOptions = {}) {
    this.onRefreshAllCompleted = options.onRefreshAllCompleted ?? null;

    const config = this.swarmManager.getConfig();
    this.cacheFilePath = getSharedStatsCachePath(config.paths.dataDir);
    this.providerUsageService = new ProviderUsageService(
      config.paths.sharedAuthFile,
      join(config.paths.sharedCacheDir, "provider-usage-history.jsonl"),
      join(config.paths.sharedCacheDir, "provider-usage-cache.json")
    );

    this.providerUsageService.setCredentialPoolGetter(() => this.swarmManager.getCredentialPoolService());
  }

  async getSnapshot(
    range: StatsRange,
    options: { forceRefresh?: boolean; timezone?: string | null } = {}
  ): Promise<StatsSnapshot> {
    await this.ensurePersistentCacheLoaded();

    const timezone = normalizeTimezone(options.timezone);
    const cacheKey = getStatsCacheKey(range);
    const inFlightKey = getStatsInFlightKey(range, timezone);
    const nowMs = Date.now();

    if (!options.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.timezone === timezone && cached.expiresAt > nowMs) {
        return this.withLatestTokenStats(cached.snapshot, timezone);
      }

      if (cached && cached.timezone === timezone) {
        void this.refreshRangeInBackground(range, timezone);
        return this.withLatestTokenStats(cached.snapshot, timezone);
      }
    }

    const inFlight = this.inFlightComputations.get(inFlightKey);
    if (inFlight) {
      return inFlight.then((snapshot) => this.withLatestTokenStats(snapshot, timezone));
    }

    const computePromise = this.computeSnapshot(range, nowMs, timezone)
      .then((snapshot) => {
        this.cache.set(cacheKey, createStatsCacheEntry(snapshot, timezone));
        this.queuePersistCacheWrite();
        return snapshot;
      })
      .finally(() => {
        this.inFlightComputations.delete(inFlightKey);
      });

    this.inFlightComputations.set(inFlightKey, computePromise);
    return computePromise.then((snapshot) => this.withLatestTokenStats(snapshot, timezone));
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getProviderUsage(): Promise<ProviderUsageStats> {
    return this.providerUsageService.getSnapshot();
  }

  async refreshAllRangesInBackground(): Promise<StatsSnapshot | null> {
    if (this.refreshAllPromise) {
      return this.refreshAllPromise;
    }

    const refreshPromise = (async () => {
      const ranges: StatsRange[] = ["7d", "30d", "all"];
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      let allSnapshot: StatsSnapshot | null = null;
      for (const range of ranges) {
        try {
          const snapshot = await this.getSnapshot(range, { forceRefresh: true, timezone });
          if (range === "all") {
            allSnapshot = snapshot;
          }
        } catch {
          // keep refreshing other ranges even if one fails
        }
      }
      return allSnapshot;
    })().catch(() => null);

    this.refreshAllPromise = refreshPromise
      .then((snapshot) => {
        this.notifyRefreshAllCompleted(snapshot);
        return snapshot;
      })
      .finally(() => {
        this.refreshAllPromise = null;
      });

    return this.refreshAllPromise;
  }

  private notifyRefreshAllCompleted(snapshot: StatsSnapshot | null): void {
    if (!this.onRefreshAllCompleted) {
      return;
    }

    void Promise.resolve(this.onRefreshAllCompleted(snapshot)).catch(() => {
      // best-effort refresh completion hook
    });
  }

  private refreshRangeInBackground(range: StatsRange, timezone: string): void {
    void this.getSnapshot(range, { forceRefresh: true, timezone }).catch(() => {
      // best-effort stale-while-revalidate refresh
    });
  }

  private async withLatestTokenStats(snapshot: StatsSnapshot, timezone: string): Promise<StatsSnapshot> {
    const latestTokens = getLatestTokenStatsForTimezone(this.cache, timezone);
    const latestProviders = await this.providerUsageService.getSnapshot();

    const tokensChanged = Boolean(latestTokens && latestTokens !== snapshot.tokens);
    const providersChanged =
      snapshot.providers.openai !== latestProviders.openai ||
      snapshot.providers.anthropic !== latestProviders.anthropic;

    if (!tokensChanged && !providersChanged) {
      return snapshot;
    }

    return {
      ...snapshot,
      ...(tokensChanged ? { tokens: latestTokens ?? snapshot.tokens } : {}),
      ...(providersChanged ? { providers: latestProviders } : {}),
    };
  }

  private async ensurePersistentCacheLoaded(): Promise<void> {
    if (this.persistentCacheLoaded) {
      return;
    }
    this.persistentCacheLoaded = true;
    await loadPersistedStatsCache(this.cacheFilePath, this.cache);
  }

  private queuePersistCacheWrite(): void {
    this.persistQueue = this.persistQueue
      .then(() => persistStatsCache(this.cacheFilePath, this.cache))
      .catch(() => {
        // best-effort persistent cache write
      });
  }

  private async computeSnapshot(range: StatsRange, nowMs: number, timezone: string): Promise<StatsSnapshot> {
    const dataDir = this.swarmManager.getConfig().paths.dataDir;
    const profileIds = await listDirectoryNames(getProfilesDir(dataDir));
    const scanResult = await scanProfilesData(dataDir, profileIds, timezone);

    const todayKey = toDayKey(nowMs, timezone);
    const yesterdayKey = shiftDayKey(todayKey, -1);
    const rangeStartMs = getRangeStartMs(range, nowMs, scanResult.earliestUsageDayKey, timezone);
    const rangeStartDayKey = toDayKey(rangeStartMs, timezone);
    const code = await computeCodeStats(scanResult.managerRepoPaths, rangeStartMs);

    const dailyEntriesInRange = buildDailyEntriesForRange(scanResult.dailyUsage, rangeStartDayKey, todayKey);

    const totalToday = scanResult.dailyUsage.get(todayKey) ?? emptyDailyTotals();
    const totalYesterday = scanResult.dailyUsage.get(yesterdayKey) ?? emptyDailyTotals();

    const last7 = sumDailyWindow(scanResult.dailyUsage, todayKey, 7);
    const last30 = sumDailyWindow(scanResult.dailyUsage, todayKey, 30);
    const allTime = sumDailyEntries(Array.from(scanResult.dailyUsage.values()));

    const rangeUsageRecords = scanResult.usageRecords.filter(
      (record) => toDayKey(record.timestampMs, timezone) >= rangeStartDayKey
    );
    const models = computeModelDistribution(rangeUsageRecords);
    const allProviders = computeProvidersUsed(rangeUsageRecords);
    const rangeTotals = sumDailyEntries(dailyEntriesInRange.map((entry) => entry.totals));

    const workerRunsInRange = scanResult.workerRuns.filter((run) => toDayKey(run.createdAtMs, timezone) >= rangeStartDayKey);
    const completedWorkerRunsInRange = workerRunsInRange.filter(
      (run) => run.terminatedAtMs !== null && typeof run.durationMs === "number" && run.durationMs >= 0
    );

    const averageRuntimeMs = trimmedMean(
      completedWorkerRunsInRange
        .map((run) => run.durationMs)
        .filter((durationMs): durationMs is number => typeof durationMs === "number" && durationMs >= 0)
    );

    const averageTokensPerRun = trimmedMean(
      completedWorkerRunsInRange.map((run) => run.billableTokens).filter((tokens) => Number.isFinite(tokens) && tokens >= 0)
    );

    const activeDays = dailyEntriesInRange.filter((entry) => entry.totals.total > 0).map((entry) => entry.day);
    const longestStreak = computeLongestStreak(activeDays);

    const peakDayEntry = dailyEntriesInRange
      .filter((entry) => entry.totals.total > 0)
      .reduce<{ day: string; tokens: number } | null>((best, entry) => {
        if (!best || entry.totals.total > best.tokens) {
          return { day: entry.day, tokens: entry.totals.total };
        }
        return best;
      }, null);

    const totalMessagesInRange = scanResult.userMessages.filter(
      (messageMs) => toDayKey(messageMs, timezone) >= rangeStartDayKey
    ).length;
    const rangeDayCount = computeRangeDayCount(range, todayKey, rangeStartDayKey);
    const uptimeMs = Math.round(process.uptime() * 1000);

    return {
      computedAt: new Date(nowMs).toISOString(),
      uptimeMs,
      tokens: buildTokenStats(totalToday, totalYesterday, todayKey, last7, last30, allTime),
      cache: {
        hitRate: round2(
          rangeTotals.input + rangeTotals.cacheRead > 0
            ? (rangeTotals.cacheRead / (rangeTotals.input + rangeTotals.cacheRead)) * 100
            : 0
        ),
        hitRatePeriod: rangePeriodLabel(range),
        cachedTokensSaved: rangeTotals.cacheRead,
      },
      workers: {
        totalWorkersRun: workerRunsInRange.length,
        totalWorkersRunPeriod: rangePeriodLabel(range),
        averageTokensPerRun,
        averageRuntimeMs,
        currentlyActive: scanResult.activeWorkerCount,
      },
      code,
      sessions: {
        totalSessions: scanResult.totalSessionCount,
        activeSessions: scanResult.activeSessionCount,
        totalMessagesSent: totalMessagesInRange,
        totalMessagesPeriod: rangePeriodLabel(range),
      },
      activity: {
        longestStreak,
        streakLabel: "Across current usage range",
        activeDays: activeDays.length,
        activeDaysInRange: activeDays.length,
        totalDaysInRange: rangeDayCount,
        peakDay: peakDayEntry ? formatDayLabel(peakDayEntry.day) : "—",
        peakDayTokens: peakDayEntry?.tokens ?? 0,
      },
      models,
      allProviders,
      dailyUsage: dailyEntriesInRange.map((entry) => ({
        date: entry.day,
        dateLabel: formatDayLabel(entry.day),
        tokens: entry.totals.total,
        inputTokens: entry.totals.input,
        outputTokens: entry.totals.output,
        cachedTokens: entry.totals.cacheRead,
      })),
      providers: await this.providerUsageService.getSnapshot(),
      system: {
        uptimeFormatted: formatUptime(uptimeMs),
        totalProfiles: profileIds.length,
        serverVersion: await readServerVersion(this.swarmManager.getConfig().paths.rootDir),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        isDesktop: this.swarmManager.getConfig().isDesktop,
        electronVersion: process.env.FORGE_ELECTRON_VERSION ?? null,
      },
    };
  }
}

function buildTokenStats(
  totalToday: TokenStatsBreakdown,
  totalYesterday: TokenStatsBreakdown,
  todayKey: string,
  last7: TokenStatsBreakdown,
  last30: TokenStatsBreakdown,
  allTime: TokenStatsBreakdown
): TokenStats {
  return {
    today: totalToday.total,
    yesterday: totalYesterday.total,
    todayDate: formatDayLabel(todayKey),
    todayInputTokens: totalToday.input,
    todayOutputTokens: totalToday.output,
    last7Days: last7.total,
    last7DaysAvgPerDay: Math.round(last7.total / 7),
    last30Days: last30.total,
    allTime: allTime.total,
  };
}

type TokenStatsBreakdown = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};
