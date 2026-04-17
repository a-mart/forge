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
    // Disallowed keys should have been filtered out — verify via untyped access.
    const labels = histogram.lastSample?.labels as Record<string, unknown> | undefined
    expect(labels?.agentId).toBeUndefined()
    expect(labels?.historySource).toBeUndefined()
    expect(histogram.lastSample?.labels.buildMode).toBeDefined()
  })
})

describe('session-switch token contract', () => {
  it('completes click_to_history_loaded_ms only on matching agent', () => {
    const { registry, advance } = createRegistryWithFakeClock()
    const interaction = registry.startSessionSwitch('agent-A')!
    advance(120)
    // Late event for an old target should be ignored.
    registry.markHistoryLoaded('agent-other', interaction.token, {
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

    registry.markHistoryLoaded('agent-A', interaction.token, {
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
    const interactionB = registry.startSessionSwitch('agent-B')!
    advance(40)
    // Stale nonce from A's token would not match active interaction (B).
    registry.markHistoryLoaded('agent-A', interactionB.token, {
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

    registry.markHistoryLoaded('agent-B', interactionB.token, {
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

  it('rejects markHistoryLoaded with a mismatched nonce', () => {
    const { registry, advance } = createRegistryWithFakeClock()
    const interaction = registry.startSessionSwitch('agent-A')!
    advance(100)
    // Pass a stale nonce (interaction.token - 1 would be wrong).
    registry.markHistoryLoaded('agent-A', interaction.token + 999, {
      conversationMessageCount: 5,
      activityMessageCount: 0,
      allMessageCount: 5,
    })
    const summary = registry.readSummary()
    expect(
      summary.histograms[SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs],
    ).toBeUndefined()
  })
})

describe('first-transcript paint guard (regression — reset empty-state must not complete)', () => {
  it('refuses to complete first-paint before conversation_history has been recorded', () => {
    const { registry, advance } = createRegistryWithFakeClock()
    const interaction = registry.startSessionSwitch('agent-A')!

    // Reset empty-state renders BEFORE conversation_history arrives.
    advance(20)
    const completedEarly = registry.maybeCompleteFirstPaint('agent-A', interaction.token, {
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
    registry.markHistoryLoaded('agent-A', interaction.token, {
      conversationMessageCount: 12,
      activityMessageCount: 4,
      allMessageCount: 16,
    })

    // First post-bootstrap paint with content can complete.
    advance(10)
    const completed = registry.maybeCompleteFirstPaint('agent-A', interaction.token, {
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
    const interaction = registry.startSessionSwitch('agent-empty')!
    advance(40)
    registry.markHistoryLoaded('agent-empty', interaction.token, {
      conversationMessageCount: 0,
      activityMessageCount: 0,
      allMessageCount: 0,
    })
    advance(15)
    const completed = registry.maybeCompleteFirstPaint('agent-empty', interaction.token, {
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
    const interaction = registry.startSessionSwitch('agent-A')!
    advance(30)
    registry.markHistoryLoaded('agent-A', interaction.token, {
      conversationMessageCount: 1,
      activityMessageCount: 0,
      allMessageCount: 1,
    })

    advance(10)
    expect(
      registry.maybeCompleteFirstPaint('agent-A', interaction.token, {
        displayEntryCount: 1,
        emptySession: false,
      }),
    ).toBe(true)

    advance(50)
    expect(
      registry.maybeCompleteFirstPaint('agent-A', interaction.token, {
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
    const interaction = registry.startSessionSwitch('agent-A')!
    advance(20)
    registry.markHistoryLoaded('agent-A', interaction.token, {
      conversationMessageCount: 1,
      activityMessageCount: 0,
      allMessageCount: 1,
    })

    // A late commit from a previous session should not complete the paint
    // metric for the active agent-A token.
    expect(
      registry.maybeCompleteFirstPaint('agent-other', interaction.token, {
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

describe('A→B→A rapid-switch staleRisk detection', () => {
  it('marks the second A click as staleRisk and drops both metrics', () => {
    const { registry, advance } = createRegistryWithFakeClock()

    // Click A (first).
    registry.startSessionSwitch('agent-A')
    advance(10)

    // Click B — A is still in-flight (no history loaded).
    registry.startSessionSwitch('agent-B')
    advance(10)

    // Click A again — A is still in-flight from the first click.
    const secondA = registry.startSessionSwitch('agent-A')!
    expect(secondA.staleRisk).toBe(true)
    advance(50)

    // First A's conversation_history arrives (stale).
    registry.markHistoryLoaded('agent-A', secondA.token, {
      conversationMessageCount: 10,
      activityMessageCount: 2,
      allMessageCount: 12,
    })

    // History-loaded metric should NOT be recorded due to staleRisk.
    let summary = registry.readSummary()
    expect(
      summary.histograms[SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs],
    ).toBeUndefined()

    // Paint completion should also be dropped.
    advance(5)
    const painted = registry.maybeCompleteFirstPaint('agent-A', secondA.token, {
      displayEntryCount: 10,
      emptySession: false,
    })
    expect(painted).toBe(false)

    summary = registry.readSummary()
    expect(
      summary.histograms[SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs],
    ).toBeUndefined()
  })

  it('does not flag staleRisk for A→B (different agents)', () => {
    const { registry, advance } = createRegistryWithFakeClock()

    const interactionA = registry.startSessionSwitch('agent-A')!
    expect(interactionA.staleRisk).toBe(false)
    advance(50)

    const interactionB = registry.startSessionSwitch('agent-B')!
    expect(interactionB.staleRisk).toBe(false)
    advance(30)

    // B's history arrives — should record normally.
    registry.markHistoryLoaded('agent-B', interactionB.token, {
      conversationMessageCount: 3,
      activityMessageCount: 1,
      allMessageCount: 4,
    })
    const summary = registry.readSummary()
    expect(
      summary.histograms[SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs]?.count,
    ).toBe(1)
  })

  it('clears staleRisk after history resolves and subsequent click is clean', () => {
    const { registry, advance } = createRegistryWithFakeClock()

    // A→B→A rapid switch (staleRisk).
    registry.startSessionSwitch('agent-A')
    advance(10)
    registry.startSessionSwitch('agent-B')
    advance(10)
    const staleA = registry.startSessionSwitch('agent-A')!
    expect(staleA.staleRisk).toBe(true)
    advance(30)

    // History for the stale A arrives, resolving the in-flight state.
    registry.markHistoryLoaded('agent-A', staleA.token, {
      conversationMessageCount: 5,
      activityMessageCount: 0,
      allMessageCount: 5,
    })

    // Now click A again — should be clean because the in-flight A was resolved.
    advance(10)
    const cleanA = registry.startSessionSwitch('agent-A')!
    expect(cleanA.staleRisk).toBe(false)

    advance(40)
    registry.markHistoryLoaded('agent-A', cleanA.token, {
      conversationMessageCount: 5,
      activityMessageCount: 0,
      allMessageCount: 5,
    })

    const summary = registry.readSummary()
    // Only one recorded sample (the clean one) — stale was dropped.
    expect(
      summary.histograms[SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs]?.count,
    ).toBe(1)
    expect(
      summary.histograms[SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs]
        ?.lastSample?.durationMs,
    ).toBe(40)
  })

  it('handles A→A (same-agent double-click) as staleRisk', () => {
    const { registry, advance } = createRegistryWithFakeClock()

    registry.startSessionSwitch('agent-A')
    advance(10)
    const secondA = registry.startSessionSwitch('agent-A')!
    expect(secondA.staleRisk).toBe(true)
  })
})

describe('integration-style wiring seam tests', () => {
  it('reset empty-state → history → post-history paint records only after history', () => {
    const { registry, advance } = createRegistryWithFakeClock()

    // Step 1: start session switch.
    const interaction = registry.startSessionSwitch('agentA')!

    // Step 2: reset empty-state render fires (messages cleared, no content).
    advance(5)
    const earlyPaint = registry.maybeCompleteFirstPaint('agentA', interaction.token, {
      displayEntryCount: 0,
      emptySession: true,
    })
    expect(earlyPaint).toBe(false)

    // Step 3: conversation_history arrives.
    advance(95)
    registry.markHistoryLoaded('agentA', interaction.token, {
      conversationMessageCount: 8,
      activityMessageCount: 3,
      allMessageCount: 11,
    })

    // Step 4: post-bootstrap paint.
    advance(10)
    const postHistoryPaint = registry.maybeCompleteFirstPaint('agentA', interaction.token, {
      displayEntryCount: 8,
      emptySession: false,
    })
    expect(postHistoryPaint).toBe(true)

    const summary = registry.readSummary()
    // History-loaded metric recorded.
    const historyHist = summary.histograms[
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs
    ]
    expect(historyHist.count).toBe(1)
    expect(historyHist.lastSample?.durationMs).toBe(100) // 5 + 95
    // Paint metric recorded.
    const paintHist = summary.histograms[
      SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs
    ]
    expect(paintHist.count).toBe(1)
    expect(paintHist.lastSample?.durationMs).toBe(110) // 5 + 95 + 10
  })

  it('A→B→A rapid switch: stale first-A bootstrap does NOT complete second-A metric', () => {
    const { registry, advance } = createRegistryWithFakeClock()

    // Click A (first time).
    const firstA = registry.startSessionSwitch('agent-A')!
    expect(firstA.staleRisk).toBe(false)
    advance(20)

    // Click B before A's history arrives.
    const switchB = registry.startSessionSwitch('agent-B')!
    expect(switchB.staleRisk).toBe(false)
    advance(20)

    // Click A again (rapid revisit) — first A is still in-flight.
    const secondA = registry.startSessionSwitch('agent-A')!
    expect(secondA.staleRisk).toBe(true)
    advance(30)

    // First A's conversation_history arrives (stale data).
    // Caller reads active nonce = secondA.token and passes it.
    const activeNonce = registry.getActiveSessionSwitch()!.token
    expect(activeNonce).toBe(secondA.token)

    registry.markHistoryLoaded('agent-A', activeNonce, {
      conversationMessageCount: 15,
      activityMessageCount: 5,
      allMessageCount: 20,
    })

    // History-loaded metric must NOT be recorded (staleRisk).
    let summary = registry.readSummary()
    expect(
      summary.histograms[SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToHistoryLoadedMs],
    ).toBeUndefined()

    // Paint effect fires — must also be dropped.
    advance(5)
    const painted = registry.maybeCompleteFirstPaint('agent-A', activeNonce, {
      displayEntryCount: 15,
      emptySession: false,
    })
    expect(painted).toBe(false)

    summary = registry.readSummary()
    expect(
      summary.histograms[SIDEBAR_PERF_METRIC_NAMES.sessionSwitchClickToFirstTranscriptPaintMs],
    ).toBeUndefined()
  })
})
