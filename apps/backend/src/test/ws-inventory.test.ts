import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { AgentDescriptor, ManagerProfile, ServerEvent } from '@forge/protocol'
import { WsHandler } from '../ws/ws-handler.js'
import { setCollaborationSocketAuthContext } from '../collaboration/auth/collaboration-auth-middleware.js'
import { SwarmWebSocketServer } from '../ws/server.js'
import { WsSubscriptions } from '../ws/ws-subscriptions.js'
import * as parser from '../ws/ws-command-parser.js'

const at = '2026-09-01T00:00:00.000Z'
function agent(agentId: string, extra: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return { agentId, managerId: agentId, role: 'manager', displayName: agentId, status: 'idle', profileId: 'p', createdAt: at, updatedAt: at, cwd: '/fixture', sessionFile: '', cli: false,
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' }, ...extra }
}
function socket() {
  return { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), terminate: vi.fn(), _socket: { write: vi.fn() } } as any
}
const perf = () => ({ recordDuration: vi.fn(), increment: vi.fn(), readSummary: vi.fn(), readRecentSlowEvents: vi.fn() })
function fixture() {
  const agents = [agent('a'), agent('b'), agent('hidden', { profileId: 'hidden' }), agent('collab', { sessionSurface: 'collab' }), agent('worker', { role: 'worker', managerId: 'a' })]
  const profiles = [{ profileId: 'p', displayName: 'P', createdAt: at, updatedAt: at }, { profileId: 'hidden', displayName: 'Hidden', profileType: 'system', createdAt: at, updatedAt: at }] as ManagerProfile[]
  let revision = 1
  const counts: Record<string, number> = { a: 4, b: 7, hidden: 9, collab: 9 }
  const unread = {
    getSnapshot: () => ({ ...counts }),
    markRead: vi.fn((_profileId: string, id: string) => { const old = counts[id] ?? 0; counts[id] = 0; return old }),
    increment: vi.fn((_profileId: string, id: string) => (counts[id] = (counts[id] ?? 0) + 1)),
  }
  const manager = {
    getConfig: () => ({ runtimeTarget: 'builder', managerId: 'a', debug: false, paths: { dataDir: '/fixture' } }),
    getAgent: (id: string) => agents.find((a) => a.agentId === id), listAgents: () => agents,
    listBootstrapAgents: () => agents.filter((a) => a.role === 'manager'), listProfiles: () => profiles,
    getSessionAttentionSnapshot: () => ({ revision, attentions: ['a', 'hidden', 'collab'].map((id) => ({ sessionAgentId: id, profileId: 'p', attentionId: `attention-${id}`, reason: 'work_settled' as const, raisedAt: at })) }),
    getAgentsSnapshotVersion: () => 1, getProfilesSnapshotVersion: () => 1,
    listWorkersForSession: () => [], getPendingChoiceIdsForSession: () => [], getPendingChoiceRequestsForSession: () => [],
    getConversationHistory: vi.fn(() => []), getConversationHistoryWithDiagnostics: vi.fn(() => ({ history: [], diagnostics: {} })),
    getSessionPlanSnapshot: async (id: string) => ({ type: 'session_plan_snapshot', sessionAgentId: id, profileId: 'p', revision: 0, updatedAt: at, plan: [], diagnostics: { state: 'defaulted' } }),
    getSessionGoalSnapshot: async (id: string) => ({ type: 'session_goal_snapshot', sessionAgentId: id, profileId: 'p', revision: 0, measuredAt: at, goal: null }),
    createManager: vi.fn(async () => agent('new-manager')),
    createSession: vi.fn(async () => ({ profile: profiles[0], sessionAgent: agent('new-session') })),
    getManagerSelectionCatalog: vi.fn(async () => ({ version: 1, revision: 'catalog', models: [] })),
  }
  const handler = new WsHandler({ swarmManager: manager as any, unreadTracker: unread as any, mobilePushService: {} as any, allowNonManagerSubscriptions: true, perf: perf() })
  const owner = (handler as any).subscriptionManager as WsSubscriptions
  const a = socket(), b = socket()
  // In-memory only: no server, upgrade, listener or network is started.
  ;(handler as any).wss = { clients: new Set([a, b]) }
  const command = (target: typeof a, value: unknown) => (handler as any).handleSocketMessage(target, Buffer.from(JSON.stringify(value))) as Promise<void>
  return { a, b, agents, profiles, manager, handler, owner, counts, unread, command, nextRevision: () => ++revision }
}
function events(s: ReturnType<typeof socket>): ServerEvent[] { return s.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw)) }
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve() }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }

describe('passive Builder inventory contract', () => {
  it('initial/refresh/demotion never read; a real unattended-message path increments while inventory remains connected', async () => {
    const f = fixture()
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'first' })
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'refresh' })
    expect(f.unread.markRead).not.toHaveBeenCalled()
    expect(f.manager.getConversationHistoryWithDiagnostics).not.toHaveBeenCalled()
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
    expect(f.owner.hasActiveSubscriptionForSession('a')).toBe(false)
    const baseline = events(f.a)[0] as Extract<ServerEvent, { type: 'inventory_snapshot' }>
    expect(baseline).toMatchObject({ type: 'inventory_snapshot', requestId: 'first', counts: { a: 4, b: 7 }, revision: 1 })
    expect(baseline.agents.map((a) => a.agentId)).toEqual(['a', 'b'])
    expect(baseline.profiles.map((p) => p.profileId)).toEqual(['p'])
    expect(baseline.attentions.map((a) => a.sessionAgentId)).toEqual(['a'])

    // Exercise the production unread policy without constructing or starting a server.
    const server = Object.create(SwarmWebSocketServer.prototype) as any
    Object.assign(server, { swarmManager: f.manager, wsHandler: f.handler, unreadTracker: f.unread })
    await server.handleUnreadTrigger('a', 'message')
    await flush()
    expect(f.counts.a).toBe(5)
    expect(events(f.a).at(-1)).toEqual({ type: 'unread_count_update', agentId: 'a', count: 5 })

    await f.command(f.b, { type: 'subscribe', agentId: 'b', subscriptionId: 'chat-b' })
    expect(f.unread.markRead.mock.calls).toEqual([['p', 'b']])
    expect(f.counts.a).toBe(5)
    expect(f.owner.hasActiveSubscriptionForSession('b')).toBe(true)
    await f.command(f.b, { type: 'subscribe_inventory', requestId: 'demote' })
    expect(f.unread.markRead).toHaveBeenCalledTimes(1)
    expect(f.owner.hasActiveSubscriptionForSession('b')).toBe(false)
    await server.handleUnreadTrigger('b', 'message')
    expect(f.counts.b).toBe(1)
    await f.command(f.a, { type: 'ping' })
    expect(events(f.a).at(-1)?.type).toBe('inventory_pong')
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
  })

  it('inventory A and chat B permit addressed create/catalog on A without viewing a default; implicit authority stays denied', async () => {
    const f = fixture()
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'inventory-a' })
    await f.command(f.b, { type: 'subscribe', agentId: 'b' })
    f.unread.markRead.mockClear()
    await f.command(f.a, { type: 'create_manager', requestId: 'create', name: 'New', cwd: '/fixture' })
    await f.command(f.a, { type: 'create_session', requestId: 'session', profileId: 'p' })
    await f.command(f.a, { type: 'api_proxy', requestId: 'catalog', method: 'GET', path: '/api/settings/manager-selection-catalog' })
    await flush()
    expect(f.manager.createManager).toHaveBeenCalledWith('a', expect.objectContaining({ name: 'New' }))
    expect(f.manager.createSession).toHaveBeenCalledWith('p', expect.anything())
    expect(f.manager.getManagerSelectionCatalog).toHaveBeenCalledOnce()
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
    expect(f.owner.getSubscribedAgentId(f.b)).toBe('b')
    expect(f.unread.markRead).not.toHaveBeenCalled()
    for (const command of [
      { type: 'user_message', text: 'must not send' },
      { type: 'merge_session_memory', agentId: 'a', requestId: 'merge' },
      { type: 'api_proxy', requestId: 'artifact', method: 'POST', path: '/api/chat-artifacts/read', body: '{}' },
      { type: 'api_proxy', requestId: 'terminal', method: 'GET', path: '/api/terminals' },
      { type: 'api_proxy', requestId: 'file', method: 'GET', path: '/api/read-file?path=x' },
    ]) {
      await f.command(f.a, command)
      await flush()
      expect(events(f.a).at(-1)).toMatchObject({ type: 'error', code: 'NOT_SUBSCRIBED' })
    }
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
  })

  it('keeps create on inventory origin A separate from an equal-ID viewed chat on origin B', async () => {
    const originA = fixture(), originB = fixture()
    await originA.command(originA.a, { type: 'subscribe_inventory', requestId: 'origin-a' })
    await originB.command(originB.a, { type: 'subscribe', agentId: 'a' })
    await originA.command(originA.a, { type: 'create_session', requestId: 'new-a', profileId: 'p' })
    expect(originA.manager.createSession).toHaveBeenCalledOnce()
    expect(originB.manager.createSession).not.toHaveBeenCalled()
    expect(originA.unread.markRead).not.toHaveBeenCalled()
    expect(originA.counts.a).toBe(4)
    expect(originA.owner.getSubscribedAgentId(originA.a)).toBeUndefined()
    expect(originB.owner.getSubscribedAgentId(originB.a)).toBe('a')
  })

  it('allows only filtered inventory fanout, not conversation, sensitive metadata, presence or request responses', async () => {
    const f = fixture()
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'inventory' })
    f.a.send.mockClear()
    for (const type of ['conversation_message', 'conversation_history', 'choice_request', 'session_plan_snapshot', 'session_goal_snapshot', 'secure_session_snapshot', 'browser_session_changed', 'terminals_snapshot', 'project_presence', 'session_workers_snapshot', 'manager_created']) {
      f.owner.broadcastToSubscribed({ type, agentId: 'a', sessionAgentId: 'a', text: 'must not leak', requestId: 'other-request' } as any)
    }
    f.owner.broadcastToSubscribed({ type: 'agent_status', agentId: 'hidden', status: 'idle', pendingCount: 0 })
    f.owner.broadcastUnreadCountUpdate('collab', 20)
    f.owner.broadcastToManagerSession('a', { type: 'conversation_message', agentId: 'a' } as any)
    f.owner.broadcastToProfile('p', { type: 'terminals_snapshot', terminals: [] })
    await flush()
    expect(events(f.a)).toEqual([])
    f.owner.broadcastToSubscribed({ type: 'agents_snapshot', agents: f.agents })
    f.owner.broadcastToSubscribed({ type: 'session_attention_snapshot', ...f.manager.getSessionAttentionSnapshot() })
    await flush()
    expect(events(f.a).map((e) => e.type)).toEqual(['agents_snapshot', 'session_attention_snapshot'])
    expect((events(f.a)[0] as any).agents.map((a: AgentDescriptor) => a.agentId)).toEqual(['a', 'b'])
    expect((events(f.a)[1] as any).attentions.map((a: any) => a.sessionAgentId)).toEqual(['a'])
  })

  it('queues live snapshots after a backpressured baseline and cancels superseded inventory/conversation frames', async () => {
    const f = fixture(), hold = deferred()
    const delivered: ServerEvent[] = []
    let blockedType = 'inventory_snapshot'
    ;(f.owner as any).sendBootstrapCritical = async (_socket: WebSocket, event: ServerEvent, shouldSend?: () => boolean) => {
      if (event.type === blockedType) await hold.promise
      if (shouldSend?.() === false) return null
      delivered.push(event)
      return 1
    }
    const initial = f.owner.handleSubscribeInventory(f.a, 'initial')
    f.nextRevision()
    f.owner.broadcastToSubscribed({ type: 'session_attention_snapshot', ...f.manager.getSessionAttentionSnapshot() })
    f.owner.broadcastUnreadCountUpdate('a', 8)
    expect(delivered).toEqual([])
    hold.resolve(); await initial
    expect(delivered.map((e) => e.type)).toEqual(['inventory_snapshot', 'session_attention_snapshot', 'unread_count_update'])
    expect((delivered[0] as any).revision).toBe(1)
    expect((delivered[1] as any).revision).toBe(2)

    const secondHold = deferred()
    ;(f.owner as any).sendBootstrapCritical = async (_socket: WebSocket, event: ServerEvent, shouldSend?: () => boolean) => {
      if (event.type === blockedType) await secondHold.promise
      if (shouldSend?.() === false) return null
      delivered.push(event)
      return 1
    }
    delivered.length = 0
    const stale = f.owner.handleSubscribeInventory(f.a, 'stale')
    await f.owner.handleSubscribe(f.a, 'a')
    secondHold.resolve(); await stale
    expect(delivered.some((event) => event.type === 'inventory_snapshot')).toBe(false)
    expect(f.owner.getSubscribedAgentId(f.a)).toBe('a')

    blockedType = 'conversation_history'
    const thirdHold = deferred()
    ;(f.owner as any).sendBootstrapCritical = async (_socket: WebSocket, event: ServerEvent, shouldSend?: () => boolean) => {
      if (event.type === blockedType) await thirdHold.promise
      if (shouldSend?.() === false) return null
      delivered.push(event)
      return 1
    }
    delivered.length = 0
    const oldChat = f.owner.handleSubscribe(f.a, 'b', undefined, false, 'all', false, 'new-chat')
    await flush()
    await f.owner.handleSubscribeInventory(f.a, 'demoted')
    const afterBaseline = delivered.length
    thirdHold.resolve(); await oldChat
    expect(delivered.slice(afterBaseline)).toEqual([])
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
  })

  it('drops an in-flight conversation-derived proxy response after demotion', async () => {
    const f = fixture()
    await f.command(f.a, { type: 'subscribe', agentId: 'a' })
    const hold = deferred()
    vi.spyOn(f.handler as any, 'routeApiProxyCommand').mockImplementation(async () => {
      await hold.promise
      return { type: 'api_proxy_response', requestId: 'old-artifact', status: 200, body: 'must not leak' }
    })
    const pending = f.command(f.a, { type: 'api_proxy', requestId: 'old-artifact', method: 'POST', path: '/api/chat-artifacts/read', body: '{}' })
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'demote' })
    f.a.send.mockClear()
    hold.resolve(); await pending; await flush()
    expect(events(f.a)).toEqual([])
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
  })

  it('bounds a stalled inventory queue and cancels its baseline on removal', async () => {
    const f = fixture(), hold = deferred()
    const delivered: ServerEvent[] = []
    ;(f.owner as any).sendBootstrapCritical = async (_socket: WebSocket, event: ServerEvent, shouldSend?: () => boolean) => {
      await hold.promise
      if (shouldSend?.() === false) return null
      delivered.push(event)
      return 1
    }
    const pending = f.owner.handleSubscribeInventory(f.a, 'slow')
    for (let count = 0; count <= 1024; count++) f.owner.broadcastUnreadCountUpdate('a', count)
    expect(f.a.close).toHaveBeenCalledWith(1013, expect.any(String))
    expect(f.owner.isInventorySubscription(f.a)).toBe(false)
    hold.resolve(); await pending
    expect(delivered).toEqual([])
    expect(f.unread.markRead).not.toHaveBeenCalled()
  })

  it('rejects inventory on Collaboration runtime without installing a viewed or passive target', async () => {
    const f = fixture()
    f.manager.getConfig = () => ({ runtimeTarget: 'collaboration-server', managerId: 'a', debug: false, paths: { dataDir: '/fixture' } })
    setCollaborationSocketAuthContext(f.a, { userId: 'fixture-admin', name: 'Admin', email: 'admin@example.test', role: 'admin', disabled: false, passwordChangeRequired: false })
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'not-builder' })
    await flush()
    expect(events(f.a).at(-1)).toMatchObject({ type: 'error', code: 'INVENTORY_NOT_SUPPORTED', requestId: 'not-builder' })
    expect(f.owner.subscriptions.size).toBe(0)
    expect(f.unread.markRead).not.toHaveBeenCalled()
  })

  it('uses the pinned old-server rejection fixture without entering normal subscribe; malformed/current unknown commands also fail closed', async () => {
    const f = fixture()
    // Exact ce3a30e6 parseClientCommand unknown-type result. The old parser has no
    // subscribe_inventory branch; this exercises the real handler's rejection path.
    const oldParser = vi.spyOn(parser, 'parseClientCommand').mockReturnValueOnce({ ok: false, error: 'Unknown command type' })
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'new-client-old-server' })
    oldParser.mockRestore()
    expect(events(f.a)).toEqual([{ type: 'error', code: 'INVALID_COMMAND', message: 'Unknown command type' }])
    expect(f.owner.subscriptions.size).toBe(0)
    expect(f.unread.markRead).not.toHaveBeenCalled()
    for (const command of [{ type: 'subscribe_inventory' }, { type: 'subscribe_inventory', requestId: 'x', agentId: 'a' }, { type: 'future_unknown_command' }]) {
      await f.command(f.a, command)
      expect(events(f.a).at(-1)).toMatchObject({ type: 'error', code: 'INVALID_COMMAND' })
    }
    expect(f.owner.subscriptions.size).toBe(0)
  })
})
