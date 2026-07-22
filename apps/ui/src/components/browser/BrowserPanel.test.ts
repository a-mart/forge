/** @vitest-environment jsdom */

import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import type { BrowserAutomationHostHandle } from './BrowserAutomationHost'
import { BrowserPanel } from './BrowserPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { if (root) act(() => root?.unmount()); root = null; container.remove(); delete window.electronBridge })

const now = new Date(0).toISOString()
const tab: BrowserTabSnapshot = { tabId: 'tab-1', sessionAgentId: 'session-1', profileId: 'profile-1', url: 'https://example.com', title: 'Example', lifecycle: 'ready', loading: false, live: true, canGoBack: true, canGoForward: false, zoomFactor: 1, controller: 'agent', agentCursor: { x: 20, y: 30, phase: 'move', sequence: 1, createdAt: now }, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: { width: 1000, height: 700, deviceScaleFactor: 1 }, error: null, createdAt: now, updatedAt: now }
const snapshot: BrowserSessionSnapshot = { schemaVersion: 1, sessionAgentId: 'session-1', profileId: 'profile-1', tabs: [tab], activeTabId: 'tab-1', defaultTabId: 'tab-1', panelVisible: true, recentActions: [], revision: 1, createdAt: now, updatedAt: now }
const disconnectedHost = { connected: false, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null }

describe('BrowserPanel', () => {
  it('shows an accessible web-unavailable state without invoking a bridge', () => {
    act(() => { root = createRoot(container); root.render(createElement(BrowserPanel, { client: null, sessionAgentId: 'session-1', profileId: 'profile-1', snapshot, host: disconnectedHost, hostRef: createRef<BrowserAutomationHostHandle>() })) })
    expect(container.querySelector('[aria-label="Browser workspace"]')).not.toBeNull()
    expect(container.textContent).toContain('available in the Forge desktop app')
    expect(container.querySelector('button[aria-label="Back"]')).not.toBeNull()
    expect(container.querySelector('input[aria-label="Viewport width"]')).not.toBeNull()
  })

  it('wires tab, history, reload, zoom, viewport, screenshot, and recording controls', async () => {
    window.electronBridge = { backendUrl: 'http://localhost', backendWsUrl: 'ws://localhost', getVersion: () => 'test', platform: 'darwin', browserAutomation: {} as never }
    const client = { activateBrowserTab: vi.fn(), closeBrowserTab: vi.fn(), openBrowserTab: vi.fn(), resizeBrowserTab: vi.fn(), startBrowserRecording: vi.fn(), stopBrowserRecording: vi.fn() }
    const hostHandle: BrowserAutomationHostHandle = { navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), setZoom: vi.fn(), captureScreenshot: vi.fn(async () => 'data:image/png;base64,a') }
    const hostRef = { current: hostHandle }
    const connectedHost = { ...disconnectedHost, connected: true, hostId: 'host-1', hostGeneration: 1, capabilities: { supportedOperations: ['status'], electronVersion: '37', chromiumVersion: '138', playwrightVersion: '1.60.0', maxResponseBytes: 1024, supportsSandboxedWebviews: true, supportsCapturePage: true, supportsRecording: true }, connectedAt: now }
    act(() => { root = createRoot(container); root.render(createElement(BrowserPanel, { client: client as never, sessionAgentId: 'session-1', profileId: 'profile-1', snapshot, host: connectedHost as never, hostRef })) })

    click('Back'); click('Hard reload'); click('Zoom in'); click('Reset zoom'); click('Screenshot')
    await act(async () => { await Promise.resolve() })
    expect(hostHandle.history).toHaveBeenCalledWith('tab-1', 'back')
    expect(hostHandle.reload).toHaveBeenCalledWith('tab-1', true)
    expect(hostHandle.setZoom).toHaveBeenCalledWith('tab-1', 1)
    expect(container.querySelector('[aria-label="Browser screenshot"]')).not.toBeNull()
    click('Resize'); click('Start recording')
    await act(async () => { await Promise.resolve() })
    expect(client.resizeBrowserTab).toHaveBeenCalled()
    expect(client.startBrowserRecording).toHaveBeenCalledWith('session-1', 'tab-1')
    expect(window.electronBridge?.browserAutomation?.invoke).toBeUndefined()

    const recordingTab = { ...tab, recording: { recordingId: 'recording-1', startedAt: now, mimeType: 'video/webm' } }
    const recordingSnapshot = { ...snapshot, tabs: [recordingTab] }
    act(() => root!.render(createElement(BrowserPanel, { client: client as never, sessionAgentId: 'session-1', profileId: 'profile-1', snapshot: recordingSnapshot, host: connectedHost as never, hostRef })))
    click('Stop recording')
    await act(async () => { await Promise.resolve() })
    expect(client.stopBrowserRecording).toHaveBeenCalledWith('session-1', 'tab-1', 'recording-1')
  })
})

function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent === label)
  if (!button) throw new Error(`Missing button ${label}`)
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
