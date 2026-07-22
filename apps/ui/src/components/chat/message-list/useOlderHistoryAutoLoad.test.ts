/** @vitest-environment jsdom */

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOlderHistoryAutoLoad } from './useOlderHistoryAutoLoad'

interface HarnessProps {
  activeAgentId?: string
  cursor?: string
  hasOlder?: boolean
  isLoading?: boolean
  historyCompleteness?: 'complete' | 'partial_scan' | 'source_changed'
  onBeforeLoad?: () => void
  onLoad?: () => unknown | Promise<unknown>
}

interface ObserverRecord {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  target: Element | null
  disconnected: boolean
}

let container: HTMLDivElement
let root: Root
let observers: ObserverRecord[]

const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}

function Harness({
  activeAgentId = 'session-1',
  cursor = 'cursor-1',
  hasOlder = true,
  isLoading = false,
  historyCompleteness = 'complete',
  onBeforeLoad = () => undefined,
  onLoad,
}: HarnessProps) {
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const loader = useOlderHistoryAutoLoad({
    activeAgentId,
    cursor,
    hasOlder,
    isLoading,
    historyCompleteness,
    scrollRoot,
    onBeforeLoad,
    onLoad,
  })

  return createElement(
    'div',
    { ref: setScrollRoot, 'data-testid': 'scroll-root' },
    createElement('div', { ref: loader.sentinelRef, 'data-testid': 'sentinel' }),
    loader.loadFailed
      ? createElement('button', { type: 'button', onClick: loader.loadManually }, 'Retry')
      : null,
    !loader.observerSupported
      ? createElement('button', { type: 'button', onClick: loader.loadManually }, 'Load manually')
      : null,
  )
}

function render(props: HarnessProps) {
  act(() => {
    root.render(createElement(Harness, props))
  })
}

function latestObserver(): ObserverRecord {
  const observer = observers.at(-1)
  if (!observer) throw new Error('IntersectionObserver was not created')
  return observer
}

function notify(observer: ObserverRecord, isIntersecting: boolean) {
  act(() => {
    observer.callback(
      [{ isIntersecting, target: observer.target } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
  })
}

beforeEach(() => {
  reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
  observers = []
  class IntersectionObserverMock {
    private readonly record: ObserverRecord

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = { callback, options, target: null, disconnected: false }
      observers.push(this.record)
    }

    observe(target: Element) {
      this.record.target = target
    }

    disconnect() {
      this.record.disconnected = true
    }

    unobserve() {}
    takeRecords() { return [] }
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds = []
  }
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = false
})

describe('useOlderHistoryAutoLoad', () => {
  it('observes the top sentinel in the real scroll root with a prefetch margin', () => {
    const onLoad = vi.fn()
    render({ onLoad })

    const observer = latestObserver()
    expect(observer.options?.root).toBe(container.querySelector('[data-testid="scroll-root"]'))
    expect(observer.options?.rootMargin).toBe('400px 0px 0px 0px')

    notify(observer, false)
    expect(onLoad).not.toHaveBeenCalled()
    notify(observer, true)
    expect(onLoad).toHaveBeenCalledOnce()
  })

  it('captures the anchor and ignores duplicate callbacks for one cursor', () => {
    const onBeforeLoad = vi.fn()
    const onLoad = vi.fn()
    render({ onBeforeLoad, onLoad })

    const observer = latestObserver()
    notify(observer, true)
    notify(observer, true)

    expect(onBeforeLoad).toHaveBeenCalledOnce()
    expect(onBeforeLoad.mock.invocationCallOrder[0]).toBeLessThan(onLoad.mock.invocationCallOrder[0])
    expect(onLoad).toHaveBeenCalledOnce()
  })

  it('does not request while loading and resumes when the guard clears', () => {
    const onLoad = vi.fn()
    render({ isLoading: true, onLoad })

    notify(latestObserver(), true)
    expect(onLoad).not.toHaveBeenCalled()

    render({ isLoading: false, onLoad })
    expect(onLoad).toHaveBeenCalledOnce()
  })

  it('paces a chained request when the cursor advances while still near the top', async () => {
    const onLoad = vi.fn()
    render({ cursor: 'cursor-1', onLoad })
    notify(latestObserver(), true)
    await act(async () => Promise.resolve())
    expect(onLoad).toHaveBeenCalledOnce()

    render({ cursor: 'cursor-2', onLoad })
    notify(latestObserver(), true)
    expect(onLoad).toHaveBeenCalledOnce()

    act(() => vi.advanceTimersByTime(749))
    expect(onLoad).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(1))
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it('stops observing and loading at the end of history', () => {
    const onLoad = vi.fn()
    render({ onLoad })
    const firstObserver = latestObserver()

    render({ hasOlder: false, cursor: undefined, onLoad })
    expect(firstObserver.disconnected).toBe(true)
    notify(firstObserver, true)
    expect(onLoad).not.toHaveBeenCalled()
  })

  it('stops automatic retries after failure and permits an explicit retry', async () => {
    const onLoad = vi.fn()
      .mockRejectedValueOnce(new Error('page failed'))
      .mockResolvedValueOnce(undefined)
    render({ onLoad })
    const observer = latestObserver()

    notify(observer, true)
    await act(async () => Promise.resolve())
    expect(onLoad).toHaveBeenCalledOnce()
    expect(container.querySelector('button')?.textContent).toBe('Retry')

    notify(latestObserver(), true)
    expect(onLoad).toHaveBeenCalledOnce()

    act(() => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it('does not automatically load or retry a source-changed timeline', () => {
    const onLoad = vi.fn()
    render({ historyCompleteness: 'source_changed', onLoad })

    expect(observers).toHaveLength(0)
    expect(onLoad).not.toHaveBeenCalled()
  })

  it('scopes duplicate prevention to the active session', async () => {
    const onLoad = vi.fn()
    render({ activeAgentId: 'session-1', cursor: 'shared-cursor', onLoad })
    notify(latestObserver(), true)
    await act(async () => Promise.resolve())
    expect(onLoad).toHaveBeenCalledOnce()

    render({ activeAgentId: 'session-2', cursor: 'shared-cursor', onLoad })
    notify(latestObserver(), true)
    act(() => vi.advanceTimersByTime(750))
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it('allows the same bootstrap cursor after leaving through a session with no page', async () => {
    const onLoad = vi.fn()
    render({ activeAgentId: 'session-a', cursor: 'shared-cursor', onLoad })
    notify(latestObserver(), true)
    await act(async () => Promise.resolve())

    render({ activeAgentId: 'session-b', cursor: undefined, hasOlder: false, onLoad })
    render({ activeAgentId: 'session-a', cursor: 'shared-cursor', onLoad })
    notify(latestObserver(), true)
    act(() => vi.advanceTimersByTime(750))

    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it('clears a failed automatic attempt after leaving and returning to the session', async () => {
    const onLoad = vi.fn()
      .mockRejectedValueOnce(new Error('page failed'))
      .mockResolvedValueOnce(undefined)
    render({ activeAgentId: 'session-a', cursor: 'shared-cursor', onLoad })
    notify(latestObserver(), true)
    await act(async () => Promise.resolve())
    expect(container.querySelector('button')?.textContent).toBe('Retry')

    render({ activeAgentId: 'session-b', cursor: undefined, hasOlder: false, onLoad })
    render({ activeAgentId: 'session-a', cursor: 'shared-cursor', onLoad })
    notify(latestObserver(), true)
    act(() => vi.advanceTimersByTime(750))

    expect(onLoad).toHaveBeenCalledTimes(2)
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps one request in flight across sessions and reschedules the current page', async () => {
    let rejectSessionA: (error: Error) => void = () => undefined
    const sessionAPage = new Promise<never>((_resolve, reject) => {
      rejectSessionA = reject
    })
    const onLoadA = vi.fn(() => sessionAPage)
    const onLoadB = vi.fn().mockResolvedValue(undefined)

    render({ activeAgentId: 'session-a', cursor: 'cursor-a', onLoad: onLoadA })
    notify(latestObserver(), true)
    render({ activeAgentId: 'session-b', cursor: 'cursor-b', onLoad: onLoadB })
    notify(latestObserver(), true)
    expect(onLoadB).not.toHaveBeenCalled()

    await act(async () => {
      rejectSessionA(new Error('stale page failure'))
      await Promise.resolve()
    })
    expect(container.querySelector('button')).toBeNull()
    act(() => vi.advanceTimersByTime(750))

    expect(onLoadA).toHaveBeenCalledOnce()
    expect(onLoadB).toHaveBeenCalledOnce()
  })

  it('disconnects the observer and cancels a paced load when unmounted', async () => {
    const onLoad = vi.fn()
    render({ cursor: 'cursor-1', onLoad })
    notify(latestObserver(), true)
    await act(async () => Promise.resolve())

    render({ cursor: 'cursor-2', onLoad })
    const secondObserver = latestObserver()
    notify(secondObserver, true)
    act(() => root.render(null))
    act(() => vi.advanceTimersByTime(750))

    expect(secondObserver.disconnected).toBe(true)
    expect(onLoad).toHaveBeenCalledOnce()
  })
})
