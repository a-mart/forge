/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it } from 'vitest'
import {
  reportBuilderConnected,
  reportCollabConnected,
  markBuilderInactive,
  markCollabInactive,
  useConnectionHealth,
  _resetForTesting,
  _getTrackers,
  type ConnectionHealth,
} from './connection-health-store'

afterEach(() => {
  _resetForTesting()
})

// ---------------------------------------------------------------------------
// Helper: render hook into a real React tree
// ---------------------------------------------------------------------------

function renderHook() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let captured: { builder: ConnectionHealth; collab: ConnectionHealth } | null = null

  function TestComponent() {
    // eslint-disable-next-line react-hooks/globals -- test-only capture pattern
    captured = useConnectionHealth()
    return null
  }

  flushSync(() => {
    root.render(createElement(TestComponent))
  })

  return {
    get value() {
      return captured!
    },
    cleanup() {
      root.unmount()
      document.body.removeChild(container)
    },
  }
}

// ---------------------------------------------------------------------------
// Core health derivation
// ---------------------------------------------------------------------------

describe('health derivation', () => {
  it('defaults to both disconnected', () => {
    const hook = renderHook()
    expect(hook.value).toEqual({ builder: 'disconnected', collab: 'disconnected' })
    hook.cleanup()
  })

  it('shows connected when WS reports true', () => {
    const hook = renderHook()
    flushSync(() => reportBuilderConnected(true))
    expect(hook.value.builder).toBe('connected')
    hook.cleanup()
  })

  it('shows disconnected when WS reports false and never connected', () => {
    const hook = renderHook()
    flushSync(() => reportBuilderConnected(false))
    expect(hook.value.builder).toBe('disconnected')
    hook.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Blocker 1: amber (reconnecting) must be reachable
// ---------------------------------------------------------------------------

describe('reconnecting (amber) state', () => {
  it('shows reconnecting after connect -> disconnect cycle', () => {
    const hook = renderHook()

    // Phase 1: WS connects and bootstraps
    flushSync(() => reportBuilderConnected(true))
    expect(hook.value.builder).toBe('connected')

    // Phase 2: WS drops — clients clear their hasBootstrapped flag, but
    // the store retains wasEverConnected internally
    flushSync(() => reportBuilderConnected(false))
    expect(hook.value.builder).toBe('reconnecting')

    hook.cleanup()
  })

  it('returns to connected after reconnect completes', () => {
    const hook = renderHook()

    flushSync(() => reportBuilderConnected(true))
    flushSync(() => reportBuilderConnected(false))
    expect(hook.value.builder).toBe('reconnecting')

    // Phase 3: WS reconnects
    flushSync(() => reportBuilderConnected(true))
    expect(hook.value.builder).toBe('connected')

    hook.cleanup()
  })

  it('tracks wasEverConnected per surface independently', () => {
    const hook = renderHook()

    flushSync(() => reportBuilderConnected(true))
    flushSync(() => reportBuilderConnected(false))
    expect(hook.value.builder).toBe('reconnecting')
    // Collab never connected — stays disconnected, not reconnecting
    expect(hook.value.collab).toBe('disconnected')

    hook.cleanup()
  })

  it('works for collab surface too', () => {
    const hook = renderHook()

    flushSync(() => reportCollabConnected(true))
    flushSync(() => reportCollabConnected(false))
    expect(hook.value.collab).toBe('reconnecting')

    hook.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Blocker 2: inactive surface shows disconnected, not stale green
// ---------------------------------------------------------------------------

describe('mark inactive on unmount', () => {
  it('shows disconnected after markBuilderInactive even if last report was connected', () => {
    const hook = renderHook()

    flushSync(() => reportBuilderConnected(true))
    expect(hook.value.builder).toBe('connected')

    flushSync(() => markBuilderInactive())
    expect(hook.value.builder).toBe('disconnected')

    hook.cleanup()
  })

  it('shows disconnected after markCollabInactive even if last report was connected', () => {
    const hook = renderHook()

    flushSync(() => reportCollabConnected(true))
    expect(hook.value.collab).toBe('connected')

    flushSync(() => markCollabInactive())
    expect(hook.value.collab).toBe('disconnected')

    hook.cleanup()
  })

  it('resets wasEverConnected so remount starts fresh', () => {
    flushSync(() => reportBuilderConnected(true))
    flushSync(() => markBuilderInactive())

    // After marking inactive, the tracker is fully reset
    const trackers = _getTrackers()
    expect(trackers.builder.wasEverConnected).toBe(false)
    expect(trackers.builder.active).toBe(false)

    // Fresh mount reports false — should be 'disconnected' not 'reconnecting'
    const hook = renderHook()
    flushSync(() => reportBuilderConnected(false))
    expect(hook.value.builder).toBe('disconnected')

    hook.cleanup()
  })

  it('does not affect the other surface', () => {
    const hook = renderHook()

    flushSync(() => {
      reportBuilderConnected(true)
      reportCollabConnected(true)
    })
    expect(hook.value).toEqual({ builder: 'connected', collab: 'connected' })

    flushSync(() => markBuilderInactive())
    expect(hook.value).toEqual({ builder: 'disconnected', collab: 'connected' })

    hook.cleanup()
  })
})

// ---------------------------------------------------------------------------
// No-op dedup (no spurious re-renders)
// ---------------------------------------------------------------------------

describe('dedup', () => {
  it('does not notify when derived health is unchanged', () => {
    let renderCount = 0
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    function TestComponent() {
      useConnectionHealth()
      renderCount++
      return null
    }

    flushSync(() => root.render(createElement(TestComponent)))

    // Report false (already disconnected, but active changes) — one render expected
    flushSync(() => reportBuilderConnected(false))
    const afterFirstReport = renderCount

    // Same value again — no change at all
    flushSync(() => reportBuilderConnected(false))
    expect(renderCount).toBe(afterFirstReport)

    root.unmount()
    document.body.removeChild(container)
  })
})

// ---------------------------------------------------------------------------
// Full lifecycle simulation (mount -> connect -> disconnect -> unmount -> remount)
// ---------------------------------------------------------------------------

describe('full surface lifecycle', () => {
  it('builder: mount -> connect -> drop -> reconnect -> unmount -> remount', () => {
    const hook = renderHook()

    // Mount: initial report
    flushSync(() => reportBuilderConnected(false))
    expect(hook.value.builder).toBe('disconnected')

    // Connect
    flushSync(() => reportBuilderConnected(true))
    expect(hook.value.builder).toBe('connected')

    // Drop
    flushSync(() => reportBuilderConnected(false))
    expect(hook.value.builder).toBe('reconnecting')

    // Reconnect
    flushSync(() => reportBuilderConnected(true))
    expect(hook.value.builder).toBe('connected')

    // Unmount
    flushSync(() => markBuilderInactive())
    expect(hook.value.builder).toBe('disconnected')

    // Remount (fresh client, starts disconnected)
    flushSync(() => reportBuilderConnected(false))
    expect(hook.value.builder).toBe('disconnected')

    // New client connects
    flushSync(() => reportBuilderConnected(true))
    expect(hook.value.builder).toBe('connected')

    hook.cleanup()
  })
})
