import { describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_BOOTSTRAP_METRIC,
  SIDEBAR_HISTORY_CACHE_STATE_METRIC,
  backendSidebarPerfMetricManifest
} from "../stats/sidebar-perf-metrics.js";
import { createSidebarPerfRegistry } from "../stats/sidebar-perf-registry.js";

describe("sidebar perf registry", () => {
  it("keeps a rolling histogram window and computes summary percentiles from retained samples", () => {
    const recorder = createSidebarPerfRegistry({
      manifest: backendSidebarPerfMetricManifest,
      histogramWindow: 3,
      onSlowEvent: vi.fn()
    });

    recorder.recordDuration(SIDEBAR_BOOTSTRAP_METRIC, 10, { labels: { buildMode: "dev" } });
    recorder.recordDuration(SIDEBAR_BOOTSTRAP_METRIC, 20, { labels: { buildMode: "dev" } });
    recorder.recordDuration(SIDEBAR_BOOTSTRAP_METRIC, 30, { labels: { buildMode: "dev" } });
    recorder.recordDuration(SIDEBAR_BOOTSTRAP_METRIC, 40, { labels: { buildMode: "dev" } });

    const summary = recorder.readSummary();
    expect(summary.histograms[SIDEBAR_BOOTSTRAP_METRIC]).toMatchObject({
      count: 3,
      mean: 30,
      p50: 30,
      p95: 40,
      max: 40,
    });
    expect(summary.histograms[SIDEBAR_BOOTSTRAP_METRIC]?.lastSample).toMatchObject({
      durationMs: 40,
      labels: { buildMode: "dev" },
    });
  });

  it("fires the slow-event hook only for threshold breaches and strips disallowed labels", () => {
    const onSlowEvent = vi.fn();
    const recorder = createSidebarPerfRegistry({
      manifest: backendSidebarPerfMetricManifest,
      onSlowEvent,
    });

    recorder.recordDuration(SIDEBAR_BOOTSTRAP_METRIC, 200, {
      labels: { buildMode: "prod", phase: "ignored" },
      fields: { agentId: "manager-1" },
    });
    recorder.increment(SIDEBAR_HISTORY_CACHE_STATE_METRIC, {
      labels: { cacheState: "memory", historySource: "memory", phase: "ignored" },
      fields: { agentId: "manager-1" },
    });
    recorder.recordDuration(SIDEBAR_BOOTSTRAP_METRIC, 900, {
      labels: { buildMode: "prod", phase: "ignored", cacheState: "memory" },
      fields: { agentId: "manager-1", payloadBytesTotal: 1234 },
    });

    expect(onSlowEvent).toHaveBeenCalledTimes(1);
    expect(onSlowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SIDEBAR_BOOTSTRAP_METRIC,
        durationMs: 900,
        thresholdMs: 750,
        labels: {
          buildMode: "prod",
          cacheState: "memory",
        },
        fields: {
          agentId: "manager-1",
          payloadBytesTotal: 1234,
        },
      })
    );

    const summary = recorder.readSummary();
    expect(summary.counters[SIDEBAR_HISTORY_CACHE_STATE_METRIC]).toMatchObject({
      total: 1,
      byLabel: {
        "cacheState=memory,historySource=memory": 1,
      },
    });
    expect(summary.counters[SIDEBAR_HISTORY_CACHE_STATE_METRIC]?.lastSample?.labels).toEqual({
      cacheState: "memory",
      historySource: "memory",
    });
    expect(recorder.readRecentSlowEvents()).toHaveLength(1);
  });
});
