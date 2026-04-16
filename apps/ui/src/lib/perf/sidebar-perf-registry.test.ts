import { describe, expect, it, vi } from 'vitest'
import { createSidebarPerfRegistry } from './sidebar-perf-registry'
import { SIDEBAR_PERF_METRIC_NAMES } from './sidebar-perf-metrics'

function createRegistryWithFakeClock() {
  let nowMs = 0
  const advance = (delta: number) => {
    nowMs += delta
  }
  const warn = vi.fn<(message: string, payload: unknown) => void>()
  const registry = createSidebarPerfRegistry({
    now: () => nowMs,
    warn,
  })
  return { registry, advance, warn, getNow: () => nowMs }
}

describe('createSidebarPerfRegistry — rolling window + threshold hook', () => {
  it('keeps histograms bounded to the most recent 128 samples (FIFO replacement)', () => {
    const { registry } = createRegistryWithFakeClock()

    // Push 200 distinct durations into the histogram.
    for (let i = 0; i < 200; i += 1) {
      registry.recordDuration(
        SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs,
        i,
      )
    }

    const summary = registry.readSummary()
    const histogram = summary.histograms[
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs
    ]
    expect(histogram).toBeDefined()
    // Window cap is 128.
    expect(histogram.count).toBe(128)
    // The retained samples should be the last 128 (72..199), so:
    //   max = 199, mean = (72 + 199) / 2 = 135.5
    expect(histogram.max).toBe(199)
    expect(histogram.mean).toBeCloseTo((72 + 199) / 2)
    // p95 over [72..199] should be at the 95th percentile mark.
    expect(histogram.p95).toBeGreaterThanOrEqual(190)
  })

  it('fires the slow-threshold hook exactly once per breach', () => {
    const { registry, warn } = createRegistryWithFakeClock()

    // Threshold for click_to_history_loaded_ms is 300ms (manifest).
    registry.recordDuration(
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs,
      150,
    )
    expect(warn).not.toHaveBeenCalled()

    registry.recordDuration(
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs,
      305,
    )
    expect(warn).toHaveBeenCalledTimes(1)
    const slow = registry.readRecentSlowEvents()
    expect(slow).toHaveLength(1)
    expect(slow[0].metric).toBe(
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs,
    )
    expect(slow[0].durationMs).toBe(305)
    expect(slow[0].thresholdMs).toBe(300)

    // Another breach should add a second slow event but not double-fire for
    // the previous one.
    registry.recordDuration(
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs,
      400,
    )
    expect(warn).toHaveBeenCalledTimes(2)
    expect(registry.readRecentSlowEvents()).toHaveLength(2)
  })

  it('drops disallowed label keys (manifest allowlist)', () => {
    const { registry } = createRegistryWithFakeClock()

    registry.recordDuration(
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs,
      42,
      {
        labels: {
          // disallowed by the manifest:
          agentId: 'manager--1',
          // disallowed:
          historySource: 'memory',
          // allowed (always provided by the registry too):
          buildMode: 'prod',
        } as unknown as Record<string, string>,
      },
    )

    const summary = registry.readSummary()
    const histogram = summary.histograms[
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs
    ]
    expect(histogram.lastSample?.labels.agentId).toBeUndefined()
    expect(histogram.lastSample?.labels.historySource).toBeUndefined()
    expect(histogram.lastSample?.labels.buildMode).toBeDefined()
  })
})

describe('session-switch token contract', () => {
  it('completes click_to_history_loaded_ms only on matching agent', () => {
    const { registry, advance } = createRegistryWithFakeClock()
    registry.startSessionSwitch('agent-A')
    advance(120)
    // Late event for an old target should be ignored.
    registry.markHistoryLoaded('agent-other', {
      conversationMessageCount: 1,
      activityMessageCount: 0,
      allMessageCount: 1,
    })
    let summary = registry.readSummary()
    expect(
      summary.histograms[
        SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs
      ],
    ).toBeUndefined()

    registry.markHistoryLoaded('agent-A', {
      conversationMessageCount: 5,
      activityMessageCount: 2,
      allMessageCount: 7,
    })
    summary = registry.readSummary()
    const histogram = summary.histograms[
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs
    ]
    expect(histogram.count).toBe(1)
    expect(histogram.lastSample?.durationMs).toBe(120)
    expect(histogram.lastSample?.fields.agentId).toBe('agent-A')
    expect(histogram.lastSample?.fields.conversationMessageCount).toBe(5)
    expect(histogram.lastSample?.fields.activityMessageCount).toBe(2)
    expect(histogram.lastSample?.fields.allMessageCount).toBe(7)
    expect(histogram.lastSample?.fields.interactionToken).toBeTypeOf('number')
  })

  it('starting a new click invalidates the previous session-switch token', () => {
    const { registry, advance } = createRegistryWithFakeClock()
    registry.startSessionSwitch('agent-A')
    advance(50)
    registry.startSessionSwitch('agent-B')
    advance(40)
    registry.markHistoryLoaded('agent-A', {
      conversationMessageCount: 1,
      activityMessageCount: 0,
      allMessageCount: 1,
    })

    let summary = registry.readSummary()
    expect(
      summary.histograms[
        SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs
      ],
    ).toBeUndefined()

    registry.markHistoryLoaded('agent-B', {
      conversationMessageCount: 2,
      activityMessageCount: 1,
      allMessageCount: 3,
    })
    summary = registry.readSummary()
    const histogram = summary.histograms[
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs
    ]
    expect(histogram.count).toBe(1)
    expect(histogram.lastSample?.fields.agentId).toBe('agent-B')
    // Duration is from the start of the agent-B click, not from the agent-A click.
    expect(histogram.lastSample?.durationMs).toBe(40)
  })
})

describe('first-transcript paint guard (regression — reset empty-state must not complete)', () => {
  it('refuses to complete first-paint before conversation_history has been recorded', () => {
    const { registry, advance } = createRegistryWithFakeClock()
    registry.startSessionSwitch('agent-A')

    // Reset empty-state renders BEFORE conversation_history arrives.
    advance(20)
    const completedEarly = registry.maybeCompleteFirstPaint('agent-A', {
      displayEntryCount: 0,
      emptySession: true,
    })
    expect(completedEarly).toBe(false)

    // No paint sample should exist.
    let summary = registry.readSummary()
    expect(
      summary.histograms[
        SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs
      ],
    ).toBeUndefined()

    // conversation_history arrives.
    advance(80)
    registry.markHistoryLoaded('agent-A', {
      conversationMessageCount: 12,
      activityMessageCount: 4,
      allMessageCount: 16,
    })

    // First post-bootstrap paint with content can complete.
    advance(10)
    const completed = registry.maybeCompleteFirstPaint('agent-A', {
      displayEntryCount: 12,
      emptySession: false,
    })
    expect(completed).toBe(true)

    summary = registry.readSummary()
    const histogram = summary.histograms[
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs
    ]
    expect(histogram.count).toBe(1)
    // 20 + 80 + 10 = 110ms total since click.
    expect(histogram.lastSample?.durationMs).toBe(110)
    expect(histogram.lastSample?.fields.displayEntryCount).toBe(12)
    expect(histogram.lastSample?.fields.emptySession).toBe(false)
  })

  it('allows empty-session paint to complete after empty conversation_history', () => {
    const { registry, advance } = createRegistryWithFakeClock()
    registry.startSessionSwitch('agent-empty')
    advance(40)
    registry.markHistoryLoaded('agent-empty', {
      conversationMessageCount: 0,
      activityMessageCount: 0,
      allMessageCount: 0,
    })
    advance(15)
    const completed = registry.maybeCompleteFirstPaint('agent-empty', {
      displayEntryCount: 0,
      emptySession: true,
    })
    expect(completed).toBe(true)

    const summary = registry.readSummary()
    const histogram = summary.histograms[
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs
    ]
    expect(histogram.count).toBe(1)
    expect(histogram.lastSample?.fields.emptySession).toBe(true)
    expect(histogram.lastSample?.fields.displayEntryCount).toBe(0)
  })

  it('refuses second completion for the same token (one paint sample per click)', () => {
    const { registry, advance } = createRegistryWithFakeClock()
    registry.startSessionSwitch('agent-A')
    advance(30)
    registry.markHistoryLoaded('agent-A', {
      conversationMessageCount: 1,
      activityMessageCount: 0,
      allMessageCount: 1,
    })

    advance(10)
    expect(
      registry.maybeCompleteFirstPaint('agent-A', {
        displayEntryCount: 1,
        emptySession: false,
      }),
    ).toBe(true)

    advance(50)
    expect(
      registry.maybeCompleteFirstPaint('agent-A', {
        displayEntryCount: 1,
        emptySession: false,
      }),
    ).toBe(false)

    const summary = registry.readSummary()
    expect(
      summary.histograms[
        SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs
      ].count,
    ).toBe(1)
  })

  it('refuses paint completion for an agentId other than the active token', () => {
    const { registry, advance } = createRegistryWithFakeClock()
    registry.startSessionSwitch('agent-A')
    advance(20)
    registry.markHistoryLoaded('agent-A', {
      conversationMessageCount: 1,
      activityMessageCount: 0,
      allMessageCount: 1,
    })

    // A late commit from a previous session should not complete the paint
    // metric for the active agent-A token.
    expect(
      registry.maybeCompleteFirstPaint('agent-other', {
        displayEntryCount: 9,
        emptySession: false,
      }),
    ).toBe(false)

    const summary = registry.readSummary()
    expect(
      summary.histograms[
        SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs
      ],
    ).toBeUndefined()
  })
})
