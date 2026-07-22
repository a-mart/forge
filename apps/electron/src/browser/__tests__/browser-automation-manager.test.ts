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
  onMousePressed: ((params: Record<string, unknown>) => void) | null = null
  commands: string[] = []
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  isAttached(): boolean { return this.attached }
  override on(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): this { return super.on(event, listener) }
  off(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): this { return super.off(event, listener) }
  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push(method)
    if (method === 'Input.dispatchMouseEvent') {
      this.activeInput += 1
      this.maximumActiveInput = Math.max(this.maximumActiveInput, this.activeInput)
      if (params.type === 'mousePressed') this.onMousePressed?.(params)
      await new Promise((resolve) => setTimeout(resolve, 10))
      this.activeInput -= 1
      return {}
    }
    if (method === 'Accessibility.getFullAXTree') return { nodes: Array.from({ length: 250 }, (_, index) => ({ nodeId: String(index), role: { value: 'button' }, name: { value: `Button ${index}` } })) }
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params.expression ?? '')
    const value = (() => {
      if (expression === 'document.readyState') return 'complete'
      if (expression.includes('window.innerWidth')) return { width: 800, height: 600, deviceScaleFactor: 2 }
      if (expression.includes('Boolean(globalThis.__forgePlaywrightInjected)')) return true
      if (expression.includes('interactiveElements')) return {
        url: 'http://127.0.0.1:3000/fixture', title: 'Fixture', loading: false, visibleText: 'Fixture text',
        interactiveElements: [{ tag: 'button', role: 'button', name: 'Increment', selector: '#increment', x: 10, y: 20, width: 80, height: 30 }],
      }
      if (expression.includes('rect.left+rect.width/2')) return { x: 50, y: 35 }
      if (expression.includes('notEditable')) return { ok: true }
      if (expression.includes('target.scrollBy')) return { scrollX: 0, scrollY: 100 }
      if (expression.includes('selectorMatched')) return { matched: this.waitMatches }
      if (expression.includes('Promise.resolve')) return { ok: true }
      return true
    })()
    return { result: { type: typeof value === 'object' ? 'object' : typeof value, value } }
  }
}

class FakeWebContents extends EventEmitter implements BrowserWebContentsLike {
  readonly debugger = new FakeDebugger()
  readonly ipc = new EventEmitter()
  readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  destroyed = false
  loading = false
  url = 'about:blank'
  title = 'Fixture'
  zoom = 1
  constructor(readonly id: number) { super() }
  isDestroyed(): boolean { return this.destroyed }
  isLoading(): boolean { return this.loading }
  getURL(): string { return this.url }
  getTitle(): string { return this.title }
  getZoomFactor(): number { return this.zoom }
  async loadURL(url: string): Promise<void> { this.url = url; this.emit('did-navigate'); this.emit('did-stop-loading') }
  async capturePage(): Promise<BrowserImageLike> { return new FakeImage() }
  focus(): void {}
  close(): void { this.destroyed = true; this.emit('destroyed') }
  setWindowOpenHandler(): void {}
}

const managers: BrowserAutomationManager[] = []
let requestSequence = 0

function tabSnapshot(tabId = 'tab-1', sessionAgentId = 'session-1', profileId = 'profile-1'): BrowserTabSnapshot {
  const now = new Date(0).toISOString()
  return {
    tabId, sessionAgentId, profileId, url: 'about:blank', title: '', lifecycle: 'ready', loading: false, live: false,
    canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null,
    viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now,
  }
}

async function setup(): Promise<{ manager: BrowserAutomationManager; webview: FakeWebContents; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-browser-manager-'))
  const manager = new BrowserAutomationManager({ approvedDataRoot: root, hostWebContentsId: 1, sendToRenderer: vi.fn() })
  const webview = new FakeWebContents(101)
  manager.registerWebview({ tab: tabSnapshot(), webContentsId: webview.id, visible: true }, webview)
  managers.push(manager)
  return { manager, webview, root }
}

function request(operation: BrowserAutomationRequest['operation'], input: Record<string, unknown>, tabId: string | null = 'tab-1', overrides: Partial<BrowserAutomationRequest> = {}): BrowserAutomationRequest {
  return {
    requestId: `request-${++requestSequence}`, sessionAgentId: 'session-1', profileId: 'profile-1', tabId,
    hostId: 'host-1', hostGeneration: 1, deadlineAt: new Date(Date.now() + 30_000).toISOString(), artifactDirectory: null,
    operation, input, ...overrides,
  } as BrowserAutomationRequest
}

afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.destroy())) })

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
      visibleText: 'Fixture text', viewport: { width: 800, height: 600 }, screenshot: { mimeType: 'image/png', width: 1280, height: 720 },
    })
  })

  it('serializes same-tab input, recognizes synthetic input, and isolates tab queues', async () => {
    const { manager, webview } = await setup()
    webview.debugger.onMousePressed = (params) => webview.ipc.emit(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {}, { kind: 'pointer', x: params.x, y: params.y, button: 0 })
    const clicks = await Promise.all([
      manager.execute(request('click', { x: 10, y: 10, timeoutMs: 2_000 })),
      manager.execute(request('click', { x: 20, y: 20, timeoutMs: 2_000 })),
    ])
    expect(clicks.every((response) => response.ok)).toBe(true)
    expect(webview.debugger.maximumActiveInput).toBe(1)

    const second = new FakeWebContents(102)
    manager.registerWebview({ tab: tabSnapshot('tab-2'), webContentsId: second.id, visible: true }, second)
    await Promise.all([
      manager.execute(request('click', { x: 10, y: 10, timeoutMs: 2_000 })),
      manager.execute(request('click', { x: 10, y: 10, timeoutMs: 2_000 }, 'tab-2')),
    ])
    expect(webview.debugger.maximumActiveInput).toBe(1)
    expect(second.debugger.maximumActiveInput).toBe(1)
  })

  it('interrupts stale agent work on unmatched human input', async () => {
    const { manager, webview } = await setup()
    webview.debugger.waitMatches = false
    const pending = manager.execute(request('waitFor', { text: 'never', timeoutMs: 2_000 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    webview.ipc.emit(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {}, { kind: 'key', key: 'x', code: 'KeyX' })
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
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

  it('rejects cross-session tabs and cleans replacement debugger sessions', async () => {
    const { manager, webview } = await setup()
    const mismatch = await manager.execute(request('snapshot', {}, 'tab-1', { sessionAgentId: 'other-session' }))
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'tab-session-mismatch' } })
    await manager.execute(request('snapshot', {}))
    const replacement = new FakeWebContents(103)
    manager.registerWebview({ tab: tabSnapshot(), webContentsId: replacement.id, visible: true }, replacement)
    expect(webview.debugger.isAttached()).toBe(false)
  })
})
