/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAutomationRequest, BrowserHostLifecycleRequest, BrowserHostRegistration, BrowserTabSnapshot } from '@forge/protocol'
import { createInitialManagerWsState } from '@/lib/ws-state'
import { BrowserAutomationHost } from './BrowserAutomationHost'
import { projectRuntimeBrowserTabState } from './browser-runtime-state'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
let registered: BrowserHostRegistration | null
let execute: ((request: BrowserAutomationRequest) => Promise<unknown>) | null
let lifecycle: ((request: BrowserHostLifecycleRequest) => Promise<unknown>) | null
const invoke = vi.fn()
const invokeLifecycle = vi.fn()
const ensureProvisional = vi.fn()
let stateChanged: ((tab: BrowserTabSnapshot) => void) | null

beforeEach(() => {
  registered = null; execute = null; lifecycle = null; stateChanged = null
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  window.electronBridge = {
    windowRole: 'main', platform: 'darwin', backendWsUrl: 'ws://local',
    browserAutomation: {
      capabilities: { supportedOperations: ['status'], playwrightVersion: '1.60.0', supportsRecording: true },
      reconcile: vi.fn(async () => ({ applied: true, tabCount: 0 })), ensureProvisional, commitProvisional: vi.fn(), abortProvisional: vi.fn(),
      reportViewport: vi.fn(), setTabPresentation: vi.fn(async () => { throw new Error('not presented in this fixture') }), captureScreenshot: vi.fn(), navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), setZoom: vi.fn(),
      invoke, invokeLifecycle, reveal: vi.fn(), takeControl: vi.fn(), onStateChanged: vi.fn((listener) => { stateChanged = listener; return vi.fn() }),
    },
  }
})
afterEach(() => { act(() => root.unmount()); container.remove(); delete window.electronBridge; vi.clearAllMocks() })

function render(onRuntimeTabStateChanged?: (tab: BrowserTabSnapshot) => void) {
  const state = createInitialManagerWsState('session-1')
  const now = new Date(0).toISOString()
  const tab: BrowserTabSnapshot = {
    targetAffinity: 'managed-electron', tabId: 'managed-1', sessionAgentId: 'session-1', profileId: 'profile-1',
    url: 'about:blank', title: 'New tab', lifecycle: 'ready', loading: false, live: true, canGoBack: false,
    canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null,
    viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now,
  }
  const inactive = { ...tab, tabId: 'managed-2', url: 'https://inactive.test/old', title: 'Inactive old' }
  state.browserSessions['session-1'] = {
    schemaVersion: 2, sessionAgentId: 'session-1', profileId: 'profile-1', hostingState: 'hosted', tabs: [tab, inactive],
    activeTabId: tab.tabId, defaultTabId: tab.tabId, panelVisible: true, recentActions: [], revision: 1,
    createdAt: now, updatedAt: now,
  }
  const client = {
    registerBrowserAutomationHost: vi.fn((registration, handler, lifecycleHandler) => {
      registered = registration; execute = handler; lifecycle = lifecycleHandler; return vi.fn()
    }),
    getState: () => state,
  }
  act(() => root.render(createElement(BrowserAutomationHost, { client: client as never, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: true, onRuntimeTabStateChanged })))
  return { state, tab, inactive }
}

const request: BrowserAutomationRequest = {
  requestId: 'request-1', sessionAgentId: 'session-1', profileId: 'profile-1', tabId: null,
  hostId: 'host-1', hostGeneration: 1, deadlineAt: new Date(Date.now() + 10_000).toISOString(), artifactDirectory: null,
  operation: 'open', input: { show: true, reuseExistingTab: false },
}
const lifecycleRequest: BrowserHostLifecycleRequest = {
  requestId: 'lifecycle-1', sessionAgentId: 'session-1', profileId: 'profile-1', hostId: 'host-1', hostGeneration: 1,
  kind: 'turn-ended', turnId: 'turn-1',
}

describe('BrowserAutomationHost', () => {
  it('registers one protocol-v2 automatic host', () => {
    render()
    expect(registered?.capabilities.protocolVersions).toEqual({ minimum: 2, maximum: 2 })
    expect(registered?.capabilities.supportedOperations).toContain('recordingStop')
  })

  it('forwards allocation to main without renderer provisional interception', async () => {
    invoke.mockResolvedValue({ ...request, ok: true, result: { tab: null }, elapsedMs: 0 })
    render()
    await act(async () => { await execute?.(request) })
    expect(invoke).toHaveBeenCalledWith(request)
    expect(ensureProvisional).not.toHaveBeenCalled()
  })

  it('forwards lifecycle cleanup to the automatic main host', async () => {
    invokeLifecycle.mockResolvedValue({ ...lifecycleRequest, ok: true })
    render()
    await act(async () => { await lifecycle?.(lifecycleRequest) })
    expect(invokeLifecycle).toHaveBeenCalledWith(lifecycleRequest)
  })

  it('projects active and inactive main-process metadata immediately without stealing selection', () => {
    let projected = createInitialManagerWsState('session-1')
    const onRuntimeTabStateChanged = vi.fn((updated: BrowserTabSnapshot) => { projected = projectRuntimeBrowserTabState(projected, updated) })
    const { state, tab, inactive } = render(onRuntimeTabStateChanged)
    projected = state
    const activeUpdate = { ...tab, url: 'https://active.test/live', title: 'Active live', updatedAt: new Date(1).toISOString() }
    const inactiveUpdate = { ...inactive, url: 'https://inactive.test/live', title: 'Inactive live', updatedAt: new Date(2).toISOString() }
    act(() => stateChanged?.(activeUpdate))
    act(() => stateChanged?.(inactiveUpdate))
    expect(onRuntimeTabStateChanged).toHaveBeenCalledWith(activeUpdate)
    expect(onRuntimeTabStateChanged).toHaveBeenCalledWith(inactiveUpdate)
    expect(projected.browserSessions['session-1']).toMatchObject({
      activeTabId: tab.tabId,
      tabs: [
        { tabId: tab.tabId, url: 'https://active.test/live', title: 'Active live' },
        { tabId: inactive.tabId, url: 'https://inactive.test/live', title: 'Inactive live' },
      ],
    })
  })
})
