/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAutomationRequest, BrowserHostRegistration, BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import { createInitialManagerWsState } from '@/lib/ws-state'
import { BrowserAutomationHost } from './BrowserAutomationHost'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root | null = null
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { if (root) act(() => root?.unmount()); root = null; container.remove(); delete window.electronBridge })

const now = new Date(0).toISOString()
function tab(tabId = 'tab-1'): BrowserTabSnapshot { return { tabId, sessionAgentId: 'session-1', profileId: 'profile-1', url: 'about:blank', title: tabId, lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now } }
function session(): BrowserSessionSnapshot { return { schemaVersion: 1, sessionAgentId: 'session-1', profileId: 'profile-1', hostingState: 'hosted', tabs: [tab()], activeTabId: 'tab-1', defaultTabId: 'tab-1', panelVisible: true, recentActions: [], revision: 1, createdAt: now, updatedAt: now } }

function installBridge() {
  const listeners: Array<(tab: BrowserTabSnapshot) => void> = []
  const reconcile = vi.fn(async () => ({ applied: true, tabCount: 1 }))
  const ensureProvisional = vi.fn(async ({ tab: value }: { tab: BrowserTabSnapshot }) => value)
  const commitProvisional = vi.fn(async () => undefined)
  const abortProvisional = vi.fn(async () => undefined)
  const invoke = vi.fn()
  window.electronBridge = {
    windowRole: 'main', backendUrl: 'http://localhost', backendWsUrl: 'ws://localhost', getVersion: () => 'test', platform: 'darwin',
    browserAutomation: {
      capabilities: { supportedOperations: ['open', 'status'], playwrightVersion: '1.60.0', supportsRecording: true },
      reconcile, ensureProvisional, commitProvisional, abortProvisional, reportViewport: vi.fn(async () => undefined),
      setTabPresentation: vi.fn(async (request) => ({ applied: true, tab: { ...tab(request.tabId), physicalVisible: request.visible }, hostGeneration: request.hostGeneration, sessionRevision: request.sessionRevision, sequence: request.sequence })),
      captureScreenshot: vi.fn(async () => 'data:image/png;base64,a'), navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), setZoom: vi.fn(), invoke,
      onStateChanged: vi.fn((listener) => { listeners.push(listener); return () => undefined }),
    },
    browserWorkspace: {
      capability: { popoutAvailable: true }, getSnapshot: vi.fn(), publish: vi.fn(async () => undefined), popOut: vi.fn(async () => 'popped-out' as const), dock: vi.fn(async () => 'docked' as const), bringToFront: vi.fn(async () => undefined), reportViewport: vi.fn(), onProjection: vi.fn(() => () => undefined), onModeChanged: vi.fn(() => () => undefined), onFocusChanged: vi.fn(() => () => undefined),
    },
  }
  return { reconcile, ensureProvisional, commitProvisional, abortProvisional, invoke, listeners }
}

describe('BrowserAutomationHost main-owned view controller', () => {
  it('registers one backend authority and reconciles canonical tabs without renderer webviews', async () => {
    const bridge = installBridge()
    const state = { ...createInitialManagerWsState('session-1'), browserSessions: { 'session-1': session() } }
    const registerBrowserAutomationHost = vi.fn((_registration: BrowserHostRegistration) => vi.fn())
    const client = { registerBrowserAutomationHost, reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: true })); await Promise.resolve() })
    expect(registerBrowserAutomationHost).toHaveBeenCalledOnce()
    expect(bridge.reconcile).toHaveBeenCalledWith(expect.objectContaining({ sessions: [expect.objectContaining({ sessionAgentId: 'session-1' })] }))
    expect(container.querySelector('webview')).toBeNull()
  })

  it('creates and atomically aborts a failed provisional main-owned tab', async () => {
    const bridge = installBridge()
    let execute: ((request: BrowserAutomationRequest) => Promise<unknown>) | null = null
    bridge.invoke.mockResolvedValue({ requestId: 'request-1', sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'native-tab', hostId: 'host', hostGeneration: 1, operation: 'open', ok: false, error: { code: 'navigation-failed', message: 'failed', retryable: true }, elapsedMs: 1 })
    const state = createInitialManagerWsState('session-1')
    const client = { registerBrowserAutomationHost: vi.fn((_registration, handler) => { execute = handler; return vi.fn() }), reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: false })); await Promise.resolve() })
    const request: Extract<BrowserAutomationRequest, { operation: 'open' }> = { requestId: 'request-1', sessionAgentId: 'session-1', profileId: 'profile-1', tabId: null, hostId: 'host', hostGeneration: 1, deadlineAt: new Date(Date.now() + 10_000).toISOString(), artifactDirectory: null, operation: 'open', input: { show: false, reuseExistingTab: false } }
    await execute!(request)
    expect(bridge.ensureProvisional).toHaveBeenCalledOnce()
    expect(bridge.abortProvisional).toHaveBeenCalledOnce()
    expect(bridge.commitProvisional).not.toHaveBeenCalled()
  })

  it('publishes only the selected local projection and never renders a second host surface', async () => {
    installBridge()
    const state = { ...createInitialManagerWsState('session-1'), connected: true, browserSessions: { 'session-1': session() } }
    const client = { registerBrowserAutomationHost: vi.fn(() => vi.fn()), reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: null, selectedProfileId: null, panelVisible: false })); await Promise.resolve() })
    expect(window.electronBridge?.browserWorkspace?.publish).toHaveBeenCalledWith(expect.objectContaining({ sessionAgentId: null, profileId: null }))
    expect(container.innerHTML).toBe('')
  })
})
