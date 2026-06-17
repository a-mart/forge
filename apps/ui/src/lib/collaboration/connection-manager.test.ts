import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollabConnectionManager } from './connection-manager'
import type { CollaborationEndpointTarget } from '../collaboration-connections'

// ---------------------------------------------------------------------------
// FakeWebSocket — minimal mock for WebSocketTransport
// ---------------------------------------------------------------------------

type ListenerMap = Record<string, Array<(event?: unknown) => void>>

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sentPayloads: string[] = []
  readonly listeners: ListenerMap = {}

  readyState = FakeWebSocket.OPEN

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    this.listeners[type] ??= []
    this.listeners[type].push(listener)
  }

  send(payload: string): void {
    this.sentPayloads.push(payload)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close')
  }

  emit(type: string, event?: unknown): void {
    const handlers = this.listeners[type] ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }
}

function emitServerEvent(socket: FakeWebSocket, event: unknown): void {
  socket.emit('message', { data: JSON.stringify(event) })
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTarget(
  connectionId: string,
  wsUrl: string,
  label = connectionId,
): CollaborationEndpointTarget {
  return {
    connectionId,
    kind: 'remote',
    label,
    serverUrl: wsUrl.replace('ws://', 'http://'),
    apiBaseUrl: wsUrl.replace('ws://', 'http://') + '/',
    wsUrl,
    isRemote: true,
  }
}

function bootstrapSocket(socket: FakeWebSocket, workspaceId = 'ws-1'): void {
  emitServerEvent(socket, {
    type: 'collab_bootstrap',
    workspace: { workspaceId, name: `Workspace ${workspaceId}` },
    categories: [],
    channels: [
      {
        channelId: 'ch-1',
        name: 'general',
        position: 0,
        readState: { unreadCount: 0 },
      },
    ],
    currentUser: { userId: 'user-1', role: 'admin', username: 'testuser' },
  })
}

function parseSent(socket: FakeWebSocket): unknown[] {
  return socket.sentPayloads.map((p) => JSON.parse(p))
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('CollabConnectionManager', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as unknown as Record<string, unknown>).window

  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
    ;(globalThis as unknown as Record<string, unknown>).window = {}
    ;(globalThis as unknown as Record<string, unknown>).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as unknown as Record<string, unknown>).WebSocket = originalWebSocket
    ;(globalThis as unknown as Record<string, unknown>).fetch = originalFetch
    ;(globalThis as unknown as Record<string, unknown>).window = originalWindow
  })

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe('lifecycle', () => {
    it('creates clients for each target on syncConnections', () => {
      const manager = new CollabConnectionManager()
      const targetA = makeTarget('conn_a', 'ws://a.example.com')
      const targetB = makeTarget('conn_b', 'ws://b.example.com')

      manager.syncConnections([targetA, targetB])
      vi.advanceTimersByTime(100)

      expect(manager.size).toBe(2)
      expect(manager.getConnectionIds()).toEqual(['conn_a', 'conn_b'])
      expect(FakeWebSocket.instances.length).toBe(2)

      manager.destroy()
    })

    it('destroys all clients on destroy()', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([
        makeTarget('conn_a', 'ws://a.example.com'),
        makeTarget('conn_b', 'ws://b.example.com'),
      ])
      vi.advanceTimersByTime(100)

      expect(manager.size).toBe(2)

      manager.destroy()

      expect(manager.size).toBe(0)
      expect(manager.activeConnectionId).toBeNull()
      expect(manager.activeChannelId).toBeNull()
    })

    it('removes stale connections when targets shrink', () => {
      const manager = new CollabConnectionManager()
      const targetA = makeTarget('conn_a', 'ws://a.example.com')
      const targetB = makeTarget('conn_b', 'ws://b.example.com')

      manager.syncConnections([targetA, targetB])
      vi.advanceTimersByTime(100)
      expect(manager.size).toBe(2)

      // Remove targetB
      manager.syncConnections([targetA])
      expect(manager.size).toBe(1)
      expect(manager.getConnectionIds()).toEqual(['conn_a'])

      manager.destroy()
    })

    it('adds new connections when targets grow', () => {
      const manager = new CollabConnectionManager()
      const targetA = makeTarget('conn_a', 'ws://a.example.com')

      manager.syncConnections([targetA])
      vi.advanceTimersByTime(100)
      expect(manager.size).toBe(1)

      const targetB = makeTarget('conn_b', 'ws://b.example.com')
      manager.syncConnections([targetA, targetB])
      vi.advanceTimersByTime(100)
      expect(manager.size).toBe(2)

      manager.destroy()
    })

    it('recreates client when wsUrl changes for same connectionId', () => {
      const manager = new CollabConnectionManager()
      const target = makeTarget('conn_a', 'ws://a.example.com')

      manager.syncConnections([target])
      vi.advanceTimersByTime(100)
      const initialSocketCount = FakeWebSocket.instances.length

      // Change the wsUrl
      const updatedTarget = makeTarget('conn_a', 'ws://a-new.example.com')
      manager.syncConnections([updatedTarget])
      vi.advanceTimersByTime(100)

      expect(manager.size).toBe(1)
      // A new socket should have been created
      expect(FakeWebSocket.instances.length).toBeGreaterThan(initialSocketCount)

      manager.destroy()
    })

    it('does NOT recreate client when only label changes', () => {
      const manager = new CollabConnectionManager()
      const target = makeTarget('conn_a', 'ws://a.example.com', 'Old Label')

      manager.syncConnections([target])
      vi.advanceTimersByTime(100)
      const socketCount = FakeWebSocket.instances.length

      const updatedTarget = makeTarget('conn_a', 'ws://a.example.com', 'New Label')
      manager.syncConnections([updatedTarget])
      vi.advanceTimersByTime(100)

      // No new socket created
      expect(FakeWebSocket.instances.length).toBe(socketCount)

      manager.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // Metadata-only clients (no detail subscription for inactive)
  // -----------------------------------------------------------------------

  describe('metadata-only clients', () => {
    it('all connections start with no active channel (metadata-only)', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([
        makeTarget('conn_a', 'ws://a.example.com'),
        makeTarget('conn_b', 'ws://b.example.com'),
      ])
      vi.advanceTimersByTime(100)

      expect(manager.activeConnectionId).toBeNull()
      expect(manager.activeChannelId).toBeNull()

      // Open the sockets and bootstrap
      for (const socket of FakeWebSocket.instances) {
        socket.emit('open')
      }

      // No subscribe_channel commands should be sent (metadata only)
      for (const socket of FakeWebSocket.instances) {
        const sent = parseSent(socket)
        const subscribes = sent.filter(
          (msg: any) => msg.type === 'collab_subscribe_channel',
        )
        expect(subscribes).toHaveLength(0)
      }

      manager.destroy()
    })

    it('inactive connections receive metadata updates from bootstrap', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket, 'workspace-1')

      const state = manager.getConnectionState('conn_a')
      expect(state).not.toBeNull()
      expect(state!.hasBootstrapped).toBe(true)
      expect(state!.workspace?.workspaceId).toBe('workspace-1')
      expect(state!.channels).toHaveLength(1)

      manager.destroy()
    })

    it('getConnectionState returns null for unknown connectionId', () => {
      const manager = new CollabConnectionManager()
      expect(manager.getConnectionState('nonexistent')).toBeNull()
      manager.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // Active channel switching + cleanup
  // -----------------------------------------------------------------------

  describe('active channel switching', () => {
    it('sets active channel on the correct connection', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket)

      manager.setActiveChannel('conn_a', 'ch-1')

      expect(manager.activeConnectionId).toBe('conn_a')
      expect(manager.activeChannelId).toBe('ch-1')

      const sent = parseSent(socket)
      const subscribes = sent.filter(
        (msg: any) => msg.type === 'collab_subscribe_channel',
      )
      expect(subscribes).toHaveLength(1)
      expect((subscribes[0] as any).channelId).toBe('ch-1')

      manager.destroy()
    })

    it('clears old connection detail sub before setting new one (cross-connection)', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([
        makeTarget('conn_a', 'ws://a.example.com'),
        makeTarget('conn_b', 'ws://b.example.com'),
      ])
      vi.advanceTimersByTime(100)

      const socketA = FakeWebSocket.instances[0]
      const socketB = FakeWebSocket.instances[1]
      socketA.emit('open')
      socketB.emit('open')
      bootstrapSocket(socketA, 'ws-a')
      bootstrapSocket(socketB, 'ws-b')

      // Activate channel on connection A
      manager.setActiveChannel('conn_a', 'ch-1')
      expect(manager.activeConnectionId).toBe('conn_a')

      // Clear sent payloads to track new commands
      socketA.sentPayloads.length = 0
      socketB.sentPayloads.length = 0

      // Switch to channel on connection B
      manager.setActiveChannel('conn_b', 'ch-2')

      // Connection A should have received unsubscribe (setActiveChannel(null))
      const sentA = parseSent(socketA)
      const unsubscribes = sentA.filter(
        (msg: any) => msg.type === 'collab_unsubscribe_channel',
      )
      expect(unsubscribes.length).toBeGreaterThanOrEqual(1)

      // Connection B should have received subscribe
      const sentB = parseSent(socketB)
      const subscribes = sentB.filter(
        (msg: any) => msg.type === 'collab_subscribe_channel',
      )
      expect(subscribes).toHaveLength(1)
      expect((subscribes[0] as any).channelId).toBe('ch-2')

      expect(manager.activeConnectionId).toBe('conn_b')
      expect(manager.activeChannelId).toBe('ch-2')

      manager.destroy()
    })

    it('clears detail sub when setting channelId to null', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket)

      manager.setActiveChannel('conn_a', 'ch-1')
      expect(manager.activeChannelId).toBe('ch-1')

      socket.sentPayloads.length = 0

      manager.setActiveChannel('conn_a', null)
      expect(manager.activeConnectionId).toBe('conn_a')
      expect(manager.activeChannelId).toBeNull()

      // Should have sent unsubscribe
      const sent = parseSent(socket)
      const unsubscribes = sent.filter(
        (msg: any) => msg.type === 'collab_unsubscribe_channel',
      )
      expect(unsubscribes.length).toBeGreaterThanOrEqual(1)

      manager.destroy()
    })

    it('clears detail sub when setting connectionId to null', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket)

      manager.setActiveChannel('conn_a', 'ch-1')
      socket.sentPayloads.length = 0

      manager.setActiveChannel(null, null)
      expect(manager.activeConnectionId).toBeNull()
      expect(manager.activeChannelId).toBeNull()

      manager.destroy()
    })

    it('is a no-op when connectionId and channelId are unchanged (prevents render loops)', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket)

      manager.setActiveChannel('conn_a', 'ch-1')

      const listener = vi.fn()
      const unsub = manager.subscribe(listener)
      listener.mockClear()
      socket.sentPayloads.length = 0

      // Call again with the same values — must NOT notify or send any commands
      manager.setActiveChannel('conn_a', 'ch-1')

      expect(listener).not.toHaveBeenCalled()
      expect(socket.sentPayloads).toHaveLength(0)
      expect(manager.activeConnectionId).toBe('conn_a')
      expect(manager.activeChannelId).toBe('ch-1')

      unsub()
      manager.destroy()
    })

    it('no-op guard applies to null/null unchanged state', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const listener = vi.fn()
      const unsub = manager.subscribe(listener)
      listener.mockClear()

      // Manager starts with null/null — calling with null/null is a no-op
      manager.setActiveChannel(null, null)

      expect(listener).not.toHaveBeenCalled()
      expect(manager.activeConnectionId).toBeNull()

      unsub()
      manager.destroy()
    })

    it('switching channel within same connection does not unsub/resub unnecessarily', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket)

      manager.setActiveChannel('conn_a', 'ch-1')
      socket.sentPayloads.length = 0

      // Switch to different channel on same connection
      manager.setActiveChannel('conn_a', 'ch-2')

      // The CollabWsClient handles the unsub/resub internally
      // Manager should just pass through
      const sent = parseSent(socket)
      const subscribes = sent.filter(
        (msg: any) => msg.type === 'collab_subscribe_channel',
      )
      expect(subscribes).toHaveLength(1)
      expect((subscribes[0] as any).channelId).toBe('ch-2')

      expect(manager.activeConnectionId).toBe('conn_a')
      expect(manager.activeChannelId).toBe('ch-2')

      manager.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // No detail subscription for inactive clients
  // -----------------------------------------------------------------------

  describe('inactive client detail isolation', () => {
    it('only active connection has channel history loaded', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([
        makeTarget('conn_a', 'ws://a.example.com'),
        makeTarget('conn_b', 'ws://b.example.com'),
      ])
      vi.advanceTimersByTime(100)

      const socketA = FakeWebSocket.instances[0]
      const socketB = FakeWebSocket.instances[1]
      socketA.emit('open')
      socketB.emit('open')
      bootstrapSocket(socketA)
      bootstrapSocket(socketB)

      // Activate channel on conn_a
      manager.setActiveChannel('conn_a', 'ch-1')

      // Simulate history arriving for conn_a
      emitServerEvent(socketA, {
        type: 'collab_channel_history',
        channelId: 'ch-1',
        messages: [{ id: 'msg-1', content: 'hello' }],
      })

      const stateA = manager.getConnectionState('conn_a')
      expect(stateA!.channelHistoryLoaded).toBe(true)
      expect(stateA!.channelHistory).toHaveLength(1)

      // conn_b should have no channel history
      const stateB = manager.getConnectionState('conn_b')
      expect(stateB!.channelHistoryLoaded).toBe(false)
      expect(stateB!.channelHistory).toHaveLength(0)

      manager.destroy()
    })

    it('inactive connections do not receive subscribe_channel commands', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([
        makeTarget('conn_a', 'ws://a.example.com'),
        makeTarget('conn_b', 'ws://b.example.com'),
      ])
      vi.advanceTimersByTime(100)

      const socketA = FakeWebSocket.instances[0]
      const socketB = FakeWebSocket.instances[1]
      socketA.emit('open')
      socketB.emit('open')

      // Only activate on conn_a
      manager.setActiveChannel('conn_a', 'ch-1')

      const sentB = parseSent(socketB)
      const subscribes = sentB.filter(
        (msg: any) => msg.type === 'collab_subscribe_channel',
      )
      expect(subscribes).toHaveLength(0)

      manager.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // Connection teardown
  // -----------------------------------------------------------------------

  describe('connection teardown', () => {
    it('removeConnection destroys the client', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([
        makeTarget('conn_a', 'ws://a.example.com'),
        makeTarget('conn_b', 'ws://b.example.com'),
      ])
      vi.advanceTimersByTime(100)
      expect(manager.size).toBe(2)

      manager.removeConnection('conn_a')
      expect(manager.size).toBe(1)
      expect(manager.getConnectionIds()).toEqual(['conn_b'])
      expect(manager.getClient('conn_a')).toBeNull()

      manager.destroy()
    })

    it('removing active connection clears active state', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([
        makeTarget('conn_a', 'ws://a.example.com'),
        makeTarget('conn_b', 'ws://b.example.com'),
      ])
      vi.advanceTimersByTime(100)

      manager.setActiveChannel('conn_a', 'ch-1')
      expect(manager.activeConnectionId).toBe('conn_a')

      manager.removeConnection('conn_a')
      expect(manager.activeConnectionId).toBeNull()
      expect(manager.activeChannelId).toBeNull()

      manager.destroy()
    })

    it('syncConnections removing active connection clears active state', () => {
      const manager = new CollabConnectionManager()
      const targetA = makeTarget('conn_a', 'ws://a.example.com')
      const targetB = makeTarget('conn_b', 'ws://b.example.com')

      manager.syncConnections([targetA, targetB])
      vi.advanceTimersByTime(100)

      manager.setActiveChannel('conn_a', 'ch-1')

      // Sync with only B → A is removed
      manager.syncConnections([targetB])

      expect(manager.activeConnectionId).toBeNull()
      expect(manager.activeChannelId).toBeNull()
      expect(manager.size).toBe(1)

      manager.destroy()
    })

    it('removeConnection is a no-op for unknown IDs', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      manager.removeConnection('nonexistent')
      expect(manager.size).toBe(1)

      manager.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // Subscription / notifications
  // -----------------------------------------------------------------------

  describe('subscription', () => {
    it('notifies listeners on state changes', () => {
      const manager = new CollabConnectionManager()
      const listener = vi.fn()
      const unsub = manager.subscribe(listener)

      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      expect(listener).toHaveBeenCalled()

      unsub()
      manager.destroy()
    })

    it('notifies on active channel change', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')

      const listener = vi.fn()
      const unsub = manager.subscribe(listener)
      listener.mockClear()

      manager.setActiveChannel('conn_a', 'ch-1')
      expect(listener).toHaveBeenCalled()

      unsub()
      manager.destroy()
    })

    it('notifies on connection metadata state changes', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const listener = vi.fn()
      const unsub = manager.subscribe(listener)
      listener.mockClear()

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket)

      // Bootstrap event should have triggered notification
      expect(listener).toHaveBeenCalled()

      unsub()
      manager.destroy()
    })

    it('unsubscribe stops notifications', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([makeTarget('conn_a', 'ws://a.example.com')])
      vi.advanceTimersByTime(100)

      const listener = vi.fn()
      const unsub = manager.subscribe(listener)
      listener.mockClear()

      unsub()

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket)

      expect(listener).not.toHaveBeenCalled()

      manager.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // Single-backend backward compatibility
  // -----------------------------------------------------------------------

  describe('single-backend backward compatibility', () => {
    it('works identically with a single connection', () => {
      const manager = new CollabConnectionManager()
      const target = makeTarget('conn_a', 'ws://a.example.com')

      manager.syncConnections([target])
      vi.advanceTimersByTime(100)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket)

      expect(manager.size).toBe(1)
      expect(manager.getConnectionIds()).toEqual(['conn_a'])

      // getActiveState falls back to first connection
      const state = manager.getActiveState()
      expect(state.hasBootstrapped).toBe(true)

      // getActiveClient falls back to first connection
      const client = manager.getActiveClient()
      expect(client).not.toBeNull()

      // Set active channel
      manager.setActiveChannel('conn_a', 'ch-1')
      expect(manager.activeConnectionId).toBe('conn_a')
      expect(manager.activeChannelId).toBe('ch-1')

      manager.destroy()
    })

    it('getActiveState returns initial state when empty', () => {
      const manager = new CollabConnectionManager()
      const state = manager.getActiveState()

      expect(state.connected).toBe(false)
      expect(state.hasBootstrapped).toBe(false)
      expect(state.workspace).toBeNull()
      expect(state.channels).toEqual([])

      manager.destroy()
    })

    it('getActiveClient returns null when empty', () => {
      const manager = new CollabConnectionManager()
      expect(manager.getActiveClient()).toBeNull()
      manager.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // Accessor edge cases
  // -----------------------------------------------------------------------

  describe('accessors', () => {
    it('getAllStates returns states for all connections', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([
        makeTarget('conn_a', 'ws://a.example.com'),
        makeTarget('conn_b', 'ws://b.example.com'),
      ])
      vi.advanceTimersByTime(100)

      const states = manager.getAllStates()
      expect(Object.keys(states)).toEqual(['conn_a', 'conn_b'])
      expect(states['conn_a'].connected).toBe(false)
      expect(states['conn_b'].connected).toBe(false)

      manager.destroy()
    })

    it('getClient returns correct client for connection', () => {
      const manager = new CollabConnectionManager()
      manager.syncConnections([
        makeTarget('conn_a', 'ws://a.example.com'),
        makeTarget('conn_b', 'ws://b.example.com'),
      ])
      vi.advanceTimersByTime(100)

      const clientA = manager.getClient('conn_a')
      const clientB = manager.getClient('conn_b')

      expect(clientA).not.toBeNull()
      expect(clientB).not.toBeNull()
      expect(clientA).not.toBe(clientB)

      manager.destroy()
    })

    it('getTarget returns target metadata', () => {
      const manager = new CollabConnectionManager()
      const target = makeTarget('conn_a', 'ws://a.example.com', 'Server A')
      manager.syncConnections([target])
      vi.advanceTimersByTime(100)

      const retrieved = manager.getTarget('conn_a')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.label).toBe('Server A')
      expect(retrieved!.wsUrl).toBe('ws://a.example.com')

      manager.destroy()
    })

    it('getTarget returns null for unknown connection', () => {
      const manager = new CollabConnectionManager()
      expect(manager.getTarget('unknown')).toBeNull()
      manager.destroy()
    })
  })

  // -----------------------------------------------------------------------
  // Auth-gated metadata connections
  // -----------------------------------------------------------------------

  describe('auth-gated metadata connections', () => {
    it('keeps unauthenticated targets represented without creating a WebSocket or retry loop', async () => {
      const authProbe = vi.fn().mockResolvedValue('unauthenticated')
      const manager = new CollabConnectionManager({
        authGateMetadataConnections: true,
        authProbe,
      })
      const target = makeTarget('conn_unauth', 'ws://unauth.example.com')

      manager.syncConnections([target])
      await flushPromises()
      vi.advanceTimersByTime(5_000)

      expect(authProbe).toHaveBeenCalledTimes(1)
      expect(manager.size).toBe(1)
      expect(manager.getConnectionIds()).toEqual(['conn_unauth'])
      expect(manager.getClient('conn_unauth')).toBeNull()
      expect(FakeWebSocket.instances).toHaveLength(0)
      expect(manager.getConnectionState('conn_unauth')?.lastErrorCode).toBe('COLLAB_AUTH_REQUIRED')

      manager.destroy()
    })

    it('treats probe rejection as unknown and preserves retryable WebSocket behavior', async () => {
      const authProbe = vi.fn().mockRejectedValue(new Error('network failed'))
      const manager = new CollabConnectionManager({
        authGateMetadataConnections: true,
        authProbe,
      })

      manager.syncConnections([makeTarget('conn_unknown', 'ws://unknown.example.com')])
      await flushPromises()
      vi.advanceTimersByTime(100)

      expect(authProbe).toHaveBeenCalledTimes(1)
      expect(manager.getConnectionState('conn_unknown')?.lastErrorCode).not.toBe('COLLAB_AUTH_REQUIRED')
      expect(manager.getClient('conn_unknown')).not.toBeNull()
      expect(FakeWebSocket.instances).toHaveLength(1)

      manager.destroy()
    })

    it('treats HTTP 500 from /api/collaboration/me as unknown and still creates a WebSocket', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }))
      ;(globalThis as unknown as Record<string, unknown>).fetch = fetchMock
      const manager = new CollabConnectionManager({
        authGateMetadataConnections: true,
      })

      manager.syncConnections([makeTarget('conn_500', 'ws://errors.example.com')])
      await flushPromises()
      vi.advanceTimersByTime(100)

      expect(fetchMock).toHaveBeenCalledWith('http://errors.example.com/api/collaboration/me', expect.objectContaining({
        credentials: 'include',
      }))
      expect(manager.getConnectionState('conn_500')?.lastErrorCode).not.toBe('COLLAB_AUTH_REQUIRED')
      expect(manager.getClient('conn_500')).not.toBeNull()
      expect(FakeWebSocket.instances).toHaveLength(1)

      manager.destroy()
    })

    it('creates and bootstraps metadata WebSocket for authenticated targets', async () => {
      const authProbe = vi.fn().mockResolvedValue('authenticated')
      const manager = new CollabConnectionManager({
        authGateMetadataConnections: true,
        authProbe,
      })

      manager.syncConnections([makeTarget('conn_auth', 'ws://auth.example.com')])
      await flushPromises()
      vi.advanceTimersByTime(100)

      expect(authProbe).toHaveBeenCalledTimes(1)
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(manager.getClient('conn_auth')).not.toBeNull()

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket, 'ws-auth')

      expect(manager.getConnectionState('conn_auth')?.hasBootstrapped).toBe(true)
      expect(manager.getConnectionState('conn_auth')?.workspace?.workspaceId).toBe('ws-auth')

      manager.destroy()
    })

    it('preserves mixed authenticated and unauthenticated target state entries', async () => {
      const authProbe = vi.fn((target: CollaborationEndpointTarget) => {
        return Promise.resolve(target.connectionId === 'conn_auth' ? 'authenticated' as const : 'unauthenticated' as const)
      })
      const manager = new CollabConnectionManager({
        authGateMetadataConnections: true,
        authProbe,
      })

      manager.syncConnections([
        makeTarget('conn_auth', 'ws://auth.example.com'),
        makeTarget('conn_unauth', 'ws://unauth.example.com'),
      ])
      await flushPromises()
      vi.advanceTimersByTime(100)

      expect(manager.size).toBe(2)
      expect(manager.getConnectionIds()).toEqual(['conn_auth', 'conn_unauth'])
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(manager.getClient('conn_auth')).not.toBeNull()
      expect(manager.getClient('conn_unauth')).toBeNull()
      expect(manager.getConnectionState('conn_unauth')?.lastErrorCode).toBe('COLLAB_AUTH_REQUIRED')

      manager.destroy()
    })

    it('retains active channel intent while authenticated target probe is pending', async () => {
      let resolveProbe: (value: 'authenticated' | 'unauthenticated' | 'unknown') => void = () => {}
      const authProbe = vi.fn(() => new Promise<'authenticated' | 'unauthenticated' | 'unknown'>((resolve) => {
        resolveProbe = resolve
      }))
      const manager = new CollabConnectionManager({
        authGateMetadataConnections: true,
        authProbe,
      })

      manager.syncConnections([makeTarget('conn_auth', 'ws://auth.example.com')])
      manager.setActiveChannel('conn_auth', 'ch-1')

      expect(manager.activeConnectionId).toBe('conn_auth')
      expect(manager.activeChannelId).toBe('ch-1')
      expect(FakeWebSocket.instances).toHaveLength(0)

      resolveProbe('authenticated')
      await flushPromises()
      vi.advanceTimersByTime(100)

      expect(FakeWebSocket.instances).toHaveLength(1)
      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      bootstrapSocket(socket, 'ws-auth')
      const sent = parseSent(socket)
      expect(sent).toContainEqual({ type: 'collab_subscribe_channel', channelId: 'ch-1' })

      manager.destroy()
    })
  })
})
