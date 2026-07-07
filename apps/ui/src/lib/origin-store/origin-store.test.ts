import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@forge/protocol'
import { OriginStore } from './origin-store'
import { OriginRegistry } from './origin-registry'
import { LOCAL_ORIGIN_ID, compositeKey, parseCompositeKey } from './origin-key'
import type { ManagerWsState } from '@/lib/ws-state'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'

// ---------------------------------------------------------------------------
// Helpers — drive stores with NO real socket via transport-agnostic ingestion
// (requirement 7).  `offline: true` means no WebSocket is opened.
// ---------------------------------------------------------------------------

const createdStores: OriginStore[] = []

function makeStore(originId: string, opts?: { httpClient?: SettingsApiClient }): OriginStore {
  const store = new OriginStore({
    originId,
    wsUrl: `ws://127.0.0.1/${originId}`,
    offline: true,
    httpClient: opts?.httpClient,
  })
  createdStores.push(store)
  return store
}

/** A minimal server event that mutates only the domain `messages` slice. */
function conversationMessageEvent(agentId: string, id: string): ServerEvent {
  return {
    type: 'conversation_message',
    agentId,
    id,
    role: 'assistant',
    text: `msg-${id}`,
    timestamp: '2026-07-06T00:00:00.000Z',
  } as unknown as ServerEvent
}

/** A `ready` event that sets the target/subscribed agent (so messages route). */
function readyEvent(agentId: string): ServerEvent {
  return { type: 'ready', subscribedAgentId: agentId } as unknown as ServerEvent
}

afterEach(() => {
  for (const store of createdStores.splice(0)) {
    store.destroy()
  }
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Composite identity (requirement 4)
// ---------------------------------------------------------------------------

describe('composite (originId, id) identity', () => {
  it('builds and parses flat keys', () => {
    expect(compositeKey('local', 'agent-1')).toBe('local::agent-1')
    expect(parseCompositeKey('local::agent-1')).toEqual({ originId: 'local', id: 'agent-1' })
  })

  it('round trips ids that themselves contain the separator', () => {
    const key = compositeKey('remote-a', 'ns::inner')
    expect(parseCompositeKey(key)).toEqual({ originId: 'remote-a', id: 'ns::inner' })
  })

  it('returns null for a key with no separator', () => {
    expect(parseCompositeKey('bare')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Per-(origin, selector) notification isolation (requirement 2)
// ---------------------------------------------------------------------------

describe('per-slice notification isolation', () => {
  it('wakes only the subscribers of the slice that changed', () => {
    const store = makeStore(LOCAL_ORIGIN_ID)
    store.ingest({ type: 'event', event: readyEvent('agent-1') })

    const messagesSpy = vi.fn()
    const statusesSpy = vi.fn()

    store.subscribeSlice('messages', (s: ManagerWsState) => s.messages, messagesSpy)
    store.subscribeSlice('statuses', (s: ManagerWsState) => s.statuses, statusesSpy)

    // A conversation_message mutates only `messages`.
    store.ingest({ type: 'event', event: conversationMessageEvent('agent-1', 'm1') })

    expect(messagesSpy).toHaveBeenCalledTimes(1)
    expect(statusesSpy).not.toHaveBeenCalled()
  })

  it('does not notify when the selected value is unchanged', () => {
    const store = makeStore(LOCAL_ORIGIN_ID)
    const connectedSpy = vi.fn()
    store.subscribeSlice('connected', (s: ManagerWsState) => s.connected, connectedSpy)

    // Patch an unrelated field: `connected` selection is unchanged → no notify.
    store.ingest({ type: 'snapshot', state: { lastError: 'boom' } })
    expect(connectedSpy).not.toHaveBeenCalled()

    // Now actually flip connected → exactly one notification.
    store.ingest({ type: 'snapshot', state: { connected: true } })
    expect(connectedSpy).toHaveBeenCalledTimes(1)
  })

  it('shares one memoized selection across subscribers with the same key', () => {
    const store = makeStore(LOCAL_ORIGIN_ID)
    const selector = vi.fn((s: ManagerWsState) => s.agents)
    const a = vi.fn()
    const b = vi.fn()
    store.subscribeSlice('agents', selector, a)
    store.subscribeSlice('agents', selector, b)

    store.ingest({ type: 'snapshot', state: { agents: [{ agentId: 'x' } as never] } })

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after unsubscribe and cleans up empty selector keys', () => {
    const store = makeStore(LOCAL_ORIGIN_ID)
    const spy = vi.fn()
    const unsub = store.subscribeSlice('agents', (s: ManagerWsState) => s.agents, spy)
    unsub()
    store.ingest({ type: 'snapshot', state: { agents: [{ agentId: 'x' } as never] } })
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Origin meta slice (requirement 5)
// ---------------------------------------------------------------------------

describe('origin meta slice', () => {
  it('is separate from domain state and mirrors connection status', () => {
    const store = makeStore(LOCAL_ORIGIN_ID)
    const metaSpy = vi.fn()
    store.subscribeMeta(metaSpy)

    expect(store.getMetaSnapshot().connectionStatus).toBe('idle')

    store.ingest({ type: 'snapshot', state: { connected: true } })
    expect(store.getMetaSnapshot().connectionStatus).toBe('connected')
    expect(metaSpy).toHaveBeenCalled()

    // Domain snapshot never carries meta fields.
    expect(store.getSnapshot()).not.toHaveProperty('connectionStatus')
  })

  it('accepts explicit meta patches (Wave R auth path)', () => {
    const store = makeStore(LOCAL_ORIGIN_ID)
    store.patchMeta({ authState: 'pending', protocolVersion: 'v2' })
    expect(store.getMetaSnapshot().authState).toBe('pending')
    expect(store.getMetaSnapshot().protocolVersion).toBe('v2')
  })
})

// ---------------------------------------------------------------------------
// Per-session granularity (requirement 8)
// ---------------------------------------------------------------------------

describe('per-session slice granularity', () => {
  it('a message for session A does not wake a selector scoped to session B', () => {
    const store = makeStore(LOCAL_ORIGIN_ID)
    store.ingest({ type: 'event', event: readyEvent('session-A') })

    // Selectors scoped per (session) — model the per-session slice: the count
    // of messages belonging to the active target only.
    const sessionASpy = vi.fn()
    const sessionBSpy = vi.fn()
    store.subscribeSlice(
      compositeKey('session', 'A'),
      (s: ManagerWsState) => (s.targetAgentId === 'session-A' ? s.messages.length : -1),
      sessionASpy,
    )
    store.subscribeSlice(
      compositeKey('session', 'B'),
      (s: ManagerWsState) => (s.targetAgentId === 'session-B' ? s.messages.length : -1),
      sessionBSpy,
    )

    store.ingest({ type: 'event', event: conversationMessageEvent('session-A', 'm1') })

    // A's slice moved 0→1; B's slice stayed -1 (not the target) → no wake.
    expect(sessionASpy).toHaveBeenCalledTimes(1)
    expect(sessionBSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Command facade + HTTP parity (requirements 6 & 9)
// ---------------------------------------------------------------------------

describe('command facade and HTTP client', () => {
  it('exposes the per-origin command client', () => {
    const store = makeStore(LOCAL_ORIGIN_ID)
    const client = store.getClient()
    expect(typeof client.subscribeToAgent).toBe('function')
    expect(typeof client.sendUserMessage).toBe('function')
  })

  it('local origin exposes a same-origin Builder HTTP client', () => {
    const store = makeStore(LOCAL_ORIGIN_ID)
    const http = store.getHttpClient()
    expect(http.target.kind).toBe('builder')
    expect(http.target.fetchCredentials).toBe('same-origin')
  })

  it('a non-local origin defaults to a credentialed collab HTTP client', () => {
    const store = makeStore('remote-a')
    const http = store.getHttpClient()
    expect(http.target.kind).toBe('collab')
    expect(http.target.fetchCredentials).toBe('include')
  })

  it('honors an explicitly injected HTTP client', () => {
    const fake = { target: { kind: 'collab', fetchCredentials: 'include' } } as unknown as SettingsApiClient
    const store = makeStore('remote-b', { httpClient: fake })
    expect(store.getHttpClient()).toBe(fake)
  })
})

// ---------------------------------------------------------------------------
// Requirement 10 — acceptance test protecting Wave R (SECOND origin)
// ---------------------------------------------------------------------------

describe('requirement 10 — second-origin acceptance', () => {
  it('(a) zero cross-origin notifications, (b) both origins keyed by (originId,id), (c) destroy leaves the other intact', () => {
    const registry = new OriginRegistry()
    try {
      const local = registry.createOrigin({ originId: LOCAL_ORIGIN_ID, wsUrl: 'ws://local', offline: true })
      const remote = registry.createOrigin({ originId: 'remote-a', wsUrl: 'ws://remote', offline: true })
      expect(registry.getOriginIds()).toEqual([LOCAL_ORIGIN_ID, 'remote-a'])

      // Both origins can hold the SAME domain id without collision because the
      // registry keys stores by originId and consumers key by (originId, id).
      local.ingest({ type: 'event', event: readyEvent('agent-shared') })
      remote.ingest({ type: 'event', event: readyEvent('agent-shared') })

      const localMessagesSpy = vi.fn()
      const remoteMessagesSpy = vi.fn()
      local.subscribeSlice('messages', (s: ManagerWsState) => s.messages, localMessagesSpy)
      remote.subscribeSlice('messages', (s: ManagerWsState) => s.messages, remoteMessagesSpy)

      // (a) An event on the LOCAL origin must never wake the REMOTE origin.
      local.ingest({ type: 'event', event: conversationMessageEvent('agent-shared', 'm-local') })
      expect(localMessagesSpy).toHaveBeenCalledTimes(1)
      expect(remoteMessagesSpy).not.toHaveBeenCalled()

      // ...and vice-versa.
      remote.ingest({ type: 'event', event: conversationMessageEvent('agent-shared', 'm-remote') })
      expect(remoteMessagesSpy).toHaveBeenCalledTimes(1)
      expect(localMessagesSpy).toHaveBeenCalledTimes(1) // unchanged

      // (b) Same id, different composite key + independent per-origin state.
      expect(compositeKey(local.originId, 'agent-shared')).not.toBe(
        compositeKey(remote.originId, 'agent-shared'),
      )
      expect(local.getSnapshot().messages).toHaveLength(1)
      expect(remote.getSnapshot().messages).toHaveLength(1)
      expect(local.getSnapshot()).not.toBe(remote.getSnapshot())

      // (c) Destroying one origin leaves the other's state AND subscriptions intact.
      registry.destroyOrigin(LOCAL_ORIGIN_ID)
      expect(registry.hasOrigin(LOCAL_ORIGIN_ID)).toBe(false)
      expect(registry.hasOrigin('remote-a')).toBe(true)

      remoteMessagesSpy.mockClear()
      remote.ingest({ type: 'event', event: conversationMessageEvent('agent-shared', 'm-remote-2') })
      expect(remoteMessagesSpy).toHaveBeenCalledTimes(1)
      expect(remote.getSnapshot().messages).toHaveLength(2)
    } finally {
      registry.destroyAll()
    }
  })

  it('registry notifies on origin add/remove', async () => {
    const registry = new OriginRegistry()
    const spy = vi.fn()
    const unsub = registry.subscribeRegistry(spy)
    try {
      registry.createOrigin({ originId: 'remote-x', wsUrl: 'ws://x', offline: true })
      // Registry notifications are deferred to a microtask (they may originate
      // during render) — flush it before asserting.
      await Promise.resolve()
      expect(spy).toHaveBeenCalledTimes(1)
      registry.destroyOrigin('remote-x')
      await Promise.resolve()
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      unsub()
      registry.destroyAll()
    }
  })

  it('createOrigin is idempotent for the same wsUrl and recreates on URL change', () => {
    const registry = new OriginRegistry()
    try {
      const first = registry.createOrigin({ originId: 'remote-y', wsUrl: 'ws://y1', offline: true })
      const same = registry.createOrigin({ originId: 'remote-y', wsUrl: 'ws://y1', offline: true })
      expect(same).toBe(first)

      const recreated = registry.createOrigin({ originId: 'remote-y', wsUrl: 'ws://y2', offline: true })
      expect(recreated).not.toBe(first)
      expect(recreated.wsUrl).toBe('ws://y2')
    } finally {
      registry.destroyAll()
    }
  })
})
