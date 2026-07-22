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
  return { schemaVersion: 1, sessionAgentId: 'session-1', profileId: 'profile-1', hostingState: 'hosted', tabs: [], activeTabId: null, defaultTabId: null, panelVisible: false, recentActions: [], revision, createdAt: new Date(0).toISOString(), updatedAt: new Date(revision).toISOString() }
}

afterEach(() => vi.unstubAllGlobals())

describe('ManagerWsClient browser automation state', () => {
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

  it('limits reveal requests to the selected session and current host generation', () => {
    const client = new ManagerWsClient('ws://example.test', 'session-1')
    client.registerBrowserAutomationHost(registration, vi.fn())
    const ingest = (event: unknown) => (client as unknown as { handleServerEvent(event: unknown): void }).handleServerEvent(event)
    ingest({ type: 'browser_host_connected', host: { connected: true, hostId: 'host-1', hostGeneration: 3, focused: false, capabilities: registration.capabilities, connectedAt: new Date().toISOString() } })
    ingest({ type: 'browser_session_snapshot', snapshot: snapshot(2) })
    ingest({ type: 'browser_panel_reveal_requested', sessionAgentId: 'background', tabId: 'tab-1', hostGeneration: 3, revision: 2 })
    expect(client.getState().browserPanelRevealRequest).toBeNull()
    ingest({ type: 'browser_panel_reveal_requested', sessionAgentId: 'session-1', tabId: 'tab-1', hostGeneration: 2, revision: 2 })
    expect(client.getState().browserPanelRevealRequest).toBeNull()
    ingest({ type: 'browser_panel_reveal_requested', sessionAgentId: 'session-1', tabId: 'tab-1', hostGeneration: 3, revision: 2 })
    expect(client.getState().browserPanelRevealRequest?.tabId).toBe('tab-1')
  })
})
