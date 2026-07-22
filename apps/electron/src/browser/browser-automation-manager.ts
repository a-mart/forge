/*
 * Managed webContents/CDP automation is substantially adapted from T3 Code's
 * apps/desktop/src/preview/Manager.ts at 9a0a0716 (MIT). Forge uses plain
 * promises and protocol-native errors instead of T3's Effect services.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  BrowserActionTimelineEntry,
  BrowserAutomationErrorCode,
  BrowserAutomationFailure,
  BrowserAutomationOperation,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserAutomationResultByOperation,
  BrowserConsoleEntry,
  BrowserNetworkEntry,
  BrowserRenderedViewport,
  BrowserSnapshotElement,
  BrowserTabSnapshot,
  BrowserViewportSetting,
} from '@forge/protocol'
import {
  BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES,
  BROWSER_AUTOMATION_MAX_EVALUATE_BYTES,
  BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH,
  BROWSER_AUTOMATION_OPERATIONS,
  resolveBrowserViewportPreset,
} from '@forge/protocol'
import { BrowserHostError, asBrowserHostError } from './browser-errors.js'
import { makeBrowserKeySequence } from './browser-keyboard.js'
import { playwrightInjectedRuntimeInstallExpression, PLAYWRIGHT_CORE_VERSION } from './playwright-injected-runtime.js'
import { BROWSER_GUEST_HUMAN_INPUT_CHANNEL, BROWSER_IPC } from './browser-bridge-contract.js'

export const BROWSER_RECORDING_FRAME_CHANNEL = 'forge:browser-recording-frame'
const ACTION_LIMIT = 200
const EXPECTED_INPUT_TTL_MS = 1_000
const POLL_INTERVAL_MS = 50
const MAX_SCREENSHOT_PNG_BYTES = 5 * 1_024 * 1_024

type UnknownRecord = Record<string, unknown>
type InputSignal =
  | { kind: 'pointer'; x: number; y: number; button: number }
  | { kind: 'key'; key: string; code: string }

type DebuggerMessageListener = (event: unknown, method: string, params: UnknownRecord) => void

export interface BrowserDebuggerLike {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, commandParams?: UnknownRecord): Promise<unknown>
  on(event: 'message', listener: DebuggerMessageListener): void
  off(event: 'message', listener: DebuggerMessageListener): void
}

export interface BrowserImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number }): BrowserImageLike
  toPNG(): Buffer
}

export interface BrowserWebContentsLike {
  readonly id: number
  readonly debugger: BrowserDebuggerLike
  readonly navigationHistory: {
    canGoBack(): boolean
    canGoForward(): boolean
  }
  readonly ipc: {
    on(channel: string, listener: (event: unknown, signal?: unknown) => void): void
    off(channel: string, listener: (event: unknown, signal?: unknown) => void): void
  }
  isDestroyed(): boolean
  isLoading(): boolean
  getURL(): string
  getTitle(): string
  getZoomFactor(): number
  loadURL(url: string): Promise<void>
  capturePage(): Promise<BrowserImageLike>
  focus(): void
  close(options?: { waitForBeforeUnload?: boolean }): void
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void
  on(event: string, listener: (...args: unknown[]) => void): void
  off(event: string, listener: (...args: unknown[]) => void): void
}

export interface BrowserWebviewRegistration {
  tab: BrowserTabSnapshot
  webContentsId: number
  visible: boolean
}

interface ExpectedInput {
  signal: InputSignal
  expiresAt: number
}

interface TabDiagnostics {
  consoleEntries: BrowserConsoleEntry[]
  networkEntries: BrowserNetworkEntry[]
  requests: Map<string, { url: string; method: string }>
}

interface TabRuntime {
  snapshot: BrowserTabSnapshot
  webContents: BrowserWebContentsLike
  visible: boolean
  queue: Promise<void>
  controlEpoch: number
  expectedInputs: ExpectedInput[]
  diagnostics: TabDiagnostics
  actionTimeline: BrowserActionTimelineEntry[]
  debuggerReady: boolean
  debuggerPromise: Promise<void> | null
  debuggerMessage: DebuggerMessageListener | null
  listeners: Array<{ event: string; listener: (...args: unknown[]) => void }>
  humanInputListener: (event: unknown, signal?: unknown) => void
  navigationWait: { interrupt(error: BrowserHostError): void } | null
  destroyed: boolean
}

interface ActiveRecording {
  recordingId: string
  tabId: string
  startedAt: string
  mimeType: string
  width: number
  height: number
  phase: 'prepared' | 'recording' | 'stopping'
}

export interface PreparedRecording {
  recordingId: string
  tabId: string
  startedAt: string
  width: number
  height: number
}

export interface BrowserAutomationManagerOptions {
  approvedDataRoot: string
  hostWebContentsId: number
  sendToRenderer(channel: string, payload: unknown): void
  now?: () => number
  isMac?: boolean
}

export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeBrowserUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (trimmed === '' || trimmed === 'about:blank') return 'about:blank'
  if (isHttpUrl(trimmed)) return new URL(trimmed).toString()
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || /^(?:about|data|file|javascript):/i.test(trimmed)) {
    throw new BrowserHostError('invalid-url', 'Managed browser URLs must use HTTP or HTTPS')
  }
  const host = trimmed.split(/[/?#]/, 1)[0]?.toLowerCase() ?? ''
  const loopback = host === 'localhost' || host.startsWith('localhost:') || host === '127.0.0.1' || host.startsWith('127.0.0.1:') || host === '[::1]' || host.startsWith('[::1]:')
  const candidate = `${loopback ? 'http' : 'https'}://${trimmed}`
  try {
    return new URL(candidate).toString()
  } catch {
    throw new BrowserHostError('invalid-url', 'The browser URL is invalid')
  }
}

export function resolveApprovedArtifactDirectory(approvedDataRoot: string, candidate: string | null): string {
  if (!candidate) throw new BrowserHostError('artifact-path-invalid', 'No artifact directory was approved for this request')
  const root = path.resolve(approvedDataRoot)
  const resolved = path.resolve(candidate)
  const relative = path.relative(root, resolved)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new BrowserHostError('artifact-path-invalid', 'Artifact directory is outside the approved Forge data root')
  }
  return resolved
}

export class BrowserAutomationManager {
  private readonly tabs = new Map<string, TabRuntime>()
  private readonly now: () => number
  private readonly approvedDataRoot: string
  private readonly sendToRenderer: BrowserAutomationManagerOptions['sendToRenderer']
  private readonly isMac: boolean
  private activeRecording: ActiveRecording | null = null
  private sequence = 0
  private destroyed = false

  constructor(options: BrowserAutomationManagerOptions) {
    this.approvedDataRoot = path.resolve(options.approvedDataRoot)
    this.sendToRenderer = options.sendToRenderer
    this.now = options.now ?? Date.now
    this.isMac = options.isMac ?? process.platform === 'darwin'
    void options.hostWebContentsId
  }

  get supportedOperations(): BrowserAutomationOperation[] {
    return [...BROWSER_AUTOMATION_OPERATIONS]
  }

  registerWebview(registration: BrowserWebviewRegistration, webContents: BrowserWebContentsLike): BrowserTabSnapshot {
    if (this.destroyed) throw new BrowserHostError('host-disconnected', 'Browser host is shutting down')
    if (webContents.isDestroyed()) throw new BrowserHostError('tab-not-found', 'The hosted webview was already destroyed')
    const current = this.tabs.get(registration.tab.tabId)
    if (current && current.webContents.id !== webContents.id) this.disposeTabRuntime(current, true)
    if (current?.webContents.id === webContents.id && !current.destroyed) {
      current.visible = registration.visible
      current.snapshot = { ...registration.tab, live: true, renderedViewport: current.snapshot.renderedViewport }
      return this.syncSnapshot(current)
    }

    const runtime: TabRuntime = {
      snapshot: { ...registration.tab, live: true, lifecycle: webContents.isLoading() ? 'loading' : 'ready', updatedAt: new Date(this.now()).toISOString() },
      webContents,
      visible: registration.visible,
      queue: Promise.resolve(),
      controlEpoch: 0,
      expectedInputs: [],
      diagnostics: { consoleEntries: [], networkEntries: [], requests: new Map() },
      actionTimeline: [],
      debuggerReady: false,
      debuggerPromise: null,
      debuggerMessage: null,
      listeners: [],
      humanInputListener: (_event, signal) => this.handleGuestInput(registration.tab.tabId, signal),
      navigationWait: null,
      destroyed: false,
    }
    this.tabs.set(runtime.snapshot.tabId, runtime)
    this.attachTabListeners(runtime)
    void this.ensureDebugger(runtime).catch(() => undefined)
    return this.syncSnapshot(runtime)
  }

  setTabPresentation(tabId: string, visible: boolean, viewportSetting?: BrowserViewportSetting): BrowserTabSnapshot {
    const tab = this.requireTab(tabId)
    tab.visible = visible
    if (viewportSetting) tab.snapshot = { ...tab.snapshot, viewportSetting }
    return this.syncSnapshot(tab)
  }

  unregisterWebview(tabId: string, webContentsId?: number): void {
    const tab = this.tabs.get(tabId)
    if (!tab || (webContentsId !== undefined && tab.webContents.id !== webContentsId)) return
    this.disposeTabRuntime(tab, false)
    this.tabs.delete(tabId)
  }

  async execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    const started = this.now()
    try {
      if (this.destroyed) throw new BrowserHostError('host-disconnected', 'Browser host is shutting down')
      if (new Date(request.deadlineAt).getTime() <= this.now()) throw new BrowserHostError('timeout', 'Browser request deadline has elapsed', true)
      const result = await this.executeOperation(request)
      const updatedTab = request.tabId ? this.tabs.get(request.tabId)?.snapshot : undefined
      return {
        requestId: request.requestId,
        sessionAgentId: request.sessionAgentId,
        profileId: request.profileId,
        tabId: request.tabId,
        hostId: request.hostId,
        hostGeneration: request.hostGeneration,
        operation: request.operation,
        ok: true,
        result,
        elapsedMs: Math.max(0, this.now() - started),
        ...(updatedTab ? { updatedTab: { ...updatedTab } } : {}),
      } as BrowserAutomationResponse
    } catch (error) {
      const failure = asBrowserHostError(error, `Browser ${request.operation} failed`).toFailure()
      return this.errorResponse(request, failure, started)
    }
  }

  async prepareRecording(request: BrowserAutomationRequest & { operation: 'recordingStart' }): Promise<PreparedRecording> {
    const tab = this.requestTab(request)
    if (!tab.visible) throw new BrowserHostError('recording-requires-visible-tab', 'Browser recording requires a visible tab')
    if (this.activeRecording) {
      if (this.activeRecording.tabId === tab.snapshot.tabId && this.activeRecording.phase === 'recording') {
        return { ...this.activeRecording }
      }
      throw new BrowserHostError('recording-conflict', `Tab ${this.activeRecording.tabId} is already being recorded`)
    }
    const viewport = await this.measureViewport(tab, this.rawSend(tab))
    const recordingId = `browser-recording-${this.now().toString(36)}-${(++this.sequence).toString(36)}`
    const startedAt = new Date(this.now()).toISOString()
    this.activeRecording = { recordingId, tabId: tab.snapshot.tabId, startedAt, mimeType: '', width: viewport.width, height: viewport.height, phase: 'prepared' }
    return { recordingId, tabId: tab.snapshot.tabId, startedAt, width: viewport.width, height: viewport.height }
  }

  setRecordingMimeType(request: BrowserAutomationRequest & { operation: 'recordingStart' }, mimeType: string): void {
    const recording = this.activeRecording
    if (!recording || recording.tabId !== request.tabId || !mimeType.startsWith('video/')) {
      throw new BrowserHostError('recording-not-found', 'Browser recording reservation was not found')
    }
    recording.mimeType = mimeType
  }

  async stopRecordingCapture(request: BrowserAutomationRequest & { operation: 'recordingStop' }): Promise<PreparedRecording> {
    const recording = this.requireRecording(request)
    const tab = this.requestTab(request)
    await this.serialize(tab, 'recording.stop', async (send) => {
      if (recording.phase === 'recording') await send('Page.stopScreencast')
      recording.phase = 'stopping'
    })
    return { ...recording }
  }

  async saveRecording(
    request: BrowserAutomationRequest & { operation: 'recordingStop' },
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<BrowserAutomationResponse> {
    const started = this.now()
    try {
      const recording = this.requireRecording(request)
      if (recording.phase !== 'stopping') throw new BrowserHostError('recording-conflict', 'Recording has not stopped capturing')
      if (!mimeType.startsWith('video/') || bytes.byteLength === 0) throw new BrowserHostError('execution-failed', 'MediaRecorder produced no video data')
      const directory = resolveApprovedArtifactDirectory(this.approvedDataRoot, request.artifactDirectory)
      const extension = mimeType.includes('mp4') ? 'mp4' : 'webm'
      const artifactPath = path.join(directory, `${recording.recordingId}.${extension}`)
      await mkdir(directory, { recursive: true })
      await writeFile(artifactPath, bytes)
      const createdAt = new Date(this.now()).toISOString()
      const result: BrowserAutomationResultByOperation['recordingStop'] = {
        recordingId: recording.recordingId,
        tabId: recording.tabId,
        path: artifactPath,
        mimeType,
        extension,
        sizeBytes: bytes.byteLength,
        width: recording.width,
        height: recording.height,
        createdAt,
      }
      const tab = this.tabs.get(recording.tabId)
      if (tab) {
        tab.snapshot = { ...tab.snapshot, recording: null, updatedAt: createdAt }
        this.emitTabState(tab)
      }
      this.activeRecording = null
      return {
        requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
        tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration,
        operation: 'recordingStop', ok: true, result, elapsedMs: Math.max(0, this.now() - started),
        ...(tab ? { updatedTab: { ...tab.snapshot } } : {}),
      }
    } catch (error) {
      return this.errorResponse(request, asBrowserHostError(error, 'Failed to save recording').toFailure(), started)
    }
  }

  cancelRecording(recordingId?: string): void {
    const active = this.activeRecording
    if (!active || (recordingId && active.recordingId !== recordingId)) return
    const tab = this.tabs.get(active.tabId)
    if (tab && tab.debuggerReady && tab.webContents.debugger.isAttached() && active.phase === 'recording') {
      void tab.webContents.debugger.sendCommand('Page.stopScreencast').catch(() => undefined)
      tab.snapshot = { ...tab.snapshot, recording: null }
    }
    this.activeRecording = null
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.cancelRecording()
    for (const tab of this.tabs.values()) this.disposeTabRuntime(tab, true)
    this.tabs.clear()
  }

  private async executeOperation(request: BrowserAutomationRequest): Promise<unknown> {
    if (request.operation === 'status') return this.status(request)
    const tab = this.requestTab(request)
    switch (request.operation) {
      case 'open': return this.open(tab, request.input)
      case 'navigate': return this.navigate(tab, request.input)
      case 'resize': return this.resize(tab, request.input)
      case 'snapshot': return this.serialize(tab, 'snapshot', (send) => this.snapshot(tab, send))
      case 'click': return this.serialize(tab, 'click', (send) => this.click(tab, request.input, send))
      case 'type': return this.serialize(tab, 'type', (send) => this.type(tab, request.input, send))
      case 'press': return this.serialize(tab, 'press', (send, cleanup) => this.press(tab, request.input, send, cleanup))
      case 'scroll': return this.serialize(tab, 'scroll', (send) => this.scroll(tab, request.input, send))
      case 'evaluate': return this.serialize(tab, 'evaluate', (send) => this.evaluate(tab, request.input, send))
      case 'waitFor': return this.serialize(tab, 'waitFor', (send) => this.waitFor(tab, request.input, send))
      case 'recordingStart': return this.startPreparedRecording(tab, request)
      case 'recordingStop': throw new BrowserHostError('recording-conflict', 'Recording stop must be completed by the trusted preload recorder')
    }
  }

  private status(request: BrowserAutomationRequest & { operation: 'status' }): BrowserAutomationResultByOperation['status'] {
    const selected = request.tabId ? this.tabs.get(request.tabId) : undefined
    return {
      available: !this.destroyed,
      host: {
        connected: !this.destroyed,
        hostId: request.hostId,
        hostGeneration: request.hostGeneration,
        focused: true,
        capabilities: {
          supportedOperations: [...BROWSER_AUTOMATION_OPERATIONS],
          electronVersion: process.versions.electron ?? 'unknown',
          chromiumVersion: process.versions.chrome ?? 'unknown',
          playwrightVersion: PLAYWRIGHT_CORE_VERSION,
          maxResponseBytes: 8 * 1_024 * 1_024,
          supportsSandboxedWebviews: true,
          supportsCapturePage: true,
          supportsRecording: typeof process.versions.electron === 'string',
        },
        connectedAt: new Date(this.now()).toISOString(),
      },
      panelVisible: selected?.visible ?? false,
      selectedTab: selected ? this.syncSnapshot(selected) : null,
    }
  }

  private async open(tab: TabRuntime, input: Extract<BrowserAutomationRequest, { operation: 'open' }>['input']): Promise<BrowserAutomationResultByOperation['open']> {
    if (input.url) await this.loadAndWait(tab, normalizeBrowserUrl(input.url), 'load', 15_000)
    return { tab: this.syncSnapshot(tab), created: false, panelRevealRequested: input.show }
  }

  private async navigate(tab: TabRuntime, input: Extract<BrowserAutomationRequest, { operation: 'navigate' }>['input']): Promise<BrowserAutomationResultByOperation['navigate']> {
    const raw = input.url ?? `${input.environmentProtocol ?? 'http'}://127.0.0.1:${input.environmentPort}${input.path ?? ''}`
    await this.loadAndWait(tab, normalizeBrowserUrl(raw), input.readiness, input.timeoutMs)
    return { tab: this.syncSnapshot(tab), readiness: input.readiness }
  }

  private async loadAndWait(tab: TabRuntime, url: string, readiness: 'load' | 'domContentLoaded' | 'none', timeoutMs: number): Promise<void> {
    const deadline = this.now() + timeoutMs
    await this.serialize(tab, 'navigate', async () => {
      tab.snapshot = { ...tab.snapshot, lifecycle: 'loading', loading: true, url, error: null }
      try {
        if (this.now() >= deadline) throw new BrowserHostError('timeout', `Navigation did not reach ${readiness}`, true)
        if (readiness === 'none') {
          const navigation = tab.webContents.loadURL(url)
          void navigation.catch((error) => this.markBackgroundNavigationFailure(tab, error))
        } else {
          await this.waitForNavigationReadiness(tab, url, readiness, deadline)
        }
        this.syncSnapshot(tab)
      } catch (error) {
        const failure = error instanceof BrowserHostError
          ? error
          : new BrowserHostError('navigation-failed', error instanceof Error ? error.message : 'Navigation failed', true)
        tab.snapshot = { ...tab.snapshot, lifecycle: 'failed', loading: false, error: { code: failure.code, message: failure.message } }
        throw failure
      }
    })
  }

  private waitForNavigationReadiness(tab: TabRuntime, url: string, readiness: 'load' | 'domContentLoaded', deadline: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let cancelTimeout = (): void => undefined
      const complete = (error?: BrowserHostError): void => {
        if (settled) return
        settled = true
        cancelTimeout()
        tab.webContents.off(readiness === 'load' ? 'did-finish-load' : 'dom-ready', ready)
        tab.webContents.off('did-fail-load', failed)
        tab.webContents.off('destroyed', destroyed)
        if (tab.navigationWait === navigationWait) tab.navigationWait = null
        if (error) reject(error)
        else resolve()
      }
      const ready = (): void => complete()
      const failed = (...args: unknown[]): void => {
        if (args[4] === false) return
        const code = typeof args[1] === 'number' ? args[1] : 0
        const description = typeof args[2] === 'string' ? args[2] : 'Page failed to load'
        complete(new BrowserHostError('navigation-failed', `Navigation failed (${code}): ${description}`, true))
      }
      const destroyed = (): void => complete(new BrowserHostError('tab-not-found', 'Browser tab was destroyed', true))
      const navigationWait = { interrupt: (error: BrowserHostError): void => complete(error) }
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        complete(new BrowserHostError('timeout', `Navigation did not reach ${readiness}`, true))
        return
      }

      tab.navigationWait = navigationWait
      tab.webContents.on(readiness === 'load' ? 'did-finish-load' : 'dom-ready', ready)
      tab.webContents.on('did-fail-load', failed)
      tab.webContents.on('destroyed', destroyed)
      const timeout = setTimeout(() => complete(new BrowserHostError('timeout', `Navigation did not reach ${readiness}`, true)), remaining)
      cancelTimeout = () => clearTimeout(timeout)
      try {
        void tab.webContents.loadURL(url).catch((error) => {
          complete(new BrowserHostError('navigation-failed', error instanceof Error ? error.message : 'Navigation failed', true))
        })
      } catch (error) {
        complete(new BrowserHostError('navigation-failed', error instanceof Error ? error.message : 'Navigation failed', true))
      }
    })
  }

  private markBackgroundNavigationFailure(tab: TabRuntime, error: unknown): void {
    if (tab.destroyed || tab.webContents.isDestroyed()) return
    const message = error instanceof Error ? error.message : 'Navigation failed'
    tab.snapshot = { ...tab.snapshot, lifecycle: 'failed', loading: false, error: { code: 'navigation-failed', message } }
    this.emitTabState(tab)
  }

  private async resize(tab: TabRuntime, input: Extract<BrowserAutomationRequest, { operation: 'resize' }>['input']): Promise<BrowserAutomationResultByOperation['resize']> {
    return this.serialize(tab, 'resize', async (send) => {
      let setting: BrowserViewportSetting
      if (input.mode === 'fill') {
        setting = { mode: 'fill' }
        await send('Emulation.clearDeviceMetricsOverride')
      } else if (input.mode === 'freeform') {
        setting = { mode: 'freeform', width: input.width, height: input.height }
        await send('Emulation.setDeviceMetricsOverride', { width: input.width, height: input.height, deviceScaleFactor: 1, mobile: false })
      } else {
        const preset = resolveBrowserViewportPreset(input.presetId, input.orientation)
        if (preset.mode !== 'preset') throw new BrowserHostError('invalid-input', 'Viewport preset did not resolve')
        setting = preset
        await send('Emulation.setDeviceMetricsOverride', { width: preset.width, height: preset.height, deviceScaleFactor: 1, mobile: false })
      }
      const viewport = await this.measureViewport(tab, send)
      tab.snapshot = { ...tab.snapshot, viewportSetting: setting, renderedViewport: viewport }
      return { tabId: tab.snapshot.tabId, setting, viewport }
    })
  }

  private async snapshot(tab: TabRuntime, send: SendCommand): Promise<BrowserAutomationResultByOperation['snapshot']> {
    await Promise.all([send('Runtime.enable'), send('Accessibility.enable')])
    const page = await this.evaluateValue<{
      url: string; title: string; loading: boolean; visibleText: string; interactiveElements: BrowserSnapshotElement[]
    }>(tab, send, `(() => {
      const selectorFor = (element) => {
        if (element.id) return '#' + CSS.escape(element.id);
        for (const attribute of ['data-testid', 'name']) {
          const value = element.getAttribute(attribute);
          if (value) return element.tagName.toLowerCase() + '[' + attribute + '=' + JSON.stringify(value) + ']';
        }
        const parts = []; let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
          const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(child => child.tagName === current.tagName) : [];
          const base = current.tagName.toLowerCase();
          parts.unshift(siblings.length > 1 ? base + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : base);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      const elements = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role],[tabindex]'))
        .filter(element => { const style=getComputedStyle(element); const rect=element.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; })
        .slice(0, ${BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS})
        .map(element => { const rect=element.getBoundingClientRect(); return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), name: (element.getAttribute('aria-label') || element.innerText || element.getAttribute('name') || '').slice(0, 500), selector: selectorFor(element), x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
      return { url: location.href, title: document.title, loading: document.readyState !== 'complete', visibleText: (document.body?.innerText || '').slice(0, ${BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH}), interactiveElements: elements };
    })()`, true, true)
    const [ax, sourceImage, viewport] = await Promise.all([
      send('Accessibility.getFullAXTree'),
      tab.webContents.capturePage(),
      this.measureViewport(tab, send),
    ])
    if (sourceImage.isEmpty()) throw new BrowserHostError('execution-failed', 'Browser screenshot was empty')
    const sourceSize = sourceImage.getSize()
    let image = sourceSize.width > BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH ? sourceImage.resize({ width: BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH }) : sourceImage
    let png = image.toPNG()
    while (png.byteLength > MAX_SCREENSHOT_PNG_BYTES && image.getSize().width > 320) {
      image = image.resize({ width: Math.max(320, Math.floor(image.getSize().width * 0.75)) })
      png = image.toPNG()
    }
    if (png.byteLength > MAX_SCREENSHOT_PNG_BYTES) throw new BrowserHostError('response-too-large', 'Browser screenshot exceeds the host response limit')
    const size = image.getSize()
    tab.snapshot = { ...tab.snapshot, url: page.url, title: page.title, loading: page.loading, renderedViewport: viewport }
    return {
      tabId: tab.snapshot.tabId,
      url: page.url,
      title: page.title,
      loading: page.loading,
      viewportSetting: tab.snapshot.viewportSetting,
      viewport,
      visibleText: page.visibleText.slice(0, BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH),
      interactiveElements: page.interactiveElements.slice(0, BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS),
      accessibility: this.boundAccessibility(ax),
      consoleEntries: tab.diagnostics.consoleEntries.slice(-BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      networkEntries: tab.diagnostics.networkEntries.slice(-BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      actionTimeline: tab.actionTimeline.slice(-ACTION_LIMIT),
      screenshot: { mimeType: 'image/png', data: png.toString('base64'), width: size.width, height: size.height },
    }
  }

  private async click(tab: TabRuntime, input: Extract<BrowserAutomationRequest, { operation: 'click' }>['input'], send: SendCommand): Promise<BrowserAutomationResultByOperation['click']> {
    await this.prepareInput(send, true)
    const point = 'x' in input ? { x: input.x, y: input.y } : await this.locatorPoint(tab, send, 'locator' in input ? input.locator : `css=${input.selector}`)
    const viewport = await this.measureViewport(tab, send)
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
      throw new BrowserHostError('coordinates-outside-viewport', 'Click coordinates are outside the rendered viewport', false, { x: point.x, y: point.y, viewportWidth: viewport.width, viewportHeight: viewport.height })
    }
    this.expectInput(tab, { kind: 'pointer', x: point.x, y: point.y, button: 0 })
    tab.snapshot = { ...tab.snapshot, agentCursor: { ...point, phase: 'move', sequence: ++this.sequence, createdAt: new Date(this.now()).toISOString() } }
    this.emitTabState(tab)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' })
    tab.snapshot = { ...tab.snapshot, agentCursor: { ...point, phase: 'click', sequence: ++this.sequence, createdAt: new Date(this.now()).toISOString() } }
    this.emitTabState(tab)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    return { tabId: tab.snapshot.tabId, point }
  }

  private async type(tab: TabRuntime, input: Extract<BrowserAutomationRequest, { operation: 'type' }>['input'], send: SendCommand): Promise<BrowserAutomationResultByOperation['type']> {
    const locator = input.locator ?? (input.selector ? `css=${input.selector}` : null)
    if (locator) await this.ensurePlaywright(tab, send)
    const result = await this.evaluateValue<{ ok?: true; notFound?: true; notEditable?: true; invalidSelector?: true; message?: string }>(tab, send, `(() => {
      try {
        const element = ${locator ? `globalThis.__forgePlaywrightInjected.querySelector(globalThis.__forgePlaywrightInjected.parseSelector(${JSON.stringify(locator)}), document, true)` : 'document.activeElement'};
        if (!element) return { notFound: true };
        const textControl = element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !new Set(['button','checkbox','color','file','hidden','image','radio','range','reset','submit']).has(element.type));
        if (!(textControl || element.isContentEditable) || element.disabled || element.readOnly) return { notEditable: true };
        element.focus(); if (document.activeElement !== element) return { notEditable: true };
        if (${input.clear}) {
          if (textControl) element.select(); else { const range=document.createRange(); range.selectNodeContents(element); const selection=document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
        }
        const text=${JSON.stringify(input.text)}; let inserted=true;
        if (text.length > 0) inserted=document.execCommand('insertText', false, text);
        else if (${input.clear}) { document.execCommand('delete', false); if (textControl && element.value.length > 0) { const proto=element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value')?.set?.call(element,''); element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'})); } }
        if (!inserted) return { notEditable: true }; element.dispatchEvent(new Event('change',{bubbles:true})); return { ok: true };
      } catch (error) { return { invalidSelector: true, message: String(error) }; }
    })()`, true, true)
    if (result.invalidSelector) throw new BrowserHostError('invalid-selector', result.message ?? 'Invalid selector')
    if (result.notFound) throw new BrowserHostError('target-not-found', 'Type target was not found', true)
    if (result.notEditable) throw new BrowserHostError('target-not-editable', 'Type target is not editable')
    return { tabId: tab.snapshot.tabId, characters: [...input.text].length, cleared: input.clear }
  }

  private async press(tab: TabRuntime, input: Extract<BrowserAutomationRequest, { operation: 'press' }>['input'], send: SendCommand, cleanup: SendCommand): Promise<BrowserAutomationResultByOperation['press']> {
    await this.prepareInput(send, false)
    const sequence = makeBrowserKeySequence(input, this.isMac)
    let down = false
    try {
      tab.webContents.focus()
      await send('Page.bringToFront')
      await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      this.expectInput(tab, sequence.signal)
      down = true
      await send('Input.dispatchKeyEvent', sequence.keyDown)
    } finally {
      if (down) await cleanup('Input.dispatchKeyEvent', sequence.keyUp).catch(() => undefined)
      await cleanup('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined)
    }
    return { tabId: tab.snapshot.tabId, key: input.key, modifiers: input.modifiers ?? [] }
  }

  private async scroll(tab: TabRuntime, input: Extract<BrowserAutomationRequest, { operation: 'scroll' }>['input'], send: SendCommand): Promise<BrowserAutomationResultByOperation['scroll']> {
    const locator = input.locator ?? (input.selector ? `css=${input.selector}` : null)
    if (locator) await this.ensurePlaywright(tab, send)
    const result = await this.evaluateValue<{ notFound?: true; invalidSelector?: true; message?: string; scrollX?: number; scrollY?: number }>(tab, send, `(() => { try {
      const target=${locator ? `globalThis.__forgePlaywrightInjected.querySelector(globalThis.__forgePlaywrightInjected.parseSelector(${JSON.stringify(locator)}),document,true)` : 'window'};
      if (!target) return {notFound:true}; target.scrollBy({left:${input.deltaX ?? 0},top:${input.deltaY ?? 0},behavior:'instant'});
      return {scrollX: target === window ? window.scrollX : target.scrollLeft, scrollY: target === window ? window.scrollY : target.scrollTop};
    } catch(error) { return {invalidSelector:true,message:String(error)}; } })()`, true, true)
    if (result.invalidSelector) throw new BrowserHostError('invalid-selector', result.message ?? 'Invalid selector')
    if (result.notFound) throw new BrowserHostError('target-not-found', 'Scroll target was not found', true)
    return { tabId: tab.snapshot.tabId, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0, scrollX: result.scrollX ?? 0, scrollY: result.scrollY ?? 0 }
  }

  private async evaluate(tab: TabRuntime, input: Extract<BrowserAutomationRequest, { operation: 'evaluate' }>['input'], send: SendCommand): Promise<BrowserAutomationResultByOperation['evaluate']> {
    const response = await this.evaluateRaw(send, input.expression, input.returnByValue, input.awaitPromise)
    const remote = this.record(response.result)
    const value = remote.value
    let serializedBytes = 0
    if (input.returnByValue) {
      let serialized: string
      try { serialized = JSON.stringify(value) ?? 'null' } catch { throw new BrowserHostError('evaluation-failed', 'Evaluation result is not JSON serializable') }
      serializedBytes = Buffer.byteLength(serialized, 'utf8')
      if (serializedBytes > BROWSER_AUTOMATION_MAX_EVALUATE_BYTES) throw new BrowserHostError('result-too-large', 'Evaluation result exceeds 64 KiB')
      return { tabId: tab.snapshot.tabId, value, serializedBytes }
    }
    return {
      tabId: tab.snapshot.tabId,
      remoteObject: {
        type: typeof remote.type === 'string' ? remote.type : 'undefined',
        ...(typeof remote.subtype === 'string' ? { subtype: remote.subtype } : {}),
        ...(typeof remote.description === 'string' ? { description: remote.description.slice(0, 2_048) } : {}),
        ...(typeof remote.objectId === 'string' ? { objectId: remote.objectId } : {}),
      },
      serializedBytes,
    }
  }

  private async waitFor(tab: TabRuntime, input: Extract<BrowserAutomationRequest, { operation: 'waitFor' }>['input'], send: SendCommand): Promise<BrowserAutomationResultByOperation['waitFor']> {
    const started = this.now()
    const locator = input.locator ?? (input.selector ? `css=${input.selector}` : null)
    if (locator) await this.ensurePlaywright(tab, send)
    const deadline = started + input.timeoutMs
    while (this.now() <= deadline) {
      const result = await this.evaluateValue<{ matched?: boolean; invalidSelector?: true; message?: string }>(tab, send, `(() => { try {
        const selectorMatched=${locator ? `globalThis.__forgePlaywrightInjected.querySelector(globalThis.__forgePlaywrightInjected.parseSelector(${JSON.stringify(locator)}),document,false)!==null` : 'true'};
        const textMatched=${input.text ? `(document.body?.innerText || '').includes(${JSON.stringify(input.text)})` : 'true'};
        const urlMatched=${input.urlIncludes ? `location.href.includes(${JSON.stringify(input.urlIncludes)})` : 'true'};
        return {matched:selectorMatched&&textMatched&&urlMatched};
      } catch(error) { return {invalidSelector:true,message:String(error)}; } })()`, true, true)
      if (result.invalidSelector) throw new BrowserHostError('invalid-selector', result.message ?? 'Invalid selector')
      if (result.matched) return { tabId: tab.snapshot.tabId, matched: true, elapsedMs: this.now() - started }
      await this.delay(POLL_INTERVAL_MS)
    }
    throw new BrowserHostError('timeout', 'Wait conditions did not match before timeout', true)
  }

  private async startPreparedRecording(tab: TabRuntime, request: BrowserAutomationRequest & { operation: 'recordingStart' }): Promise<BrowserAutomationResultByOperation['recordingStart']> {
    const active = this.activeRecording ?? await this.prepareRecording(request)
    if (active.tabId !== tab.snapshot.tabId) throw new BrowserHostError('recording-conflict', 'Another tab is being recorded')
    const recording = this.activeRecording
    if (!recording) throw new BrowserHostError('execution-failed', 'Recording reservation was lost')
    if (recording.phase === 'prepared') {
      await this.serialize(tab, 'recording.start', async (send) => {
        await send('Page.enable')
        await send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1_600, maxHeight: 1_200, everyNthFrame: 1 })
      })
      recording.phase = 'recording'
      tab.snapshot = { ...tab.snapshot, recording: { recordingId: recording.recordingId, startedAt: recording.startedAt, mimeType: recording.mimeType || 'video/webm' } }
      this.emitTabState(tab)
    }
    return { recordingId: recording.recordingId, tabId: recording.tabId, recording: true, startedAt: recording.startedAt, mimeType: recording.mimeType || 'video/webm', width: recording.width, height: recording.height }
  }

  private async locatorPoint(tab: TabRuntime, send: SendCommand, locator: string): Promise<{ x: number; y: number }> {
    await this.ensurePlaywright(tab, send)
    const result = await this.evaluateValue<{ x?: number; y?: number; notFound?: true; invalidSelector?: true; message?: string }>(tab, send, `(() => { try {
      const injected=globalThis.__forgePlaywrightInjected; const element=injected.querySelector(injected.parseSelector(${JSON.stringify(locator)}),document,true);
      if (!element) return {notFound:true}; const visible=injected.elementState(element,'visible'); const enabled=injected.elementState(element,'enabled');
      if (!visible.matches || !enabled.matches) return {notFound:true}; element.scrollIntoView({block:'center',inline:'center'}); const rect=element.getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    } catch(error) { return {invalidSelector:true,message:String(error)}; } })()`, true, true)
    if (result.invalidSelector) throw new BrowserHostError('invalid-selector', result.message ?? 'Invalid selector')
    if (result.notFound || typeof result.x !== 'number' || typeof result.y !== 'number') throw new BrowserHostError('target-not-found', 'Click target was not found', true)
    return { x: result.x, y: result.y }
  }

  private async ensurePlaywright(tab: TabRuntime, send: SendCommand): Promise<void> {
    const installed = await this.evaluateValue<boolean>(tab, send, 'Boolean(globalThis.__forgePlaywrightInjected)', true, true)
    if (!installed) await this.evaluateValue<boolean>(tab, send, playwrightInjectedRuntimeInstallExpression(), true, true)
  }

  private async measureViewport(tab: TabRuntime, send: SendCommand): Promise<BrowserRenderedViewport> {
    const viewport = await this.evaluateValue<{ width: number; height: number; deviceScaleFactor: number }>(tab, send, '({width:window.innerWidth,height:window.innerHeight,deviceScaleFactor:window.devicePixelRatio})', true, true)
    return {
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height)),
      deviceScaleFactor: Number.isFinite(viewport.deviceScaleFactor) ? viewport.deviceScaleFactor : 1,
    }
  }

  private async serialize<T>(tab: TabRuntime, action: string, use: (send: SendCommand, cleanup: SendCommand) => Promise<T>): Promise<T> {
    const previous = tab.queue.catch(() => undefined)
    let release: () => void = () => undefined
    tab.queue = new Promise<void>((resolve) => { release = resolve })
    await previous
    if (tab.destroyed || tab.webContents.isDestroyed()) { release(); throw new BrowserHostError('tab-not-found', 'Browser tab was destroyed') }
    const epoch = tab.controlEpoch
    const startedAt = new Date(this.now()).toISOString()
    const event: BrowserActionTimelineEntry = { id: `browser-action-${this.now().toString(36)}-${(++this.sequence).toString(36)}`, action, status: 'running', startedAt }
    tab.actionTimeline = [...tab.actionTimeline, event].slice(-ACTION_LIMIT)
    tab.snapshot = { ...tab.snapshot, controller: 'agent' }
    this.emitTabState(tab)
    const send: SendCommand = async (method, params) => {
      if (epoch !== tab.controlEpoch) throw new BrowserHostError('control-interrupted', `Human input interrupted ${action}`, true)
      const result = await this.rawSend(tab)(method, params)
      if (epoch !== tab.controlEpoch) throw new BrowserHostError('control-interrupted', `Human input interrupted ${action}`, true)
      return result
    }
    try {
      await this.ensureDebugger(tab)
      const result = await use(send, this.rawSend(tab))
      this.finishAction(tab, event.id, 'succeeded')
      return result
    } catch (error) {
      this.finishAction(tab, event.id, error instanceof BrowserHostError && error.code === 'control-interrupted' ? 'interrupted' : 'failed', error instanceof BrowserHostError ? error.code : 'execution-failed')
      throw error
    } finally {
      if (!tab.destroyed) {
        tab.snapshot = { ...tab.snapshot, controller: 'none' }
        this.emitTabState(tab)
      }
      release()
    }
  }

  private finishAction(tab: TabRuntime, id: string, status: BrowserActionTimelineEntry['status'], errorCode?: BrowserAutomationErrorCode): void {
    const completedAt = new Date(this.now()).toISOString()
    tab.actionTimeline = tab.actionTimeline.map((event) => event.id === id ? { ...event, status, completedAt, ...(errorCode ? { errorCode } : {}) } : event)
  }

  private rawSend(tab: TabRuntime): SendCommand {
    return async (method, params) => {
      if (tab.destroyed || tab.webContents.isDestroyed()) throw new BrowserHostError('tab-not-found', 'Browser tab was destroyed')
      try { return await tab.webContents.debugger.sendCommand(method, params) }
      catch (error) { throw new BrowserHostError('execution-failed', error instanceof Error ? error.message : `CDP command ${method} failed`, true) }
    }
  }

  private async ensureDebugger(tab: TabRuntime): Promise<void> {
    if (tab.debuggerReady && tab.webContents.debugger.isAttached()) return
    if (tab.debuggerPromise) return tab.debuggerPromise
    if (tab.webContents.debugger.isAttached()) throw new BrowserHostError('execution-failed', 'Browser debugger is attached by another client')
    const listener: DebuggerMessageListener = (_event, method, params) => this.captureDebuggerMessage(tab, method, params)
    tab.debuggerMessage = listener
    tab.webContents.debugger.on('message', listener)
    tab.debuggerPromise = (async () => {
      try {
        tab.webContents.debugger.attach('1.3')
        await Promise.all(['Runtime.enable', 'Accessibility.enable', 'Network.enable', 'Log.enable', 'Page.enable'].map((method) => tab.webContents.debugger.sendCommand(method)))
        tab.debuggerReady = true
      } catch (error) {
        tab.webContents.debugger.off('message', listener)
        tab.debuggerMessage = null
        if (tab.webContents.debugger.isAttached()) tab.webContents.debugger.detach()
        throw new BrowserHostError('execution-failed', error instanceof Error ? error.message : 'Could not attach browser debugger')
      } finally {
        tab.debuggerPromise = null
      }
    })()
    return tab.debuggerPromise
  }

  private attachTabListeners(tab: TabRuntime): void {
    const sync = (): void => { if (!tab.destroyed && !tab.webContents.isDestroyed()) this.syncSnapshot(tab) }
    const loading = (): void => { tab.snapshot = { ...tab.snapshot, lifecycle: 'loading', loading: true }; sync() }
    const stopped = (): void => { tab.snapshot = { ...tab.snapshot, lifecycle: 'ready', loading: false }; sync() }
    const failed = (...args: unknown[]): void => {
      const code = typeof args[1] === 'number' ? args[1] : 0
      if (code === -3) return
      const description = typeof args[2] === 'string' ? args[2] : 'Page failed to load'
      tab.snapshot = { ...tab.snapshot, lifecycle: 'failed', loading: false, error: { code: String(code), message: description } }
    }
    const destroyed = (): void => this.unregisterWebview(tab.snapshot.tabId, tab.webContents.id)
    const willNavigate = (...args: unknown[]): void => {
      const event = args[0] as { preventDefault?: () => void } | undefined
      const url = typeof args[1] === 'string' ? args[1] : ''
      if (url !== 'about:blank' && !isHttpUrl(url)) event?.preventDefault?.()
    }
    for (const [event, listener] of [['did-navigate', sync], ['did-navigate-in-page', sync], ['page-title-updated', sync], ['did-start-loading', loading], ['did-stop-loading', stopped], ['did-fail-load', failed], ['will-navigate', willNavigate], ['destroyed', destroyed]] as Array<[string, (...args: unknown[]) => void]>) {
      tab.webContents.on(event, listener); tab.listeners.push({ event, listener })
    }
    tab.webContents.ipc.on(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, tab.humanInputListener)
    tab.webContents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void tab.webContents.loadURL(url).catch(() => undefined)
      return { action: 'deny' }
    })
  }

  private disposeTabRuntime(tab: TabRuntime, close: boolean): void {
    if (tab.destroyed) return
    tab.destroyed = true
    tab.navigationWait?.interrupt(new BrowserHostError('tab-not-found', 'Browser tab was destroyed', true))
    if (this.activeRecording?.tabId === tab.snapshot.tabId) this.cancelRecording(this.activeRecording.recordingId)
    for (const { event, listener } of tab.listeners) tab.webContents.off(event, listener)
    tab.listeners = []
    tab.webContents.ipc.off(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, tab.humanInputListener)
    if (tab.debuggerMessage) tab.webContents.debugger.off('message', tab.debuggerMessage)
    if (tab.webContents.debugger.isAttached()) {
      try { tab.webContents.debugger.detach() } catch { /* teardown must continue */ }
    }
    tab.debuggerReady = false
    tab.debuggerPromise = null
    if (close && !tab.webContents.isDestroyed()) tab.webContents.close({ waitForBeforeUnload: false })
  }

  private syncSnapshot(tab: TabRuntime): BrowserTabSnapshot {
    if (!tab.webContents.isDestroyed()) {
      tab.snapshot = {
        ...tab.snapshot,
        url: tab.webContents.getURL() || tab.snapshot.url || 'about:blank',
        title: tab.webContents.getTitle() || tab.snapshot.title,
        loading: tab.webContents.isLoading(),
        lifecycle: tab.webContents.isLoading() ? 'loading' : tab.snapshot.lifecycle === 'failed' ? 'failed' : 'ready',
        canGoBack: tab.webContents.navigationHistory.canGoBack(),
        canGoForward: tab.webContents.navigationHistory.canGoForward(),
        zoomFactor: tab.webContents.getZoomFactor(),
        live: true,
        updatedAt: new Date(this.now()).toISOString(),
      }
    }
    this.emitTabState(tab)
    return { ...tab.snapshot }
  }

  private emitTabState(tab: TabRuntime): void {
    this.sendToRenderer(BROWSER_IPC.stateChanged, { ...tab.snapshot })
  }

  private handleGuestInput(tabId: string, value: unknown): void {
    const tab = this.tabs.get(tabId)
    if (!tab || !this.isInputSignal(value)) return
    const now = this.now()
    tab.expectedInputs = tab.expectedInputs.filter((expected) => expected.expiresAt > now)
    const match = tab.expectedInputs.findIndex((expected) => this.inputsMatch(expected.signal, value))
    if (match >= 0) { tab.expectedInputs.splice(match, 1); return }
    tab.controlEpoch += 1
    tab.navigationWait?.interrupt(new BrowserHostError('control-interrupted', 'Human input interrupted navigate', true))
    tab.snapshot = { ...tab.snapshot, controller: 'human', updatedAt: new Date(now).toISOString() }
    this.emitTabState(tab)
    setTimeout(() => {
      if (!tab.destroyed && tab.snapshot.controller === 'human') {
        tab.snapshot = { ...tab.snapshot, controller: 'none', updatedAt: new Date(this.now()).toISOString() }
        this.emitTabState(tab)
      }
    }, 750).unref?.()
  }

  private expectInput(tab: TabRuntime, signal: InputSignal): void {
    const now = this.now()
    tab.expectedInputs = [...tab.expectedInputs.filter((item) => item.expiresAt > now), { signal, expiresAt: now + EXPECTED_INPUT_TTL_MS }]
  }

  private isInputSignal(value: unknown): value is InputSignal {
    if (!value || typeof value !== 'object') return false
    const signal = value as UnknownRecord
    return signal.kind === 'pointer'
      ? typeof signal.x === 'number' && typeof signal.y === 'number' && typeof signal.button === 'number'
      : signal.kind === 'key' && typeof signal.key === 'string' && typeof signal.code === 'string'
  }

  private inputsMatch(left: InputSignal, right: InputSignal): boolean {
    if (left.kind !== right.kind) return false
    return left.kind === 'pointer' && right.kind === 'pointer'
      ? Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1 && left.button === right.button
      : left.kind === 'key' && right.kind === 'key' && left.key === right.key && left.code === right.code
  }

  private captureDebuggerMessage(tab: TabRuntime, method: string, params: UnknownRecord): void {
    const timestamp = new Date(this.now()).toISOString()
    if (method === 'Page.screencastFrame') {
      const sessionId = params.sessionId
      if (typeof sessionId === 'number') void tab.webContents.debugger.sendCommand('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
      const active = this.activeRecording
      const metadata = this.record(params.metadata)
      if (active?.tabId === tab.snapshot.tabId && active.phase === 'recording' && typeof params.data === 'string') {
        this.sendToRenderer(BROWSER_RECORDING_FRAME_CHANNEL, { recordingId: active.recordingId, tabId: active.tabId, data: params.data, width: typeof metadata.deviceWidth === 'number' ? metadata.deviceWidth : active.width, height: typeof metadata.deviceHeight === 'number' ? metadata.deviceHeight : active.height })
      }
      return
    }
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params.args) ? params.args : []
      const text = args.map((arg) => { const item = this.record(arg); return String(item.value ?? item.description ?? '') }).join(' ').slice(0, 8_192)
      this.pushConsole(tab, { level: typeof params.type === 'string' ? params.type : 'log', text, timestamp, source: 'console' })
    } else if (method === 'Runtime.exceptionThrown') {
      const detail = this.record(params.exceptionDetails)
      this.pushConsole(tab, { level: 'error', text: String(detail.text ?? 'Uncaught exception').slice(0, 8_192), timestamp, source: 'exception' })
    } else if (method === 'Log.entryAdded') {
      const entry = this.record(params.entry)
      this.pushConsole(tab, { level: typeof entry.level === 'string' ? entry.level : 'info', text: String(entry.text ?? '').slice(0, 8_192), timestamp, source: typeof entry.source === 'string' ? entry.source : 'log' })
    } else if (method === 'Network.requestWillBeSent' && typeof params.requestId === 'string') {
      const request = this.record(params.request)
      tab.diagnostics.requests.set(params.requestId, { url: String(request.url ?? '').slice(0, 2_048), method: String(request.method ?? 'GET').slice(0, 32) })
    } else if (method === 'Network.responseReceived' && typeof params.requestId === 'string') {
      const request = tab.diagnostics.requests.get(params.requestId)
      const response = this.record(params.response)
      const status = typeof response.status === 'number' ? response.status : null
      if (request && status !== null && status >= 400) this.pushNetwork(tab, { ...request, status, failed: true, timestamp })
    } else if (method === 'Network.loadingFailed' && typeof params.requestId === 'string') {
      const request = tab.diagnostics.requests.get(params.requestId)
      tab.diagnostics.requests.delete(params.requestId)
      if (request) this.pushNetwork(tab, { ...request, status: null, failed: true, errorText: String(params.errorText ?? 'Network request failed').slice(0, 1_024), timestamp })
    } else if (method === 'Network.loadingFinished' && typeof params.requestId === 'string') {
      tab.diagnostics.requests.delete(params.requestId)
    }
    while (tab.diagnostics.requests.size > BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES * 2) tab.diagnostics.requests.delete(tab.diagnostics.requests.keys().next().value as string)
  }

  private pushConsole(tab: TabRuntime, entry: BrowserConsoleEntry): void { tab.diagnostics.consoleEntries = [...tab.diagnostics.consoleEntries, entry].slice(-BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES) }
  private pushNetwork(tab: TabRuntime, entry: BrowserNetworkEntry): void { tab.diagnostics.networkEntries = [...tab.diagnostics.networkEntries, entry].slice(-BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES) }

  private async evaluateRaw(send: SendCommand, expression: string, returnByValue: boolean, awaitPromise: boolean): Promise<UnknownRecord> {
    const response = this.record(await send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: true }))
    if (response.exceptionDetails) {
      const details = this.record(response.exceptionDetails)
      const exception = this.record(details.exception)
      throw new BrowserHostError('evaluation-failed', String(exception.description ?? details.text ?? 'Page evaluation failed').slice(0, 8_192))
    }
    return response
  }

  private async evaluateValue<T>(tab: TabRuntime, send: SendCommand, expression: string, returnByValue: boolean, awaitPromise: boolean): Promise<T> {
    void tab
    const response = await this.evaluateRaw(send, expression, returnByValue, awaitPromise)
    return this.record(response.result).value as T
  }

  private prepareInput(send: SendCommand, runtime: boolean): Promise<unknown[]> {
    return Promise.all([...(runtime ? [send('Runtime.enable')] : []), send('Input.setIgnoreInputEvents', { ignore: false })])
  }

  private boundAccessibility(value: unknown): unknown {
    const root = this.record(value)
    const nodes = Array.isArray(root.nodes) ? root.nodes.slice(0, BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS).map((node) => {
      const item = this.record(node)
      return { nodeId: item.nodeId, ignored: item.ignored, role: item.role, name: item.name, description: item.description, value: item.value, properties: Array.isArray(item.properties) ? item.properties.slice(0, 20) : [] }
    }) : []
    return { nodes }
  }

  private requestTab(request: BrowserAutomationRequest): TabRuntime {
    if (!request.tabId) throw new BrowserHostError('tab-not-found', `Browser ${request.operation} requires a tab`)
    const tab = this.requireTab(request.tabId)
    if (tab.snapshot.sessionAgentId !== request.sessionAgentId || tab.snapshot.profileId !== request.profileId) throw new BrowserHostError('tab-session-mismatch', 'Browser tab does not belong to the requesting session')
    return tab
  }

  private requireTab(tabId: string): TabRuntime {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.destroyed || tab.webContents.isDestroyed()) throw new BrowserHostError('tab-not-found', `Browser tab ${tabId} is not hosted`, true)
    return tab
  }

  private requireRecording(request: BrowserAutomationRequest & { operation: 'recordingStop' }): ActiveRecording {
    const active = this.activeRecording
    if (!active) throw new BrowserHostError('recording-not-found', 'There is no active browser recording')
    if (request.input.recordingId && request.input.recordingId !== active.recordingId) throw new BrowserHostError('recording-not-found', 'The requested browser recording is not active')
    if (request.tabId && request.tabId !== active.tabId) throw new BrowserHostError('recording-not-found', 'The active recording belongs to another tab')
    return active
  }

  private record(value: unknown): UnknownRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {} }

  private errorResponse(request: BrowserAutomationRequest, error: BrowserAutomationFailure, started: number): BrowserAutomationResponse {
    return { requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, ok: false, error, elapsedMs: Math.max(0, this.now() - started), ...(request.tabId && this.tabs.get(request.tabId) ? { updatedTab: { ...this.tabs.get(request.tabId)!.snapshot } } : {}) }
  }

  private delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
}

type SendCommand = (method: string, params?: UnknownRecord) => Promise<unknown>
