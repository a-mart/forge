import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostRegistration, BrowserSessionSnapshot } from '@forge/protocol'
import { ManagerWsClient } from './ws-client'

const registration: BrowserHostRegistration = {
  hostId: 'host-1', clientInstanceId: 'renderer-1', registeredAt: new Date(0).toISOString(),
  capabilities: {
    supportedOperations: ['status'], electronVersion: '37', chromiumVersion: '138', playwrightVersion: '1.60.0',
    maxResponseBytes: 1024 * 1024, supportsSandboxedWebviews: true, supportsCapturePage: true, supportsRecording: true,
  },
}
function snapshot(revision: number): BrowserSessionSnapshot {
  return { schemaVersion: 1, sessionAgentId: 'session-1', profileId: 'profile-1', hostingState: 'hosted', tabs: [], activeTabId: null, defaultTabId: null, panelVisible: false, panelReveal: { sequence: 0, acknowledgedSequence: 0, tabId: null }, recentActions: [], revision, createdAt: new Date(0).toISOString(), updatedAt: new Date(revision).toISOString() }
}
function snapshotWithReveal(revision: number, acknowledgedSequence = 0): BrowserSessionSnapshot {
  const now = new Date(0).toISOString()
  const tab = {
    tabId: 'tab-1', sessionAgentId: 'session-1', profileId: 'profile-1', url: 'https://example.com', title: 'Example',
    lifecycle: 'ready' as const, loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1,
    controller: 'none' as const, agentCursor: null, recording: null, viewportSetting: { mode: 'fill' as const },
    renderedViewport: { width: 1000, height: 700, deviceScaleFactor: 1 }, physicalVisible: acknowledgedSequence > 0,
    error: null, createdAt: now, updatedAt: now,
  }
  return {
    ...snapshot(revision), tabs: [tab], activeTabId: tab.tabId, defaultTabId: tab.tabId, panelVisible: true,
    panelReveal: { sequence: 7, acknowledgedSequence, tabId: acknowledgedSequence < 7 ? tab.tabId : null },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ManagerWsClient browser automation state', () => {
  it('retries dropped registration and hydration phases on the same open transport', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', class { static readonly OPEN = 1 })
    const client = new ManagerWsClient('ws://example.test', 'session-1')
    const send = vi.fn()
    const socket = { readyState: 1, send, close: vi.fn() }
    ;(client as unknown as { transport: { socket: typeof socket } }).transport.socket = socket
    client.registerBrowserAutomationHost(registration, vi.fn())
    const ingest = (event: unknown) => (client as unknown as { handleServerEvent(event: unknown): void }).handleServerEvent(event)

    await vi.advanceTimersByTimeAsync(0)
    const firstRegister = JSON.parse(send.mock.calls[0]![0] as string)
    expect(firstRegister).toMatchObject({ type: 'browser_host_register', requestId: expect.any(String) })
    // Simulate a saturated server dropping the first registration acknowledgement.
    await vi.advanceTimersByTimeAsync(2_500)
    const secondRegister = JSON.parse(send.mock.calls[1]![0] as string)
    expect(secondRegister).toMatchObject({ type: 'browser_host_register' })
    expect(secondRegister.requestId).not.toBe(firstRegister.requestId)
    ingest({ type: 'browser_host_connected', requestId: secondRegister.requestId, host: { connected: true, hostId: 'host-1', hostGeneration: 2, focused: false, capabilities: registration.capabilities, connectedAt: new Date().toISOString() } })
    await Promise.resolve()

    const firstHydrate = JSON.parse(send.mock.calls[2]![0] as string)
    expect(firstHydrate).toMatchObject({ type: 'browser_host_hydrate', hostId: 'host-1', hostGeneration: 2 })
    // Drop hydration independently. The established generation must be reused.
    await vi.advanceTimersByTimeAsync(2_500)
    const secondHydrate = JSON.parse(send.mock.calls[3]![0] as string)
    expect(secondHydrate).toMatchObject({ type: 'browser_host_hydrate', hostGeneration: 2 })
    expect(send.mock.calls.map(([payload]) => JSON.parse(payload as string).type).filter((type) => type === 'browser_host_register')).toHaveLength(2)

    const payloadBase64 = btoa(JSON.stringify([snapshot(8)]))
    ingest({ type: 'browser_host_hydration_chunk', requestId: secondHydrate.requestId, hostId: 'host-1', hostGeneration: 2, chunkIndex: 0, chunkCount: 1, payloadBase64 })
    await Promise.resolve()
    expect(client.getState().browserHostHydrated).toBe(true)
    expect(client.getState().browserSessions['session-1']?.revision).toBe(8)
    expect((client as unknown as { transport: { socket: unknown } }).transport.socket).toBe(socket)
    client.destroy()
  })

  it('hydrates a host generation, ignores stale revisions, and applies reconnect bootstrap authoritatively', () => {
    const client = new ManagerWsClient('ws://example.test', 'session-1')
    client.registerBrowserAutomationHost(registration, vi.fn())
    const ingest = (event: unknown) => (client as unknown as { handleServerEvent(event: unknown): void }).handleServerEvent(event)

    ingest({ type: 'browser_host_connected', host: { connected: true, hostId: 'host-1', hostGeneration: 2, focused: false, capabilities: registration.capabilities, connectedAt: new Date().toISOString() } })
    ingest({ type: 'browser_host_state_snapshot', hostId: 'host-1', hostGeneration: 1, sessions: [snapshot(9)] })
    expect(client.getState().browserHostHydrated).toBe(false)
    ingest({ type: 'browser_host_state_snapshot', hostId: 'host-1', hostGeneration: 2, sessions: [snapshot(4)] })
    expect(client.getState().browserSessions['session-1']?.revision).toBe(4)

    ingest({ type: 'browser_session_changed', snapshot: snapshot(6), reason: 'automation' })
    ingest({ type: 'browser_session_changed', snapshot: snapshot(5), reason: 'host-report' })
    expect(client.getState().browserSessions['session-1']?.revision).toBe(6)

    ingest({ type: 'browser_session_changed', snapshot: { ...snapshot(7), hostingState: 'removed' }, reason: 'lifecycle' })
    expect(client.getState().browserSessions['session-1']).toBeUndefined()

    ingest({ type: 'browser_session_snapshot', snapshot: snapshot(3) })
    expect(client.getState().browserSessions['session-1']?.revision).toBe(3)
  })

  it('sends host state as a typed request and resolves its acknowledgment', async () => {
    vi.stubGlobal('WebSocket', class { static readonly OPEN = 1 })
    const client = new ManagerWsClient('ws://example.test', 'session-1')
    client.registerBrowserAutomationHost(registration, vi.fn())
    const send = vi.fn()
    ;(client as unknown as { transport: { socket: { readyState: number; send: (payload: string) => void } } }).transport.socket = { readyState: 1, send }
    const ingest = (event: unknown) => (client as unknown as { handleServerEvent(event: unknown): void }).handleServerEvent(event)
    ingest({ type: 'browser_host_connected', host: { connected: true, hostId: 'host-1', hostGeneration: 2, focused: false, capabilities: registration.capabilities, connectedAt: new Date().toISOString() } })

    const reportPromise = client.reportBrowserHostState([{
      sessionAgentId: 'session-1', profileId: 'profile-1', baseRevision: 4, tabs: [],
    }])
    const command = JSON.parse(send.mock.calls[0]![0] as string)
    expect(command).toMatchObject({
      type: 'browser_host_state_report', hostId: 'host-1', hostGeneration: 2,
      sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', baseRevision: 4 }],
    })
    expect(command.requestId).toEqual(expect.any(String))
    const result = {
      hostId: 'host-1', hostGeneration: 2, status: 'processed' as const,
      sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', status: 'revision-conflict' as const, snapshot: snapshot(5) }],
    }
    ingest({ type: 'browser_host_state_report_result', requestId: command.requestId, result })
    await expect(reportPromise).resolves.toEqual(result)
  })

  it('resolves typed recording start and stop results without a client artifact path', async () => {
    vi.stubGlobal('WebSocket', class { static readonly OPEN = 1 })
    const client = new ManagerWsClient('ws://example.test', 'session-1')
    const send = vi.fn()
    ;(client as unknown as { transport: { socket: { readyState: number; send: (payload: string) => void } } }).transport.socket = { readyState: 1, send }
    const ingest = (event: unknown) => (client as unknown as { handleServerEvent(event: unknown): void }).handleServerEvent(event)

    const startedPromise = client.startBrowserRecording('session-1', 'tab-1')
    const startCommand = JSON.parse(send.mock.calls[0]![0] as string)
    expect(startCommand).toMatchObject({ type: 'browser_recording_start', sessionAgentId: 'session-1', tabId: 'tab-1' })
    expect(startCommand).not.toHaveProperty('artifactDirectory')
    const started = { recordingId: 'recording-1', tabId: 'tab-1', recording: true, startedAt: new Date(0).toISOString(), mimeType: 'video/webm', width: 1000, height: 700 }
    ingest({ type: 'browser_recording_command_succeeded', requestId: startCommand.requestId, commandType: 'browser_recording_start', result: started, snapshot: snapshot(2) })
    await expect(startedPromise).resolves.toEqual(started)

    const stoppedPromise = client.stopBrowserRecording('session-1', 'tab-1', 'recording-1')
    const stopCommand = JSON.parse(send.mock.calls[1]![0] as string)
    expect(stopCommand).toMatchObject({ type: 'browser_recording_stop', sessionAgentId: 'session-1', tabId: 'tab-1', recordingId: 'recording-1' })
    expect(stopCommand).not.toHaveProperty('artifactDirectory')
    const stopped = { recordingId: 'recording-1', tabId: 'tab-1', path: '/canonical/browser/recording-1.webm', mimeType: 'video/webm', extension: 'webm', sizeBytes: 14, width: 1000, height: 700, createdAt: new Date(1).toISOString() }
    ingest({ type: 'browser_recording_command_succeeded', requestId: stopCommand.requestId, commandType: 'browser_recording_stop', result: stopped, snapshot: snapshot(3) })
    await expect(stoppedPromise).resolves.toEqual(stopped)
  })

  it('replays a dropped reveal from authoritative hydration and never replays it after presentation acknowledgement', async () => {
    vi.stubGlobal('WebSocket', class { static readonly OPEN = 1 })
    const client = new ManagerWsClient('ws://example.test', 'session-1')
    client.registerBrowserAutomationHost(registration, vi.fn())
    const send = vi.fn()
    ;(client as unknown as { transport: { socket: { readyState: number; send: (payload: string) => void } } }).transport.socket = { readyState: 1, send }
    const ingest = (event: unknown) => (client as unknown as { handleServerEvent(event: unknown): void }).handleServerEvent(event)

    ingest({ type: 'browser_host_connected', host: { connected: true, hostId: 'host-1', hostGeneration: 3, focused: false, capabilities: registration.capabilities, connectedAt: new Date().toISOString() } })
    // No transient reveal event arrives: host hydration is the replay path.
    ingest({ type: 'browser_host_state_snapshot', hostId: 'host-1', hostGeneration: 3, sessions: [snapshotWithReveal(5)] })
    expect(client.getState().browserPanelRevealRequest).toMatchObject({ tabId: 'tab-1', sequence: 7, hostGeneration: 3 })

    const acknowledged = client.acknowledgeBrowserPanelReveal({ sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'tab-1', sequence: 7 })
    const command = JSON.parse(send.mock.calls.at(-1)![0] as string)
    expect(command).toMatchObject({ type: 'browser_panel_reveal_acknowledge', hostId: 'host-1', hostGeneration: 3, sequence: 7 })
    const satisfied = snapshotWithReveal(6, 7)
    ingest({ type: 'browser_panel_reveal_acknowledged', requestId: command.requestId, snapshot: satisfied })
    await expect(acknowledged).resolves.toEqual(satisfied)
    expect(client.getState().browserPanelRevealRequest).toBeNull()

    ingest({ type: 'browser_host_connected', host: { connected: true, hostId: 'host-1', hostGeneration: 4, focused: false, capabilities: registration.capabilities, connectedAt: new Date().toISOString() } })
    ingest({ type: 'browser_host_state_snapshot', hostId: 'host-1', hostGeneration: 4, sessions: [satisfied] })
    expect(client.getState().browserPanelRevealRequest).toBeNull()
  })
})
