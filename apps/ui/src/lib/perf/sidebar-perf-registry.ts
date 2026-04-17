/**
 * Sidebar perf — frontend in-memory registry.
 *
 * Steady-state cost when nothing is recording is essentially zero:
 *  - no timers are scheduled when no session-switch is in flight
 *  - debug-only Profiler-based metrics (`sidebar.commit_ms`,
 *    `sidebar.renders_per_ws_event`) are gated by the caller via the
 *    `isSidebarPerfDebugEnabled()` helper in `sidebar-perf-debug.ts`.
 *
 * The "off" path for always-on session-switch metrics is just two
 * `performance.now()` calls + a few field assignments, which is intentional
 * per the plan.
 *
 * See `.internal/sidebar-perf/instrumentation-plan.md` Sections 3 + 4.
 */

import {
  getSidebarPerfMetric,
  resolveSidebarPerfBuildMode,
  SIDEBAR_PERF_METRIC_NAMES,
  SIDEBAR_PERF_METRICS,
  type SidebarPerfBuildMode,
  type SidebarPerfLabelKey,
  type SidebarPerfMetricDefinition,
  type SidebarPerfMetricName,
} from './sidebar-perf-metrics'

const HISTOGRAM_WINDOW_SIZE = 128
const SLOW_EVENT_RING_SIZE = 50

type LabelMap = Partial<Record<SidebarPerfLabelKey, string | number | boolean | undefined>>
type FieldMap = Record<string, unknown>

export interface PerfDurationOptions {
  labels?: LabelMap
  fields?: FieldMap
}

export interface PerfCounterOptions {
  labels?: LabelMap
  fields?: FieldMap
  value?: number
}

export interface PerfDurationSample {
  durationMs: number
  recordedAt: number
  labels: LabelMap
  fields: FieldMap
}

export interface PerfCounterEntry {
  total: number
  byLabel: Record<string, number>
  lastSample?: {
    value: number
    labels: LabelMap
    fields: FieldMap
    recordedAt: number
  }
}

export interface PerfHistogramSummary {
  count: number
  mean: number
  p50: number
  p95: number
  max: number
  lastSample?: PerfDurationSample
}

export interface PerfSlowEvent {
  type: 'perf_slow_event'
  surface: 'frontend'
  metric: SidebarPerfMetricName
  timestamp: string
  durationMs: number
  thresholdMs: number
  labels: LabelMap
  fields: FieldMap
}

export interface PerfRegistrySummary {
  schemaVersion: 1
  generatedAt: string
  buildMode: SidebarPerfBuildMode
  histograms: Record<string, PerfHistogramSummary>
  counters: Record<string, PerfCounterEntry>
  recentSlowEvents: PerfSlowEvent[]
}

export interface SessionSwitchInteraction {
  token: number
  targetAgentId: string
  startedAtMs: number
  historyLoadedAtMs?: number
  conversationMessageCount?: number
  activityMessageCount?: number
  allMessageCount?: number
  paintCompleted: boolean
  /**
   * True when a rapid same-agent revisit (A→B→A) is detected and the prior A
   * subscribe is still in-flight. The registry drops metric recording for
   * stale-risk interactions because the arriving `conversation_history` cannot
   * be attributed to the correct subscribe request.
   */
  staleRisk: boolean
}

interface HistogramEntry {
  samples: number[]
  cursor: number
  count: number
  lastSample?: PerfDurationSample
}

export interface SidebarPerfRegistry {
  recordDuration(metricName: SidebarPerfMetricName, durationMs: number, options?: PerfDurationOptions): void
  increment(metricName: SidebarPerfMetricName, options?: PerfCounterOptions): void
  startSessionSwitch(targetAgentId: string): SessionSwitchInteraction | null
  /**
   * Marks the active session-switch as history-loaded and records the
   * `click_to_history_loaded_ms` duration.
   *
   * @param interactionNonce — must match the active interaction token.
   *   Callers obtain this from `getActiveSessionSwitch()?.token` at the time
   *   of the subscribe response. Together with the internal `staleRisk` flag,
   *   this ensures stale bootstraps from a prior same-agent click (A→B→A)
   *   cannot complete a newer interaction's metric.
   */
  markHistoryLoaded(targetAgentId: string, interactionNonce: number, counts: {
    conversationMessageCount: number
    activityMessageCount: number
    allMessageCount: number
  }): void
  /**
   * Attempts to complete `click_to_first_transcript_paint_ms` for the given
   * `activeAgentId`. Returns `true` if a sample was recorded.
   *
   * The registry refuses completion unless the active token for the supplied
   * agent already has `historyLoadedAtMs` — this is the explicit fix for the
   * v1 review's reset-empty-state false-completion regression.
   *
   * @param interactionNonce — must match the active interaction token.
   */
  maybeCompleteFirstPaint(activeAgentId: string, interactionNonce: number, sampleFields: {
    displayEntryCount: number
    emptySession: boolean
  }): boolean
  getActiveSessionSwitch(): SessionSwitchInteraction | null
  readSummary(): PerfRegistrySummary
  readRecentSlowEvents(): PerfSlowEvent[]
  reset(): void
}

interface CreateSidebarPerfRegistryOptions {
  /** Override the high-resolution clock (test seam). Defaults to `performance.now()`. */
  now?: () => number
  /** Override slow-event log (test seam). Defaults to `console.warn`. */
  warn?: (message: string, payload: unknown) => void
}

export function createSidebarPerfRegistry(
  options: CreateSidebarPerfRegistryOptions = {},
): SidebarPerfRegistry {
  const now = options.now ?? defaultNow
  const warn = options.warn ?? defaultWarn
  const buildMode = resolveSidebarPerfBuildMode()

  const histograms = new Map<string, HistogramEntry>()
  const counters = new Map<string, PerfCounterEntry>()
  const slowEvents: PerfSlowEvent[] = []

  let activeInteraction: SessionSwitchInteraction | null = null
  let nextToken = 1
  // Tracks agents with in-flight (unresolved) subscribes. Used to detect the
  // A→B→A rapid-switch pattern where a stale `conversation_history` for the
  // first A subscribe could incorrectly complete the second A's metric.
  const inFlightAgentIds = new Set<string>()

  function ensureHistogram(name: string): HistogramEntry {
    let entry = histograms.get(name)
    if (!entry) {
      entry = {
        samples: new Array<number>(HISTOGRAM_WINDOW_SIZE),
        cursor: 0,
        count: 0,
      }
      histograms.set(name, entry)
    }
    return entry
  }

  function ensureCounter(name: string): PerfCounterEntry {
    let entry = counters.get(name)
    if (!entry) {
      entry = { total: 0, byLabel: {} }
      counters.set(name, entry)
    }
    return entry
  }

  function pickAllowedLabels(
    definition: SidebarPerfMetricDefinition | undefined,
    labels: LabelMap | undefined,
  ): LabelMap {
    if (!labels) {
      return {}
    }

    if (!definition) {
      return { ...labels }
    }

    const allowed: LabelMap = {}
    for (const key of definition.labelKeys) {
      if (key in labels) {
        allowed[key] = labels[key]
      }
    }
    return allowed
  }

  function maybeEmitSlowEvent(
    definition: SidebarPerfMetricDefinition | undefined,
    metricName: SidebarPerfMetricName,
    durationMs: number,
    labels: LabelMap,
    fields: FieldMap,
  ): void {
    const threshold = definition?.thresholdMs
    if (threshold === undefined || durationMs <= threshold) {
      return
    }

    const slowEvent: PerfSlowEvent = {
      type: 'perf_slow_event',
      surface: 'frontend',
      metric: metricName,
      timestamp: new Date().toISOString(),
      durationMs,
      thresholdMs: threshold,
      labels,
      fields,
    }

    slowEvents.push(slowEvent)
    if (slowEvents.length > SLOW_EVENT_RING_SIZE) {
      slowEvents.splice(0, slowEvents.length - SLOW_EVENT_RING_SIZE)
    }

    warn('[forge-perf]', slowEvent)
  }

  function recordDuration(
    metricName: SidebarPerfMetricName,
    durationMs: number,
    durationOptions: PerfDurationOptions = {},
  ): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return
    }

    const definition = getSidebarPerfMetric(metricName)
    const labels: LabelMap = {
      buildMode,
      ...pickAllowedLabels(definition, durationOptions.labels),
    }
    const fields: FieldMap = durationOptions.fields ? { ...durationOptions.fields } : {}

    const histogram = ensureHistogram(metricName)
    histogram.samples[histogram.cursor] = durationMs
    histogram.cursor = (histogram.cursor + 1) % HISTOGRAM_WINDOW_SIZE
    if (histogram.count < HISTOGRAM_WINDOW_SIZE) {
      histogram.count += 1
    }

    histogram.lastSample = {
      durationMs,
      recordedAt: now(),
      labels,
      fields,
    }

    maybeEmitSlowEvent(definition, metricName, durationMs, labels, fields)
  }

  function increment(
    metricName: SidebarPerfMetricName,
    counterOptions: PerfCounterOptions = {},
  ): void {
    const definition = getSidebarPerfMetric(metricName)
    const value = counterOptions.value ?? 1
    if (!Number.isFinite(value)) {
      return
    }

    const labels: LabelMap = {
      buildMode,
      ...pickAllowedLabels(definition, counterOptions.labels),
    }
    const fields: FieldMap = counterOptions.fields ? { ...counterOptions.fields } : {}

    const entry = ensureCounter(metricName)
    entry.total += value

    const labelKey = serializeLabelKey(labels)
    if (labelKey) {
      entry.byLabel[labelKey] = (entry.byLabel[labelKey] ?? 0) + value
    }

    entry.lastSample = {
      value,
      labels,
      fields,
      recordedAt: now(),
    }
  }

  function startSessionSwitch(targetAgentId: string): SessionSwitchInteraction | null {
    if (!targetAgentId) {
      return null
    }

    // Detect A→B→A: if this agent already has an unresolved in-flight
    // subscribe, the next `conversation_history` for this agent is ambiguous
    // (could be from the old or new subscribe). Drop the measurement.
    const staleRisk = inFlightAgentIds.has(targetAgentId)

    // Clean up the previous interaction's in-flight tracking when resolved.
    if (activeInteraction && activeInteraction.historyLoadedAtMs !== undefined) {
      inFlightAgentIds.delete(activeInteraction.targetAgentId)
    }

    inFlightAgentIds.add(targetAgentId)

    const interaction: SessionSwitchInteraction = {
      token: nextToken++,
      targetAgentId,
      startedAtMs: now(),
      paintCompleted: false,
      staleRisk,
    }
    activeInteraction = interaction
    return interaction
  }

  function markHistoryLoaded(
    targetAgentId: string,
    interactionNonce: number,
    counts: {
      conversationMessageCount: number
      activityMessageCount: number
      allMessageCount: number
    },
  ): void {
    const interaction = activeInteraction
    if (!interaction || interaction.targetAgentId !== targetAgentId) {
      return
    }
    if (interaction.token !== interactionNonce) {
      return
    }
    if (interaction.historyLoadedAtMs !== undefined) {
      // already recorded for this token — ignore duplicates from re-renders.
      return
    }

    // Resolve in-flight tracking for this agent.
    inFlightAgentIds.delete(targetAgentId)

    const recordedAt = now()
    const durationMs = recordedAt - interaction.startedAtMs
    interaction.historyLoadedAtMs = recordedAt
    interaction.conversationMessageCount = counts.conversationMessageCount
    interaction.activityMessageCount = counts.activityMessageCount
    interaction.allMessageCount = counts.allMessageCount

    // Skip recording if this interaction is ambiguous due to A→B→A pattern.
    if (interaction.staleRisk) {
      return
    }

    recordDuration(
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs,
      durationMs,
      {
        fields: {
          agentId: targetAgentId,
          conversationMessageCount: counts.conversationMessageCount,
          activityMessageCount: counts.activityMessageCount,
          allMessageCount: counts.allMessageCount,
          interactionToken: interaction.token,
        },
      },
    )
  }

  function maybeCompleteFirstPaint(
    activeAgentId: string,
    interactionNonce: number,
    sampleFields: {
      displayEntryCount: number
      emptySession: boolean
    },
  ): boolean {
    const interaction = activeInteraction
    if (!interaction) {
      return false
    }
    if (interaction.paintCompleted) {
      return false
    }
    if (interaction.targetAgentId !== activeAgentId) {
      return false
    }
    if (interaction.token !== interactionNonce) {
      return false
    }
    if (interaction.historyLoadedAtMs === undefined) {
      // The reset empty-state can render before `conversation_history` arrives.
      // Refuse completion until the history milestone has been recorded —
      // this is the explicit fix for the v1 review's false-completion bug.
      return false
    }
    if (interaction.staleRisk) {
      // A→B→A rapid-switch: the arriving conversation_history cannot be
      // reliably attributed to this subscribe, so drop the measurement.
      interaction.paintCompleted = true
      return false
    }

    const recordedAt = now()
    const durationMs = recordedAt - interaction.startedAtMs
    interaction.paintCompleted = true

    recordDuration(
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs,
      durationMs,
      {
        fields: {
          agentId: activeAgentId,
          displayEntryCount: sampleFields.displayEntryCount,
          conversationMessageCount: interaction.conversationMessageCount,
          activityMessageCount: interaction.activityMessageCount,
          allMessageCount: interaction.allMessageCount,
          emptySession: sampleFields.emptySession,
          interactionToken: interaction.token,
        },
      },
    )
    return true
  }

  function getActiveSessionSwitch(): SessionSwitchInteraction | null {
    return activeInteraction ? { ...activeInteraction } : null
  }

  function readSummary(): PerfRegistrySummary {
    const histogramSummaries: Record<string, PerfHistogramSummary> = {}
    for (const [name, entry] of histograms.entries()) {
      histogramSummaries[name] = summarizeHistogram(entry)
    }

    const counterSnapshots: Record<string, PerfCounterEntry> = {}
    for (const [name, entry] of counters.entries()) {
      counterSnapshots[name] = {
        total: entry.total,
        byLabel: { ...entry.byLabel },
        lastSample: entry.lastSample
          ? { ...entry.lastSample, labels: { ...entry.lastSample.labels }, fields: { ...entry.lastSample.fields } }
          : undefined,
      }
    }

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      buildMode,
      histograms: histogramSummaries,
      counters: counterSnapshots,
      recentSlowEvents: slowEvents.slice(),
    }
  }

  function readRecentSlowEvents(): PerfSlowEvent[] {
    return slowEvents.slice()
  }

  function reset(): void {
    histograms.clear()
    counters.clear()
    slowEvents.length = 0
    activeInteraction = null
    nextToken = 1
    inFlightAgentIds.clear()
  }

  return {
    recordDuration,
    increment,
    startSessionSwitch,
    markHistoryLoaded,
    maybeCompleteFirstPaint,
    getActiveSessionSwitch,
    readSummary,
    readRecentSlowEvents,
    reset,
  }
}

function serializeLabelKey(labels: LabelMap): string | null {
  const keys = (Object.keys(labels) as SidebarPerfLabelKey[]).sort()
  if (keys.length === 0) {
    return null
  }
  const parts: string[] = []
  for (const key of keys) {
    const value = labels[key]
    if (value === undefined) continue
    parts.push(`${key}=${String(value)}`)
  }
  return parts.length > 0 ? parts.join('|') : null
}

function summarizeHistogram(entry: HistogramEntry): PerfHistogramSummary {
  const count = entry.count
  if (count === 0) {
    return { count: 0, mean: 0, p50: 0, p95: 0, max: 0, lastSample: undefined }
  }

  const flat = new Array<number>(count)
  if (entry.count < HISTOGRAM_WINDOW_SIZE) {
    for (let i = 0; i < count; i += 1) {
      flat[i] = entry.samples[i]
    }
  } else {
    for (let i = 0; i < HISTOGRAM_WINDOW_SIZE; i += 1) {
      const idx = (entry.cursor + i) % HISTOGRAM_WINDOW_SIZE
      flat[i] = entry.samples[idx]
    }
  }

  let sum = 0
  let max = 0
  for (let i = 0; i < count; i += 1) {
    const value = flat[i]
    sum += value
    if (value > max) {
      max = value
    }
  }

  const sorted = flat.slice().sort((a, b) => a - b)
  const p50 = percentile(sorted, 0.5)
  const p95 = percentile(sorted, 0.95)

  return {
    count,
    mean: sum / count,
    p50,
    p95,
    max,
    lastSample: entry.lastSample
      ? { ...entry.lastSample, labels: { ...entry.lastSample.labels }, fields: { ...entry.lastSample.fields } }
      : undefined,
  }
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) {
    return 0
  }
  if (sortedAscending.length === 1) {
    return sortedAscending[0]
  }

  const rank = p * (sortedAscending.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) {
    return sortedAscending[lower]
  }

  const lowerValue = sortedAscending[lower]
  const upperValue = sortedAscending[upper]
  return lowerValue + (upperValue - lowerValue) * (rank - lower)
}

function defaultNow(): number {
  if (typeof globalThis !== 'undefined' && typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now()
  }
  return Date.now()
}

function defaultWarn(message: string, payload: unknown): void {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(message, payload)
  }
}

// Re-export the manifest names so consumers can import a single module.
export { SIDEBAR_PERF_METRIC_NAMES, SIDEBAR_PERF_METRICS }
