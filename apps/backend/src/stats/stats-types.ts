import type { StatsRange, StatsSnapshot } from "@forge/protocol";

export interface SessionMetaLite {
  workers?: Array<{
    id?: string;
    createdAt?: string;
    terminatedAt?: string | null;
  }>;
}

export interface UsageRecord {
  timestampMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  modelId: string;
  reasoningLevel: string;
}

export interface DailyTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface WorkerRun {
  workerId: string;
  createdAtMs: number;
  terminatedAtMs: number | null;
  durationMs: number | null;
  billableTokens: number;
}

export interface StatsScanResult {
  usageRecords: UsageRecord[];
  dailyUsage: Map<string, DailyTotals>;
  workerRuns: WorkerRun[];
  activeWorkerCount: number;
  totalSessionCount: number;
  activeSessionCount: number;
  userMessages: number[];
  earliestUsageDayKey: string | null;
  managerRepoPaths: string[];
}

export interface CacheEntry {
  expiresAt: number;
  timezone: string;
  snapshot: StatsSnapshot;
}

export interface PersistedStatsCache {
  version: number;
  entries: Partial<Record<StatsRange, CacheEntry>>;
}

export interface StatsServiceOptions {
  onRefreshAllCompleted?: (snapshot: StatsSnapshot | null) => void | Promise<void>;
}
