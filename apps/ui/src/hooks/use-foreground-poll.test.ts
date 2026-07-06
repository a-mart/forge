/** @vitest-environment jsdom */

import { createElement, useCallback } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useForegroundPoll } from './use-foreground-poll'

let container: HTMLDivElement
let root: Root | null = null

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

function Harness({ poll, intervalMs, enabled }: {
  poll: (signal: AbortSignal) => Promise<void>
  intervalMs: number
  enabled?: boolean
}) {
  const stablePoll = useCallback(poll, [poll])
  useForegroundPoll(stablePoll, { intervalMs, enabled })
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  setVisibility('visible')
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.useRealTimers()
})

describe('useForegroundPoll', () => {
  it('runs once immediately and reschedules after each completion', async () => {
    const poll = vi.fn(async () => {})

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(Harness, { poll, intervalMs: 5_000 }))
    })

    // Immediate run on mount.
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(1)

    // Next run one interval after the first completes.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(poll).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it('does not run when disabled', async () => {
    const poll = vi.fn(async () => {})

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(Harness, { poll, intervalMs: 5_000, enabled: false }))
    })

    await vi.advanceTimersByTimeAsync(20_000)
    expect(poll).not.toHaveBeenCalled()
  })

  it('pauses while hidden and runs immediately when visible again', async () => {
    const poll = vi.fn(async () => {})

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(Harness, { poll, intervalMs: 5_000 }))
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(1)

    // Hide: pending timer is cleared, so no further polls fire.
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(poll).toHaveBeenCalledTimes(1)

    // Visible again: immediate poll, then schedule resumes.
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it('aborts the in-flight poll signal on unmount', async () => {
    let capturedSignal: AbortSignal | null = null
    const poll = vi.fn(async (signal: AbortSignal) => {
      capturedSignal = signal
      await new Promise(() => {}) // never resolves — stays in-flight
    })

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(Harness, { poll, intervalMs: 5_000 }))
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(capturedSignal).not.toBeNull()
    expect(capturedSignal!.aborted).toBe(false)

    flushSync(() => root?.unmount())
    root = null
    expect(capturedSignal!.aborted).toBe(true)
  })
})
