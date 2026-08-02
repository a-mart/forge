import type {
  GenerationMeasurementRecordV1,
  TokenAnalyticsAttributionKind,
} from "@forge/protocol";

export interface GenerationMeasurementRecord extends GenerationMeasurementRecordV1 {
  completedAtMs: number | null;
  effectiveModelId: string;
  attributionKind: TokenAnalyticsAttributionKind;
  profileDisplayName: string;
  sessionLabel: string;
  specialistDisplayName: string | null;
  specialistColor: string | null;
}

export interface GenerationThroughputScanDiagnostics {
  malformedRecordCount: number;
  duplicateRecordCount: number;
  conflictRecordCount: number;
  startOnlyCallCount: number;
}

export interface GenerationThroughputScanResult {
  scannedAt: string;
  records: GenerationMeasurementRecord[];
  diagnostics: GenerationThroughputScanDiagnostics;
}

export interface GenerationThroughputCacheEntry {
  expiresAt: number;
  result: GenerationThroughputScanResult;
}

export interface PersistedGenerationThroughputCache {
  /** v2 rejects first-output-tail cache semantics and forces request-wall re-derivation. */
  version: 2;
  entry: GenerationThroughputCacheEntry | null;
}

export const GENERATION_THROUGHPUT_CACHE_VERSION = 2 as const;
export const DEFAULT_GENERATION_CALLS_PAGE_LIMIT = 25;
export const MAX_GENERATION_CALLS_PAGE_LIMIT = 100;
export const MAX_GENERATION_MODEL_TABLE_ROWS = 100;
export const MAX_GENERATION_TREND_SERIES = 8;
