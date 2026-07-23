/** @vitest-environment jsdom */

import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import type { BrowserAutomationHostHandle } from './BrowserAutomationHost'
import type { BrowserWorkspaceCommandPort } from './BrowserPanel'
import { getArticlesForContext, initializeHelpContent } from '@/components/help/help-registry'

vi.mock('@/components/help/HelpTrigger', () => ({
  HelpTrigger: ({ contextKey }: { contextKey: string }) =>
    createElement('button', {
      type: 'button',
      'aria-label': 'Help',
      'data-testid': 'browser-help-trigger',
      'data-context-key': contextKey,
    }),
}))

const { BrowserPanel } = await import('./BrowserPanel')

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { if (root) act(() => root?.unmount()); root = null; container.remove(); delete window.electronBridge })

const now = new Date(0).toISOString()
const tab: BrowserTabSnapshot = { tabId: 'tab-1', sessionAgentId: 'session-1', profileId: 'profile-1', url: 'https://example.com', title: 'Example', lifecycle: 'ready', loading: false, live: true, canGoBack: true, canGoForward: false, zoomFactor: 1, controller: 'agent', agentCursor: { x: 20, y: 30, phase: 'move', sequence: 1, createdAt: now }, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: { width: 1000, height: 700, deviceScaleFactor: 1 }, error: null, createdAt: now, updatedAt: now }
const snapshot: BrowserSessionSnapshot = { schemaVersion: 1, sessionAgentId: 'session-1', profileId: 'profile-1', hostingState: 'hosted', tabs: [tab], activeTabId: 'tab-1', defaultTabId: 'tab-1', panelVisible: true, recentActions: [], revision: 1, createdAt: now, updatedAt: now }
const disconnectedHost = { connected: false, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null }

describe('BrowserPanel', () => {
  it('shows an accessible web-unavailable state without invoking a bridge', () => {
    act(() => { root = createRoot(container); root.render(createElement(BrowserPanel, { client: null, sessionAgentId: 'session-1', profileId: 'profile-1', snapshot, host: disconnectedHost, hostRef: createRef<BrowserAutomationHostHandle>() })) })
    expect(container.querySelector('[aria-label="Managed Browser workspace"]')).not.toBeNull()
    expect(container.textContent).toContain('available in the Forge desktop app')
    expect(container.querySelector('button[aria-label="Back"]')).not.toBeNull()
    expect(container.querySelector('input[aria-label="Viewport width"]')).not.toBeNull()
  })

  it('renders a HelpTrigger that routes to the Managed Browser article', () => {
    initializeHelpContent()
    act(() => {
      root = createRoot(container)
      root.render(createElement(BrowserPanel, {
        client: null,
        sessionAgentId: 'session-1',
        profileId: 'profile-1',
        snapshot,
        host: disconnectedHost,
        hostRef: createRef<BrowserAutomationHostHandle>(),
      }))
    })

    const help = container.querySelector('[data-testid="browser-help-trigger"]')
    expect(help).not.toBeNull()
    expect(help?.getAttribute('data-context-key')).toBe('chat.browser')

    const recording = container.querySelector('button[aria-label="Start recording"]')
    expect(recording).not.toBeNull()
    expect(
      Boolean(recording && help && Boolean(recording.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING)),
    ).toBe(true)

    const routed = getArticlesForContext('chat.browser')
    expect(routed.map((article) => article.id)).toContain('chat-browser')
  })

  it('wires tab, history, reload, zoom, viewport, screenshot, and recording controls', async () => {
    window.electronBridge = { windowRole: 'main', backendUrl: 'http://localhost', backendWsUrl: 'ws://localhost', getVersion: () => 'test', platform: 'darwin', browserAutomation: {} as never }
    const commandPort: BrowserWorkspaceCommandPort = {
      open: vi.fn(), activate: vi.fn(), close: vi.fn(), resize: vi.fn(), navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), zoom: vi.fn(),
      capture: vi.fn(async () => 'data:image/png;base64,a'), startRecording: vi.fn(), stopRecording: vi.fn(), popOut: vi.fn(), dock: vi.fn(),
    }
    const connectedHost = { ...disconnectedHost, connected: true, hostId: 'host-1', hostGeneration: 1, capabilities: { supportedOperations: ['status'], electronVersion: '37', chromiumVersion: '138', playwrightVersion: '1.60.0', maxResponseBytes: 1024, supportsSandboxedWebviews: true, supportsCapturePage: true, supportsRecording: true }, connectedAt: now }
    act(() => { root = createRoot(container); root.render(createElement(BrowserPanel, { sessionAgentId: 'session-1', profileId: 'profile-1', snapshot, host: connectedHost as never, commandPort, popoutAvailable: true })) })

    click('Back'); click('Hard reload'); click('Zoom in'); click('Reset zoom'); click('Screenshot')
    await act(async () => { await Promise.resolve() })
    expect(commandPort.history).toHaveBeenCalledWith('tab-1', 'back')
    expect(commandPort.reload).toHaveBeenCalledWith('tab-1', true)
    expect(commandPort.zoom).toHaveBeenCalledWith('tab-1', 1)
    expect(container.querySelector('[aria-label="Browser screenshot"]')).not.toBeNull()
    click('Resize'); click('Start recording')
    await act(async () => { await Promise.resolve() })
    expect(commandPort.resize).toHaveBeenCalled()
    expect(commandPort.startRecording).toHaveBeenCalledWith('tab-1')
    expect(window.electronBridge?.browserAutomation?.invoke).toBeUndefined()

    const recordingTab = { ...tab, recording: { recordingId: 'recording-1', startedAt: now, mimeType: 'video/webm' } }
    const recordingSnapshot = { ...snapshot, tabs: [recordingTab] }
    act(() => root!.render(createElement(BrowserPanel, { sessionAgentId: 'session-1', profileId: 'profile-1', snapshot: recordingSnapshot, host: connectedHost as never, commandPort, popoutAvailable: true })))
    click('Stop recording')
    await act(async () => { await Promise.resolve() })
    expect(commandPort.stopRecording).toHaveBeenCalledWith('tab-1', 'recording-1')
  })
})

function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent === label)
  if (!button) throw new Error(`Missing button ${label}`)
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
