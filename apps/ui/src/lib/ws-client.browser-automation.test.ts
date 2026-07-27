import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAutomationRequest, BrowserHostLifecycleRequest, BrowserHostRegistration, BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import { ManagerWsClient } from './ws-client'

const now = new Date(0).toISOString()
const registration: BrowserHostRegistration = {
  hostId: 'host-1', clientInstanceId: 'desktop-1', registeredAt: now,
  capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ['status', 'open'], maxResponseBytes: 1024 },
}
function tab(targetAffinity: BrowserTabSnapshot['targetAffinity']): BrowserTabSnapshot {
  return { targetAffinity, tabId: targetAffinity === 'external-chrome' ? 'ext.profile.7' : 'managed-1', sessionAgentId: 'session-1', profileId: 'profile-1', url: '', title: 'Browser tab', lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now }
}
function snapshot(revision: number, tabs: BrowserTabSnapshot[] = [], activeTabId = tabs[0]?.tabId ?? null): BrowserSessionSnapshot {
  return { schemaVersion: 2, sessionAgentId: 'session-1', profileId: 'profile-1', hostingState: 'hosted', tabs, activeTabId, defaultTabId: activeTabId, panelVisible: true, recentActions: [], revision, createdAt: now, updatedAt: new Date(revision).toISOString() }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', class { static readonly OPEN = 1 })
  const client = new ManagerWsClient('ws://example.test', 'session-1')
  const send = vi.fn()
  const socket = { readyState: 1, send, close: vi.fn() }
  ;(client as unknown as { transport: { socket: typeof socket } }).transport.socket = socket
  const ingest = (event: unknown) => (client as unknown as { handleServerEvent(event: unknown): void }).handleServerEvent(event)
  return { client, send, ingest }
}

async function connectHost(value: ReturnType<typeof fixture>) {
  await vi.advanceTimersByTimeAsync(0)
  const register = JSON.parse(value.send.mock.calls[0]![0] as string)
  value.ingest({ type: 'browser_host_connected', requestId: register.requestId, host: { connected: true, hostId: 'host-1', hostGeneration: 3, focused: true, capabilities: registration.capabilities, connectedAt: now } })
  await Promise.resolve(); await vi.advanceTimersByTimeAsync(0)
  return JSON.parse(value.send.mock.calls.at(-1)![0] as string)
}

describe('ManagerWsClient automatic Browser integration', () => {
  it('registers one protocol-v2 host and hydrates mixed target affinity from bootstrap', async () => {
    const value = fixture()
    value.client.registerBrowserAutomationHost(registration, vi.fn())
    const hydrate = await connectHost(value)
    const register = JSON.parse(value.send.mock.calls[0]![0] as string)
    expect(register).toMatchObject({ type: 'browser_host_register', registration: { capabilities: { protocolVersions: { minimum: 2, maximum: 2 } } } })
    expect(hydrate).toMatchObject({ type: 'browser_host_hydrate', hostId: 'host-1', hostGeneration: 3 })
    value.ingest({ type: 'browser_host_hydration_chunk', requestId: hydrate.requestId, hostId: 'host-1', hostGeneration: 3, chunkIndex: 0, chunkCount: 1, payloadBase64: btoa(JSON.stringify([snapshot(1, [tab('external-chrome')])])) })
    expect(value.client.getState().browserHostHydrated).toBe(true)
    expect(value.client.getState().browserSessions['session-1']?.tabs[0]?.targetAffinity).toBe('external-chrome')
    value.client.destroy()
  })

  it('applies newer live snapshots after bootstrap while ignoring stale replay', async () => {
    const value = fixture()
    value.client.registerBrowserAutomationHost(registration, vi.fn())
    const hydrate = await connectHost(value)
    value.ingest({ type: 'browser_host_hydration_chunk', requestId: hydrate.requestId, hostId: 'host-1', hostGeneration: 3, chunkIndex: 0, chunkCount: 1, payloadBase64: btoa(JSON.stringify([snapshot(2)])) })
    value.ingest({ type: 'browser_session_changed', reason: 'automation', snapshot: snapshot(4, [tab('managed-electron')]) })
    value.ingest({ type: 'browser_session_changed', reason: 'recovery', snapshot: snapshot(3, [tab('external-chrome')]) })
    expect(value.client.getState().browserSessions['session-1']?.revision).toBe(4)
    expect(value.client.getState().browserSessions['session-1']?.tabs[0]?.targetAffinity).toBe('managed-electron')
    value.client.destroy()
  })

  it('hydrates URL/title metadata and applies live active/inactive metadata without stealing selection', async () => {
    const value = fixture()
    value.client.registerBrowserAutomationHost(registration, vi.fn())
    const hydrate = await connectHost(value)
    const active = { ...tab('managed-electron'), tabId: 'managed-active', url: 'https://active.test/bootstrap', title: 'Active bootstrap' }
    const inactive = { ...tab('managed-electron'), tabId: 'managed-inactive', url: 'https://inactive.test/bootstrap', title: 'Inactive bootstrap' }
    value.ingest({ type: 'browser_host_hydration_chunk', requestId: hydrate.requestId, hostId: 'host-1', hostGeneration: 3, chunkIndex: 0, chunkCount: 1, payloadBase64: btoa(JSON.stringify([snapshot(2, [active, inactive], active.tabId)])) })
    expect(value.client.getState().browserSessions['session-1']).toMatchObject({ activeTabId: active.tabId, tabs: [{ title: 'Active bootstrap' }, { title: 'Inactive bootstrap' }] })

    value.ingest({ type: 'browser_session_changed', reason: 'host-report', snapshot: snapshot(3, [
      { ...active, url: 'https://active.test/live', title: 'Active live' },
      { ...inactive, url: 'https://inactive.test/live', title: 'Inactive live' },
    ], active.tabId) })
    expect(value.client.getState().browserSessions['session-1']).toMatchObject({
      activeTabId: active.tabId,
      tabs: [
        { tabId: active.tabId, url: 'https://active.test/live', title: 'Active live' },
        { tabId: inactive.tabId, url: 'https://inactive.test/live', title: 'Inactive live' },
      ],
    })
    value.client.destroy()
  })

  it('routes automation and lifecycle through the same host registration', async () => {
    const value = fixture()
    const handle = vi.fn(async (request: BrowserAutomationRequest) => ({ ...request, ok: false as const, error: { code: 'unavailable-host' as const, message: 'fallback', retryable: true }, elapsedMs: 1 }))
    const handleLifecycle = vi.fn(async (request: BrowserHostLifecycleRequest) => ({ ...request, ok: true as const }))
    value.client.registerBrowserAutomationHost(registration, handle, handleLifecycle)
    await connectHost(value)
    const request: BrowserAutomationRequest = { requestId: 'auto-1', sessionAgentId: 'session-1', profileId: 'profile-1', tabId: null, hostId: 'host-1', hostGeneration: 3, deadlineAt: new Date(Date.now() + 10_000).toISOString(), artifactDirectory: null, operation: 'status', input: {} }
    const lifecycle: BrowserHostLifecycleRequest = { requestId: 'life-1', sessionAgentId: 'session-1', profileId: 'profile-1', hostId: 'host-1', hostGeneration: 3, kind: 'turn-ended', turnId: 'turn-1' }
    value.ingest({ type: 'browser_automation_request', request })
    value.ingest({ type: 'browser_host_lifecycle_request', request: lifecycle })
    await Promise.resolve(); await Promise.resolve()
    expect(handle).toHaveBeenCalledWith(request)
    expect(handleLifecycle).toHaveBeenCalledWith(lifecycle)
    const messages = value.send.mock.calls.map(([payload]) => JSON.parse(payload as string).type)
    expect(messages).toContain('browser_host_response')
    expect(messages).toContain('browser_host_lifecycle_response')
    value.client.destroy()
  })
})
