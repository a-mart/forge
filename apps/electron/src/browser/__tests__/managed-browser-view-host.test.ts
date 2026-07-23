import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => {
  const createdViews: Array<{ webContents: unknown; bounds: { x: number; y: number; width: number; height: number }; visible: boolean; setBounds: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn> }> = []
  let nextId = 100
  class FakeContents {
    id = ++nextId; debugger = {}; ipc = { on: vi.fn(), off: vi.fn() }
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() }
    listeners = new Map<string, (...args: unknown[]) => void>(); destroyed = false
    isDestroyed = () => this.destroyed; isLoading = () => false; getURL = () => 'about:blank'; getTitle = () => 'tab'; getZoomFactor = () => 1
    loadURL = vi.fn(async () => undefined); reload = vi.fn(); reloadIgnoringCache = vi.fn(); setZoomFactor = vi.fn(); capturePage = vi.fn(); send = vi.fn(); focus = vi.fn()
    close = vi.fn(() => { this.destroyed = true }); setWindowOpenHandler = vi.fn()
    on = vi.fn((event: string, listener: (...args: unknown[]) => void) => this.listeners.set(event, listener)); once = this.on
    off = vi.fn((event: string) => this.listeners.delete(event))
  }
  class FakeView {
    webContents = new FakeContents(); bounds = { x: 0, y: 0, width: 0, height: 0 }; visible = false
    constructor() { createdViews.push(this) }
    setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds }); setVisible = vi.fn((visible: boolean) => { this.visible = visible })
  }
  return { createdViews, FakeView }
})
const createdViews = fakes.createdViews
type FakeView = InstanceType<typeof fakes.FakeView>
vi.mock('electron', () => ({ WebContentsView: fakes.FakeView }))

import type { BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'
import { ManagedBrowserViewHost } from '../managed-browser-view-host.js'

const now = new Date(0).toISOString()
function tab(id: string): BrowserTabSnapshot { return { tabId: id, sessionAgentId: 'session', profileId: 'profile', url: 'about:blank', title: id, lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now } }
function session(tabs: BrowserTabSnapshot[], hostingState: 'hosted' | 'unhosted' = 'hosted'): BrowserSessionSnapshot { return { schemaVersion: 1, sessionAgentId: 'session', profileId: 'profile', hostingState, tabs, activeTabId: tabs[0]?.tabId ?? null, defaultTabId: tabs[0]?.tabId ?? null, panelVisible: true, recentActions: [], revision: 1, createdAt: now, updatedAt: now } }
function fakeWindow() {
  const children = new Set<FakeView>()
  return {
    children,
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    webContents: { getZoomFactor: () => 1 },
    contentView: { addChildView: vi.fn((view: FakeView) => children.add(view)), removeChildView: vi.fn((view: FakeView) => children.delete(view)) },
  }
}
function makeHost() {
  const manager = {
    registerTabWebContents: vi.fn(({ tab: value }) => value), unregisterTabWebContents: vi.fn(), setTabPresentation: vi.fn((request) => ({ applied: true, tab: { ...tab(request.tabId), physicalVisible: request.visible }, hostGeneration: request.hostGeneration, sessionRevision: request.sessionRevision, sequence: request.sequence })),
    captureScreenshot: vi.fn(), markGuestCrashed: vi.fn(), destroy: vi.fn(async () => undefined),
  }
  const host = new ManagedBrowserViewHost({ manager: manager as never, sessions: { getSession: vi.fn(() => ({})) } as never, guestPreloadPath: '/guest.js', capabilityEnabled: true })
  return { host, manager }
}

beforeEach(() => { createdViews.length = 0 })
describe('ManagedBrowserViewHost', () => {
  it('creates exactly one runtime per canonical tab and ignores stale reconciliation', async () => {
    const { host, manager } = makeHost()
    const input = { controllerInstanceId: 'controller', hostGeneration: 4, updateSequence: 1, workspaceEpoch: 9, sessions: [session([tab('one'), tab('two')])] }
    await host.reconcile(input)
    await host.reconcile(input)
    expect(createdViews).toHaveLength(2)
    expect(manager.registerTabWebContents).toHaveBeenCalledTimes(2)
    expect(host.tabCount).toBe(2)
  })

  it('reconciles, presents, and reparents the identical view without stealing toolbar focus', async () => {
    const { host } = makeHost()
    await host.reconcile({ controllerInstanceId: 'c', hostGeneration: 1, updateSequence: 1, workspaceEpoch: 2, sessions: [session([tab('one'), tab('two')])] })
    const main = fakeWindow(); const popout = fakeWindow()
    const metrics = { workspaceEpoch: 2, rect: { x: 10, y: 20, width: 600, height: 500 }, innerWidth: 1000, innerHeight: 800 }
    host.setPresentationTarget('docked', main as never, metrics)
    host.setPresentationTarget('popout', popout as never, metrics)
    await host.present({ tabId: 'one', visible: true, viewportSetting: { mode: 'fill' }, renderedViewport: { width: 1, height: 1, deviceScaleFactor: 1 }, hostGeneration: 1, sessionRevision: 1, sequence: 1, workspaceEpoch: 2 })
    const identity = createdViews[0]
    expect(main.children).toEqual(new Set([identity]))
    await host.transferOwner('popout', 2)
    await host.reconcile({ controllerInstanceId: 'c', hostGeneration: 1, updateSequence: 2, workspaceEpoch: 2, sessions: [session([{ ...tab('one'), title: 'metadata changed' }, tab('two')])] })
    await host.present({ tabId: 'one', visible: true, viewportSetting: { mode: 'fill' }, renderedViewport: { width: 1, height: 1, deviceScaleFactor: 1 }, hostGeneration: 1, sessionRevision: 2, sequence: 2, workspaceEpoch: 2 })
    expect(main.children.size).toBe(0)
    expect(popout.children).toEqual(new Set([identity]))
    expect(createdViews).toHaveLength(2)
    expect((identity.webContents as { focus: ReturnType<typeof vi.fn> }).focus).not.toHaveBeenCalled()
  })

  it('makes canonical removal win over queued presentation and teardown repeats', async () => {
    const { host, manager } = makeHost()
    await host.reconcile({ controllerInstanceId: 'c', hostGeneration: 1, updateSequence: 1, workspaceEpoch: 3, sessions: [session([tab('one')])] })
    await host.reconcile({ controllerInstanceId: 'c', hostGeneration: 1, updateSequence: 2, workspaceEpoch: 3, sessions: [session([], 'unhosted')] })
    await expect(host.present({ tabId: 'one', visible: true, renderedViewport: { width: 1, height: 1, deviceScaleFactor: 1 }, hostGeneration: 1, sessionRevision: 2, sequence: 2, workspaceEpoch: 3 })).rejects.toMatchObject({ code: 'tab-not-found' })
    await host.destroy(); await host.destroy()
    expect(manager.unregisterTabWebContents).toHaveBeenCalledOnce()
    expect(manager.destroy).toHaveBeenCalledOnce()
  })
})
