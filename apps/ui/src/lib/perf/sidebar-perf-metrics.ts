/**
 * Sidebar perf — frontend metric manifest.
 *
 * Centralizes metric names, kinds, thresholds, and allowed label keys so the
 * recorder + debug surfaces have a single source of truth.
 *
 * See `.internal/sidebar-perf/instrumentation-plan.md` (Section 3) for the
 * `labels` vs `fields` contract:
 *   - labels  → low-cardinality bucket keys safe for counters
 *   - fields  → high-cardinality details (agentId, byte counts, tokens, etc.)
 *               kept only on the last sample / slow events.
 *
 * Package 2 of the plan only implements the two `session_switch.*` metrics.
 * `sidebar.commit_ms` and `sidebar.renders_per_ws_event` are intentionally
 * declared here so the debug-off path knows their names, but Package 5 wires
 * the actual measurement.
 */

export const SIDEBAR_PERF_METRIC_NAMES = {
  sessionSwitchClickToHistoryLoadedMs: 'session_switch.click_to_history_loaded_ms',
  sessionSwitchClickToFirstTranscriptPaintMs: 'session_switch.click_to_first_transcript_paint_ms',
  sidebarCommitMs: 'sidebar.commit_ms',
  sidebarRendersPerWsEvent: 'sidebar.renders_per_ws_event',
} as const

export type SidebarPerfMetricName =
  (typeof SIDEBAR_PERF_METRIC_NAMES)[keyof typeof SIDEBAR_PERF_METRIC_NAMES]

export type SidebarPerfMetricKind = 'duration' | 'counter'

export type SidebarPerfBuildMode = 'dev' | 'prod'

/**
 * Constrained label-key union — mirrors the backend pattern so typos are
 * caught at compile time rather than silently filtered at runtime.
 */
export type SidebarPerfLabelKey = 'buildMode' | 'phase' | 'eventType'

export interface SidebarPerfMetricDefinition {
  name: SidebarPerfMetricName
  kind: SidebarPerfMetricKind
  surface: 'frontend'
  /** Slow-threshold in ms. When `undefined`, no slow log is emitted. */
  thresholdMs?: number
  /** Allowed low-cardinality label keys for this metric. */
  labelKeys: readonly SidebarPerfLabelKey[]
}

/**
 * Frontend manifest. Kept readonly; the registry uses this to enforce the
 * label allowlist and to resolve thresholds for slow-event logging.
 */
export const SIDEBAR_PERF_METRICS: readonly SidebarPerfMetricDefinition[] = [
  {
    name: SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs,
    kind: 'duration',
    surface: 'frontend',
    thresholdMs: 300,
    labelKeys: ['buildMode'],
  },
  {
    name: SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs,
    kind: 'duration',
    surface: 'frontend',
    thresholdMs: 500,
    labelKeys: ['buildMode'],
  },
  {
    name: SIDEBAR_PERF_METRIC_NAMES.sidebarCommitMs,
    kind: 'duration',
    surface: 'frontend',
    thresholdMs: 16,
    labelKeys: ['phase', 'eventType', 'buildMode'],
  },
  {
    name: SIDEBAR_PERF_METRIC_NAMES.sidebarRendersPerWsEvent,
    kind: 'counter',
    surface: 'frontend',
    labelKeys: ['eventType', 'buildMode'],
  },
] as const

const METRICS_BY_NAME: ReadonlyMap<string, SidebarPerfMetricDefinition> = new Map(
  SIDEBAR_PERF_METRICS.map((definition) => [definition.name, definition]),
)

export function getSidebarPerfMetric(
  name: string,
): SidebarPerfMetricDefinition | undefined {
  return METRICS_BY_NAME.get(name)
}

export function resolveSidebarPerfBuildMode(): SidebarPerfBuildMode {
  // import.meta.env.DEV is defined by Vite. Fall back to `prod` for safety in
  // non-Vite consumers (jest/vitest without env defines, SSR, etc.).
  try {
    const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
    if (env && typeof env.DEV === 'boolean') {
      return env.DEV ? 'dev' : 'prod'
    }
  } catch {
    /* ignore */
  }
  return 'prod'
}
