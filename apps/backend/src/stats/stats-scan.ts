import { join } from "node:path";
import { getAgentsStoreFilePath, getProfilesDir } from "../swarm/data-paths.js";
import {
  extractReasoningLevel,
  extractUsage,
  isRecord,
  listDirectoryNames,
  listFileNames,
  readJsonFileOrNull,
  scanJsonlFile,
  toTimestampMs,
} from "./stats-shared.js";
import { buildDayRange, shiftDayKey, toDayKey } from "./stats-time.js";
import { collectManagerRepoPaths } from "./stats-git.js";
import { emptyDailyTotals, sumDailyEntries } from "./stats-usage.js";
import type { DailyTotals, SessionMetaLite, StatsScanResult, UsageRecord, WorkerRun } from "./stats-types.js";

export async function scanProfilesData(
  dataDir: string,
  profileIds: string[],
  timezone: string
): Promise<StatsScanResult> {
  const usageRecords: UsageRecord[] = [];
  const dailyUsage = new Map<string, DailyTotals>();
  const workerRuns: WorkerRun[] = [];
  const userMessages: number[] = [];

  let totalSessionCount = 0;

  for (const profileId of profileIds) {
    const sessionsDir = join(getProfilesDir(dataDir), profileId, "sessions");
    const sessionIds = await listDirectoryNames(sessionsDir);
    totalSessionCount += sessionIds.length;

    for (const sessionId of sessionIds) {
      const sessionDir = join(sessionsDir, sessionId);
      const sessionFile = join(sessionDir, "session.jsonl");
      const metaFile = join(sessionDir, "meta.json");
      const workersDir = join(sessionDir, "workers");
      const workerBillableTokenTotalsByRunKey = new Map<string, number>();

      await scanJsonlFile(sessionFile, (entry, context) => {
        collectUsageAndMessages(entry, usageRecords, dailyUsage, userMessages, {
          fallbackThinkingLevel: context.thinkingLevel,
          timezone,
        });
      });

      const workerFiles = (await listFileNames(workersDir)).filter(
        (name) => name.endsWith(".jsonl") && !name.endsWith(".conversation.jsonl")
      );

      for (const workerFileName of workerFiles) {
        const workerId = workerFileName.slice(0, -".jsonl".length);
        const workerRunKey = toWorkerRunKey(profileId, sessionId, workerId);
        let billableTokensForWorker = 0;

        await scanJsonlFile(join(workersDir, workerFileName), (entry, context) => {
          billableTokensForWorker += collectUsageAndMessages(entry, usageRecords, dailyUsage, userMessages, {
            fallbackThinkingLevel: context.thinkingLevel,
            timezone,
          });
        });

        workerBillableTokenTotalsByRunKey.set(workerRunKey, billableTokensForWorker);
      }

      const meta = await readSessionMeta(metaFile);
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
            billableTokens: workerBillableTokenTotalsByRunKey.get(workerRunKey) ?? 0,
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

  const agents = await readAgentsRegistry(dataDir);
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
    managerRepoPaths,
  };
}

export function sumDailyWindow(daily: Map<string, DailyTotals>, todayDayKey: string, days: number): DailyTotals {
  const startDayKey = shiftDayKey(todayDayKey, -(days - 1));
  const values = Array.from(daily.entries())
    .filter(([day]) => day >= startDayKey)
    .map(([, totals]) => totals);

  return sumDailyEntries(values);
}

export function buildDailyEntriesForRange(
  daily: Map<string, DailyTotals>,
  rangeStartDayKey: string,
  rangeEndDayKey: string
): Array<{ day: string; totals: DailyTotals }> {
  return buildDayRange(rangeStartDayKey, rangeEndDayKey).map((day) => ({
    day,
    totals: daily.get(day) ?? emptyDailyTotals(),
  }));
}

function collectUsageAndMessages(
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
        reasoningLevel,
      });

      const existing = dailyUsage.get(day) ?? emptyDailyTotals();
      dailyUsage.set(day, {
        input: existing.input + usage.input,
        output: existing.output + usage.output,
        cacheRead: existing.cacheRead + usage.cacheRead,
        cacheWrite: existing.cacheWrite + usage.cacheWrite,
        total: existing.total + usage.total,
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

async function readSessionMeta(path: string): Promise<SessionMetaLite | null> {
  return readJsonFileOrNull<SessionMetaLite>(path);
}

async function readAgentsRegistry(dataDir: string): Promise<Array<{ role?: string; status?: string; cwd?: string }>> {
  const path = getAgentsStoreFilePath(dataDir);
  const parsed = await readJsonFileOrNull<{ agents?: unknown }>(path);
  return Array.isArray(parsed?.agents)
    ? parsed.agents.filter((agent): agent is { role?: string; status?: string; cwd?: string } => isRecord(agent))
    : [];
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

function toWorkerRunKey(profileId: string, sessionId: string, workerId: string): string {
  return `${profileId}/${sessionId}/${workerId}`;
}

