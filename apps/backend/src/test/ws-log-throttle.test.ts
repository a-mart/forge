import { afterEach, describe, expect, it, vi } from 'vitest'
import { warnWsThrottled, resetWsLogThrottleForTest } from '../ws/ws-log-throttle.js'

afterEach(() => {
  resetWsLogThrottleForTest()
  vi.restoreAllMocks()
})

describe('warnWsThrottled', () => {
  it('logs the first occurrence, suppresses repeats inside the window, and reports suppressed count later', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warnWsThrottled('backpressure', '[swarm] ws:drop_event:backpressure', { eventType: 'ready' }, { nowMs: 1_000, throttleMs: 30_000 })
    warnWsThrottled('backpressure', '[swarm] ws:drop_event:backpressure', { eventType: 'agents_snapshot' }, { nowMs: 2_000, throttleMs: 30_000 })
    warnWsThrottled('backpressure', '[swarm] ws:drop_event:backpressure', { eventType: 'profiles_snapshot' }, { nowMs: 31_000, throttleMs: 30_000 })

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenNthCalledWith(1, '[swarm] ws:drop_event:backpressure', {
      eventType: 'ready',
    })
    expect(warn).toHaveBeenNthCalledWith(2, '[swarm] ws:drop_event:backpressure', {
      eventType: 'profiles_snapshot',
      suppressedCount: 1,
    })
  })

  it('tracks throttle state independently by key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warnWsThrottled('bootstrap:manager-1', '[swarm] ws:trim_bootstrap_history', { agentId: 'manager-1' }, { nowMs: 1_000 })
    warnWsThrottled('bootstrap:manager-2', '[swarm] ws:trim_bootstrap_history', { agentId: 'manager-2' }, { nowMs: 1_000 })

    expect(warn).toHaveBeenCalledTimes(2)
  })
})
