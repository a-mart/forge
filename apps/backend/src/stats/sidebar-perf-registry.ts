import type {
  SidebarPerfCounterSummary,
  SidebarPerfFields,
  SidebarPerfHistogramSummary,
  SidebarPerfLabels,
  SidebarPerfLastSample,
  SidebarPerfMetricDefinition,
  SidebarPerfRecorder,
  SidebarPerfSlowEvent,
  SidebarPerfSummary
} from "./sidebar-perf-types.js";

const DEFAULT_HISTOGRAM_WINDOW = 128;
const DEFAULT_SLOW_EVENT_WINDOW = 50;

interface SidebarPerfRegistryOptions {
  manifest: Record<string, SidebarPerfMetricDefinition>;
  now?: () => string;
  histogramWindow?: number;
  slowEventWindow?: number;
  onSlowEvent?: (event: SidebarPerfSlowEvent) => void;
}

interface DurationSample {
  durationMs: number;
  sample: SidebarPerfLastSample;
}

class FixedRingBuffer<T> {
  private readonly values: T[];
  private nextIndex = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.values = new Array<T>(capacity);
  }

  push(value: T): void {
    if (this.capacity <= 0) {
      return;
    }

    this.values[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  toArray(): T[] {
    if (this.size === 0) {
      return [];
    }

    if (this.size < this.capacity) {
      return this.values.slice(0, this.size);
    }

    return [...this.values.slice(this.nextIndex), ...this.values.slice(0, this.nextIndex)];
  }
}

interface CounterState {
  total: number;
  byLabel: Map<string, number>;
  lastSample?: SidebarPerfLastSample;
}

export function createSidebarPerfRegistry(options: SidebarPerfRegistryOptions): SidebarPerfRecorder {
  return new SidebarPerfRegistry(options);
}

class SidebarPerfRegistry implements SidebarPerfRecorder {
  private readonly definitions: Map<string, SidebarPerfMetricDefinition>;
  private readonly histogramWindow: number;
  private readonly slowEventWindow: number;
  private readonly now: () => string;
  private readonly onSlowEvent: (event: SidebarPerfSlowEvent) => void;
  private readonly histograms = new Map<string, FixedRingBuffer<DurationSample>>();
  private readonly counters = new Map<string, CounterState>();
  private readonly slowEvents: FixedRingBuffer<SidebarPerfSlowEvent>;

  constructor(options: SidebarPerfRegistryOptions) {
    this.definitions = new Map<string, SidebarPerfMetricDefinition>(Object.entries(options.manifest));
    this.histogramWindow = normalizeWindowSize(options.histogramWindow, DEFAULT_HISTOGRAM_WINDOW);
    this.slowEventWindow = normalizeWindowSize(options.slowEventWindow, DEFAULT_SLOW_EVENT_WINDOW);
    this.now = options.now ?? (() => new Date().toISOString());
    this.onSlowEvent = options.onSlowEvent ?? defaultSlowEventLogger;
    this.slowEvents = new FixedRingBuffer<SidebarPerfSlowEvent>(this.slowEventWindow);
  }

  recordDuration(
    metricName: string,
    durationMs: number,
    options?: { labels?: SidebarPerfLabels; fields?: SidebarPerfFields }
  ): void {
    const definition = this.definitions.get(metricName);
    if (!definition || definition.kind !== "duration" || !Number.isFinite(durationMs)) {
      return;
    }

    const timestamp = this.now();
    const labels = sanitizeLabels(definition, options?.labels);
    const fields = cloneFields(options?.fields);
    const sample: SidebarPerfLastSample = {
      timestamp,
      labels,
      fields,
      durationMs
    };

    const histogram = this.getOrCreateHistogram(metricName);
    histogram.push({ durationMs, sample });

    const thresholdMs = definition.thresholdMs;
    if (typeof thresholdMs !== "number" || durationMs < thresholdMs) {
      return;
    }

    const slowEvent: SidebarPerfSlowEvent = {
      type: "perf_slow_event",
      surface: definition.surface,
      metric: metricName,
      timestamp,
      durationMs,
      thresholdMs,
      labels,
      fields
    };

    this.slowEvents.push(slowEvent);
    this.onSlowEvent(slowEvent);
  }

  increment(
    metricName: string,
    options?: { labels?: SidebarPerfLabels; fields?: SidebarPerfFields; value?: number }
  ): void {
    const definition = this.definitions.get(metricName);
    if (!definition || definition.kind !== "counter") {
      return;
    }

    const incrementBy =
      typeof options?.value === "number" && Number.isFinite(options.value) ? options.value : 1;
    const labels = sanitizeLabels(definition, options?.labels);
    const fields = cloneFields(options?.fields);
    const state = this.getOrCreateCounter(metricName);
    state.total += incrementBy;

    const labelKey = formatCounterLabelKey(definition, labels);
    if (labelKey) {
      state.byLabel.set(labelKey, (state.byLabel.get(labelKey) ?? 0) + incrementBy);
    }

    state.lastSample = {
      timestamp: this.now(),
      labels,
      fields,
      value: incrementBy
    };
  }

  readSummary(): SidebarPerfSummary {
    const histograms: Record<string, SidebarPerfHistogramSummary> = {};
    for (const [metricName, ringBuffer] of this.histograms.entries()) {
      const samples = ringBuffer.toArray();
      if (samples.length === 0) {
        continue;
      }

      const durations = samples.map((entry) => entry.durationMs);
      histograms[metricName] = summarizeHistogram(durations, samples.at(-1)?.sample);
    }

    const counters: Record<string, SidebarPerfCounterSummary> = {};
    for (const [metricName, state] of this.counters.entries()) {
      counters[metricName] = {
        total: state.total,
        byLabel: state.byLabel.size > 0 ? Object.fromEntries(state.byLabel.entries()) : undefined,
        lastSample: state.lastSample
      };
    }

    return { histograms, counters };
  }

  readRecentSlowEvents(): SidebarPerfSlowEvent[] {
    return this.slowEvents.toArray();
  }

  private getOrCreateHistogram(metricName: string): FixedRingBuffer<DurationSample> {
    const existing = this.histograms.get(metricName);
    if (existing) {
      return existing;
    }

    const created = new FixedRingBuffer<DurationSample>(this.histogramWindow);
    this.histograms.set(metricName, created);
    return created;
  }

  private getOrCreateCounter(metricName: string): CounterState {
    const existing = this.counters.get(metricName);
    if (existing) {
      return existing;
    }

    const created: CounterState = {
      total: 0,
      byLabel: new Map<string, number>()
    };
    this.counters.set(metricName, created);
    return created;
  }
}

function sanitizeLabels(
  definition: SidebarPerfMetricDefinition,
  labels: SidebarPerfLabels | undefined
): SidebarPerfLabels {
  if (!labels) {
    return {};
  }

  const sanitized: SidebarPerfLabels = {};
  for (const labelKey of definition.labelKeys) {
    const value = labels[labelKey];
    if (value === undefined) {
      continue;
    }

    sanitized[labelKey] = value;
  }

  return sanitized;
}

function cloneFields(fields: SidebarPerfFields | undefined): SidebarPerfFields | undefined {
  if (!fields) {
    return undefined;
  }

  return { ...fields };
}

function summarizeHistogram(
  durations: number[],
  lastSample: SidebarPerfLastSample | undefined
): SidebarPerfHistogramSummary {
  const sorted = [...durations].sort((left, right) => left - right);
  const total = durations.reduce((sum, value) => sum + value, 0);

  return {
    count: durations.length,
    mean: total / durations.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    lastSample
  };
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0] ?? 0;
  }

  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[Math.min(index, sortedValues.length - 1)] ?? 0;
}

function formatCounterLabelKey(
  definition: SidebarPerfMetricDefinition,
  labels: SidebarPerfLabels
): string | undefined {
  const parts: string[] = [];
  for (const labelKey of definition.labelKeys) {
    const value = labels[labelKey];
    if (value === undefined) {
      continue;
    }

    parts.push(`${labelKey}=${String(value)}`);
  }

  return parts.length > 0 ? parts.join(",") : undefined;
}

function normalizeWindowSize(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function defaultSlowEventLogger(event: SidebarPerfSlowEvent): void {
  console.warn("[swarm] perf:slow_event", event);
}
