/** @vitest-environment jsdom */

import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@forge/protocol'
import type { ManagerWsState } from '@/lib/ws-state'
import { OriginRegistry, originRegistry } from './origin-registry'
import { LOCAL_ORIGIN_ID } from './origin-key'
import { useOriginSlice, useAllOrigins, useOriginMeta } from './use-origin-store'

// ---------------------------------------------------------------------------
// The hooks read the module-level `originRegistry`.  Each test creates/destroys
// the reserved local origin (and any second origin) on that shared registry.
// Hooks + slices are exercised through a real React tree via createRoot, using
// createElement (no JSX) to match the repo's .test.ts convention.
// ---------------------------------------------------------------------------

function ready(agentId: string): ServerEvent {
  return { type: 'ready', subscribedAgentId: agentId } as unknown as ServerEvent
}
function conversationMessage(agentId: string, id: string): ServerEvent {
  return {
    type: 'conversation_message',
    agentId,
    id,
    role: 'assistant',
    text: id,
    timestamp: '2026-07-06T00:00:00.000Z',
  } as unknown as ServerEvent
}

interface Harness {
  cleanup: () => void
}

function render(node: ReactNode): Harness {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(node)
  })
  return {
    cleanup() {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

afterEach(() => {
  originRegistry.destroyAll()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Render-reduction evidence: a slice-scoped subscriber re-renders ONLY when its
// own slice changes.  This is the core WP-U1 win — a status-family event must
// not re-render a transcript that only reads `messages`.
// ---------------------------------------------------------------------------

describe('useOriginSlice render reduction', () => {
  it('re-renders only the subscriber whose slice changed', () => {
    const store = originRegistry.createOrigin({ originId: LOCAL_ORIGIN_ID, wsUrl: 'ws://local', offline: true })
    store.ingest({ type: 'event', event: ready('agent-1') })

    let messagesRenders = 0
    let statusesRenders = 0

    function MessagesView() {
      useOriginSlice(LOCAL_ORIGIN_ID, (s: ManagerWsState) => s.messages, { selectorKey: 'messages' })
      messagesRenders++
      return null
    }
    function StatusesView() {
      useOriginSlice(LOCAL_ORIGIN_ID, (s: ManagerWsState) => s.statuses, { selectorKey: 'statuses' })
      statusesRenders++
      return null
    }

    const harness = render(createElement('div', null, createElement(MessagesView), createElement(StatusesView)))

    const messagesBaseline = messagesRenders
    const statusesBaseline = statusesRenders

    // A conversation_message mutates ONLY `messages`.
    flushSync(() => {
      store.ingest({ type: 'event', event: conversationMessage('agent-1', 'm1') })
    })

    expect(messagesRenders).toBe(messagesBaseline + 1)
    // The statuses subscriber must NOT have re-rendered.
    expect(statusesRenders).toBe(statusesBaseline)

    // A statuses-only patch wakes only the statuses view.
    flushSync(() => {
      store.ingest({ type: 'snapshot', state: { statuses: { 'agent-1': { status: 'streaming', pendingCount: 0 } } } })
    })
    expect(statusesRenders).toBe(statusesBaseline + 1)
    expect(messagesRenders).toBe(messagesBaseline + 1)

    harness.cleanup()
  })

  it('does not re-render when an unrelated field changes but the selected value is equal', () => {
    const store = originRegistry.createOrigin({ originId: LOCAL_ORIGIN_ID, wsUrl: 'ws://local', offline: true })

    let renders = 0
    function ConnectedView() {
      useOriginSlice(LOCAL_ORIGIN_ID, (s: ManagerWsState) => s.connected, { selectorKey: 'connected' })
      renders++
      return null
    }

    const harness = render(createElement(ConnectedView))
    const baseline = renders

    flushSync(() => {
      store.ingest({ type: 'snapshot', state: { lastError: 'x' } })
    })
    expect(renders).toBe(baseline)

    harness.cleanup()
  })

  it('supports a shallow equalityFn for object slices', () => {
    const store = originRegistry.createOrigin({ originId: LOCAL_ORIGIN_ID, wsUrl: 'ws://local', offline: true })

    let renders = 0
    const shallow = (a: Record<string, number>, b: Record<string, number>) => {
      const ak = Object.keys(a)
      if (ak.length !== Object.keys(b).length) return false
      return ak.every((k) => a[k] === b[k])
    }
    function UnreadView() {
      useOriginSlice(LOCAL_ORIGIN_ID, (s: ManagerWsState) => s.unreadCounts, {
        selectorKey: 'unread',
        equalityFn: shallow,
      })
      renders++
      return null
    }

    const harness = render(createElement(UnreadView))
    const baseline = renders

    // New object, same contents → shallow-equal → no re-render.
    flushSync(() => {
      store.ingest({ type: 'snapshot', state: { unreadCounts: {} } })
    })
    expect(renders).toBe(baseline)

    harness.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Cross-origin composition (requirement 3)
// ---------------------------------------------------------------------------

describe('useAllOrigins', () => {
  it('returns per-origin results and reacts to origin add/remove', () => {
    originRegistry.createOrigin({ originId: LOCAL_ORIGIN_ID, wsUrl: 'ws://local', offline: true })

    let lastResult: Array<{ originId: string; value: number }> = []
    function AllView() {
      // eslint-disable-next-line react-hooks/globals -- test-only capture pattern
      lastResult = useAllOrigins((s: ManagerWsState) => s.agents.length, { selectorKey: 'agentCount' })
      return null
    }
    const harness = render(createElement(AllView))

    expect(lastResult.map((r) => r.originId)).toEqual([LOCAL_ORIGIN_ID])

    flushSync(() => {
      originRegistry.createOrigin({ originId: 'remote-a', wsUrl: 'ws://remote', offline: true })
    })
    expect(lastResult.map((r) => r.originId)).toEqual([LOCAL_ORIGIN_ID, 'remote-a'])

    flushSync(() => {
      originRegistry.destroyOrigin('remote-a')
    })
    expect(lastResult.map((r) => r.originId)).toEqual([LOCAL_ORIGIN_ID])

    harness.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Meta slice hook (requirement 5)
// ---------------------------------------------------------------------------

describe('useOriginMeta', () => {
  it('reflects connection status transitions', () => {
    const store = originRegistry.createOrigin({ originId: LOCAL_ORIGIN_ID, wsUrl: 'ws://local', offline: true })

    let status: string | undefined
    function MetaView() {
      // eslint-disable-next-line react-hooks/globals -- test-only capture pattern
      status = useOriginMeta(LOCAL_ORIGIN_ID)?.connectionStatus
      return null
    }
    const harness = render(createElement(MetaView))
    expect(status).toBe('idle')

    flushSync(() => {
      store.ingest({ type: 'snapshot', state: { connected: true } })
    })
    expect(status).toBe('connected')

    harness.cleanup()
  })

  it('returns null for an origin that is not in the registry', () => {
    let meta: unknown = 'sentinel'
    function MetaView() {
      // eslint-disable-next-line react-hooks/globals -- test-only capture pattern
      meta = useOriginMeta('nonexistent')
      return null
    }
    const harness = render(createElement(MetaView))
    expect(meta).toBeNull()
    harness.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Ordering: a consumer that mounts BEFORE its origin exists must start
// receiving slice notifications once the origin is created (Wave R remote
// origins connect after mount).  Regression for the dead-subscription bug.
// ---------------------------------------------------------------------------

describe('useOriginSlice when the origin is created after mount', () => {
  it('starts delivering slice notifications once the origin appears', () => {
    let renders = 0
    let lastLength = -1
    function AgentsView() {
      const agents = useOriginSlice('remote-late', (s: ManagerWsState) => s.agents, { selectorKey: 'agents' })
      lastLength = agents.length
      renders++
      return null
    }

    // Mount with NO 'remote-late' origin in the registry.
    const harness = render(createElement(AgentsView))
    const baseline = renders
    expect(lastLength).toBe(0)

    // Now the origin connects.
    let store!: ReturnType<typeof originRegistry.createOrigin>
    flushSync(() => {
      store = originRegistry.createOrigin({ originId: 'remote-late', wsUrl: 'ws://late', offline: true })
    })
    expect(renders).toBeGreaterThan(baseline)

    // A subsequent slice change must re-render the component (the subscription
    // is now live — this is what the ordering bug broke).
    const afterCreate = renders
    flushSync(() => {
      store.ingest({ type: 'snapshot', state: { agents: [{ agentId: 'a' } as never] } })
    })
    expect(renders).toBe(afterCreate + 1)
    expect(lastLength).toBe(1)

    harness.cleanup()
  })
})

describe('useAllOrigins when a store is added after mount', () => {
  it('tracks slice changes on origins created after mount', () => {
    originRegistry.createOrigin({ originId: LOCAL_ORIGIN_ID, wsUrl: 'ws://local', offline: true })

    let renders = 0
    let lastResult: Array<{ originId: string; value: number }> = []
    function AllView() {
      lastResult = useAllOrigins((s: ManagerWsState) => s.agents.length, { selectorKey: 'agentCount' })
      renders++
      return null
    }
    const harness = render(createElement(AllView))

    let remote!: ReturnType<typeof originRegistry.createOrigin>
    flushSync(() => {
      remote = originRegistry.createOrigin({ originId: 'remote-b', wsUrl: 'ws://remote', offline: true })
    })
    expect(lastResult.map((r) => r.originId)).toEqual([LOCAL_ORIGIN_ID, 'remote-b'])

    // A slice change on the LATE-added origin must wake the hook.
    const afterAdd = renders
    flushSync(() => {
      remote.ingest({ type: 'snapshot', state: { agents: [{ agentId: 'a' } as never, { agentId: 'b' } as never] } })
    })
    expect(renders).toBe(afterAdd + 1)
    expect(lastResult.find((r) => r.originId === 'remote-b')?.value).toBe(2)

    harness.cleanup()
  })
})

describe('OriginRegistry isolation under React', () => {
  it('a second registry is independent of the module-level one', () => {
    const other = new OriginRegistry()
    try {
      other.createOrigin({ originId: 'x', wsUrl: 'ws://x', offline: true })
      expect(originRegistry.hasOrigin('x')).toBe(false)
      expect(other.hasOrigin('x')).toBe(true)
    } finally {
      other.destroyAll()
    }
  })
})
