import type { HistoryCacheState, HistorySource } from "./sidebar-perf-metrics.js";

export type SidebarPerfSurface = "backend";
export type SidebarPerfMetricKind = "duration" | "counter";
export type SidebarPerfBuildMode = "dev" | "prod";

export const SIDEBAR_PERF_LABEL_KEYS = [
  "cacheState",
  "historySource",
  "phase",
  "eventType",
  "buildMode",
  "trigger",
  "playwrightDiscoveryEnabled",
  "includeStreamingWorkers",
  "sessionPurpose",
  "success",
] as const;

export type SidebarPerfLabelKey = (typeof SIDEBAR_PERF_LABEL_KEYS)[number];
export type SidebarPerfLabelValue = string | number | boolean;
export type SidebarPerfLabels = Partial<Record<SidebarPerfLabelKey, SidebarPerfLabelValue>>;
export type SidebarPerfFields = Record<string, unknown>;

export interface SidebarPerfMetricDefinition<Name extends string = string> {
  name: Name;
  kind: SidebarPerfMetricKind;
  thresholdMs?: number;
  labelKeys: readonly SidebarPerfLabelKey[];
  surface: SidebarPerfSurface;
}

export interface SidebarPerfSlowEvent {
  type: "perf_slow_event";
  surface: SidebarPerfSurface;
  metric: string;
  timestamp: string;
  durationMs: number;
  thresholdMs: number;
  labels: SidebarPerfLabels;
  fields?: SidebarPerfFields;
}

export interface SidebarPerfLastSample {
  timestamp: string;
  labels: SidebarPerfLabels;
  fields?: SidebarPerfFields;
  durationMs?: number;
  value?: number;
}

export interface SidebarPerfHistogramSummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
  min: number;
  lastSample?: SidebarPerfLastSample;
}

export interface SidebarPerfCounterSummary {
  total: number;
  byLabel?: Record<string, number>;
  lastSample?: SidebarPerfLastSample;
}

export interface SidebarPerfSummary {
  histograms: Record<string, SidebarPerfHistogramSummary>;
  counters: Record<string, SidebarPerfCounterSummary>;
}

export interface SidebarPerfRecentSamples {
  histograms: Record<string, SidebarPerfLastSample[]>;
}

export interface SidebarConversationHistoryDiagnostics {
  cacheState: HistoryCacheState;
  historySource: HistorySource;
  coldLoad: boolean;
  fsReadOps: number;
  fsReadBytes: number;
  sessionFileBytes?: number;
  cacheFileBytes?: number;
  persistedEntryCount?: number;
  cachedEntryCount?: number;
  sessionSummaryBytesScanned?: number;
  cacheReadMs?: number;
  sessionSummaryReadMs?: number;
  fastPathUsed?: boolean;
  detail?: string | null;
}

export interface SidebarPerfRecorder {
  recordDuration(
    metricName: string,
    durationMs: number,
    options?: { labels?: SidebarPerfLabels; fields?: SidebarPerfFields }
  ): void;
  increment(
    metricName: string,
    options?: { labels?: SidebarPerfLabels; fields?: SidebarPerfFields; value?: number }
  ): void;
  readSummary(): SidebarPerfSummary;
  readRecentSlowEvents(): SidebarPerfSlowEvent[];
  readRecentSamples?(): SidebarPerfRecentSamples;
}
