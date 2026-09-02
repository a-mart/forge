import { EventEmitter } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAutomationRequest, BrowserTabSnapshot } from '@forge/protocol'
import {
  BrowserAutomationManager,
  normalizeBrowserUrl,
  resolveApprovedArtifactDirectory,
  type BrowserDebuggerLike,
  type BrowserImageLike,
  type BrowserWebContentsLike,
} from '../browser-automation-manager.js'
import { BROWSER_GUEST_HUMAN_INPUT_CHANNEL } from '../browser-bridge-contract.js'

class FakeImage implements BrowserImageLike {
  constructor(private readonly width = 1_600, private readonly height = 900) {}
  isEmpty(): boolean { return false }
  getSize(): { width: number; height: number } { return { width: this.width, height: this.height } }
  resize(options: { width: number }): BrowserImageLike { return new FakeImage(options.width, Math.round(this.height * options.width / this.width)) }
  toPNG(): Buffer { return Buffer.from('89504e470d0a1a0a', 'hex') }
}

class FakeDebugger extends EventEmitter implements BrowserDebuggerLike {
  attached = false
  activeInput = 0
  maximumActiveInput = 0
  waitMatches = true
  keyDelivery = { keydown: 1, keyup: 1, input: 0, editable: false, defaultPrevented: false, valueChanged: false }
  hangLocator = false
  locatorResolvers: Array<(value: unknown) => void> = []
  onMousePressed: ((params: Record<string, unknown>) => void) | null = null
  hangCaptureOnce = false
  viewport = { width: 800, height: 600, deviceScaleFactor: 2 }
  commands: string[] = []
  commandCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  isAttached(): boolean { return this.attached }
  override on(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): this { return super.on(event, listener) }
  off(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): this { return super.off(event, listener) }
  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push(method)
    this.commandCalls.push({ method, params })
    if (method === 'Input.dispatchMouseEvent') {
      this.activeInput += 1
      this.maximumActiveInput = Math.max(this.maximumActiveInput, this.activeInput)
      if (params.type === 'mousePressed') this.onMousePressed?.(params)
      await new Promise((resolve) => setTimeout(resolve, 10))
      this.activeInput -= 1
      return {}
    }
    if (method === 'Accessibility.getFullAXTree') return { nodes: Array.from({ length: 250 }, (_, index) => ({ nodeId: String(index), role: { value: 'button' }, name: { value: `Button ${index}` } })) }
    if (method === 'Page.captureScreenshot') {
      if (this.hangCaptureOnce) { this.hangCaptureOnce = false; return new Promise(() => undefined) }
      return { data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') }
    }
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params.expression ?? '')
    if (this.hangLocator && (expression.includes('rect.left+rect.width/2') || expression.includes('notEditable'))) {
      return new Promise((resolve) => this.locatorResolvers.push(resolve))
    }
    const value = (() => {
      if (expression === 'document.readyState') return 'complete'
      if (expression.includes('window.innerWidth')) return this.viewport
      if (expression.includes('Boolean(globalThis.__forgePlaywrightInjected)')) return true
      if (expression.includes('interactiveElements')) return {
        url: 'http://127.0.0.1:3000/fixture', title: 'Fixture', loading: false, visibleText: 'Fixture text',
        interactiveElements: [{ tag: 'button', role: 'button', name: 'Increment', selector: '#increment', x: 10, y: 20, width: 80, height: 30 }],
      }
      if (expression.includes('rect.left+rect.width/2')) return { x: 50, y: 35 }
      if (expression.includes('notEditable')) return { ok: true }
      if (expression.includes('target.scrollBy')) return { scrollX: 0, scrollY: 100 }
      if (expression.includes('selectorMatched')) return { matched: this.waitMatches }
      if (expression.includes('const holder=globalThis.__forgeKeyDeliveryProbe')) return this.keyDelivery
      if (expression.includes('Promise.resolve')) return { ok: true }
      return true
    })()
    return { result: { type: typeof value === 'object' ? 'object' : typeof value, value } }
  }
}

class FakeWebContents extends EventEmitter implements BrowserWebContentsLike {
  private readonly debuggerValue = new FakeDebugger()
  private readonly ipcValue = new EventEmitter()
  throwOnDestroyedAccess = false
  get debugger(): FakeDebugger {
    if (this.destroyed && this.throwOnDestroyedAccess) throw new TypeError('Object has been destroyed')
    return this.debuggerValue
  }
  get ipc(): EventEmitter {
    if (this.destroyed && this.throwOnDestroyedAccess) throw new TypeError('Object has been destroyed')
    return this.ipcValue
  }
  canGoBack = false
  canGoForward = false
  historyActions: string[] = []
  readonly navigationHistory = {
    canGoBack: () => this.canGoBack,
    canGoForward: () => this.canGoForward,
    goBack: () => { this.historyActions.push('back') },
    goForward: () => { this.historyActions.push('forward') },
  }
  destroyed = false
  loading = false
  url = 'about:blank'
  title = 'Fixture'
  zoom = 1
  loadURLImplementation: ((url: string) => Promise<void>) | null = null
  constructor(readonly id: number) { super() }
  isDestroyed(): boolean { return this.destroyed }
  isLoading(): boolean { return this.loading }
  getURL(): string { return this.url }
  getTitle(): string { return this.title }
  getZoomFactor(): number { return this.zoom }
  async loadURL(url: string): Promise<void> {
    if (this.loadURLImplementation) return this.loadURLImplementation(url)
    this.url = url
    this.loading = true
    this.emit('did-start-loading')
    this.emit('did-navigate')
    this.emit('dom-ready')
    this.loading = false
    this.emit('did-finish-load')
    this.emit('did-stop-loading')
  }
  reloads: string[] = []
  syntheticSequence: string | undefined
  nativeCaptures = 0
  async capturePage(): Promise<BrowserImageLike> { this.nativeCaptures += 1; return new FakeImage() }
  send(channel: string, value: unknown): void {
    if (channel !== 'forge:browser-guest-synthetic-input') return
    const sequence = value && typeof value === 'object' ? (value as { sequence?: unknown }).sequence : undefined
    this.syntheticSequence = typeof sequence === 'string' ? sequence : undefined
    if (this.syntheticSequence) this.ipcValue.emit(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {}, { kind: 'synthetic-ready', sequence: this.syntheticSequence })
  }
  reload(): void { this.reloads.push('normal') }
  reloadIgnoringCache(): void { this.reloads.push('hard') }
  setZoomFactor(factor: number): void { this.zoom = factor }
  focusCalls = 0
  focus(): void { this.focusCalls += 1 }
  close(): void { this.destroyed = true; this.emit('destroyed') }
  setWindowOpenHandler(): void {}
}

const managers: BrowserAutomationManager[] = []
let requestSequence = 0

function tabSnapshot(tabId = 'tab-1', sessionAgentId = 'session-1', profileId = 'profile-1'): BrowserTabSnapshot {
  const now = new Date(0).toISOString()
  return {
    targetAffinity: 'managed-electron', tabId, sessionAgentId, profileId, url: 'about:blank', title: '', lifecycle: 'ready', loading: false, live: false,
    canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null,
    viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now,
  }
}

async function setup(
  created = false,
  options: Pick<ConstructorParameters<typeof BrowserAutomationManager>[0], 'writeArtifactFile' | 'sendToRenderer' | 'now'> = {},
): Promise<{ manager: BrowserAutomationManager; webview: FakeWebContents; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-browser-manager-'))
  const manager = new BrowserAutomationManager({ approvedDataRoot: root, sendToRenderer: vi.fn(), ...options })
  const webview = new FakeWebContents(101)
  manager.registerTabWebContents({ tab: tabSnapshot(), visible: false, created }, webview)
  manager.setTabPresentation({ tabId: 'tab-1', visible: true, viewportSetting: { mode: 'fill' }, renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 }, hostGeneration: 1, sessionRevision: 1, sequence: 1 })
  managers.push(manager)
  return { manager, webview, root }
}

function navigationListenerCounts(webview: FakeWebContents): Record<string, number> {
  return {
    domReady: webview.listenerCount('dom-ready'),
    didFinishLoad: webview.listenerCount('did-finish-load'),
    didFailLoad: webview.listenerCount('did-fail-load'),
    destroyed: webview.listenerCount('destroyed'),
  }
}

function request(operation: BrowserAutomationRequest['operation'], input: Record<string, unknown>, tabId: string | null = 'tab-1', overrides: Partial<BrowserAutomationRequest> = {}): BrowserAutomationRequest {
  return {
    requestId: `request-${++requestSequence}`, sessionAgentId: 'session-1', profileId: 'profile-1', tabId,
    hostId: 'host-1', hostGeneration: 1, deadlineAt: new Date(Date.now() + 30_000).toISOString(), artifactDirectory: null,
    operation, input, ...overrides,
  } as BrowserAutomationRequest
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.destroy()))
  vi.useRealTimers()
})

describe('BrowserAutomationManager', () => {
  it('normalizes only blank and HTTP(S) browser URLs', () => {
    expect(normalizeBrowserUrl('localhost:3000/path')).toBe('http://localhost:3000/path')
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrl('')).toBe('about:blank')
    expect(() => normalizeBrowserUrl('file:///tmp/a')).toThrow(/HTTP or HTTPS/)
  })

  it('executes the non-recording operation set against a deterministic webContents fixture', async () => {
    const { manager } = await setup()
    const operations: BrowserAutomationRequest[] = [
      request('status', {}, null), request('open', { url: 'localhost:3000/fixture', show: true, reuseExistingTab: true }),
      request('navigate', { url: 'http://127.0.0.1:3000/fixture', readiness: 'load', timeoutMs: 2_000 }),
      request('resize', { mode: 'freeform', width: 800, height: 600, timeoutMs: 2_000 }), request('snapshot', {}),
      request('click', { locator: "role=button[name='Increment']", timeoutMs: 2_000 }),
      request('type', { selector: '#message', text: 'typed', clear: true, timeoutMs: 2_000 }),
      request('press', { key: 'Enter', modifiers: [] }), request('scroll', { deltaY: 100 }),
      request('evaluate', { expression: 'Promise.resolve({ok:true})', awaitPromise: true, returnByValue: true }),
      request('waitFor', { text: 'Fixture', timeoutMs: 2_000 }),
    ]
    const responses = []
    for (const operation of operations) responses.push(await manager.execute(operation))
    expect(responses.filter((response) => !response.ok)).toEqual([])
    const snapshot = responses[4]
    expect(snapshot?.ok && snapshot.operation === 'snapshot' ? snapshot.result : null).toMatchObject({
      visibleText: 'Fixture text', viewport: { width: 800, height: 600 }, screenshot: { mimeType: 'image/png', width: 800, height: 600 },
    })
  })

  it('uses non-gesture evaluation and enables CDP domains only when attaching the debugger', async () => {
    const { manager, webview } = await setup()
    const expression = 'Promise.resolve({ok:true})'
    await expect(manager.execute(request('evaluate', { expression, awaitPromise: true, returnByValue: true })))
      .resolves.toMatchObject({ ok: true, result: { value: { ok: true } } })
    await expect(manager.execute(request('snapshot', {}))).resolves.toMatchObject({ ok: true })
    await expect(manager.execute(request('click', { x: 10, y: 10, timeoutMs: 2_000 }))).resolves.toMatchObject({ ok: true })
    const recordingStart = request('recordingStart', {}) as BrowserAutomationRequest & { operation: 'recordingStart' }
    await manager.prepareRecording(recordingStart)
    await expect(manager.execute(recordingStart)).resolves.toMatchObject({ ok: true })

    const evaluations = webview.debugger.commandCalls.filter(({ method }) => method === 'Runtime.evaluate')
    expect(evaluations).not.toHaveLength(0)
    expect(evaluations.every(({ params }) => params.userGesture === false)).toBe(true)
    expect(evaluations).toContainEqual({
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true, userGesture: false },
    })
    expect(webview.debugger.commands.filter((method) => method === 'Runtime.enable')).toHaveLength(1)
    expect(webview.debugger.commands.filter((method) => method === 'Accessibility.enable')).toHaveLength(1)
    expect(webview.debugger.commands.filter((method) => method === 'Page.enable')).toHaveLength(1)
    expect(webview.debugger.commands).toContain('Input.setIgnoreInputEvents')
  })

  it('fails snapshot capture when the measured viewport is below the 8px minimum', async () => {
    const { manager, webview } = await setup()
    webview.debugger.viewport = { width: 1, height: 1, deviceScaleFactor: 1 }
    await expect(manager.execute(request('snapshot', {}))).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'execution-failed',
        retryable: true,
        message: 'Browser snapshot viewport 1×1 is below the 8px capture minimum',
        details: { width: 1, height: 1 },
      },
    })
    expect(webview.debugger.commands).not.toContain('Page.captureScreenshot')
  })

  it('projects guest navigation and title metadata without presentation or reselection', async () => {
    const sendToRenderer = vi.fn()
    const { webview } = await setup(false, { sendToRenderer })
    sendToRenderer.mockClear()

    webview.url = 'https://active.test/live'
    webview.title = 'Active live'
    webview.emit('did-navigate')
    expect(sendToRenderer).toHaveBeenLastCalledWith('forge:browser-state-changed', expect.objectContaining({
      tabId: 'tab-1', url: 'https://active.test/live', title: 'Active live',
    }))

    webview.title = 'Renamed live'
    webview.emit('page-title-updated')
    expect(sendToRenderer).toHaveBeenLastCalledWith('forge:browser-state-changed', expect.objectContaining({
      tabId: 'tab-1', url: 'https://active.test/live', title: 'Renamed live',
    }))
  })

  it('resolves none before DOMContentLoaded before load and removes readiness listeners', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const fixtures = await Promise.all([setup(), setup(), setup()])
    const configureNavigation = (webview: FakeWebContents): void => {
      webview.loadURLImplementation = (url) => new Promise<void>((resolve) => {
        webview.url = url
        webview.loading = true
        webview.emit('did-start-loading')
        setTimeout(() => webview.emit('dom-ready'), 100)
        setTimeout(() => {
          webview.loading = false
          webview.emit('did-finish-load')
          webview.emit('did-stop-loading')
          resolve()
        }, 200)
      })
    }
    for (const { webview } of fixtures) configureNavigation(webview)
    const baselines = fixtures.map(({ webview }) => navigationListenerCounts(webview))
    const completedAt: Partial<Record<'none' | 'domContentLoaded' | 'load', number>> = {}
    const readiness = ['none', 'domContentLoaded', 'load'] as const
    const pending = readiness.map((mode, index) => fixtures[index]!.manager.execute(
      request('navigate', { url: `http://127.0.0.1:3000/${mode}`, readiness: mode, timeoutMs: 1_000 }),
    ).then((response) => {
      completedAt[mode] = Date.now()
      return response
    }))

    await vi.advanceTimersByTimeAsync(0)
    expect(completedAt).toEqual({ none: 0 })
    await vi.advanceTimersByTimeAsync(99)
    expect(completedAt).toEqual({ none: 0 })
    await vi.advanceTimersByTimeAsync(1)
    expect(completedAt).toEqual({ none: 0, domContentLoaded: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(completedAt).toEqual({ none: 0, domContentLoaded: 100, load: 200 })
    expect((await Promise.all(pending)).every((response) => response.ok)).toBe(true)
    expect(fixtures.map(({ webview }) => navigationListenerCounts(webview))).toEqual(baselines)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses one navigation deadline instead of starting a second readiness timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { manager, webview } = await setup()
    const baseline = navigationListenerCounts(webview)
    webview.loadURLImplementation = (url) => new Promise<void>((resolve) => {
      webview.url = url
      webview.loading = true
      setTimeout(resolve, 75)
    })
    let settled = false
    const pending = manager.execute(request('navigate', {
      url: 'http://127.0.0.1:3000/slow-dom', readiness: 'domContentLoaded', timeoutMs: 100,
    })).then((response) => { settled = true; return response })

    await vi.advanceTimersByTimeAsync(99)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'timeout' }, elapsedMs: 100 })
    expect(navigationListenerCounts(webview)).toEqual(baseline)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans navigation waits on failure, tab destruction, and human interruption', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const failed = await setup()
    const failedBaseline = navigationListenerCounts(failed.webview)
    failed.webview.loadURLImplementation = async (url) => { failed.webview.url = url; await new Promise<void>(() => undefined) }
    const failedResponse = failed.manager.execute(request('navigate', { url: 'http://127.0.0.1:3000/fail', readiness: 'load', timeoutMs: 1_000 }))
    await vi.advanceTimersByTimeAsync(0)
    failed.webview.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', failed.webview.url, true)
    await expect(failedResponse).resolves.toMatchObject({ ok: false, error: { code: 'navigation-failed' } })
    expect(navigationListenerCounts(failed.webview)).toEqual(failedBaseline)
    expect(vi.getTimerCount()).toBe(0)

    const destroyed = await setup()
    destroyed.webview.loadURLImplementation = async (url) => { destroyed.webview.url = url; await new Promise<void>(() => undefined) }
    const destroyedResponse = destroyed.manager.execute(request('navigate', { url: 'http://127.0.0.1:3000/destroy', readiness: 'load', timeoutMs: 1_000 }))
    await vi.advanceTimersByTimeAsync(0)
    destroyed.webview.close()
    await expect(destroyedResponse).resolves.toMatchObject({ ok: false, error: { code: 'tab-not-found' } })
    // Electron has already destroyed the guest, so permanent host listeners
    // cannot be dereferenced/removed; operation-local readiness listeners are gone.
    expect(navigationListenerCounts(destroyed.webview)).toEqual({ domReady: 0, didFinishLoad: 0, didFailLoad: 1, destroyed: 1 })
    expect(vi.getTimerCount()).toBe(0)

    const interrupted = await setup()
    const interruptedBaseline = navigationListenerCounts(interrupted.webview)
    interrupted.webview.loadURLImplementation = async (url) => { interrupted.webview.url = url; await new Promise<void>(() => undefined) }
    const interruptedResponse = interrupted.manager.execute(request('navigate', { url: 'http://127.0.0.1:3000/interrupted', readiness: 'load', timeoutMs: 1_000 }))
    await vi.advanceTimersByTimeAsync(0)
    interrupted.webview.ipc.emit(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {}, { kind: 'key', key: 'x', code: 'KeyX' })
    await expect(interruptedResponse).resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
    expect(navigationListenerCounts(interrupted.webview)).toEqual(interruptedBaseline)
    await vi.advanceTimersByTimeAsync(750)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('serializes same-tab input, recognizes synthetic input, and isolates tab queues', async () => {
    const { manager, webview } = await setup()
    webview.debugger.onMousePressed = (params) => webview.ipc.emit(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {}, { kind: 'pointer', x: params.x, y: params.y, button: 0, syntheticSequence: webview.syntheticSequence })
    const clicks = await Promise.all([
      manager.execute(request('click', { x: 10, y: 10, timeoutMs: 2_000 })),
      manager.execute(request('click', { x: 20, y: 20, timeoutMs: 2_000 })),
    ])
    expect(clicks.every((response) => response.ok)).toBe(true)
    expect(webview.debugger.maximumActiveInput).toBe(1)

    const second = new FakeWebContents(102)
    manager.registerTabWebContents({ tab: tabSnapshot('tab-2'), visible: true, created: false }, second)
    await Promise.all([
      manager.execute(request('click', { x: 10, y: 10, timeoutMs: 2_000 })),
      manager.execute(request('click', { x: 10, y: 10, timeoutMs: 2_000 }, 'tab-2')),
    ])
    expect(webview.debugger.maximumActiveInput).toBe(1)
    expect(second.debugger.maximumActiveInput).toBe(1)
  })

  it('expires queued requests before they can produce a late input side effect', async () => {
    const { manager, webview } = await setup()
    const first = manager.execute(request('click', { x: 10, y: 10, timeoutMs: 2_000 }))
    const expired = manager.execute(request('click', { x: 20, y: 20, timeoutMs: 2_000 }, 'tab-1', {
      deadlineAt: new Date(Date.now() + 1).toISOString(),
    }))

    await expect(first).resolves.toMatchObject({ ok: true })
    await expect(expired).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(webview.debugger.commands.filter((command) => command === 'Input.dispatchMouseEvent')).toHaveLength(3)
  })

  it('bounds a never-settling screenshot and recovers the same-tab queue', async () => {
    const { manager, webview } = await setup()
    webview.debugger.hangCaptureOnce = true
    const timedOut = await manager.execute(request('snapshot', {}, 'tab-1', {
      deadlineAt: new Date(Date.now() + 25).toISOString(),
    }))
    expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true } })
    expect(webview.nativeCaptures).toBe(0)
    expect(webview.debugger.isAttached()).toBe(false)

    const recovered = await manager.execute(request('evaluate', { expression: 'Promise.resolve({ok:true})', awaitPromise: true, returnByValue: true }))
    expect(recovered).toMatchObject({ ok: true, result: { value: { ok: true } } })
    expect(webview.debugger.isAttached()).toBe(true)
  })

  it('times out and cancels locator work before click or type can continue', async () => {
    for (const operation of ['click', 'type'] as const) {
      const { manager, webview } = await setup()
      webview.debugger.hangLocator = true
      const input = operation === 'click'
        ? { locator: "role=button[name='Never']", timeoutMs: 10 }
        : { locator: "role=textbox[name='Never']", text: 'late', clear: true, timeoutMs: 10 }
      const pending = manager.execute(request(operation, input))

      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
      expect(webview.debugger.commands).toContain('Runtime.terminateExecution')
      expect(webview.debugger.commands).not.toContain('Input.dispatchMouseEvent')
      for (const resolve of webview.debugger.locatorResolvers.splice(0)) {
        resolve({ result: { type: 'object', value: operation === 'click' ? { x: 10, y: 10 } : { ok: true } } })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(webview.debugger.commands).not.toContain('Input.dispatchMouseEvent')
      webview.debugger.hangLocator = false
      const retried = await manager.execute(request(operation, input))
      expect(retried).toMatchObject({ ok: true })
    }
  })

  it('verifies key delivery and fails when the focused guest observes no DOM events', async () => {
    const delivered = await setup()
    await expect(delivered.manager.execute(request('press', { key: 'Enter', modifiers: [] }))).resolves.toMatchObject({ ok: true })
    expect(delivered.webview.focusCalls).toBe(1)
    expect(delivered.webview.debugger.commands.filter((command) => command === 'Input.dispatchKeyEvent')).toHaveLength(2)

    const missing = await setup()
    missing.webview.debugger.keyDelivery = { keydown: 0, keyup: 0, input: 0, editable: true, defaultPrevented: false, valueChanged: false }
    await expect(missing.manager.execute(request('press', { key: 'a', modifiers: [] }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution-failed', retryable: true, details: { keydown: 0, keyup: 0 } },
    })
  })

  it('interrupts stale agent work on unmatched human input', async () => {
    const { manager, webview } = await setup()
    webview.debugger.waitMatches = false
    const pending = manager.execute(request('waitFor', { text: 'never', timeoutMs: 2_000 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    webview.ipc.emit(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {}, { kind: 'key', key: 'x', code: 'KeyX' })
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
  })

  it('routes every toolbar action through human control and interrupts agent work', async () => {
    const fixtures = await Promise.all([setup(), setup(), setup(), setup()])
    const actions = [
      async ({ manager }: Awaited<ReturnType<typeof setup>>) => manager.humanNavigate('tab-1', 'https://example.com'),
      async ({ manager, webview }: Awaited<ReturnType<typeof setup>>) => { webview.canGoBack = true; manager.humanHistory('tab-1', 'back') },
      async ({ manager }: Awaited<ReturnType<typeof setup>>) => { manager.humanReload('tab-1', true) },
      async ({ manager }: Awaited<ReturnType<typeof setup>>) => { manager.humanSetZoom('tab-1', 1.5) },
    ]

    for (const [index, fixture] of fixtures.entries()) {
      fixture.webview.debugger.waitMatches = false
      const pending = fixture.manager.execute(request('waitFor', { text: 'never', timeoutMs: 2_000 }))
      await new Promise((resolve) => setTimeout(resolve, 10))
      await actions[index]!(fixture)
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
    }
    expect(fixtures[1]!.webview.historyActions).toEqual(['back'])
    expect(fixtures[2]!.webview.reloads).toEqual(['hard'])
    expect(fixtures[3]!.webview.zoom).toBe(1.5)
  })

  it('bounds diagnostics and detaches the debugger during teardown', async () => {
    const { manager, webview } = await setup()
    await manager.execute(request('status', {}, null))
    for (let index = 0; index < 250; index += 1) {
      webview.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: `line-${index}` }] })
    }
    const response = await manager.execute(request('snapshot', {}))
    expect(response.ok && response.operation === 'snapshot' ? response.result.consoleEntries : []).toHaveLength(200)
    await manager.destroy()
    expect(webview.debugger.isAttached()).toBe(false)
  })

  it('returns created only for an explicitly provisional tab and false after canonical reconnect', async () => {
    const { manager, webview } = await setup(true)
    manager.setTabPresentation({ tabId: 'tab-1', visible: true, viewportSetting: { mode: 'fill' }, renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 }, hostGeneration: 1, sessionRevision: 1, sequence: 1 })
    const first = await manager.execute(request('open', { show: true, reuseExistingTab: true }))
    expect(first).toMatchObject({ ok: true, result: { created: true, panelRevealRequested: true } })
    const second = await manager.execute(request('open', { show: false, reuseExistingTab: true }))
    expect(second).toMatchObject({ ok: true, result: { created: false, panelRevealRequested: false } })
    manager.unregisterTabWebContents('tab-1', webview.id)
    const reconnected = new FakeWebContents(104)
    manager.registerTabWebContents({ tab: tabSnapshot(), visible: false, created: false }, reconnected)
    manager.setTabPresentation({ tabId: 'tab-1', visible: true, viewportSetting: { mode: 'fill' }, renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 }, hostGeneration: 1, sessionRevision: 2, sequence: 2 })
    const afterReconnect = await manager.execute(request('open', { show: false, reuseExistingTab: true }))
    expect(afterReconnect).toMatchObject({ ok: true, result: { created: false } })
    const status = await manager.execute(request('status', {}, 'tab-1'))
    expect(status).toMatchObject({
      ok: true,
      result: {
        available: true,
        host: {
          connected: false,
          hostId: null,
          hostGeneration: null,
          focused: false,
          capabilities: null,
          connectedAt: null,
        },
        panelVisible: true,
        panelRevealRequested: false,
        physicalTabVisible: true,
        selectedTab: expect.objectContaining({ tabId: 'tab-1', live: true, physicalVisible: true }),
      },
    })
    expect(reconnected.debugger.isAttached()).toBe(true)
  })

  it('requires a current physical presentation acknowledgement before recording', async () => {
    const { manager } = await setup()
    const hidden = manager.setTabPresentation({ tabId: 'tab-1', visible: false, renderedViewport: null, hostGeneration: 2, sessionRevision: 2, sequence: 2 })
    expect(hidden).toMatchObject({ applied: true, tab: { physicalVisible: false, renderedViewport: null } })
    const stale = manager.setTabPresentation({ tabId: 'tab-1', visible: true, renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 }, hostGeneration: 1, sessionRevision: 1, sequence: 99 })
    expect(stale.applied).toBe(false)
    await expect(manager.prepareRecording(request('recordingStart', {}) as BrowserAutomationRequest & { operation: 'recordingStart' }))
      .rejects.toMatchObject({ code: 'recording-requires-visible-tab', retryable: true })
  })

  it('coordinates recording capture and constrains the final artifact', async () => {
    const { manager, root } = await setup()
    const artifactDirectory = path.join(root, 'profiles', 'profile-1', 'artifacts', 'browser')
    const start = request('recordingStart', {}) as BrowserAutomationRequest & { operation: 'recordingStart' }
    const prepared = await manager.prepareRecording(start)
    const started = await manager.execute(start)
    expect(started).toMatchObject({ ok: true, result: { recordingId: prepared.recordingId, recording: true } })
    const stop = request('recordingStop', { recordingId: prepared.recordingId }, 'tab-1', { artifactDirectory }) as BrowserAutomationRequest & { operation: 'recordingStop' }
    await manager.stopRecordingCapture(stop)
    const saved = await manager.saveRecording(stop, 'video/webm;codecs=vp9', new Uint8Array([1, 2, 3, 4]))
    expect(saved).toMatchObject({ ok: true, result: { mimeType: 'video/webm;codecs=vp9', extension: 'webm', sizeBytes: 4 } })
    if (saved.ok && saved.operation === 'recordingStop') expect(await readFile(saved.result.path)).toEqual(Buffer.from([1, 2, 3, 4]))

    expect(() => resolveApprovedArtifactDirectory(root, path.join(root, '..', 'escape'))).toThrow(/outside/)
  })

  it('cancels expired recording saves before writing and leaves no artifact or active recording', async () => {
    const { manager, root } = await setup()
    const artifactDirectory = path.join(root, 'profiles', 'profile-1', 'artifacts', 'browser')
    const start = request('recordingStart', {}) as BrowserAutomationRequest & { operation: 'recordingStart' }
    const prepared = await manager.prepareRecording(start)
    await manager.execute(start)
    const stop = request('recordingStop', { recordingId: prepared.recordingId }, 'tab-1', { artifactDirectory }) as BrowserAutomationRequest & { operation: 'recordingStop' }
    await manager.stopRecordingCapture(stop)
    const expired = { ...stop, requestId: 'expired-save', deadlineAt: new Date(Date.now() - 1).toISOString() }
    await expect(manager.saveRecording(expired, 'video/webm', new Uint8Array([1]))).resolves.toMatchObject({
      requestId: 'expired-save', ok: false, error: { code: 'timeout', retryable: true },
    })
    await expect(import('node:fs/promises').then(({ readdir }) => readdir(artifactDirectory))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(manager.prepareRecording(request('recordingStart', {}) as BrowserAutomationRequest & { operation: 'recordingStart' })).resolves.toMatchObject({ tabId: 'tab-1' })
  })

  it('aborts a recording write at its deadline and removes temporary/final artifacts', async () => {
    let now = Date.now()
    const writeStarted = Promise.withResolvers<void>()
    const writeArtifactFile = vi.fn((_path, _bytes, options) => new Promise<void>((_resolve, reject) => {
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      writeStarted.resolve()
    })) as unknown as NonNullable<ConstructorParameters<typeof BrowserAutomationManager>[0]['writeArtifactFile']>
    const { manager, root } = await setup(false, { writeArtifactFile, now: () => now })
    const artifactDirectory = path.join(root, 'profiles', 'profile-1', 'artifacts', 'browser')
    const start = request('recordingStart', {}) as BrowserAutomationRequest & { operation: 'recordingStart' }
    const prepared = await manager.prepareRecording(start)
    await manager.execute(start)
    const deadlineAt = now + 50
    const stop = request('recordingStop', { recordingId: prepared.recordingId }, 'tab-1', {
      artifactDirectory,
      requestId: 'during-save',
      deadlineAt: new Date(deadlineAt).toISOString(),
    }) as BrowserAutomationRequest & { operation: 'recordingStop' }
    await manager.stopRecordingCapture(stop)
    const save = manager.saveRecording(stop, 'video/webm', new Uint8Array([1]))
    await writeStarted.promise
    now = deadlineAt
    await expect(save).resolves.toMatchObject({
      requestId: 'during-save', ok: false, error: { code: 'timeout', retryable: true },
    })
    expect(writeArtifactFile).toHaveBeenCalledOnce()
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(artifactDirectory))
    expect(entries).toEqual([])
    await expect(manager.prepareRecording(request('recordingStart', {}) as BrowserAutomationRequest & { operation: 'recordingStart' })).resolves.toMatchObject({ tabId: 'tab-1' })
  })

  it('makes destroyed-event, repeated unregister, and manager teardown races harmless', async () => {
    const { manager, webview } = await setup()
    const other = new FakeWebContents(202)
    manager.registerTabWebContents({ tab: tabSnapshot('tab-2'), visible: false, created: false }, other)
    webview.throwOnDestroyedAccess = true

    expect(() => webview.close()).not.toThrow()
    expect(() => manager.unregisterTabWebContents('tab-1', webview.id)).not.toThrow()
    expect(() => manager.unregisterTabWebContents('tab-1', webview.id)).not.toThrow()
    await expect(manager.destroy()).resolves.toBeUndefined()
    await expect(manager.destroy()).resolves.toBeUndefined()
    expect(other.destroyed).toBe(true)
  })

  it('keeps other tabs functional after a destroyed/unregister race', async () => {
    const { manager, webview } = await setup()
    const other = new FakeWebContents(203)
    manager.registerTabWebContents({ tab: tabSnapshot('tab-2'), visible: false, created: false }, other)
    webview.throwOnDestroyedAccess = true
    webview.close()
    manager.unregisterTabWebContents('tab-1', webview.id)

    const response = await manager.execute(request('evaluate', { expression: 'Promise.resolve({ok:true})', awaitPromise: true, returnByValue: true }, 'tab-2'))
    expect(response).toMatchObject({ ok: true, result: { value: { ok: true } } })
  })

  it('rejects cross-session tabs and cleans replacement debugger sessions', async () => {
    const { manager, webview } = await setup()
    const mismatch = await manager.execute(request('snapshot', {}, 'tab-1', { sessionAgentId: 'other-session' }))
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'tab-session-mismatch' } })
    await manager.execute(request('snapshot', {}))
    const replacement = new FakeWebContents(103)
    manager.registerTabWebContents({ tab: tabSnapshot(), visible: true, created: false }, replacement)
    expect(webview.debugger.isAttached()).toBe(false)
  })
})
