/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostRegistration,
  BrowserHostSessionStateReport,
  BrowserHostStateReportResult,
  BrowserSessionSnapshot,
  BrowserTabSnapshot,
} from '@forge/protocol'
import { createInitialManagerWsState, type ManagerWsState } from '@/lib/ws-state'
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
        navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), setZoom: vi.fn(), invoke: vi.fn(), onStateChanged: vi.fn(() => vi.fn()),
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

  it('removes provisional webviews and readiness state after failed and exceptional opens', async () => {
    let executeRequest: ((request: BrowserAutomationRequest) => Promise<BrowserAutomationResponse>) | null = null
    const unregisterWebview = vi.fn(async () => undefined)
    const invoke = vi.fn()
    const registerWebview = vi.fn(async (registration: { tab: BrowserTabSnapshot; created: boolean }) => registration.tab)
    window.electronBridge = {
      backendUrl: 'http://localhost', backendWsUrl: 'ws://localhost', getVersion: () => 'test', platform: 'darwin',
      browserAutomation: {
        capabilities: { supportedOperations: ['open'], playwrightVersion: '1.60.0', supportsRecording: true },
        getWebviewConfig: vi.fn(async (profileId) => ({ partition: `persist:forge-browser-${profileId}`, preloadUrl: 'file:///guest.js', webPreferences: 'sandbox=yes' })),
        registerWebview, unregisterWebview, setTabPresentation: vi.fn(async (_id, _visible, _viewport) => tab('unused', 'unused', 'unused')),
        navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), setZoom: vi.fn(), invoke, onStateChanged: vi.fn(() => vi.fn()),
      },
    }
    const state = { ...createInitialManagerWsState('session-1'), browserHostHydrated: true }
    const client = {
      registerBrowserAutomationHost: vi.fn((_registration: BrowserHostRegistration, execute: typeof executeRequest) => {
        executeRequest = execute
        return vi.fn()
      }),
      reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state,
    } as never
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', panelVisible: false }))
      await Promise.resolve()
    })

    const openRequest = (requestId: string): BrowserAutomationRequest => ({
      requestId, sessionAgentId: 'session-1', profileId: 'profile-1', tabId: null,
      hostId: 'host-1', hostGeneration: 1, deadlineAt: new Date(Date.now() + 30_000).toISOString(), artifactDirectory: null,
      operation: 'open', input: { show: false, reuseExistingTab: false },
    })
    const readyLatestWebview = async () => {
      for (let attempt = 0; attempt < 20 && container.querySelectorAll('webview').length === 0; attempt += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      }
      expect(container.querySelectorAll('webview')).toHaveLength(1)
      const webview = container.querySelector('webview') as HTMLElement & { getWebContentsId(): number }
      Object.defineProperty(webview, 'getWebContentsId', { configurable: true, value: () => 101 })
      await act(async () => {
        webview.dispatchEvent(new Event('dom-ready'))
        await Promise.resolve()
      })
    }

    invoke.mockResolvedValueOnce({
      requestId: 'failed', sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'provisional', hostId: 'host-1', hostGeneration: 1,
      operation: 'open', ok: false, error: { code: 'navigation-failed', message: 'failed', retryable: true }, elapsedMs: 1,
    } satisfies BrowserAutomationResponse)
    let failed!: Promise<BrowserAutomationResponse>
    act(() => { failed = executeRequest!(openRequest('failed')) })
    await readyLatestWebview()
    await act(async () => { await expect(failed).resolves.toMatchObject({ ok: false }) })
    expect(container.querySelectorAll('webview')).toHaveLength(0)

    invoke.mockRejectedValueOnce(new Error('IPC failed'))
    let exceptional!: Promise<BrowserAutomationResponse>
    act(() => { exceptional = executeRequest!(openRequest('exceptional')) })
    const exceptionalOutcome = exceptional.then(
      () => null,
      (error: unknown) => error,
    )
    await readyLatestWebview()
    await act(async () => { expect(await exceptionalOutcome).toEqual(new Error('IPC failed')) })
    expect(container.querySelectorAll('webview')).toHaveLength(0)
    expect(unregisterWebview).toHaveBeenCalledTimes(4)
    expect(registerWebview.mock.calls.every(([registration]) => registration.created === true)).toBe(true)
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
        navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), setZoom: vi.fn(), invoke: vi.fn(), onStateChanged: vi.fn(() => vi.fn()),
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
        navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), setZoom: vi.fn(), invoke: vi.fn(), onStateChanged: vi.fn((listener) => { stateChanged = listener; return () => undefined }),
      },
    }
    const hosted = session('session-1', 'profile-1', tab('tab-1', 'session-1', 'profile-1'))
    const state = {
      ...createInitialManagerWsState('session-1'),
      browserSessions: { 'session-1': hosted },
      browserHostHydrated: true,
      browserHost: {
        connected: true,
        hostId: 'host-test',
        hostGeneration: 1,
        focused: false,
        capabilities: null,
        connectedAt: new Date(0).toISOString(),
      },
    }
    reportBrowserHostState.mockImplementation(async () => ({
      hostId: state.browserHost.hostId!,
      hostGeneration: state.browserHost.hostGeneration!,
      status: 'processed',
      sessions: [{
        sessionAgentId: hosted.sessionAgentId,
        profileId: hosted.profileId,
        status: 'accepted',
        snapshot: { ...hosted, revision: 2, tabs: [{ ...hosted.tabs[0]!, title: 'Updated', loading: true }] },
      }],
    }))
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

  it('retains rapid updates, rebases conflicts, and retries only on a current reconnect generation', async () => {
    let stateChanged: ((tab: BrowserTabSnapshot) => void) | null = null
    window.electronBridge = {
      backendUrl: 'http://localhost', backendWsUrl: 'ws://localhost', getVersion: () => 'test', platform: 'darwin',
      browserAutomation: {
        capabilities: { supportedOperations: ['status'], playwrightVersion: '1.60.0', supportsRecording: true },
        getWebviewConfig: vi.fn(async (profileId) => ({ partition: `persist:forge-browser-${profileId}`, preloadUrl: 'file:///guest.js', webPreferences: 'sandbox=yes' })),
        registerWebview: vi.fn(), unregisterWebview: vi.fn(async () => undefined), setTabPresentation: vi.fn(async (_id, _visible, _viewport) => tab('unused', 'unused', 'unused')),
        navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), setZoom: vi.fn(), invoke: vi.fn(), onStateChanged: vi.fn((listener) => { stateChanged = listener; return () => undefined }),
      },
    }

    const hosted = session('session-1', 'profile-1', tab('tab-1', 'session-1', 'profile-1'))
    let currentState: ManagerWsState = {
      ...createInitialManagerWsState('session-1'),
      browserSessions: { 'session-1': hosted },
      browserHostHydrated: true,
      browserHost: {
        connected: true, hostId: 'pending-registration', hostGeneration: 1, focused: false,
        capabilities: null, connectedAt: new Date(0).toISOString(),
      },
    }
    const deferred: Array<{
      sessions: BrowserHostSessionStateReport[]
      resolve: (result: BrowserHostStateReportResult) => void
      reject: (error: Error) => void
    }> = []
    const reportBrowserHostState = vi.fn((sessions: BrowserHostSessionStateReport[]) =>
      new Promise<BrowserHostStateReportResult>((resolve, reject) => deferred.push({ sessions, resolve, reject })))
    const client = {
      registerBrowserAutomationHost: vi.fn((registration: BrowserHostRegistration) => {
        currentState = { ...currentState, browserHost: { ...currentState.browserHost, hostId: registration.hostId } }
        return vi.fn()
      }),
      reportBrowserHostState,
      setBrowserHostFocused: vi.fn(),
      getState: () => currentState,
    } as never
    const render = async () => {
      await act(async () => {
        root!.render(createElement(BrowserAutomationHost, {
          client, state: currentState, selectedSessionAgentId: 'session-1', panelVisible: currentState.browserSessions['session-1']?.panelVisible ?? false,
        }))
        await Promise.resolve()
      })
    }

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(BrowserAutomationHost, { client, state: currentState, selectedSessionAgentId: 'session-1', panelVisible: false }))
      await Promise.resolve(); await Promise.resolve()
    })
    const hostId = currentState.browserHost.hostId!

    const firstRuntime = { ...hosted.tabs[0]!, title: 'Runtime one', loading: true }
    await act(async () => {
      stateChanged?.(firstRuntime)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(1)

    const latestRuntime = { ...firstRuntime, title: 'Runtime latest', controller: 'agent' as const }
    ;(stateChanged as ((tab: BrowserTabSnapshot) => void) | null)?.(latestRuntime)
    const backendTab = { ...hosted.tabs[0]!, title: 'Backend canonical', createdAt: new Date(5).toISOString() }
    const secondTab = tab('tab-2', 'session-1', 'profile-1')
    const conflictedCanonical: BrowserSessionSnapshot = {
      ...hosted,
      tabs: [backendTab, secondTab],
      activeTabId: 'tab-2',
      defaultTabId: 'tab-2',
      panelVisible: true,
      recentActions: [{ id: 'action-1', operation: 'status', tabId: 'tab-2', status: 'succeeded', startedAt: new Date(0).toISOString() }],
      revision: 2,
    }
    currentState = { ...currentState, browserSessions: { 'session-1': conflictedCanonical } }
    await render()
    await act(async () => {
      deferred[0]!.resolve({
        hostId, hostGeneration: 1, status: 'processed',
        sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', status: 'revision-conflict', snapshot: conflictedCanonical }],
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(reportBrowserHostState).toHaveBeenCalledTimes(2)
    expect(deferred[1]!.sessions).toEqual([{
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      baseRevision: 2,
      tabs: [expect.objectContaining({ tabId: 'tab-1', title: 'Runtime latest', controller: 'agent', createdAt: backendTab.createdAt })],
    }])
    const acceptedCanonical: BrowserSessionSnapshot = {
      ...conflictedCanonical,
      tabs: [{ ...backendTab, title: 'Runtime latest', controller: 'agent' }, secondTab],
      revision: 3,
    }
    await act(async () => {
      deferred[1]!.resolve({
        hostId, hostGeneration: 1, status: 'processed',
        sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', status: 'accepted', snapshot: acceptedCanonical }],
      })
      await Promise.resolve()
    })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(2)

    const reconnectRuntime = { ...acceptedCanonical.tabs[0]!, title: 'After reconnect' }
    await act(async () => {
      ;(stateChanged as ((tab: BrowserTabSnapshot) => void) | null)?.(reconnectRuntime)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(3)
    currentState = {
      ...currentState,
      browserSessions: { 'session-1': acceptedCanonical },
      browserHostHydrated: false,
      browserHost: { connected: false, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null },
    }
    await render()
    await act(async () => {
      deferred[2]!.reject(new Error('disconnected'))
      await Promise.resolve()
    })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(3)

    currentState = {
      ...currentState,
      browserHostHydrated: true,
      browserHost: { ...currentState.browserHost, connected: true, hostId, hostGeneration: 2, connectedAt: new Date(1).toISOString() },
    }
    await render()
    await vi.waitFor(() => expect(reportBrowserHostState).toHaveBeenCalledTimes(4))
    expect(deferred[3]!.sessions[0]).toMatchObject({
      baseRevision: 3,
      tabs: [{ tabId: 'tab-1', title: 'After reconnect', controller: 'agent' }],
    })
    const reconnectedCanonical: BrowserSessionSnapshot = {
      ...acceptedCanonical,
      revision: 4,
      tabs: [reconnectRuntime, secondTab],
    }
    await act(async () => {
      deferred[3]!.resolve({
        hostId, hostGeneration: 2, status: 'processed',
        sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', status: 'accepted', snapshot: reconnectedCanonical }],
      })
      await Promise.resolve()
    })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(4)

    const boundedRuntime = { ...reconnectRuntime, title: 'Bounded retry' }
    await act(async () => {
      ;(stateChanged as ((tab: BrowserTabSnapshot) => void) | null)?.(boundedRuntime)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(5)
    for (let deferredIndex = 4; deferredIndex < 8; deferredIndex += 1) {
      const conflictSnapshot = { ...reconnectedCanonical, revision: deferredIndex + 1 }
      await act(async () => {
        deferred[deferredIndex]!.resolve({
          hostId, hostGeneration: 2, status: 'processed',
          sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', status: 'revision-conflict', snapshot: conflictSnapshot }],
        })
        await Promise.resolve()
      })
      if (deferredIndex < 7) {
        await vi.waitFor(() => expect(reportBrowserHostState).toHaveBeenCalledTimes(deferredIndex + 2))
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reportBrowserHostState).toHaveBeenCalledTimes(8)
  })
})
