/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostRegistration, BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import { createInitialManagerWsState } from '@/lib/ws-state'
import { BrowserAutomationHost } from './BrowserAutomationHost'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { if (root) act(() => root?.unmount()); root = null; container.remove(); delete window.electronBridge })

function tab(tabId: string, sessionAgentId: string, profileId: string): BrowserTabSnapshot {
  const now = new Date(0).toISOString()
  return { tabId, sessionAgentId, profileId, url: 'about:blank', title: tabId, lifecycle: 'restoring', loading: false, live: false, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now }
}
function session(sessionAgentId: string, profileId: string, hostedTab: BrowserTabSnapshot): BrowserSessionSnapshot {
  const now = new Date(0).toISOString()
  return { schemaVersion: 1, sessionAgentId, profileId, hostingState: 'hosted', tabs: [hostedTab], activeTabId: hostedTab.tabId, defaultTabId: hostedTab.tabId, panelVisible: false, recentActions: [], revision: 1, createdAt: now, updatedAt: now }
}

describe('BrowserAutomationHost', () => {
  it('mounts every hydrated session tab offscreen so background tabs stay alive', async () => {
    const registerBrowserAutomationHost = vi.fn((_registration: BrowserHostRegistration) => vi.fn())
    window.electronBridge = {
      backendUrl: 'http://localhost', backendWsUrl: 'ws://localhost', getVersion: () => 'test', platform: 'darwin',
      browserAutomation: {
        capabilities: { supportedOperations: ['status'], playwrightVersion: '1.60.0', supportsRecording: true },
        getWebviewConfig: vi.fn(async (profileId) => ({ partition: `persist:forge-browser-${profileId}`, preloadUrl: 'file:///guest.js', webPreferences: 'sandbox=yes' })),
        registerWebview: vi.fn(), unregisterWebview: vi.fn(async () => undefined), setTabPresentation: vi.fn(async (_id, _visible, _viewport) => tab('unused', 'unused', 'unused')),
        invoke: vi.fn(), onStateChanged: vi.fn(() => vi.fn()),
      },
    }
    const first = session('session-1', 'profile-1', tab('tab-1', 'session-1', 'profile-1'))
    const second = session('session-2', 'profile-2', tab('tab-2', 'session-2', 'profile-2'))
    const state = { ...createInitialManagerWsState('session-1'), browserSessions: { 'session-1': first, 'session-2': second } }
    const setBrowserHostFocused = vi.fn()
    const client = { registerBrowserAutomationHost, reportBrowserHostState: vi.fn(), setBrowserHostFocused, getState: () => state } as never

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', panelVisible: false }))
      await Promise.resolve(); await Promise.resolve()
    })

    expect(registerBrowserAutomationHost).toHaveBeenCalledOnce()
    expect(container.querySelectorAll('webview')).toHaveLength(2)
    expect(Array.from(container.querySelectorAll('webview')).every((element) => element.getAttribute('style')?.includes('-10000'))).toBe(true)

    const registration = registerBrowserAutomationHost.mock.calls[0]![0]
    const connectedState = {
      ...state,
      browserHost: {
        connected: true,
        hostId: registration.hostId,
        hostGeneration: 1,
        focused: false,
        capabilities: registration.capabilities,
        connectedAt: new Date(0).toISOString(),
      },
    }
    await act(async () => {
      root!.render(createElement(BrowserAutomationHost, { client, state: connectedState, selectedSessionAgentId: 'session-1', panelVisible: false }))
      await Promise.resolve()
    })
    expect(setBrowserHostFocused).toHaveBeenCalledWith(document.hasFocus())
  })

  it('does not touch Electron IPC in the normal web UI', () => {
    const state = createInitialManagerWsState('session-1')
    act(() => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client: null, state, selectedSessionAgentId: 'session-1', panelVisible: true })) })
    expect(container.innerHTML).toBe('')
  })

  it('unhosts webviews when hostingState becomes unhosted and remounts after restore', async () => {
    const unregisterWebview = vi.fn(async () => undefined)
    window.electronBridge = {
      backendUrl: 'http://localhost', backendWsUrl: 'ws://localhost', getVersion: () => 'test', platform: 'darwin',
      browserAutomation: {
        capabilities: { supportedOperations: ['status'], playwrightVersion: '1.60.0', supportsRecording: true },
        getWebviewConfig: vi.fn(async (profileId) => ({ partition: `persist:forge-browser-${profileId}`, preloadUrl: 'file:///guest.js', webPreferences: 'sandbox=yes' })),
        registerWebview: vi.fn(), unregisterWebview, setTabPresentation: vi.fn(async (_id, _visible, _viewport) => tab('unused', 'unused', 'unused')),
        invoke: vi.fn(), onStateChanged: vi.fn(() => vi.fn()),
      },
    }
    const hosted = session('session-1', 'profile-1', tab('tab-1', 'session-1', 'profile-1'))
    const state = { ...createInitialManagerWsState('session-1'), browserSessions: { 'session-1': hosted } }
    const client = { registerBrowserAutomationHost: vi.fn(() => vi.fn()), reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state } as never

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', panelVisible: false }))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(container.querySelectorAll('webview')).toHaveLength(1)

    const unhostedState = {
      ...state,
      browserSessions: { 'session-1': { ...hosted, hostingState: 'unhosted' as const } },
    }
    await act(async () => {
      root!.render(createElement(BrowserAutomationHost, { client, state: unhostedState, selectedSessionAgentId: 'session-1', panelVisible: false }))
      await Promise.resolve()
    })
    expect(container.querySelectorAll('webview')).toHaveLength(0)

    const restoredState = {
      ...state,
      browserSessions: { 'session-1': { ...hosted, hostingState: 'hosted' as const, tabs: [{ ...hosted.tabs[0]!, lifecycle: 'restoring' as const }] } },
    }
    await act(async () => {
      root!.render(createElement(BrowserAutomationHost, { client, state: restoredState, selectedSessionAgentId: 'session-1', panelVisible: false }))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(container.querySelectorAll('webview')).toHaveLength(1)
  })

  it('reports runtime tab updates with baseRevision against the latest acknowledged session', async () => {
    const reportBrowserHostState = vi.fn()
    let stateChanged: ((tab: BrowserTabSnapshot) => void) | null = null
    window.electronBridge = {
      backendUrl: 'http://localhost', backendWsUrl: 'ws://localhost', getVersion: () => 'test', platform: 'darwin',
      browserAutomation: {
        capabilities: { supportedOperations: ['status'], playwrightVersion: '1.60.0', supportsRecording: true },
        getWebviewConfig: vi.fn(async (profileId) => ({ partition: `persist:forge-browser-${profileId}`, preloadUrl: 'file:///guest.js', webPreferences: 'sandbox=yes' })),
        registerWebview: vi.fn(), unregisterWebview: vi.fn(async () => undefined), setTabPresentation: vi.fn(async (_id, _visible, _viewport) => tab('unused', 'unused', 'unused')),
        invoke: vi.fn(), onStateChanged: vi.fn((listener) => { stateChanged = listener; return () => undefined }),
      },
    }
    const hosted = session('session-1', 'profile-1', tab('tab-1', 'session-1', 'profile-1'))
    const state = {
      ...createInitialManagerWsState('session-1'),
      browserSessions: { 'session-1': hosted },
      browserHost: {
        connected: true,
        hostId: 'host-test',
        hostGeneration: 1,
        focused: false,
        capabilities: null,
        connectedAt: new Date(0).toISOString(),
      },
    }
    const client = {
      registerBrowserAutomationHost: vi.fn((registration: BrowserHostRegistration) => {
        state.browserHost.hostId = registration.hostId
        return vi.fn()
      }),
      reportBrowserHostState,
      setBrowserHostFocused: vi.fn(),
      getState: () => state,
    } as never

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', panelVisible: false }))
      await Promise.resolve(); await Promise.resolve()
    })

    const updated = { ...hosted.tabs[0]!, title: 'Updated', loading: true }
    await act(async () => {
      stateChanged?.(updated)
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(reportBrowserHostState).toHaveBeenCalledWith([{
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      baseRevision: 1,
      tabs: [updated],
    }])
  })
})
