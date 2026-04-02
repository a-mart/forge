import { execFile as execFileCallback } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { CodeStats, ModelDistributionEntry, ProviderUsageStats, StatsRange, StatsSnapshot, TokenStats } from "@forge/protocol";
import { ProviderUsageService } from "./provider-usage-service.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { getAgentsStoreFilePath, getProfilesDir, getSharedDir } from "../swarm/data-paths.js";

export const STATS_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATS_CACHE_FILE_NAME = "stats-cache.json";
const STATS_CACHE_VERSION = 5;
const SERVER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const GIT_COMMAND_TIMEOUT_MS = 10_000;
const GIT_COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const execFileAsync = promisify(execFileCallback);

interface SessionMetaLite {
  workers?: Array<{
    id?: string;
    createdAt?: string;
    terminatedAt?: string | null;
  }>;
}

interface UsageRecord {
  timestampMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  modelId: string;
  reasoningLevel: string;
}

interface DailyTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface WorkerRun {
  workerId: string;
  createdAtMs: number;
  terminatedAtMs: number | null;
  durationMs: number | null;
  billableTokens: number;
}

interface CacheEntry {
  expiresAt: number;
  timezone: string;
  snapshot: StatsSnapshot;
}

interface PersistedStatsCache {
  version: number;
  entries: Partial<Record<StatsRange, CacheEntry>>;
}

export class StatsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlightComputations = new Map<string, Promise<StatsSnapshot>>();
  private readonly cacheFilePath: string;
  private readonly providerUsageService: ProviderUsageService;

  private persistentCacheLoaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private refreshAllPromise: Promise<void> | null = null;

  constructor(private readonly swarmManager: SwarmManager) {
    const config = this.swarmManager.getConfig();
    this.cacheFilePath = join(getSharedDir(config.paths.dataDir), STATS_CACHE_FILE_NAME);
    this.providerUsageService = new ProviderUsageService(config.paths.sharedAuthFile);
  }

  async getSnapshot(
    range: StatsRange,
    options: { forceRefresh?: boolean; timezone?: string | null } = {}
  ): Promise<StatsSnapshot> {
    await this.ensurePersistentCacheLoaded();

    const timezone = normalizeTimezone(options.timezone);
    const cacheKey = this.getCacheKey(range);
    const inFlightKey = this.getInFlightKey(range, timezone);
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
        this.cache.set(cacheKey, {
          expiresAt: Date.now() + STATS_CACHE_TTL_MS,
          timezone,
          snapshot
        });
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

  async refreshAllRangesInBackground(): Promise<void> {
    if (this.refreshAllPromise) {
      return this.refreshAllPromise;
    }

    this.refreshAllPromise = (async () => {
      const ranges: StatsRange[] = ["7d", "30d", "all"];
      const timezone = SERVER_TIMEZONE;
      for (const range of ranges) {
        try {
          await this.getSnapshot(range, { forceRefresh: true, timezone });
        } catch {
          // keep refreshing other ranges even if one fails
        }
      }
    })()
      .catch(() => {
        // best-effort background refresh
      })
      .finally(() => {
        this.refreshAllPromise = null;
      });

    return this.refreshAllPromise;
  }

  private refreshRangeInBackground(range: StatsRange, timezone: string): void {
    void this.getSnapshot(range, { forceRefresh: true, timezone }).catch(() => {
      // best-effort stale-while-revalidate refresh
    });
  }

  private getCacheKey(range: StatsRange): string {
    return `stats:${range}`;
  }

  private getInFlightKey(range: StatsRange, timezone: string): string {
    return `stats:${range}:${timezone}`;
  }

  private async withLatestTokenStats(snapshot: StatsSnapshot, timezone: string): Promise<StatsSnapshot> {
    const latestTokens = this.getLatestTokenStatsForTimezone(timezone);
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
      ...(providersChanged ? { providers: latestProviders } : {})
    };
  }

  private getLatestTokenStatsForTimezone(timezone: string): TokenStats | null {
    const ranges: StatsRange[] = ["7d", "30d", "all"];
    let latestTokens: TokenStats | null = null;
    let latestComputedAtMs = Number.NEGATIVE_INFINITY;

    for (const range of ranges) {
      const entry = this.cache.get(this.getCacheKey(range));
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

  private async ensurePersistentCacheLoaded(): Promise<void> {
    if (this.persistentCacheLoaded) {
      return;
    }
    this.persistentCacheLoaded = true;

    try {
      const raw = await readFile(this.cacheFilePath, "utf8");
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

        this.cache.set(this.getCacheKey(range), {
          expiresAt,
          timezone,
          snapshot: entry.snapshot as StatsSnapshot
        });
      }
    } catch (error) {
      if (isEnoentError(error)) {
        return;
      }
      return;
    }
  }

  private queuePersistCacheWrite(): void {
    this.persistQueue = this.persistQueue
      .then(async () => {
        const entries: Partial<Record<StatsRange, CacheEntry>> = {};
        const entry7d = this.cache.get(this.getCacheKey("7d"));
        const entry30d = this.cache.get(this.getCacheKey("30d"));
        const entryAll = this.cache.get(this.getCacheKey("all"));

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
          entries
        };

        await mkdir(dirname(this.cacheFilePath), { recursive: true });
        await writeFile(this.cacheFilePath, JSON.stringify(payload), "utf8");
      })
      .catch(() => {
        // best-effort persistent cache write
      });
  }

  private async computeSnapshot(range: StatsRange, nowMs: number, timezone: string): Promise<StatsSnapshot> {
    const dataDir = this.swarmManager.getConfig().paths.dataDir;
    const profilesDir = getProfilesDir(dataDir);

    const profileIds = await this.listDirectoryNames(profilesDir);
    const scanResult = await this.scanProfilesData(dataDir, profileIds, timezone);

    const todayKey = toDayKey(nowMs, timezone);
    const yesterdayKey = shiftDayKey(todayKey, -1);
    const rangeStartMs = getRangeStartMs(range, nowMs, scanResult.earliestUsageDayKey, timezone);
    const rangeStartDayKey = toDayKey(rangeStartMs, timezone);
    const code = await this.computeCodeStats(scanResult.managerRepoPaths, rangeStartMs);

    const dailyEntriesInRange = this.buildDailyEntriesForRange(scanResult.dailyUsage, rangeStartDayKey, todayKey);

    const totalToday = scanResult.dailyUsage.get(todayKey) ?? emptyDailyTotals();
    const totalYesterday = scanResult.dailyUsage.get(yesterdayKey) ?? emptyDailyTotals();

    const last7 = this.sumDailyWindow(scanResult.dailyUsage, todayKey, 7);
    const last30 = this.sumDailyWindow(scanResult.dailyUsage, todayKey, 30);
    const allTime = this.sumDailyEntries(Array.from(scanResult.dailyUsage.values()));

    const rangeUsageRecords = scanResult.usageRecords.filter(
      (record) => toDayKey(record.timestampMs, timezone) >= rangeStartDayKey
    );
    const models = this.computeModelDistribution(rangeUsageRecords);
    const rangeTotals = this.sumDailyEntries(dailyEntriesInRange.map((entry) => entry.totals));

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

    const snapshot: StatsSnapshot = {
      computedAt: new Date(nowMs).toISOString(),
      uptimeMs: Math.round(process.uptime() * 1000),
      tokens: {
        today: totalToday.total,
        yesterday: totalYesterday.total,
        todayDate: formatDayLabel(todayKey),
        todayInputTokens: totalToday.input,
        todayOutputTokens: totalToday.output,
        last7Days: last7.total,
        last7DaysAvgPerDay: Math.round(last7.total / 7),
        last30Days: last30.total,
        allTime: allTime.total
      },
      cache: {
        hitRate: round2(
          rangeTotals.input + rangeTotals.cacheRead > 0
            ? (rangeTotals.cacheRead / (rangeTotals.input + rangeTotals.cacheRead)) * 100
            : 0
        ),
        hitRatePeriod: rangePeriodLabel(range),
        cachedTokensSaved: rangeTotals.cacheRead
      },
      workers: {
        totalWorkersRun: workerRunsInRange.length,
        totalWorkersRunPeriod: rangePeriodLabel(range),
        averageTokensPerRun: averageTokensPerRun,
        averageRuntimeMs: averageRuntimeMs,
        currentlyActive: scanResult.activeWorkerCount
      },
      code,
      sessions: {
        totalSessions: scanResult.totalSessionCount,
        activeSessions: scanResult.activeSessionCount,
        totalMessagesSent: totalMessagesInRange,
        totalMessagesPeriod: rangePeriodLabel(range)
      },
      activity: {
        longestStreak,
        streakLabel: "Across current usage range",
        activeDays: activeDays.length,
        activeDaysInRange: activeDays.length,
        totalDaysInRange: rangeDayCount,
        peakDay: peakDayEntry ? formatDayLabel(peakDayEntry.day) : "—",
        peakDayTokens: peakDayEntry?.tokens ?? 0
      },
      models,
      dailyUsage: dailyEntriesInRange.map((entry) => ({
        date: entry.day,
        dateLabel: formatDayLabel(entry.day),
        tokens: entry.totals.total,
        inputTokens: entry.totals.input,
        outputTokens: entry.totals.output,
        cachedTokens: entry.totals.cacheRead
      })),
      providers: await this.providerUsageService.getSnapshot(),
      system: {
        uptimeFormatted: formatUptime(Math.round(process.uptime() * 1000)),
        totalProfiles: profileIds.length,
        serverVersion: await this.readServerVersion(),
        nodeVersion: process.version
      }
    };

    return snapshot;
  }

  private async scanProfilesData(dataDir: string, profileIds: string[], timezone: string): Promise<{
    usageRecords: UsageRecord[];
    dailyUsage: Map<string, DailyTotals>;
    workerRuns: WorkerRun[];
    activeWorkerCount: number;
    totalSessionCount: number;
    activeSessionCount: number;
    userMessages: number[];
    earliestUsageDayKey: string | null;
    managerRepoPaths: string[];
  }> {
    const usageRecords: UsageRecord[] = [];
    const dailyUsage = new Map<string, DailyTotals>();
    const workerRuns: WorkerRun[] = [];
    const userMessages: number[] = [];

    let totalSessionCount = 0;

    for (const profileId of profileIds) {
      const sessionsDir = join(getProfilesDir(dataDir), profileId, "sessions");
      const sessionIds = await this.listDirectoryNames(sessionsDir);
      totalSessionCount += sessionIds.length;

      for (const sessionId of sessionIds) {
        const sessionDir = join(sessionsDir, sessionId);
        const sessionFile = join(sessionDir, "session.jsonl");
        const metaFile = join(sessionDir, "meta.json");
        const workersDir = join(sessionDir, "workers");
        const workerBillableTokenTotalsByRunKey = new Map<string, number>();

        await this.scanJsonlFile(sessionFile, (entry, context) => {
          this.collectUsageAndMessages(entry, usageRecords, dailyUsage, userMessages, {
            fallbackThinkingLevel: context.thinkingLevel,
            timezone
          });
        });

        const workerFiles = (await this.listFileNames(workersDir)).filter(
          (name) => name.endsWith(".jsonl") && !name.endsWith(".conversation.jsonl")
        );

        for (const workerFileName of workerFiles) {
          const workerId = workerFileName.slice(0, -".jsonl".length);
          const workerRunKey = toWorkerRunKey(profileId, sessionId, workerId);
          let billableTokensForWorker = 0;

          await this.scanJsonlFile(join(workersDir, workerFileName), (entry, context) => {
            billableTokensForWorker += this.collectUsageAndMessages(entry, usageRecords, dailyUsage, userMessages, {
              fallbackThinkingLevel: context.thinkingLevel,
              timezone
            });
          });

          workerBillableTokenTotalsByRunKey.set(workerRunKey, billableTokensForWorker);
        }

        const meta = await this.readSessionMeta(metaFile);
        if (meta) {
          for (const worker of meta.workers ?? []) {
            if (typeof worker.id === "string" && worker.id.endsWith(".conversation")) {
              continue;
            }

            const createdAtMs = toTimestampMs(worker.createdAt);
            if (createdAtMs === null) {
              continue;
            }

            const terminatedAtMs = toTimestampMs(worker.terminatedAt);
            const durationMs =
              terminatedAtMs !== null && terminatedAtMs >= createdAtMs ? terminatedAtMs - createdAtMs : null;
            const workerId = typeof worker.id === "string" && worker.id.trim().length > 0 ? worker.id : "unknown";
            const workerRunKey = toWorkerRunKey(profileId, sessionId, workerId);

            workerRuns.push({
              workerId,
              createdAtMs,
              terminatedAtMs,
              durationMs,
              billableTokens: workerBillableTokenTotalsByRunKey.get(workerRunKey) ?? 0
            });
          }
        }
      }
    }

    let earliestUsageDayKey: string | null = null;
    for (const day of dailyUsage.keys()) {
      if (earliestUsageDayKey === null || day < earliestUsageDayKey) {
        earliestUsageDayKey = day;
      }
    }

    const agents = await this.readAgentsRegistry(dataDir);
    const activeWorkerCount = agents.filter((agent) => agent.role === "worker" && agent.status === "streaming").length;
    const activeSessionCount = agents.filter(
      (agent) => agent.role === "manager" && agent.status !== "terminated" && agent.status !== "stopped"
    ).length;
    const managerRepoPaths = collectManagerRepoPaths(agents);

    return {
      usageRecords,
      dailyUsage,
      workerRuns,
      activeWorkerCount,
      totalSessionCount,
      activeSessionCount,
      userMessages,
      earliestUsageDayKey,
      managerRepoPaths
    };
  }

  private collectUsageAndMessages(
    entry: unknown,
    usageRecords: UsageRecord[],
    dailyUsage: Map<string, DailyTotals>,
    userMessages: number[],
    options: { fallbackThinkingLevel: string | null; timezone: string }
  ): number {
    if (!isRecord(entry)) {
      return 0;
    }

    if (entry.type === "message" && isRecord(entry.message)) {
      const timestampMs =
        toTimestampMs(entry.timestamp) ??
        toTimestampMs((entry.message as Record<string, unknown>).timestamp) ??
        Date.now();

      const usage = extractUsage((entry.message as Record<string, unknown>).usage);
      if (usage) {
        const modelId = extractModelId(entry.message);
        const day = toDayKey(timestampMs, options.timezone);
        const reasoningLevel = extractReasoningLevel(entry.message, options.fallbackThinkingLevel);

        usageRecords.push({
          timestampMs,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          total: usage.total,
          modelId,
          reasoningLevel
        });

        const existing = dailyUsage.get(day) ?? emptyDailyTotals();
        dailyUsage.set(day, {
          input: existing.input + usage.input,
          output: existing.output + usage.output,
          cacheRead: existing.cacheRead + usage.cacheRead,
          cacheWrite: existing.cacheWrite + usage.cacheWrite,
          total: existing.total + usage.total
        });

        return usage.input + usage.output;
      }

      return 0;
    }

    if (
      entry.type === "custom" &&
      entry.customType === "swarm_conversation_entry" &&
      isRecord(entry.data) &&
      entry.data.type === "conversation_message" &&
      entry.data.role === "user" &&
      entry.data.source === "user_input"
    ) {
      const ts = toTimestampMs(entry.data.timestamp);
      if (ts !== null) {
        userMessages.push(ts);
      }
    }

    return 0;
  }

  private async scanJsonlFile(
    path: string,
    onEntry: (entry: unknown, context: { thinkingLevel: string | null }) => void
  ): Promise<void> {
    try {
      const stream = createReadStream(path, { encoding: "utf8" });
      const reader = createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY
      });
      let thinkingLevel: string | null = null;

      try {
        for await (const line of reader) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (isRecord(parsed)) {
              const thinkingLevelChange = extractThinkingLevelChange(parsed);
              if (thinkingLevelChange !== null) {
                thinkingLevel = thinkingLevelChange;
              }
            }

            onEntry(parsed, { thinkingLevel });
          } catch {
            // ignore malformed lines
          }
        }
      } finally {
        reader.close();
      }
    } catch (error) {
      if (isEnoentError(error)) {
        return;
      }
      return;
    }
  }

  private async readSessionMeta(path: string): Promise<SessionMetaLite | null> {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as SessionMetaLite;
    } catch (error) {
      if (isEnoentError(error)) {
        return null;
      }
      return null;
    }
  }

  private async readAgentsRegistry(dataDir: string): Promise<Array<{ role?: string; status?: string; cwd?: string }>> {
    const path = getAgentsStoreFilePath(dataDir);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as { agents?: unknown };
      return Array.isArray(parsed.agents)
        ? parsed.agents.filter((agent): agent is { role?: string; status?: string; cwd?: string } => isRecord(agent))
        : [];
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }
      return [];
    }
  }

  private async computeCodeStats(repoPaths: string[], rangeStartMs: number): Promise<CodeStats> {
    if (repoPaths.length === 0) {
      return {
        linesAdded: 0,
        linesDeleted: 0,
        commits: 0,
        repos: 0
      };
    }

    const sinceIso = new Date(rangeStartMs).toISOString();
    let linesAdded = 0;
    let linesDeleted = 0;
    let commits = 0;
    let repos = 0;

    for (const repoPath of repoPaths) {
      try {
        if (!(await this.isGitRepo(repoPath))) {
          continue;
        }

        const author = await this.getRepoAuthor(repoPath);
        if (!author) {
          continue;
        }

        const numstatOutput = await this.runGitCommand(repoPath, [
          "log",
          `--author=${author}`,
          `--since=${sinceIso}`,
          "--numstat",
          "--format="
        ]);
        const parsedNumstat = parseNumstatTotals(numstatOutput);

        const commitCount = await this.countCommits(repoPath, author, sinceIso);

        linesAdded += parsedNumstat.linesAdded;
        linesDeleted += parsedNumstat.linesDeleted;
        commits += commitCount;

        if (commitCount > 0 || parsedNumstat.linesAdded > 0 || parsedNumstat.linesDeleted > 0) {
          repos += 1;
        }
      } catch {
        // skip repositories where git commands fail
      }
    }

    return {
      linesAdded,
      linesDeleted,
      commits,
      repos
    };
  }

  private async getRepoAuthor(repoPath: string): Promise<string | null> {
    const email = await this.getGitConfigValue(repoPath, "user.email");
    if (email) {
      return email;
    }

    return this.getGitConfigValue(repoPath, "user.name");
  }

  private async getGitConfigValue(repoPath: string, key: string): Promise<string | null> {
    try {
      const output = await this.runGitCommand(repoPath, ["config", "--get", key]);
      const value = output.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  private async isGitRepo(repoPath: string): Promise<boolean> {
    try {
      const output = await this.runGitCommand(repoPath, ["rev-parse", "--is-inside-work-tree"]);
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  private async countCommits(repoPath: string, author: string, sinceIso: string): Promise<number> {
    const output = await this.runGitCommand(repoPath, [
      "log",
      `--author=${author}`,
      `--since=${sinceIso}`,
      "--format=%H"
    ]);

    return output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  }

  private async runGitCommand(repoPath: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
      windowsHide: true
    });

    return typeof result.stdout === "string" ? result.stdout : `${result.stdout ?? ""}`;
  }

  private async listDirectoryNames(path: string): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }
      return [];
    }
  }

  private async listFileNames(path: string): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }
      return [];
    }
  }

  private sumDailyWindow(daily: Map<string, DailyTotals>, todayDayKey: string, days: number): DailyTotals {
    const startDayKey = shiftDayKey(todayDayKey, -(days - 1));
    const values = Array.from(daily.entries())
      .filter(([day]) => day >= startDayKey)
      .map(([, totals]) => totals);

    return this.sumDailyEntries(values);
  }

  private buildDailyEntriesForRange(
    daily: Map<string, DailyTotals>,
    rangeStartDayKey: string,
    rangeEndDayKey: string
  ): Array<{ day: string; totals: DailyTotals }> {
    const startOrdinal = dayKeyToOrdinal(rangeStartDayKey);
    const endOrdinal = dayKeyToOrdinal(rangeEndDayKey);

    if (startOrdinal === null || endOrdinal === null || endOrdinal < startOrdinal) {
      return [];
    }

    const entries: Array<{ day: string; totals: DailyTotals }> = [];
    for (let ordinal = startOrdinal; ordinal <= endOrdinal; ordinal += 1) {
      const day = ordinalToDayKey(ordinal);
      entries.push({
        day,
        totals: daily.get(day) ?? emptyDailyTotals()
      });
    }

    return entries;
  }

  private sumDailyEntries(values: DailyTotals[]): DailyTotals {
    return values.reduce(
      (sum, value) => ({
        input: sum.input + value.input,
        output: sum.output + value.output,
        cacheRead: sum.cacheRead + value.cacheRead,
        cacheWrite: sum.cacheWrite + value.cacheWrite,
        total: sum.total + value.total
      }),
      emptyDailyTotals()
    );
  }

  private computeModelDistribution(usageRecords: UsageRecord[]): ModelDistributionEntry[] {
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
            percentage: tokenCount > 0 ? round2((levelTokenCount / tokenCount) * 100) : 0
          }))
          .sort((left, right) => right.tokenCount - left.tokenCount);

        return {
          modelId,
          displayName: modelId,
          percentage: round2((tokenCount / grandTotal) * 100),
          tokenCount,
          reasoningBreakdown
        };
      })
      .sort((left, right) => right.tokenCount - left.tokenCount)
      .slice(0, 10);
  }

  private async readServerVersion(): Promise<string> {
    try {
      const packageJsonPath = join(this.swarmManager.getConfig().paths.rootDir, "package.json");
      const raw = await readFile(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === "string" ? parsed.version : "1.0.0";
    } catch {
      return "1.0.0";
    }
  }
}

function collectManagerRepoPaths(
  agents: Array<{ role?: string; status?: string; cwd?: string }>
): string[] {
  const uniquePaths = new Set<string>();

  for (const agent of agents) {
    if (agent.role !== "manager" || typeof agent.cwd !== "string") {
      continue;
    }

    const cwd = agent.cwd.trim();
    if (cwd.length === 0) {
      continue;
    }

    uniquePaths.add(resolve(cwd));
  }

  return Array.from(uniquePaths.values());
}

function parseNumstatTotals(output: string): { linesAdded: number; linesDeleted: number } {
  let linesAdded = 0;
  let linesDeleted = 0;

  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split("\t");
    if (parts.length < 3) {
      continue;
    }

    const additionsRaw = parts[0]?.trim() ?? "";
    const deletionsRaw = parts[1]?.trim() ?? "";
    if (additionsRaw === "-" || deletionsRaw === "-") {
      continue;
    }

    const additions = Number.parseInt(additionsRaw, 10);
    const deletions = Number.parseInt(deletionsRaw, 10);

    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
      continue;
    }

    linesAdded += additions;
    linesDeleted += deletions;
  }

  return { linesAdded, linesDeleted };
}

function extractUsage(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null {
  if (!isRecord(value)) {
    return null;
  }

  const input = toSafeNumber(value.input ?? value.input_tokens);
  const output = toSafeNumber(value.output ?? value.output_tokens);
  const cacheRead = toSafeNumber(value.cacheRead ?? value.cache_read_input_tokens ?? value.cached_tokens);
  const cacheWrite = toSafeNumber(value.cacheWrite ?? value.cache_creation_input_tokens);
  const total = toSafeNumber(value.totalTokens, input + output + cacheRead + cacheWrite);

  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === 0) {
    return null;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total
  };
}

function extractModelId(message: unknown): string {
  if (!isRecord(message)) {
    return "unknown";
  }

  if (typeof message.model === "string" && message.model.trim().length > 0) {
    return message.model;
  }

  const provider = typeof message.provider === "string" ? message.provider.trim() : "";
  const modelId = typeof message.modelId === "string" ? message.modelId.trim() : "";
  if (provider && modelId) {
    return `${provider}/${modelId}`;
  }

  return modelId || provider || "unknown";
}

function extractReasoningLevel(message: unknown, fallbackThinkingLevel: string | null): string {
  if (!isRecord(message)) {
    return fallbackThinkingLevel ?? "default";
  }

  const explicit =
    normalizeReasoningLevel(message.reasoningLevel) ??
    normalizeReasoningLevel(message.thinkingLevel) ??
    normalizeReasoningLevel(message.reasoning_effort) ??
    normalizeReasoningLevel(message.reasoningEffort) ??
    normalizeReasoningLevel(message.reasoning);

  return explicit ?? fallbackThinkingLevel ?? "default";
}

function normalizeReasoningLevel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function extractThinkingLevelChange(entry: Record<string, unknown>): string | null {
  if (entry.type === "thinking_level_change") {
    return normalizeReasoningLevel(entry.thinkingLevel);
  }

  if (entry.type === "reasoning_level_change") {
    return normalizeReasoningLevel(entry.reasoningLevel);
  }

  return null;
}

function toWorkerRunKey(profileId: string, sessionId: string, workerId: string): string {
  return `${profileId}/${sessionId}/${workerId}`;
}

function toSafeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return fallback;
}

function getRangeStartMs(
  range: StatsRange,
  nowMs: number,
  earliestUsageDayKey: string | null,
  timezone: string
): number {
  const todayKey = toDayKey(nowMs, timezone);

  if (range === "7d") {
    return dayKeyToStartMs(shiftDayKey(todayKey, -6), timezone);
  }

  if (range === "30d") {
    return dayKeyToStartMs(shiftDayKey(todayKey, -29), timezone);
  }

  return dayKeyToStartMs(earliestUsageDayKey ?? todayKey, timezone);
}

function computeRangeDayCount(range: StatsRange, todayDayKey: string, rangeStartDayKey: string): number {
  if (range === "7d") {
    return 7;
  }

  if (range === "30d") {
    return 30;
  }

  const todayOrdinal = dayKeyToOrdinal(todayDayKey);
  const rangeStartOrdinal = dayKeyToOrdinal(rangeStartDayKey);
  if (todayOrdinal === null || rangeStartOrdinal === null) {
    return 1;
  }

  const count = todayOrdinal - rangeStartOrdinal + 1;
  return Math.max(1, count);
}

function rangePeriodLabel(range: StatsRange): string {
  if (range === "7d") {
    return "Last 7 days";
  }

  if (range === "30d") {
    return "Last 30 days";
  }

  return "All time";
}

function computeLongestStreak(activeDays: string[]): number {
  if (activeDays.length === 0) {
    return 0;
  }

  const sorted = activeDays.slice().sort((left, right) => left.localeCompare(right));
  let longest = 1;
  let current = 1;

  for (let index = 1; index < sorted.length; index += 1) {
    const prev = dayKeyToMs(sorted[index - 1]);
    const next = dayKeyToMs(sorted[index]);

    if (next - prev === DAY_MS) {
      current += 1;
      if (current > longest) {
        longest = current;
      }
      continue;
    }

    current = 1;
  }

  return longest;
}

function emptyDailyTotals(): DailyTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0
  };
}

function toTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1000);
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeTimezone(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return SERVER_TIMEZONE;
  }

  const timezone = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return SERVER_TIMEZONE;
  }
}

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();

function toDayKey(timestampMs: number, timezone: string): string {
  const formatter = getDayKeyFormatter(timezone);
  const parts = formatter.formatToParts(new Date(timestampMs));

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    const fallbackDate = new Date(timestampMs);
    const fallbackYear = fallbackDate.getUTCFullYear();
    const fallbackMonth = `${fallbackDate.getUTCMonth() + 1}`.padStart(2, "0");
    const fallbackDay = `${fallbackDate.getUTCDate()}`.padStart(2, "0");
    return `${fallbackYear}-${fallbackMonth}-${fallbackDay}`;
  }

  return `${year}-${month}-${day}`;
}

function getDayKeyFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = dayKeyFormatters.get(timezone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  dayKeyFormatters.set(timezone, formatter);
  return formatter;
}

function startOfDayMs(timestampMs: number, timezone: string): number {
  return dayKeyToStartMs(toDayKey(timestampMs, timezone), timezone);
}

function dayKeyToStartMs(dayKey: string, timezone: string): number {
  const baseMs = dayKeyToMs(dayKey);
  if (baseMs <= 0) {
    return 0;
  }

  const [yearRaw, monthRaw, dayRaw] = dayKey.split("-");
  const year = Number.parseInt(yearRaw ?? "", 10);
  const month = Number.parseInt(monthRaw ?? "", 10);
  const day = Number.parseInt(dayRaw ?? "", 10);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return 0;
  }

  const localMidnightAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let adjusted = localMidnightAsUtc;

  for (let index = 0; index < 3; index += 1) {
    const offsetMs = getTimeZoneOffsetMs(adjusted, timezone);
    const next = localMidnightAsUtc - offsetMs;
    if (next === adjusted) {
      break;
    }
    adjusted = next;
  }

  return adjusted;
}

const dateTimePartFormatters = new Map<string, Intl.DateTimeFormat>();

function getTimeZoneOffsetMs(timestampMs: number, timezone: string): number {
  const formatter = getDateTimePartFormatter(timezone);
  const parts = formatter.formatToParts(new Date(timestampMs));

  const year = Number.parseInt(parts.find((part) => part.type === "year")?.value ?? "", 10);
  const month = Number.parseInt(parts.find((part) => part.type === "month")?.value ?? "", 10);
  const day = Number.parseInt(parts.find((part) => part.type === "day")?.value ?? "", 10);
  const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "", 10);
  const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "", 10);
  const second = Number.parseInt(parts.find((part) => part.type === "second")?.value ?? "", 10);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return 0;
  }

  const utcEquivalent = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const roundedTimestampMs = Math.floor(timestampMs / 1000) * 1000;
  return utcEquivalent - roundedTimestampMs;
}

function getDateTimePartFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = dateTimePartFormatters.get(timezone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  dateTimePartFormatters.set(timezone, formatter);
  return formatter;
}

function shiftDayKey(dayKey: string, offsetDays: number): string {
  const ms = dayKeyToMs(dayKey);
  if (!Number.isFinite(ms) || ms <= 0) {
    return dayKey;
  }

  const date = new Date(ms);
  date.setUTCDate(date.getUTCDate() + offsetDays);

  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayKeyToOrdinal(dayKey: string): number | null {
  const dayMs = dayKeyToMs(dayKey);
  if (!Number.isFinite(dayMs) || dayMs <= 0) {
    return null;
  }

  return Math.floor(dayMs / DAY_MS);
}

function ordinalToDayKey(ordinal: number): string {
  if (!Number.isFinite(ordinal)) {
    return "1970-01-01";
  }

  const date = new Date(ordinal * DAY_MS);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayKeyToMs(dayKey: string): number {
  const [yearRaw, monthRaw, dayRaw] = dayKey.split("-");
  const year = Number.parseInt(yearRaw ?? "", 10);
  const month = Number.parseInt(monthRaw ?? "", 10);
  const day = Number.parseInt(dayRaw ?? "", 10);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return 0;
  }

  return Date.UTC(year, month - 1, day);
}

function formatDayLabel(dayKey: string): string {
  const ms = dayKeyToMs(dayKey);
  if (!Number.isFinite(ms) || ms <= 0) {
    return dayKey;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(new Date(ms));
}

function formatUptime(uptimeMs: number): string {
  const days = Math.floor(uptimeMs / DAY_MS);
  const hours = Math.floor((uptimeMs % DAY_MS) / (60 * 60 * 1000));
  const minutes = Math.floor((uptimeMs % (60 * 60 * 1000)) / (60 * 1000));

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || days > 0) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);

  return parts.join(" ");
}

function trimmedMean(values: number[]): number {
  const normalized = values.filter((value) => Number.isFinite(value) && value >= 0).map((value) => Math.round(value)).sort((left, right) => left - right);

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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
