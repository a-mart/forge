import type {
  ManagerProfile,
  TokenAnalyticsAttributionKind,
  TokenAnalyticsResolvedQuery,
  TokenAnalyticsSortDirection,
  TokenAnalyticsWorkerRunModelUsage,
  TokenAnalyticsWorkerSort,
  TokenCostTotals,
  TokenUsageTotals,
} from "@forge/protocol";

export interface SessionMetaLite {
  label?: string | null;
  workers?: WorkerMetaLite[];
}

export interface WorkerMetaLite {
  id?: string;
  specialistId?: string | null;
  specialistAttributionKnown?: boolean;
  createdAt?: string;
  terminatedAt?: string | null;
}

export interface SpecialistDisplayMeta {
  displayName: string;
  color: string | null;
}

export interface TokenAnalyticsEventRecord {
  timestampMs: number;
  profileId: string;
  sessionId: string;
  workerId: string;
  provider: string;
  modelId: string;
  reasoningLevel: string | null;
  specialistId: string | null;
  attributionKind: TokenAnalyticsAttributionKind;
  usage: TokenUsageTotals;
  cost: TokenCostTotals | null;
}

export interface TokenAnalyticsWorkerRecord {
  profileId: string;
  sessionId: string;
  sessionLabel: string;
  workerId: string;
  specialistId: string | null;
  attributionKind: TokenAnalyticsAttributionKind;
  createdAtMs: number;
  terminatedAtMs: number | null;
  durationMs: number | null;
}

export interface TokenAnalyticsScanResult {
  scannedAt: string;
  events: TokenAnalyticsEventRecord[];
  workers: TokenAnalyticsWorkerRecord[];
  profiles: ManagerProfile[];
  specialistMetadataByProfile: Map<string, Map<string, SpecialistDisplayMeta>>;
}

export interface TokenAnalyticsScanDiagnostics {
  skippedMissingTimestampEvents: number;
}

export interface ScanCacheEntry {
  expiresAt: number;
  result: TokenAnalyticsScanResult;
}

export interface PersistedTokenAnalyticsScanResult {
  scannedAt: string;
  events: TokenAnalyticsEventRecord[];
  workers: TokenAnalyticsWorkerRecord[];
  profiles: ManagerProfile[];
  specialistMetadataByProfile: Record<string, Record<string, SpecialistDisplayMeta>>;
}

export interface PersistedTokenAnalyticsCache {
  version: number;
  entry: {
    expiresAt: number;
    result: PersistedTokenAnalyticsScanResult;
  } | null;
}

export interface ResolvedQueryWindow {
  query: TokenAnalyticsResolvedQuery;
  startMs: number | null;
  endExclusiveMs: number | null;
}

export interface WorkerAggregate {
  worker: TokenAnalyticsWorkerRecord;
  events: TokenAnalyticsEventRecord[];
  eventCount: number;
  usage: TokenUsageTotals;
  costTotals: TokenCostTotals | null;
  costCoveredEventCount: number;
  reasoningLevels: Set<string>;
  modelsUsed: Map<string, TokenAnalyticsWorkerRunModelUsage>;
}

export interface DecodedCursor {
  offset: number;
  sort: TokenAnalyticsWorkerSort;
  direction: TokenAnalyticsSortDirection;
}

export const DEFAULT_WORKER_PAGE_LIMIT = 25;
export const MAX_WORKER_PAGE_LIMIT = 100;
export const TOKEN_ANALYTICS_CACHE_VERSION = 1;
