import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ModelDistributionEntry, StatsRange, StatsSnapshot } from "@forge/protocol";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { getAgentsStoreFilePath, getProfilesDir, getSharedDir } from "../swarm/data-paths.js";

export const STATS_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATS_CACHE_FILE_NAME = "stats-cache.json";

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
  totalTokens: number;
}

interface CacheEntry {
  expiresAt: number;
  snapshot: StatsSnapshot;
}

interface PersistedStatsCache {
  version: number;
  entries: Partial<Record<StatsRange, CacheEntry>>;
}

export class StatsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly swarmManager: SwarmManager) {}

  async getSnapshot(range: StatsRange, options: { forceRefresh?: boolean } = {}): Promise<StatsSnapshot> {
    const key = this.getCacheKey(range);
    const nowMs = Date.now();

    if (!options.forceRefresh) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > nowMs) {
        return cached.snapshot;
      }
    }

    const snapshot = await this.computeSnapshot(range, nowMs);
    this.cache.set(key, {
      expiresAt: nowMs + CACHE_TTL_MS,
      snapshot
    });

    return snapshot;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private getCacheKey(range: StatsRange): string {
    return `stats:${range}`;
  }

  private async computeSnapshot(range: StatsRange, nowMs: number): Promise<StatsSnapshot> {
    const dataDir = this.swarmManager.getConfig().paths.dataDir;
    const profilesDir = getProfilesDir(dataDir);

    const profileIds = await this.listDirectoryNames(profilesDir);
    const scanResult = await this.scanProfilesData(dataDir, profileIds);

    const todayKey = toDayKey(nowMs);
    const rangeStartMs = getRangeStartMs(range, nowMs, scanResult.earliestUsageDayMs);

    const dailyEntriesInRange = Array.from(scanResult.dailyUsage.entries())
      .map(([day, totals]) => ({ day, totals, dayMs: dayKeyToMs(day) }))
      .filter((entry) => entry.dayMs >= rangeStartMs)
      .sort((left, right) => left.day.localeCompare(right.day));

    const totalToday = scanResult.dailyUsage.get(todayKey) ?? emptyDailyTotals();

    const last7 = this.sumDailyWindow(scanResult.dailyUsage, nowMs, 7);
    const last30 = this.sumDailyWindow(scanResult.dailyUsage, nowMs, 30);
    const allTime = this.sumDailyEntries(Array.from(scanResult.dailyUsage.values()));

    const rangeUsageRecords = scanResult.usageRecords.filter((record) => record.timestampMs >= rangeStartMs);
    const models = this.computeModelDistribution(rangeUsageRecords);
    const rangeTotals = this.sumDailyEntries(dailyEntriesInRange.map((entry) => entry.totals));

    const workerRunsInRange = scanResult.workerRuns.filter((run) => run.createdAtMs >= rangeStartMs);
    const workerDurations = workerRunsInRange
      .map((run) => run.durationMs)
      .filter((duration): duration is number => typeof duration === "number" && duration >= 0);

    const totalDurationMs = workerDurations.reduce((sum, duration) => sum + duration, 0);
    const averageRuntimeMs = workerDurations.length > 0 ? Math.round(totalDurationMs / workerDurations.length) : 0;

    const activeDays = dailyEntriesInRange.filter((entry) => entry.totals.total > 0).map((entry) => entry.day);
    const longestStreak = computeLongestStreak(activeDays);

    const peakDayEntry = dailyEntriesInRange.reduce<{ day: string; tokens: number } | null>((best, entry) => {
      if (!best || entry.totals.total > best.tokens) {
        return { day: entry.day, tokens: entry.totals.total };
      }
      return best;
    }, null);

    const rangeDayCount = computeRangeDayCount(range, nowMs, rangeStartMs);

    const snapshot: StatsSnapshot = {
      computedAt: new Date(nowMs).toISOString(),
      uptimeMs: Math.round(process.uptime() * 1000),
      tokens: {
        today: totalToday.total,
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
        averageTokensPerRun:
          workerRunsInRange.length > 0 ? Math.round(rangeTotals.total / workerRunsInRange.length) : 0,
        averageRuntimeMs,
        currentlyActive: scanResult.activeWorkerCount
      },
      sessions: {
        totalSessions: scanResult.totalSessionCount,
        activeSessions: scanResult.activeSessionCount,
        totalMessagesSent: scanResult.userMessages.filter((messageMs) => messageMs >= rangeStartMs).length,
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
      // TODO(stats): Replace placeholder provider usage with real account/subscription data.
      providers: {
        anthropic: {
          provider: "anthropic",
          available: false,
          error: "No subscription data available"
        },
        openai: {
          provider: "openai",
          available: false,
          error: "No subscription data available"
        }
      },
      system: {
        uptimeFormatted: formatUptime(Math.round(process.uptime() * 1000)),
        totalProfiles: profileIds.length,
        serverVersion: await this.readServerVersion(),
        nodeVersion: process.version
      }
    };

    return snapshot;
  }

  private async scanProfilesData(dataDir: string, profileIds: string[]): Promise<{
    usageRecords: UsageRecord[];
    dailyUsage: Map<string, DailyTotals>;
    workerRuns: WorkerRun[];
    activeWorkerCount: number;
    totalSessionCount: number;
    activeSessionCount: number;
    userMessages: number[];
    earliestUsageDayMs: number | null;
  }> {
    const usageRecords: UsageRecord[] = [];
    const dailyUsage = new Map<string, DailyTotals>();
    const workerRuns: WorkerRun[] = [];
    const userMessages: number[] = [];

    let totalSessionCount = 0;
    let earliestUsageDayMs: number | null = null;

    for (const profileId of profileIds) {
      const sessionsDir = join(getProfilesDir(dataDir), profileId, "sessions");
      const sessionIds = await this.listDirectoryNames(sessionsDir);
      totalSessionCount += sessionIds.length;

      for (const sessionId of sessionIds) {
        const sessionDir = join(sessionsDir, sessionId);
        const sessionFile = join(sessionDir, "session.jsonl");
        const metaFile = join(sessionDir, "meta.json");
        const workersDir = join(sessionDir, "workers");

        await this.scanJsonlFile(sessionFile, (entry) => {
          this.collectUsageAndMessages(entry, usageRecords, dailyUsage, userMessages);
        });

        const workerFiles = (await this.listFileNames(workersDir)).filter(
          (name) => name.endsWith(".jsonl") && !name.endsWith(".conversation.jsonl")
        );

        for (const workerFileName of workerFiles) {
          await this.scanJsonlFile(join(workersDir, workerFileName), (entry) => {
            this.collectUsageAndMessages(entry, usageRecords, dailyUsage, userMessages);
          });
        }

        const meta = await this.readSessionMeta(metaFile);
        if (meta) {
          for (const worker of meta.workers ?? []) {
            const createdAtMs = toTimestampMs(worker.createdAt);
            if (createdAtMs === null) {
              continue;
            }

            const terminatedAtMs = toTimestampMs(worker.terminatedAt);
            const durationMs = terminatedAtMs !== null && terminatedAtMs >= createdAtMs
              ? terminatedAtMs - createdAtMs
              : null;

            workerRuns.push({
              createdAtMs,
              durationMs
            });
          }
        }
      }
    }

    for (const day of dailyUsage.keys()) {
      const dayMs = dayKeyToMs(day);
      if (earliestUsageDayMs === null || dayMs < earliestUsageDayMs) {
        earliestUsageDayMs = dayMs;
      }
    }

    const agents = await this.readAgentsRegistry(dataDir);
    const activeWorkerCount = agents.filter((agent) => agent.role === "worker" && agent.status === "streaming").length;
    const activeSessionCount = agents.filter(
      (agent) => agent.role === "manager" && agent.status !== "terminated" && agent.status !== "stopped"
    ).length;

    return {
      usageRecords,
      dailyUsage,
      workerRuns,
      activeWorkerCount,
      totalSessionCount,
      activeSessionCount,
      userMessages,
      earliestUsageDayMs
    };
  }

  private collectUsageAndMessages(
    entry: unknown,
    usageRecords: UsageRecord[],
    dailyUsage: Map<string, DailyTotals>,
    userMessages: number[]
  ): void {
    if (!isRecord(entry)) {
      return;
    }

    if (entry.type === "message" && isRecord(entry.message)) {
      const timestampMs =
        toTimestampMs(entry.timestamp) ??
        toTimestampMs((entry.message as Record<string, unknown>).timestamp) ??
        Date.now();

      const usage = extractUsage((entry.message as Record<string, unknown>).usage);
      if (usage) {
        const modelId = extractModelId(entry.message);
        const day = toDayKey(timestampMs);

        usageRecords.push({
          timestampMs,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          total: usage.total,
          modelId
        });

        const existing = dailyUsage.get(day) ?? emptyDailyTotals();
        dailyUsage.set(day, {
          input: existing.input + usage.input,
          output: existing.output + usage.output,
          cacheRead: existing.cacheRead + usage.cacheRead,
          cacheWrite: existing.cacheWrite + usage.cacheWrite,
          total: existing.total + usage.total
        });
      }

      return;
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
  }

  private async scanJsonlFile(path: string, onEntry: (entry: unknown) => void): Promise<void> {
    try {
      const stream = createReadStream(path, { encoding: "utf8" });
      const reader = createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY
      });

      try {
        for await (const line of reader) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          try {
            onEntry(JSON.parse(trimmed) as unknown);
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

  private async readAgentsRegistry(dataDir: string): Promise<Array<{ role?: string; status?: string }>> {
    const path = getAgentsStoreFilePath(dataDir);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as { agents?: unknown };
      return Array.isArray(parsed.agents)
        ? parsed.agents.filter((agent): agent is { role?: string; status?: string } => isRecord(agent))
        : [];
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }
      return [];
    }
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

  private sumDailyWindow(daily: Map<string, DailyTotals>, nowMs: number, days: number): DailyTotals {
    const startMs = startOfDayMs(nowMs) - (days - 1) * DAY_MS;
    const values = Array.from(daily.entries())
      .map(([day, totals]) => ({ dayMs: dayKeyToMs(day), totals }))
      .filter((entry) => entry.dayMs >= startMs)
      .map((entry) => entry.totals);

    return this.sumDailyEntries(values);
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

    for (const record of usageRecords) {
      const current = totalsByModel.get(record.modelId) ?? 0;
      totalsByModel.set(record.modelId, current + record.total);
    }

    const grandTotal = Array.from(totalsByModel.values()).reduce((sum, value) => sum + value, 0);
    if (grandTotal <= 0) {
      return [];
    }

    return Array.from(totalsByModel.entries())
      .map(([modelId, tokenCount]) => ({
        modelId,
        displayName: modelId,
        percentage: round2((tokenCount / grandTotal) * 100),
        tokenCount
      }))
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

function toSafeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return fallback;
}

function getRangeStartMs(range: StatsRange, nowMs: number, earliestUsageDayMs: number | null): number {
  const todayStart = startOfDayMs(nowMs);
  if (range === "7d") {
    return todayStart - 6 * DAY_MS;
  }

  if (range === "30d") {
    return todayStart - 29 * DAY_MS;
  }

  return earliestUsageDayMs ?? todayStart;
}

function computeRangeDayCount(range: StatsRange, nowMs: number, rangeStartMs: number): number {
  if (range === "7d") {
    return 7;
  }

  if (range === "30d") {
    return 30;
  }

  const count = Math.floor((startOfDayMs(nowMs) - startOfDayMs(rangeStartMs)) / DAY_MS) + 1;
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

function toDayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDayMs(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
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
