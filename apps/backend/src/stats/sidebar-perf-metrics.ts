import type { SidebarPerfBuildMode, SidebarPerfMetricDefinition } from "./sidebar-perf-types.js";

export const SIDEBAR_BOOTSTRAP_METRIC = "sidebar.bootstrap";
export const SIDEBAR_HISTORY_CACHE_STATE_METRIC = "sidebar.history.cache_state";
export const SIDEBAR_SNAPSHOT_BUILD_METRIC = "sidebar.snapshot.build";
export const AGENTS_STORE_SAVE_METRIC = "agents_store.save";
export const SESSION_CREATE_METRIC = "session.create";
export const SESSION_CREATE_PHASE_METRIC = "session.create.phase";

export const HISTORY_CACHE_STATES = [
  "memory",
  "hit",
  "absent",
  "cache_read_error",
  "legacy_rebuild",
  "metadata_entries_mismatch",
  "cache_missing_persisted_prefix",
  "persisted_entry_count_mismatch",
  "last_persisted_entry_mismatch",
  "size_guard_skip",
] as const;

export type HistoryCacheState = (typeof HISTORY_CACHE_STATES)[number];

export const HISTORY_SOURCES = [
  "memory",
  "cache_hit",
  "cache_rebuild",
  "full_parse",
  "size_guard_skip",
] as const;

export type HistorySource = (typeof HISTORY_SOURCES)[number];

export const BACKEND_SIDEBAR_PERF_METRICS = {
  sidebarBootstrap: {
    name: SIDEBAR_BOOTSTRAP_METRIC,
    kind: "duration",
    thresholdMs: 750,
    labelKeys: ["historySource", "cacheState", "playwrightDiscoveryEnabled", "buildMode"],
    surface: "backend",
  },
  sidebarHistoryCacheState: {
    name: SIDEBAR_HISTORY_CACHE_STATE_METRIC,
    kind: "counter",
    labelKeys: ["cacheState", "historySource"],
    surface: "backend",
  },
  sidebarSnapshotBuild: {
    name: SIDEBAR_SNAPSHOT_BUILD_METRIC,
    kind: "duration",
    thresholdMs: 100,
    labelKeys: ["includeStreamingWorkers", "buildMode"],
    surface: "backend",
  },
  agentsStoreSave: {
    name: AGENTS_STORE_SAVE_METRIC,
    kind: "duration",
    thresholdMs: 200,
    labelKeys: ["trigger", "buildMode"],
    surface: "backend",
  },
  sessionCreate: {
    name: SESSION_CREATE_METRIC,
    kind: "duration",
    thresholdMs: 1000,
    labelKeys: ["sessionPurpose", "success", "buildMode"],
    surface: "backend",
  },
  sessionCreatePhase: {
    name: SESSION_CREATE_PHASE_METRIC,
    kind: "duration",
    thresholdMs: 250,
    labelKeys: ["phase", "sessionPurpose", "buildMode"],
    surface: "backend",
  },
} as const satisfies Record<string, SidebarPerfMetricDefinition>;

export type BackendSidebarPerfMetricName =
  (typeof BACKEND_SIDEBAR_PERF_METRICS)[keyof typeof BACKEND_SIDEBAR_PERF_METRICS]["name"];

export const backendSidebarPerfMetricManifest = Object.freeze(
  Object.values(BACKEND_SIDEBAR_PERF_METRICS).reduce<Record<BackendSidebarPerfMetricName, SidebarPerfMetricDefinition>>(
    (accumulator, metric) => {
      accumulator[metric.name] = metric;
      return accumulator;
    },
    {
      [SIDEBAR_BOOTSTRAP_METRIC]: BACKEND_SIDEBAR_PERF_METRICS.sidebarBootstrap,
      [SIDEBAR_HISTORY_CACHE_STATE_METRIC]: BACKEND_SIDEBAR_PERF_METRICS.sidebarHistoryCacheState,
      [SIDEBAR_SNAPSHOT_BUILD_METRIC]: BACKEND_SIDEBAR_PERF_METRICS.sidebarSnapshotBuild,
      [AGENTS_STORE_SAVE_METRIC]: BACKEND_SIDEBAR_PERF_METRICS.agentsStoreSave,
      [SESSION_CREATE_METRIC]: BACKEND_SIDEBAR_PERF_METRICS.sessionCreate,
      [SESSION_CREATE_PHASE_METRIC]: BACKEND_SIDEBAR_PERF_METRICS.sessionCreatePhase,
    }
  )
);

export function resolveBackendSidebarPerfBuildMode(): SidebarPerfBuildMode {
  return process.env.NODE_ENV === "development" ? "dev" : "prod";
}
