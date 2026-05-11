/** @vitest-environment jsdom */

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'http://collab.test/',
}))

const fetchMock = vi.fn()

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { useCollaborationSession } = await import('./use-collaboration-session')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let container: HTMLDivElement
let root: Root | null = null

const captured: {
  current: ReturnType<typeof useCollaborationSession> | null
} = { current: null }

function TestComponent({ enabled, apiBaseUrl }: { enabled?: boolean; apiBaseUrl?: string }) {
  const result = useCollaborationSession({ enabled, apiBaseUrl })
  useEffect(() => {
    captured.current = result
  })
  return createElement('div', null, `admin=${result.isAdmin},member=${result.isMember},loaded=${result.hasLoaded}`)
}

function renderHook(props: { enabled?: boolean; apiBaseUrl?: string } = {}) {
  root = createRoot(container)
  act(() => {
    root?.render(createElement(TestComponent, props))
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  captured.current = null
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  // The hook skips loading in test mode by checking import.meta.env.MODE === 'test'.
  // Since vitest sets MODE=test, we need to override it for these tests.
  vi.stubEnv('MODE', 'production')
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
    root = null
  }
  container.remove()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useCollaborationSession — event listeners', () => {
  it('refreshes on forge-collab-connections-change event', async () => {
    // Initial fetch: collab not enabled
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/collaboration/status')) {
        return { ok: true, json: async () => ({ enabled: false }) }
      }
      return { ok: true, json: async () => ({ authenticated: false }) }
    })

    renderHook()
    // Wait for initial load
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(captured.current?.isCollabEnabled).toBe(false)

    // Now mock collab as enabled + admin
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/collaboration/status')) {
        return { ok: true, json: async () => ({ enabled: true, adminExists: true }) }
      }
      if (typeof url === 'string' && url.includes('/api/collaboration/me')) {
        return {
          ok: true,
          json: async () => ({
            authenticated: true,
            user: { userId: 'u1', email: 'a@test.com', role: 'admin' },
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    })

    // Dispatch the connections-change event (as SettingsCollaboration does after sign-in)
    await act(async () => {
      window.dispatchEvent(new Event('forge-collab-connections-change'))
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(captured.current?.isCollabEnabled).toBe(true)
    expect(captured.current?.isAdmin).toBe(true)
  })

  it('refreshes on forge-collab-server-url-change event (legacy)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/collaboration/status')) {
        return { ok: true, json: async () => ({ enabled: false }) }
      }
      return { ok: true, json: async () => ({ authenticated: false }) }
    })

    renderHook()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(captured.current?.isCollabEnabled).toBe(false)

    // Now change response
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/collaboration/status')) {
        return { ok: true, json: async () => ({ enabled: true }) }
      }
      if (typeof url === 'string' && url.includes('/api/collaboration/me')) {
        return {
          ok: true,
          json: async () => ({
            authenticated: true,
            user: { userId: 'u1', email: 'a@test.com', role: 'member' },
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    })

    await act(async () => {
      window.dispatchEvent(new Event('forge-collab-server-url-change'))
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(captured.current?.isCollabEnabled).toBe(true)
    expect(captured.current?.isMember).toBe(true)
  })

  it('does not listen to events when disabled', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) })

    renderHook({ enabled: false })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // fetch should not have been called at all for disabled hook
    const initialCalls = fetchMock.mock.calls.length

    // Dispatch event — should not trigger fetch
    await act(async () => {
      window.dispatchEvent(new Event('forge-collab-connections-change'))
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(fetchMock.mock.calls.length).toBe(initialCalls)
  })
})
