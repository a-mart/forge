/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it } from 'vitest'
import {
  reportBuilderConnected,
  reportCollabConnected,
  reportBuilderPoll,
  reportCollabPoll,
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
// markInactive — clears WS signal but poll keeps availability accurate
// ---------------------------------------------------------------------------

describe('mark inactive on unmount', () => {
  it('shows reconnecting (not stale green) after markBuilderInactive when no poll', () => {
    const hook = renderHook()

    flushSync(() => reportBuilderConnected(true))
    expect(hook.value.builder).toBe('connected')

    // Unmount clears WS; wasEverConnected preserved → reconnecting
    flushSync(() => markBuilderInactive())
    expect(hook.value.builder).toBe('reconnecting')

    hook.cleanup()
  })

  it('stays green after markCollabInactive when poll says available', () => {
    const hook = renderHook()

    flushSync(() => {
      reportCollabConnected(true)
      reportCollabPoll(true)
    })
    expect(hook.value.collab).toBe('connected')

    // Unmount clears WS but poll keeps it green
    flushSync(() => markCollabInactive())
    expect(hook.value.collab).toBe('connected')

    hook.cleanup()
  })

  it('preserves wasEverConnected across markInactive', () => {
    flushSync(() => reportBuilderConnected(true))
    flushSync(() => markBuilderInactive())

    const trackers = _getTrackers()
    expect(trackers.builder.wasEverConnected).toBe(true)
    expect(trackers.builder.wsConnected).toBe(false)
  })

  it('does not affect the other surface', () => {
    const hook = renderHook()

    flushSync(() => {
      reportBuilderConnected(true)
      reportCollabConnected(true)
    })
    expect(hook.value).toEqual({ builder: 'connected', collab: 'connected' })

    flushSync(() => markBuilderInactive())
    // Builder: WS cleared, was ever connected → reconnecting
    // Collab: still connected
    expect(hook.value).toEqual({ builder: 'reconnecting', collab: 'connected' })

    hook.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Health poll — backend availability without active WS
// ---------------------------------------------------------------------------

describe('health poll', () => {
  it('shows green from poll even without WS connection', () => {
    const hook = renderHook()
    flushSync(() => reportBuilderPoll(true))
    expect(hook.value.builder).toBe('connected')
    hook.cleanup()
  })

  it('shows reconnecting when poll goes unavailable after prior connection', () => {
    const hook = renderHook()
    flushSync(() => {
      reportCollabConnected(true)
      reportCollabConnected(false)
      reportCollabPoll(false)
    })
    expect(hook.value.collab).toBe('reconnecting')
    hook.cleanup()
  })

  it('poll keeps dot green even after surface unmount', () => {
    const hook = renderHook()
    flushSync(() => {
      reportBuilderConnected(true)
      reportBuilderPoll(true)
    })
    expect(hook.value.builder).toBe('connected')

    // Surface unmounts: WS signal clears, but poll stays
    flushSync(() => markBuilderInactive())
    expect(hook.value.builder).toBe('connected')

    hook.cleanup()
  })

  it('poll going false after unmount shows reconnecting', () => {
    const hook = renderHook()
    flushSync(() => {
      reportBuilderConnected(true)
      reportBuilderPoll(true)
    })
    flushSync(() => markBuilderInactive())
    // Poll fails → both signals false, wasEverConnected true → reconnecting
    flushSync(() => reportBuilderPoll(false))
    expect(hook.value.builder).toBe('reconnecting')
    hook.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Screenshot scenario: collab active + both backends available
// ---------------------------------------------------------------------------

describe('screenshot scenario', () => {
  it('collab active + builder poll available + collab WS connected => both green', () => {
    const hook = renderHook()

    flushSync(() => {
      // Builder surface not mounted but poll says it's up
      reportBuilderPoll(true)
      // Collab has active WS connection
      reportCollabConnected(true)
    })

    expect(hook.value.builder).toBe('connected')
    expect(hook.value.collab).toBe('connected')

    hook.cleanup()
  })

  it('builder active + collab poll available + builder WS connected => both green', () => {
    const hook = renderHook()

    flushSync(() => {
      reportBuilderConnected(true)
      reportCollabPoll(true)
    })

    expect(hook.value.builder).toBe('connected')
    expect(hook.value.collab).toBe('connected')

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

    // Report false (already disconnected) — no state change
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
  it('builder: mount -> connect -> drop -> reconnect -> unmount -> poll -> remount', () => {
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

    // Unmount — WS clears, but wasEverConnected preserved
    flushSync(() => markBuilderInactive())
    expect(hook.value.builder).toBe('reconnecting')

    // Poll says backend is still up
    flushSync(() => reportBuilderPoll(true))
    expect(hook.value.builder).toBe('connected')

    // Remount (fresh client reports connected)
    flushSync(() => reportBuilderConnected(true))
    expect(hook.value.builder).toBe('connected')

    hook.cleanup()
  })
})
