import { describe, expect, it } from 'vitest'
import type { ProviderUsageWindow } from '@forge/protocol'
import { getUsageMetrics } from './SidebarUsageWidget'

const WEEK_SECONDS = 7 * 24 * 60 * 60

describe('getUsageMetrics', () => {
  it('matches codexbar deterministic weekly math when no historical pace is present', () => {
    const nowMs = 0
    const window: ProviderUsageWindow = {
      percent: 51,
      resetInfo: 'Resets in 4d 12h',
      resetAtMs: 4.5 * 24 * 60 * 60 * 1000,
      windowSeconds: WEEK_SECONDS,
    }

    const metrics = getUsageMetrics(window, nowMs)

    expect(metrics?.paceLabel).toBe('Far in deficit')
    expect(metrics?.paceSummary).toBe('15% in deficit')
    expect(metrics?.runoutLabel).toBe('Runs out in 2d 9h')
    expect(metrics?.deltaPercent).toBeCloseTo(15.2857142857, 6)
  })

  it('prefers historical pace from the backend when available', () => {
    const window: ProviderUsageWindow = {
      percent: 51,
      resetInfo: 'Resets in 4d 13h',
      resetAtMs: 0,
      windowSeconds: WEEK_SECONDS,
      pace: {
        mode: 'historical',
        expectedPercent: 63,
        deltaPercent: -12,
        willLastToReset: true,
        runOutProbability: 0.29,
      },
    }

    const metrics = getUsageMetrics(window, Date.now())

    expect(metrics).toEqual({
      paceLabel: 'Reserve',
      paceSummary: '12% in reserve',
      runoutLabel: 'Lasts until reset · ≈ 30% run-out risk',
      deltaPercent: -12,
    })
  })

  it('returns null for invalid deterministic windows the way codexbar does', () => {
    const nowMs = 0
    const window: ProviderUsageWindow = {
      percent: 12,
      resetInfo: 'Resets in 7d',
      resetAtMs: WEEK_SECONDS * 1000,
      windowSeconds: WEEK_SECONDS,
    }

    expect(getUsageMetrics(window, nowMs)).toBeNull()
  })
})
