import { describe, expect, it, vi } from 'vitest'
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
  return { schemaVersion: 1, sessionAgentId: 'session-1', profileId: 'profile-1', tabs: [], activeTabId: null, defaultTabId: null, panelVisible: false, recentActions: [], revision, createdAt: new Date(0).toISOString(), updatedAt: new Date(revision).toISOString() }
}

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

    ingest({ type: 'browser_session_snapshot', snapshot: snapshot(3) })
    expect(client.getState().browserSessions['session-1']?.revision).toBe(3)
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
