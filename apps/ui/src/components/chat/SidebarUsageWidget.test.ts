/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderAccountUsage, ProviderUsageWindow } from '@forge/protocol'
import { TooltipProvider } from '@/components/ui/tooltip'
import { buildRows, getAccountLabel, getUsageMetrics, MiniVerticalGauge } from './SidebarUsageWidget'

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

describe('getAccountLabel', () => {
  const base: ProviderAccountUsage = { provider: 'anthropic', available: true }

  it('returns just the provider name for a single account', () => {
    expect(getAccountLabel('Anthropic', base, 0, 1)).toBe('Anthropic')
  })

  it('includes the account label when there are multiple accounts', () => {
    const account: ProviderAccountUsage = { ...base, accountLabel: 'Work' }
    expect(getAccountLabel('Anthropic', account, 0, 2)).toBe('Anthropic — Work')
  })

  it('falls back to accountEmail then accountId then index', () => {
    const withEmail: ProviderAccountUsage = { ...base, accountEmail: 'a@b.com' }
    expect(getAccountLabel('Anthropic', withEmail, 0, 2)).toBe('Anthropic — a@b.com')

    const withId: ProviderAccountUsage = { ...base, accountId: 'acct_123' }
    expect(getAccountLabel('Anthropic', withId, 1, 3)).toBe('Anthropic — acct_123')

    expect(getAccountLabel('Anthropic', base, 2, 3)).toBe('Anthropic — Account 3')
  })
})

describe('buildRows', () => {
  it('renders xAI as a weekly-only provider with the xAI brand asset', () => {
    const rows = buildRows({
      xai: [
        {
          provider: 'xai',
          available: true,
          plan: 'SuperGrok',
          weeklyUsage: {
            percent: 12.5,
            resetInfo: '3.0d',
            resetAtMs: WEEK_SECONDS * 1000,
            windowSeconds: WEEK_SECONDS,
          },
        },
      ],
    })

    expect(rows).toEqual([
      {
        key: 'xai-0',
        label: 'xAI',
        iconSrc: '/agents/xai-logo.svg',
        iconClassName: 'dark:invert',
        provider: 'xai',
        showSession: false,
        usage: expect.objectContaining({
          provider: 'xai',
          plan: 'SuperGrok',
          weeklyUsage: expect.objectContaining({ percent: 12.5 }),
        }),
      },
    ])
    expect(rows[0]?.usage?.sessionUsage).toBeUndefined()
  })
})

describe('MiniVerticalGauge', () => {
  let container: HTMLDivElement
  let root: Root | null = null

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount()
      })
    }
    root = null
    container.remove()
  })

  it('renders an accessible unknown marker for weekly-only xAI usage without a percent', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(
        TooltipProvider,
        null,
        createElement(MiniVerticalGauge, {
          weeklyPercent: null,
          weeklyDeltaPercent: null,
          providerColor: '#000000',
          label: 'xAI',
        }),
      ))
    })

    expect(container.querySelector('[data-testid="usage-gauge-unknown"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="xAI weekly usage unknown"]')).not.toBeNull()
  })

  it('does not mark a real 0% weekly window as unknown', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(
        TooltipProvider,
        null,
        createElement(MiniVerticalGauge, {
          weeklyPercent: 0,
          weeklyDeltaPercent: null,
          providerColor: '#000000',
          label: 'xAI',
        }),
      ))
    })

    expect(container.querySelector('[data-testid="usage-gauge-unknown"]')).toBeNull()
    expect(container.querySelector('[aria-label="xAI weekly usage unknown"]')).toBeNull()
  })
})
