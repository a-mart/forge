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
afterEach(() => { if (root) act(() => root?.unmount()); root = null; container.remove(); delete window.electronBridge; vi.useRealTimers() })

const now = new Date(0).toISOString()
function tab(tabId = 'tab-1'): BrowserTabSnapshot { return { tabId, sessionAgentId: 'session-1', profileId: 'profile-1', url: 'about:blank', title: tabId, lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now } }
function session(revision = 1, tabs = [tab()]): BrowserSessionSnapshot { return { schemaVersion: 1, sessionAgentId: 'session-1', profileId: 'profile-1', hostingState: 'hosted', tabs, activeTabId: tabs[0]?.tabId ?? null, defaultTabId: tabs[0]?.tabId ?? null, panelVisible: true, recentActions: [], revision, createdAt: now, updatedAt: new Date(revision).toISOString() } }

function installBridge() {
  const listeners: Array<(tab: BrowserTabSnapshot) => void> = []
  const reconcile = vi.fn(async () => ({ applied: true, tabCount: 1 }))
  const ensureProvisional = vi.fn(async ({ tab: value }: { tab: BrowserTabSnapshot }) => value)
  const commitProvisional = vi.fn(async () => undefined)
  const abortProvisional = vi.fn(async () => undefined)
  const invoke = vi.fn()
  const setTabPresentation = vi.fn(async (request: { tabId: string; visible: boolean; hostGeneration: number; sessionRevision: number; sequence: number }) => ({ applied: true, tab: { ...tab(request.tabId), hostKind: 'managed-electron' as const, physicalVisible: request.visible }, hostGeneration: request.hostGeneration, sessionRevision: request.sessionRevision, sequence: request.sequence }))
  const publish = vi.fn(async () => undefined)
  window.electronBridge = {
    windowRole: 'main', backendUrl: 'http://localhost', backendWsUrl: 'ws://localhost', getVersion: () => 'test', platform: 'darwin',
    browserAutomation: {
      capabilities: { supportedOperations: ['open', 'status'], playwrightVersion: '1.60.0', supportsRecording: true },
      reconcile, ensureProvisional, commitProvisional, abortProvisional, reportViewport: vi.fn(async () => undefined),
      setTabPresentation,
      captureScreenshot: vi.fn(async () => 'data:image/png;base64,a'), navigate: vi.fn(), history: vi.fn(), reload: vi.fn(), setZoom: vi.fn(), invoke,
      onStateChanged: vi.fn((listener) => { listeners.push(listener); return () => undefined }),
    },
    browserWorkspace: {
      capability: { popoutAvailable: true }, getSnapshot: vi.fn(), publish, popOut: vi.fn(async () => 'popped-out' as const), dock: vi.fn(async () => 'docked' as const), bringToFront: vi.fn(async () => undefined), reportViewport: vi.fn(), onProjection: vi.fn(() => () => undefined), onModeChanged: vi.fn(() => () => undefined), onFocusChanged: vi.fn(() => () => undefined),
    },
  }
  return { reconcile, ensureProvisional, commitProvisional, abortProvisional, invoke, listeners, setTabPresentation, publish }
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

  it('never projects or presents an external-only session to the Managed Browser lifecycle', async () => {
    const bridge = installBridge()
    const externalSession = {
      ...session(1, [{ ...tab(), hostKind: 'external-chrome' as const }]),
      hostKind: 'external-chrome' as const,
    }
    const state = {
      ...createInitialManagerWsState('session-1'),
      connected: true,
      browserSessions: { 'session-1': externalSession },
    }
    const client = { registerBrowserAutomationHost: vi.fn(() => vi.fn()), reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: true })); await Promise.resolve() })
    expect(bridge.reconcile).toHaveBeenCalledWith(expect.objectContaining({ sessions: [] }))
    expect(bridge.setTabPresentation).not.toHaveBeenCalled()
    expect(bridge.publish).toHaveBeenCalledWith(expect.objectContaining({
      sessionAgentId: null, profileId: null, snapshot: null, connected: false,
    }))
  })

  it('filters a same-id external tab from a mixed managed projection', async () => {
    const bridge = installBridge()
    const mixed = {
      ...session(1, [
        { ...tab('same'), hostKind: 'external-chrome' as const, title: 'external' },
        { ...tab('same'), hostKind: 'managed-electron' as const, title: 'managed' },
      ]),
      hostKind: 'managed-electron' as const,
    }
    const state = { ...createInitialManagerWsState('session-1'), browserSessions: { 'session-1': mixed } }
    const client = { registerBrowserAutomationHost: vi.fn(() => vi.fn()), reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: true })); await Promise.resolve() })
    expect(bridge.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      sessions: [expect.objectContaining({ tabs: [expect.objectContaining({ hostKind: 'managed-electron', title: 'managed' })] })],
    }))
    expect(bridge.setTabPresentation).toHaveBeenCalledTimes(1)
  })

  it('preserves the original open envelope for every provisional lifecycle failure and tears down provisional state', async () => {
    const bridge = installBridge()
    let execute: ((request: BrowserAutomationRequest) => Promise<unknown>) | null = null
    const state = createInitialManagerWsState('session-1')
    const client = { registerBrowserAutomationHost: vi.fn((_registration, handler) => { execute = handler; return vi.fn() }), reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: false })); await Promise.resolve() })

    for (const phase of ['ensure', 'invoke', 'commit', 'abort'] as const) {
      bridge.ensureProvisional.mockReset().mockImplementation(async ({ tab: value }: { tab: BrowserTabSnapshot }) => value)
      bridge.invoke.mockReset().mockImplementation(async (invoked: BrowserAutomationRequest) => ({ ...invoked, ok: true, result: { tab: tab(String(invoked.tabId)) }, elapsedMs: 1 }))
      bridge.commitProvisional.mockReset().mockResolvedValue(undefined)
      bridge.abortProvisional.mockReset().mockResolvedValue(undefined)
      const failure = Object.assign(new Error(`${phase} failed`), { code: 'execution-failed' })
      if (phase === 'ensure') bridge.ensureProvisional.mockRejectedValue(failure)
      if (phase === 'invoke') bridge.invoke.mockRejectedValue(failure)
      if (phase === 'commit') bridge.commitProvisional.mockRejectedValue(failure)
      if (phase === 'abort') {
        bridge.invoke.mockImplementation(async (invoked: BrowserAutomationRequest) => ({ ...invoked, ok: false, error: { code: 'navigation-failed', message: 'failed', retryable: true }, elapsedMs: 1 }))
        bridge.abortProvisional.mockRejectedValue(failure)
      }
      const request: Extract<BrowserAutomationRequest, { operation: 'open' }> = { requestId: `request-${phase}`, hostKind: 'managed-electron', sessionAgentId: 'session-1', profileId: 'profile-1', tabId: null, hostId: 'host', hostGeneration: 1, deadlineAt: new Date(Date.now() + 10_000).toISOString(), artifactDirectory: null, operation: 'open', input: { show: false, reuseExistingTab: false } }
      const response = await execute!(request)
      expect(response).toMatchObject({
        requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
        tabId: null, hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, ok: false,
      })
      expect(bridge.abortProvisional).toHaveBeenCalled()
    }
  })

  it('adopts an authoritative conflict snapshot, rebases host fields, and reports against the new base', async () => {
    vi.useFakeTimers()
    installBridge()
    const original = session()
    const canonicalCreatedAt = new Date(123).toISOString()
    const conflict = session(5, [{ ...tab(), createdAt: canonicalCreatedAt, title: 'backend-old-runtime' }])
    const state = { ...createInitialManagerWsState('session-1'), browserSessions: { 'session-1': original } }
    let registeredHostId: string | null = null
    const reportBrowserHostState = vi.fn()
      .mockImplementationOnce(async () => ({ hostId: registeredHostId, hostGeneration: 7, status: 'processed', sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', status: 'revision-conflict', snapshot: conflict }] }))
      .mockImplementationOnce(async () => ({ hostId: registeredHostId, hostGeneration: 7, status: 'processed', sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', status: 'accepted', snapshot: session(6) }] }))
    const client = {
      registerBrowserAutomationHost: vi.fn((registration: BrowserHostRegistration) => { registeredHostId = registration.hostId; return vi.fn() }),
      reportBrowserHostState,
      setBrowserHostFocused: vi.fn(),
      getState: () => ({ ...state, browserHost: { ...state.browserHost, connected: true, hostId: registeredHostId, hostGeneration: 7 } }),
    } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: true })); await Promise.resolve() })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(2)
    expect(reportBrowserHostState.mock.calls[0]?.[0]?.[0]).toMatchObject({ baseRevision: 1 })
    expect(reportBrowserHostState.mock.calls[1]?.[0]?.[0]).toMatchObject({
      baseRevision: 5,
      tabs: [expect.objectContaining({ createdAt: canonicalCreatedAt, title: 'tab-1', physicalVisible: true })],
    })
  })

  it('ceases unchanged conflicts and hard-caps advancing conflicts until new runtime state arrives', async () => {
    vi.useFakeTimers()
    const bridge = installBridge()
    const state = { ...createInitialManagerWsState('session-1'), browserSessions: { 'session-1': session() } }
    let registeredHostId: string | null = null
    let mode: 'unchanged' | 'advancing' | 'accepted' = 'unchanged'
    const reportBrowserHostState = vi.fn(async ([report]) => {
      const revision = mode === 'unchanged' ? 2 : report.baseRevision + 1
      return mode === 'accepted'
        ? { hostId: registeredHostId, hostGeneration: 9, status: 'processed', sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', status: 'accepted', snapshot: session(revision) }] }
        : { hostId: registeredHostId, hostGeneration: 9, status: 'processed', sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', status: 'revision-conflict', snapshot: session(revision) }] }
    })
    const client = {
      registerBrowserAutomationHost: vi.fn((registration: BrowserHostRegistration) => { registeredHostId = registration.hostId; return vi.fn() }),
      reportBrowserHostState, setBrowserHostFocused: vi.fn(),
      getState: () => ({ ...state, browserHost: { ...state.browserHost, connected: true, hostId: registeredHostId, hostGeneration: 9 } }),
    } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: true })); await Promise.resolve() })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(2)

    mode = 'advancing'
    act(() => bridge.listeners[0]?.({ ...tab(), title: 'new-runtime-1' }))
    await act(async () => { await vi.runAllTimersAsync() })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(5)
    mode = 'accepted'
    act(() => bridge.listeners[0]?.({ ...tab(), title: 'new-runtime-2' }))
    await act(async () => { await vi.runAllTimersAsync() })
    expect(reportBrowserHostState).toHaveBeenCalledTimes(6)
    expect(reportBrowserHostState.mock.calls[5]?.[0]?.[0]?.tabs[0]?.title).toBe('new-runtime-2')
  })

  it('acknowledges correlated lifecycle release only after the exact local lease release succeeds', async () => {
    installBridge()
    const releaseForLifecycle = vi.fn(async () => ({ ok: true as const, status: {
      coordinator: { state: 'online', authority: 'owned', auth: 'secure', registration: 'owned', trust: 'trusted', platform: 'darwin', canEnable: false, canDisable: true, canRepair: true, canRollback: false, canRemove: true, canTakeover: false, canReveal: true, setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', pathState: 'ready' } },
      instances: [{ extensionInstanceId: 'profile_a', chromeVersion: '125', payloadVersion: '1', connectedAt: now }], attachment: null,
    } }))
    window.electronBridge!.externalChrome = {
      releaseForLifecycle,
      localStatus: vi.fn(async () => ({ ok: true as const, status: {
        coordinator: { state: 'online', authority: 'owned', auth: 'secure', registration: 'owned', trust: 'trusted', platform: 'darwin', canEnable: false, canDisable: true, canRepair: true, canRollback: false, canRemove: true, canTakeover: false, canReveal: true, setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', pathState: 'ready' } },
        instances: [{ extensionInstanceId: 'profile_a', chromeVersion: '125', payloadVersion: '1', connectedAt: now }], attachment: null,
      } })),
    } as never
    const state = createInitialManagerWsState('session-1')
    let executeSecondary: ((request: BrowserAutomationRequest) => Promise<any>) | null = null
    const client = {
      registerBrowserAutomationHost: vi.fn(() => vi.fn()),
      registerSecondaryBrowserAutomationHost: vi.fn((_registration, handler) => { executeSecondary = handler; return vi.fn() }),
      reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state,
    } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: false })); await Promise.resolve() })
    const request = { requestId: 'external-chrome-release:prepare:archive:correlation-1', hostKind: 'external-chrome', sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'ext.profile_a.7', hostId: 'external-host', hostGeneration: 5, deadlineAt: new Date(Date.now() + 5_000).toISOString(), artifactDirectory: null, operation: 'status', input: { hostKind: 'external-chrome', tabId: 'ext.profile_a.7', externalChromeLifecycleRelease: { phase: 'prepare', releaseId: 'release-1', reason: 'archive', originalHostId: 'external-host', originalHostGeneration: 5 } } } as BrowserAutomationRequest
    const response = await executeSecondary!(request)
    expect(releaseForLifecycle).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId, hostGeneration: 5, phase: 'prepare', releaseId: 'release-1', reason: 'archive', tabId: 'ext.profile_a.7' }))
    expect(response).toMatchObject({ requestId: request.requestId, hostGeneration: 5, operation: 'status', ok: true, result: { externalChromeLifecycleRelease: { phase: 'prepare', releaseId: 'release-1' } } })
  })

  it('does not advertise External Chrome when coordinator setup exists but no extension runtime is ready', async () => {
    installBridge()
    window.electronBridge!.externalChrome = { localStatus: vi.fn(async () => ({ ok: true as const, status: {
      coordinator: { state: 'online', authority: 'owned', auth: 'secure', registration: 'owned', trust: 'trusted', platform: 'darwin', canEnable: false, canDisable: true, canRepair: true, canRollback: false, canRemove: true, canTakeover: false, canReveal: true, setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', pathState: 'ready' } },
      instances: [], attachment: null,
    } })) } as never
    const state = createInitialManagerWsState('session-1')
    const registerSecondaryBrowserAutomationHost = vi.fn()
    const client = { registerBrowserAutomationHost: vi.fn(() => vi.fn()), registerSecondaryBrowserAutomationHost, reportBrowserHostState: vi.fn(), setBrowserHostFocused: vi.fn(), getState: () => state } as never
    await act(async () => { root = createRoot(container); root.render(createElement(BrowserAutomationHost, { client, state, selectedSessionAgentId: 'session-1', selectedProfileId: 'profile-1', panelVisible: false })); await Promise.resolve(); await Promise.resolve() })
    expect(registerSecondaryBrowserAutomationHost).not.toHaveBeenCalled()
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
