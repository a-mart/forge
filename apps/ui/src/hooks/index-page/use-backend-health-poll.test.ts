/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const reportBuilderPoll = vi.fn()
const reportCollabPoll = vi.fn()

vi.mock('@/lib/connection-health-store', () => ({
  reportBuilderPoll: (...args: unknown[]) => reportBuilderPoll(...args),
  reportCollabPoll: (...args: unknown[]) => reportCollabPoll(...args),
}))

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (wsUrl: string, path: string) => {
    // Simple WS→HTTP conversion for tests
    const url = wsUrl.replace(/^ws/, 'http')
    return `${url.replace(/\/$/, '')}${path}`
  },
}))

const fetchMock = vi.fn()

// ---------------------------------------------------------------------------
// Import the module under test *after* mocks are set up
// ---------------------------------------------------------------------------

const { useBackendHealthPoll } = await import('./use-backend-health-poll')

// ---------------------------------------------------------------------------
// Helpers — render the hook in a minimal React tree
// ---------------------------------------------------------------------------

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'

let container: HTMLDivElement
let root: Root | null = null

function TestComponent({ builderWsUrl, collabWsUrls }: {
  builderWsUrl: string
  collabWsUrls: readonly string[]
}) {
  useBackendHealthPoll(builderWsUrl, collabWsUrls)
  return null
}

function renderHook(builderWsUrl: string, collabWsUrls: readonly string[]) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(TestComponent, { builderWsUrl, collabWsUrls }))
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  fetchMock.mockReset()
  reportBuilderPoll.mockReset()
  reportCollabPoll.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
    root = null
  }
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useBackendHealthPoll — multi-backend collab', () => {
  it('reports collab connected when at least one backend is reachable', async () => {
    // Backend A is up, backend B is down
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('collab-a')) return { ok: true, status: 200 }
      if (url.includes('collab-b')) throw new Error('unreachable')
      return { ok: true, status: 200 } // builder
    })

    renderHook('ws://builder', ['ws://collab-a', 'ws://collab-b'])

    // Flush microtasks (the initial poll is async)
    await vi.advanceTimersByTimeAsync(0)

    expect(reportBuilderPoll).toHaveBeenCalledWith(true)
    // At least one collab backend reachable → collab is available
    expect(reportCollabPoll).toHaveBeenCalledWith(true)
  })

  it('reports collab disconnected when no backend is reachable', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('collab')) throw new Error('unreachable')
      return { ok: true, status: 200 } // builder
    })

    renderHook('ws://builder', ['ws://collab-a', 'ws://collab-b'])
    await vi.advanceTimersByTimeAsync(0)

    expect(reportCollabPoll).toHaveBeenCalledWith(false)
  })

  it('reports collab disconnected when no collab URLs are provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })

    renderHook('ws://builder', [])
    await vi.advanceTimersByTimeAsync(0)

    expect(reportCollabPoll).toHaveBeenCalledWith(false)
  })

  it('reports collab connected with single backend (backward compat)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })

    renderHook('ws://builder', ['ws://collab'])
    await vi.advanceTimersByTimeAsync(0)

    expect(reportCollabPoll).toHaveBeenCalledWith(true)
  })

  it('polls periodically', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })

    renderHook('ws://builder', ['ws://collab'])

    // Initial poll
    await vi.advanceTimersByTimeAsync(0)
    const initialCallCount = reportCollabPoll.mock.calls.length

    // Advance past one poll interval
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reportCollabPoll.mock.calls.length).toBeGreaterThan(initialCallCount)
  })
})
