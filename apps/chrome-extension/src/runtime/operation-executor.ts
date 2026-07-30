import {
  BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES,
  BROWSER_AUTOMATION_MAX_EVALUATE_BYTES,
  BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS,
  BROWSER_AUTOMATION_MAX_SAFE_ACTIONS,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH,
  BROWSER_VIEWPORT_MAX_DIMENSION,
  EXTERNAL_CHROME_MAX_NEGOTIATED_MESSAGE_BYTES,
  EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES,
  EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES,
  externalChromeScreenshotOverflowDetails,
  type BrowserActionTimelineEntry,
  type BrowserAutomationErrorCode,
  type BrowserAutomationFailure,
  type BrowserAutomationOperation,
  type BrowserAutomationResultByOperation,
  type BrowserConsoleEntry,
  type BrowserNetworkEntry,
  type ExternalChromeExecuteParams,
} from '@forge/protocol'
import type { ChromeTab } from './chrome-api.js'
import { DebuggerController, type DebuggerRoute } from './debugger-controller.js'
import type { SyntheticTrustedEventSignature } from './human-control.js'

const POLL_MS = 50
const MAX_OPERATION_RESULT_BYTES = EXTERNAL_CHROME_MAX_NEGOTIATED_MESSAGE_BYTES - EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES
const MAX_AX_NODES = 200

type ExecuteSuccess = { ok: true; result: BrowserAutomationResultByOperation[BrowserAutomationOperation] }
type ExecuteFailure = { ok: false; error: BrowserAutomationFailure }
export type ExternalChromeOperationOutcome = ExecuteSuccess | ExecuteFailure

interface OperationAuthority {
  isCurrent(): boolean
  wasHumanInterrupted(): boolean
  navigationGeneration: number
  /** Revokes lease authority, detaches, and settles all outstanding CDP work. */
  cancelOutstanding(): Promise<void>
  /** Brackets only the actual CDP input dispatch with its exact trusted DOM event sequence. */
  beginSyntheticInput?(expectedEvents: readonly SyntheticTrustedEventSignature[]): Promise<void>
  endSyntheticInput?(): void
}

interface LocatedPoint {
  route: DebuggerRoute
  x: number
  y: number
  editable?: boolean
}

interface LocatorSpec { kind: 'css' | 'text' | 'role'; value: string; name?: string }

export class ExternalChromeOperationError extends Error {
  constructor(
    readonly code: BrowserAutomationErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, string | number | boolean | null>,
  ) { super(message); this.name = 'ExternalChromeOperationError' }

  failure(): BrowserAutomationFailure {
    return { code: this.code, message: this.message.slice(0, 1_024), retryable: this.retryable, ...(this.details ? { details: this.details } : {}) }
  }
}

export class ExternalChromeOperationExecutor {
  private readonly queues = new Map<number, Promise<void>>()
  private readonly consoleByTab = new Map<number, BrowserConsoleEntry[]>()
  private readonly networkByTab = new Map<number, BrowserNetworkEntry[]>()
  private readonly requestsByTab = new Map<number, Map<string, { url: string; method: string }>>()
  private readonly actionsByTab = new Map<number, BrowserActionTimelineEntry[]>()
  private actionSequence = 0

  constructor(
    private readonly debuggers: DebuggerController,
    private readonly getTab: (tabId: number) => Promise<ChromeTab>,
    private readonly now: () => number = Date.now,
  ) {}

  runExclusive<Value>(tabId: number, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.queues.get(tabId) ?? Promise.resolve()
    const work = previous.then(operation, operation)
    const tail = work.then(() => undefined, () => undefined)
    this.queues.set(tabId, tail)
    void tail.finally(() => { if (this.queues.get(tabId) === tail) this.queues.delete(tabId) })
    return work
  }

  execute(params: ExternalChromeExecuteParams, authority: OperationAuthority): Promise<ExternalChromeOperationOutcome> {
    return this.runExclusive(params.tabId, () => this.executeNow(params, authority))
  }

  executeNow(params: ExternalChromeExecuteParams, authority: OperationAuthority): Promise<ExternalChromeOperationOutcome> {
    return this.executeUnlocked(params, authority)
  }

  onCdpEvent(tabId: number, route: DebuggerRoute, method: string, raw: unknown): void {
    const params = record(raw)
    if (method === 'Runtime.consoleAPICalled') {
      const text = Array.isArray(params.args)
        ? params.args.map((entry) => {
          const value = record(entry)
          return typeof value.value === 'string' ? value.value : typeof value.description === 'string' ? value.description : String(value.value ?? '')
        }).join(' ').slice(0, 4_096)
        : ''
      this.pushBounded(this.consoleByTab, tabId, {
        level: typeof params.type === 'string' ? params.type : 'log', text,
        timestamp: new Date(typeof params.timestamp === 'number' ? params.timestamp : this.now()).toISOString(),
        ...(route.sessionId ? { source: `frame:${route.targetId}` } : {}),
      })
      return
    }
    if (method === 'Network.requestWillBeSent' && typeof params.requestId === 'string') {
      const request = record(params.request)
      const requests = this.requestsByTab.get(tabId) ?? new Map()
      requests.set(params.requestId, {
        url: typeof request.url === 'string' ? request.url.slice(0, 2_048) : '',
        method: typeof request.method === 'string' ? request.method.slice(0, 128) : 'GET',
      })
      if (requests.size > BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES) requests.delete(requests.keys().next().value as string)
      this.requestsByTab.set(tabId, requests)
      return
    }
    if ((method === 'Network.responseReceived' || method === 'Network.loadingFailed') && typeof params.requestId === 'string') {
      const request = this.requestsByTab.get(tabId)?.get(params.requestId)
      const response = record(params.response)
      this.pushBounded(this.networkByTab, tabId, {
        url: (request?.url ?? (typeof response.url === 'string' ? response.url : '')).slice(0, 2_048),
        method: request?.method ?? 'GET',
        status: typeof response.status === 'number' && Number.isFinite(response.status) ? Math.max(0, Math.min(999, Math.trunc(response.status))) : null,
        failed: method === 'Network.loadingFailed',
        ...(typeof params.errorText === 'string' ? { errorText: params.errorText.slice(0, 1_024) } : {}),
        timestamp: new Date(this.now()).toISOString(),
      })
      this.requestsByTab.get(tabId)?.delete(params.requestId)
    }
  }

  clear(tabId: number): void {
    // Never delete the serialization tail here: release/loss may race an active command,
    // and a new claim must not bypass that command before debugger reset settles it.
    this.consoleByTab.delete(tabId)
    this.networkByTab.delete(tabId)
    this.requestsByTab.delete(tabId)
    this.actionsByTab.delete(tabId)
  }

  private async executeUnlocked(params: ExternalChromeExecuteParams, authority: OperationAuthority): Promise<ExternalChromeOperationOutcome> {
    const started = this.now()
    const actionId = `external-action-${++this.actionSequence}`
    const timeline: BrowserActionTimelineEntry = { id: actionId, action: params.operation, status: 'running', startedAt: new Date(started).toISOString() }
    this.pushBounded(this.actionsByTab, params.tabId, timeline, BROWSER_AUTOMATION_MAX_SAFE_ACTIONS)
    try {
      this.assertCurrent(params, authority)
      let result: BrowserAutomationResultByOperation[BrowserAutomationOperation]
      switch (params.operation) {
        case 'snapshot': result = await this.snapshot(params, authority); break
        case 'click': result = await this.click(params, authority); break
        case 'type': result = await this.type(params, authority); break
        case 'press': result = await this.press(params, authority); break
        case 'scroll': result = await this.scroll(params, authority); break
        case 'evaluate': result = await this.evaluate(params, authority); break
        case 'waitFor': result = await this.waitFor(params, authority); break
        default: throw new ExternalChromeOperationError('unsupported-operation', `External Chrome does not implement ${params.operation}.`)
      }
      const resultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
      // Snapshot responses are adaptively compacted against the complete native
      // JSON-RPC envelope by NativeRpcClient after this operation returns.
      if (params.operation !== 'snapshot' && resultBytes > MAX_OPERATION_RESULT_BYTES) {
        throw new ExternalChromeOperationError('response-too-large', 'External Chrome result exceeds the bounded native relay payload.', false, {
          resultBytes, maximumBytes: MAX_OPERATION_RESULT_BYTES,
        })
      }
      this.assertCurrent(params, authority)
      Object.assign(timeline, { status: 'succeeded', completedAt: new Date(this.now()).toISOString() })
      return { ok: true, result }
    } catch (error) {
      const normalized = this.normalizeError(error, params, authority)
      Object.assign(timeline, {
        status: normalized.code === 'control-interrupted' || normalized.code === 'request-cancelled' ? 'interrupted' : 'failed',
        completedAt: new Date(this.now()).toISOString(), errorCode: normalized.code,
      })
      return { ok: false, error: normalized.failure() }
    }
  }

  private async snapshot(params: Extract<ExternalChromeExecuteParams, { operation: 'snapshot' }>, authority: OperationAuthority): Promise<BrowserAutomationResultByOperation['snapshot']> {
    const routes = this.debuggers.routes(params.tabId)
    if (routes.length === 0) throw new ExternalChromeOperationError('debugger-unavailable', 'The leased tab debugger is not attached.', true)
    await Promise.all([
      this.command(params, authority, routes[0]!, 'Page.enable'),
      ...routes.flatMap((route) => [
        this.command(params, authority, route, 'Runtime.enable'),
        this.command(params, authority, route, 'Network.enable'),
        this.command(params, authority, route, 'Accessibility.enable'),
      ]),
    ])
    const pages = await Promise.all(routes.map(async (route) => {
      const response = await this.evaluateValue(params, authority, route, snapshotExpression())
      const transform = await this.topLevelTransform(params, authority, route)
      return { route, transform, ...objectValue(response, 'Snapshot DOM result') as SnapshotPage }
    }))
    const root = pages[0]
    if (!root || typeof root.url !== 'string' || typeof root.title !== 'string') {
      throw new ExternalChromeOperationError('execution-failed', 'Chrome returned an invalid snapshot document.', true)
    }
    const metrics = record(await this.command(params, authority, routes[0]!, 'Page.getLayoutMetrics'))
    const visual = record(metrics.cssVisualViewport)
    const width = positiveInteger(visual.clientWidth, 1)
    const height = positiveInteger(visual.clientHeight, 1)
    if (width > BROWSER_VIEWPORT_MAX_DIMENSION || height > BROWSER_VIEWPORT_MAX_DIMENSION) {
      throw new ExternalChromeOperationError('response-too-large', 'The actual External Chrome CSS viewport exceeds the shared snapshot dimension bound.', false, {
        limitation: 'external-chrome-viewport-dimension-bound', viewportWidth: width, viewportHeight: height, maximumDimension: BROWSER_VIEWPORT_MAX_DIMENSION,
      })
    }
    const rawDeviceScaleFactor = await this.evaluateValue(params, authority, routes[0]!, 'window.devicePixelRatio')
    if (typeof rawDeviceScaleFactor !== 'number' || !Number.isFinite(rawDeviceScaleFactor) || rawDeviceScaleFactor < 0.1 || rawDeviceScaleFactor > 16) {
      throw new ExternalChromeOperationError('execution-failed', 'Chrome returned an invalid root document device pixel ratio.', true)
    }
    const deviceScaleFactor = rawDeviceScaleFactor
    const scale = Math.min(1, BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH / width)
    const capture = record(await this.command(params, authority, routes[0]!, 'Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
      clip: { x: finiteNumber(visual.pageX, 0), y: finiteNumber(visual.pageY, 0), width, height, scale },
    }))
    if (typeof capture.data !== 'string' || capture.data.length === 0) throw new ExternalChromeOperationError('execution-failed', 'Chrome returned an empty screenshot.', true)
    const bytes = base64Bytes(capture.data)
    if (bytes === 0) throw new ExternalChromeOperationError('execution-failed', 'Chrome returned an empty screenshot.', true)
    if (bytes > EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES) {
      throw new ExternalChromeOperationError(
        'response-too-large',
        'External Chrome screenshot exceeds the decoded PNG byte limit.',
        false,
        externalChromeScreenshotOverflowDetails(
          bytes,
          'decoded-png',
          EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES,
          'decoded-png',
        ),
      )
    }
    const dimensions = pngDimensions(capture.data) ?? { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
    const axResults = await Promise.all(routes.map((route) => this.command(params, authority, route, 'Accessibility.getFullAXTree').catch(() => ({ nodes: [] }))))
    const accessibility = {
      frames: axResults.map((value, index) => ({
        targetId: routes[index]!.targetId,
        nodes: boundedJsonArray(record(value).nodes, MAX_AX_NODES),
      })).slice(0, routes.length),
    }
    const visibleText = pages.map((page) => typeof page.visibleText === 'string' ? page.visibleText : '').filter(Boolean).join('\n').slice(0, BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH)
    const interactiveElements = pages.flatMap((page) => Array.isArray(page.interactiveElements)
      ? page.interactiveElements.filter(validSnapshotElement).map((element) => ({
        ...element, x: element.x + page.transform.x, y: element.y + page.transform.y,
      }))
      : []).slice(0, BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS)
    return {
      tabId: String(params.tabId), url: root.url.slice(0, 2_048), title: root.title.slice(0, 512), loading: root.loading === true,
      viewportSetting: { mode: 'fill' }, viewport: { width, height, deviceScaleFactor }, visibleText, interactiveElements,
      accessibility,
      consoleEntries: (this.consoleByTab.get(params.tabId) ?? []).slice(-BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      networkEntries: (this.networkByTab.get(params.tabId) ?? []).slice(-BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      actionTimeline: (this.actionsByTab.get(params.tabId) ?? []).slice(-BROWSER_AUTOMATION_MAX_SAFE_ACTIONS),
      screenshot: { mimeType: 'image/png', data: capture.data, width: dimensions.width, height: dimensions.height },
    }
  }

  private async click(params: Extract<ExternalChromeExecuteParams, { operation: 'click' }>, authority: OperationAuthority): Promise<BrowserAutomationResultByOperation['click']> {
    const input = params.input as ({ x: number; y: number; timeoutMs: number } | { locator: string; timeoutMs: number } | { selector: string; timeoutMs: number })
    let point: LocatedPoint
    if ('x' in input) {
      const route = this.debuggers.routes(params.tabId)[0]
      if (!route) throw new ExternalChromeOperationError('debugger-unavailable', 'The leased tab debugger is not attached.', true)
      const viewport = await this.routeViewport(params, authority, route)
      if (input.x < 0 || input.y < 0 || input.x >= viewport.width || input.y >= viewport.height) {
        throw new ExternalChromeOperationError('coordinates-outside-viewport', 'Click coordinates are outside the actual CSS viewport.', false, { x: input.x, y: input.y, viewportWidth: viewport.width, viewportHeight: viewport.height })
      }
      point = { route, x: input.x, y: input.y }
    } else {
      const spec = parseLocator('locator' in input ? input.locator : `css=${input.selector}`)
      point = await this.pollLocator(params, authority, spec, input.timeoutMs, 'click')
    }
    let syntheticInput = false
    try {
      await authority.beginSyntheticInput?.(pointerClickSequence(point.x, point.y))
      syntheticInput = true
      await this.command(params, authority, point.route, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
      await this.command(params, authority, point.route, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await this.command(params, authority, point.route, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    } finally {
      if (syntheticInput) authority.endSyntheticInput?.()
    }
    return { tabId: String(params.tabId), point: { x: point.x, y: point.y } }
  }

  private async type(params: Extract<ExternalChromeExecuteParams, { operation: 'type' }>, authority: OperationAuthority): Promise<BrowserAutomationResultByOperation['type']> {
    const input = params.input
    let route = this.debuggers.routes(params.tabId)[0]
    if (!route) throw new ExternalChromeOperationError('debugger-unavailable', 'The leased tab debugger is not attached.', true)
    if (input.locator || input.selector) {
      const point = await this.pollLocator(params, authority, parseLocator(input.locator ?? `css=${input.selector}`), input.timeoutMs, 'type', input.clear)
      route = point.route
      if (!point.editable) throw new ExternalChromeOperationError('target-not-editable', 'Type target is disabled, read-only, or not editable.')
    } else {
      const routes = this.debuggers.routes(params.tabId)
      const probes = await Promise.all(routes.map(async (candidate) => ({
        route: candidate,
        focused: objectValue(await this.evaluateValue(params, authority, candidate, focusedEditableExpression(input.clear)), 'Focused target result') as { found?: boolean; editable?: boolean },
      })))
      const editable = probes.find((probe) => probe.focused.editable === true)
      if (!editable) {
        if (!probes.some((probe) => probe.focused.found)) throw new ExternalChromeOperationError('target-not-found', 'No focused type target was found.', true)
        throw new ExternalChromeOperationError('target-not-editable', 'The focused target is not editable.')
      }
      // Prove the focused child still belongs to the root immediately before input.
      route = (await this.topLevelTransform(params, authority, editable.route)).route
    }
    if (input.text.length > 0) {
      let syntheticInput = false
      try {
        // insertText emits beforeinput/input rather than one of the trusted physical-input
        // sentinels. An empty expectation means any interleaved trusted event interrupts.
        await authority.beginSyntheticInput?.([])
        syntheticInput = true
        await this.command(params, authority, route, 'Input.insertText', { text: input.text })
      } finally {
        if (syntheticInput) authority.endSyntheticInput?.()
      }
    }
    return { tabId: String(params.tabId), characters: [...input.text].length, cleared: input.clear }
  }

  private async press(params: Extract<ExternalChromeExecuteParams, { operation: 'press' }>, authority: OperationAuthority): Promise<BrowserAutomationResultByOperation['press']> {
    const route = this.debuggers.routes(params.tabId)[0]
    if (!route) throw new ExternalChromeOperationError('debugger-unavailable', 'The leased tab debugger is not attached.', true)
    const input = params.input
    const event = keyEvent(input.key, input.modifiers ?? [])
    let down = false
    let syntheticInput = false
    try {
      await authority.beginSyntheticInput?.(keyPressSequence(event.down))
      syntheticInput = true
      await this.command(params, authority, route, 'Input.dispatchKeyEvent', { type: 'keyDown', ...event.down })
      down = true
      await this.command(params, authority, route, 'Input.dispatchKeyEvent', { type: 'keyUp', ...event.up })
      down = false
    } finally {
      if (down) await this.debuggers.sendCommand(params.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...event.up }, route.sessionId).catch(() => undefined)
      if (syntheticInput) authority.endSyntheticInput?.()
    }
    return { tabId: String(params.tabId), key: input.key, modifiers: input.modifiers ?? [] }
  }

  private async scroll(params: Extract<ExternalChromeExecuteParams, { operation: 'scroll' }>, authority: OperationAuthority): Promise<BrowserAutomationResultByOperation['scroll']> {
    const input = params.input
    const deltaX = input.deltaX ?? 0
    const deltaY = input.deltaY ?? 0
    if (input.locator || input.selector) {
      const match = await this.resolveLocator(params, authority, parseLocator(input.locator ?? `css=${input.selector}`), 'scroll', false, deltaX, deltaY)
      if (match.kind === 'invalid-selector') throw new ExternalChromeOperationError('invalid-selector', match.message ?? 'Invalid CSS selector.')
      const matchCount = match.count ?? 0
      if (matchCount === 0) throw new ExternalChromeOperationError('target-not-found', 'Scroll target was not found.', true)
      if (matchCount > 1) throw ambiguity(matchCount)
      return { tabId: String(params.tabId), deltaX, deltaY, scrollX: finiteNumber(match.scrollX, 0), scrollY: finiteNumber(match.scrollY, 0) }
    }
    const route = this.debuggers.routes(params.tabId)[0]
    if (!route) throw new ExternalChromeOperationError('debugger-unavailable', 'The leased tab debugger is not attached.', true)
    const value = objectValue(await this.evaluateValue(params, authority, route, windowScrollExpression(deltaX, deltaY)), 'Scroll result') as LocatorResult
    return { tabId: String(params.tabId), deltaX, deltaY, scrollX: finiteNumber(value.scrollX, 0), scrollY: finiteNumber(value.scrollY, 0) }
  }

  private async evaluate(params: Extract<ExternalChromeExecuteParams, { operation: 'evaluate' }>, authority: OperationAuthority): Promise<BrowserAutomationResultByOperation['evaluate']> {
    const route = this.debuggers.routes(params.tabId)[0]
    if (!route) throw new ExternalChromeOperationError('debugger-unavailable', 'The leased tab debugger is not attached.', true)
    const response = record(await this.command(params, authority, route, 'Runtime.evaluate', {
      expression: params.input.expression, awaitPromise: params.input.awaitPromise, returnByValue: params.input.returnByValue,
      // Arbitrary evaluation never receives transient user activation. Synthetic input has its
      // own narrowly bracketed CDP path and trusted-input acknowledgement.
      userGesture: false, generatePreview: false,
    }, true))
    if (response.exceptionDetails !== undefined) throw new ExternalChromeOperationError('evaluation-failed', safeException(response.exceptionDetails), false)
    const remote = record(response.result)
    if (params.input.returnByValue) {
      if (typeof remote.unserializableValue === 'string') {
        throw new ExternalChromeOperationError('evaluation-failed', 'Evaluation result is not representable as bounded JSON.')
      }
      const value = remote.value
      let serialized: string
      try { serialized = JSON.stringify(value) ?? 'null' } catch { throw new ExternalChromeOperationError('evaluation-failed', 'Evaluation result is not JSON serializable.') }
      const serializedBytes = new TextEncoder().encode(serialized).byteLength
      if (serializedBytes > BROWSER_AUTOMATION_MAX_EVALUATE_BYTES) throw new ExternalChromeOperationError('result-too-large', 'Evaluation result exceeds 64 KiB.')
      return { tabId: String(params.tabId), value, serializedBytes }
    }
    return {
      tabId: String(params.tabId), serializedBytes: 0,
      remoteObject: {
        type: typeof remote.type === 'string' ? remote.type : 'undefined',
        ...(typeof remote.subtype === 'string' ? { subtype: remote.subtype } : {}),
        ...(typeof remote.description === 'string' ? { description: remote.description.slice(0, 1_024) } : {}),
        ...(typeof remote.objectId === 'string' ? { objectId: remote.objectId.slice(0, 128) } : {}),
      },
    }
  }

  private async waitFor(params: Extract<ExternalChromeExecuteParams, { operation: 'waitFor' }>, authority: OperationAuthority): Promise<BrowserAutomationResultByOperation['waitFor']> {
    const started = this.now()
    const deadline = Math.min(Date.parse(params.deadlineAt), started + params.input.timeoutMs)
    const locator = params.input.locator ?? (params.input.selector ? `css=${params.input.selector}` : undefined)
    const spec = locator ? parseLocator(locator) : undefined
    while (this.now() <= deadline) {
      this.assertCurrent(params, authority)
      let locatorMatched = true
      if (spec) {
        const match = await this.resolveLocator(params, authority, spec, 'probe')
        if (match.kind === 'invalid-selector') throw new ExternalChromeOperationError('invalid-selector', match.message ?? 'Invalid CSS selector.')
        locatorMatched = (match.count ?? 0) > 0
      }
      const routes = this.debuggers.routes(params.tabId)
      const textMatched = params.input.text === undefined || (await Promise.all(routes.map((route) => this.evaluateValue(params, authority, route, bodyTextExpression(params.input.text!))))).some(Boolean)
      const tab = await this.getTab(params.tabId)
      const urlMatched = params.input.urlIncludes === undefined || (tab.url ?? '').includes(params.input.urlIncludes)
      if (locatorMatched && textMatched && urlMatched) return { tabId: String(params.tabId), matched: true, elapsedMs: this.now() - started }
      await delay(Math.min(POLL_MS, Math.max(1, deadline - this.now())))
    }
    throw new ExternalChromeOperationError('timeout', 'Wait conditions did not match before the deadline.', true)
  }

  private async pollLocator(
    params: ExternalChromeExecuteParams,
    authority: OperationAuthority,
    spec: LocatorSpec,
    timeoutMs: number,
    mode: 'click' | 'type',
    clear = false,
  ): Promise<LocatedPoint> {
    const deadline = Math.min(Date.parse(params.deadlineAt), this.now() + timeoutMs)
    while (this.now() <= deadline) {
      const result = await this.resolveLocator(params, authority, spec, mode, clear)
      if (result.kind === 'invalid-selector') throw new ExternalChromeOperationError('invalid-selector', result.message ?? 'Invalid CSS selector.')
      const matchCount = result.count ?? 0
      if (matchCount > 1) throw ambiguity(matchCount)
      if (matchCount === 1 && result.route && typeof result.x === 'number' && typeof result.y === 'number') {
        return { route: result.route, x: result.x, y: result.y, ...(typeof result.editable === 'boolean' ? { editable: result.editable } : {}) }
      }
      await delay(Math.min(POLL_MS, Math.max(1, deadline - this.now())))
    }
    throw new ExternalChromeOperationError('target-not-found', `${mode === 'click' ? 'Click' : 'Type'} target was not found before timeout.`, true)
  }

  private async resolveLocator(
    params: ExternalChromeExecuteParams,
    authority: OperationAuthority,
    spec: LocatorSpec,
    mode: 'click' | 'type' | 'scroll' | 'probe',
    clear = false,
    deltaX = 0,
    deltaY = 0,
  ): Promise<LocatorResult & { route?: DebuggerRoute }> {
    const routes = this.debuggers.routes(params.tabId)
    const results = await Promise.all(routes.map(async (route) => {
      const value = objectValue(await this.evaluateValue(params, authority, route, locatorExpression(spec, mode, clear, deltaX, deltaY)), 'Locator result') as LocatorResult
      if ((value.count ?? 0) <= 0) return { route, ...value }
      const transform = await this.topLevelTransform(params, authority, route)
      return {
        route: transform.route, ...value,
        ...(typeof value.x === 'number' ? { x: value.x + transform.x } : {}),
        ...(typeof value.y === 'number' ? { y: value.y + transform.y } : {}),
      }
    }))
    const invalid = results.find((entry) => entry.kind === 'invalid-selector')
    if (invalid) return invalid
    const count = results.reduce((sum, entry) => sum + Math.max(0, Math.trunc(entry.count ?? 0)), 0)
    const match = results.find((entry) => (entry.count ?? 0) > 0)
    return { ...(match ?? { kind: 'match' }), count, ...(match ? { route: match.route } : {}) }
  }

  private async evaluateValue(params: ExternalChromeExecuteParams, authority: OperationAuthority, route: DebuggerRoute, expression: string): Promise<unknown> {
    const response = record(await this.command(params, authority, route, 'Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: false, generatePreview: false,
    }))
    if (response.exceptionDetails !== undefined) throw new ExternalChromeOperationError('execution-failed', safeException(response.exceptionDetails), true)
    return record(response.result).value
  }

  private async topLevelTransform(
    params: ExternalChromeExecuteParams,
    authority: OperationAuthority,
    route: DebuggerRoute,
  ): Promise<{ route: DebuggerRoute; x: number; y: number }> {
    const chain = this.debuggers.routeChain(params.tabId, route)
    if (chain.length === 0 || chain[0]?.targetId !== route.targetId) {
      throw new ExternalChromeOperationError('request-cancelled', 'Frame ancestry changed before coordinates could be proven.', true, { reason: 'frame-migrated' })
    }
    let x = 0
    let y = 0
    for (let index = 0; index < chain.length - 1; index += 1) {
      const child = chain[index]!
      const parent = chain[index + 1]!
      const owner = record(await this.command(params, authority, parent, 'DOM.getFrameOwner', { frameId: child.targetId }))
      const backendNodeId = owner.backendNodeId
      if (!Number.isSafeInteger(backendNodeId)) {
        throw new ExternalChromeOperationError('request-cancelled', 'Chrome could not prove the child frame owner.', true, { reason: 'unknown-frame-ancestry' })
      }
      const model = record(await this.command(params, authority, parent, 'DOM.getBoxModel', { backendNodeId }))
      const content = record(model.model).content
      if (!Array.isArray(content) || content.length < 8 || content.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new ExternalChromeOperationError('request-cancelled', 'Chrome returned an invalid frame-owner transform.', true, { reason: 'unknown-frame-transform' })
      }
      x += content[0] as number
      y += content[1] as number
    }
    const root = chain.at(-1)
    if (!root || root.sessionId !== undefined) {
      throw new ExternalChromeOperationError('request-cancelled', 'Frame route did not terminate at the leased root.', true, { reason: 'unknown-frame-ancestry' })
    }
    return { route: root, x, y }
  }

  private async routeViewport(params: ExternalChromeExecuteParams, authority: OperationAuthority, route: DebuggerRoute): Promise<{ width: number; height: number }> {
    const metrics = record(await this.command(params, authority, route, 'Page.getLayoutMetrics'))
    const viewport = record(metrics.cssVisualViewport)
    return { width: positiveInteger(viewport.clientWidth, 1), height: positiveInteger(viewport.clientHeight, 1) }
  }

  private async command(
    params: ExternalChromeExecuteParams,
    authority: OperationAuthority,
    route: DebuggerRoute,
    method: string,
    commandParams?: Record<string, unknown>,
    terminateOnTimeout = false,
  ): Promise<unknown> {
    this.assertCurrent(params, authority)
    const deadline = Date.parse(params.deadlineAt)
    const remaining = deadline - this.now()
    if (remaining <= 0) throw new ExternalChromeOperationError('timeout', 'External Chrome operation deadline elapsed.', true)
    let timer: ReturnType<typeof setTimeout> | undefined
    let authorityTimer: ReturnType<typeof setInterval> | undefined
    const command = this.debuggers.sendCommand(params.tabId, method, commandParams, route.sessionId)
    try {
      const result = await Promise.race([
        command,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ExternalChromeOperationError('timeout', `${method} exceeded the operation deadline.`, true)), remaining) }),
        new Promise<never>((_resolve, reject) => {
          authorityTimer = setInterval(() => {
            try { this.assertCurrent(params, authority) } catch (error) { reject(error) }
          }, Math.min(25, Math.max(1, remaining)))
        }),
      ])
      this.assertCurrent(params, authority)
      return result
    } catch (error) {
      if (error instanceof ExternalChromeOperationError &&
        (error.code === 'timeout' || error.code === 'control-interrupted' || error.code === 'request-cancelled')) {
        // Termination is advisory; it must not delay the authoritative debugger
        // detach if Chrome also stalls the termination command itself.
        if (terminateOnTimeout) void this.debuggers.sendCommand(params.tabId, 'Runtime.terminateExecution', {}, route.sessionId).catch(() => undefined)
        await authority.cancelOutstanding()
        // Debugger detach is the cancellation acknowledgement. Do not release the
        // per-tab queue until Chrome has settled the original command callback.
        await command.catch(() => undefined)
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (authorityTimer) clearInterval(authorityTimer)
    }
  }

  private assertCurrent(params: ExternalChromeExecuteParams, authority: OperationAuthority): void {
    if (Date.parse(params.deadlineAt) <= this.now()) throw new ExternalChromeOperationError('timeout', 'External Chrome operation deadline elapsed.', true)
    if (this.debuggers.navigationGeneration(params.tabId) !== authority.navigationGeneration) {
      throw new ExternalChromeOperationError('request-cancelled', 'Page navigation cancelled the stale operation.', true, { reason: 'navigation' })
    }
    if (!authority.isCurrent()) {
      if (authority.wasHumanInterrupted()) throw new ExternalChromeOperationError('control-interrupted', 'Trusted human input interrupted the operation.', true)
      throw new ExternalChromeOperationError('request-cancelled', 'Lease or debugger authority changed during the operation.', true)
    }
  }

  private normalizeError(error: unknown, params: ExternalChromeExecuteParams, authority: OperationAuthority): ExternalChromeOperationError {
    if (error instanceof ExternalChromeOperationError) return error
    if (!authority.isCurrent()) return authority.wasHumanInterrupted()
      ? new ExternalChromeOperationError('control-interrupted', 'Trusted human input interrupted the operation.', true)
      : new ExternalChromeOperationError('request-cancelled', 'Lease authority changed during the operation.', true)
    const message = error instanceof Error ? error.message : String(error)
    if (/detached|not attached|No tab with given id/iu.test(message)) return new ExternalChromeOperationError('lease-lost', 'The leased debugger target was detached.', true)
    if (/timeout|timed out/iu.test(message)) return new ExternalChromeOperationError('timeout', 'External Chrome operation timed out.', true)
    return new ExternalChromeOperationError(params.operation === 'evaluate' ? 'evaluation-failed' : 'execution-failed', message.slice(0, 1_024), true)
  }

  private pushBounded<T>(map: Map<number, T[]>, tabId: number, value: T, maximum = BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES): void {
    const values = map.get(tabId) ?? []
    values.push(value)
    if (values.length > maximum) values.splice(0, values.length - maximum)
    map.set(tabId, values)
  }
}

interface LocatorResult {
  kind?: 'match' | 'invalid-selector'
  count?: number
  message?: string
  x?: number
  y?: number
  editable?: boolean
  scrollX?: number
  scrollY?: number
}
interface SnapshotPage { url?: string; title?: string; loading?: boolean; visibleText?: string; interactiveElements?: unknown[] }

function parseLocator(locator: string): LocatorSpec {
  if (locator.startsWith('css=')) {
    const value = locator.slice(4)
    if (!value) throw new ExternalChromeOperationError('invalid-selector', 'CSS locator is empty.')
    return { kind: 'css', value }
  }
  if (locator.startsWith('text=')) {
    const value = unquote(locator.slice(5).trim())
    if (!value) throw new ExternalChromeOperationError('invalid-selector', 'Text locator is empty.')
    return { kind: 'text', value }
  }
  if (locator.startsWith('role=')) {
    const body = locator.slice(5).trim()
    const match = /^([a-z][a-z0-9_-]*)(?:\[name=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\]]+)\])?$/iu.exec(body)
    if (!match) throw new ExternalChromeOperationError('invalid-selector', 'Role locator must use role=<role>[name=<name>].')
    return { kind: 'role', value: match[1]!.toLowerCase(), ...(match[2] ? { name: unquote(match[2].trim()) } : {}) }
  }
  throw new ExternalChromeOperationError('invalid-selector', 'External Chrome semantic locators must use role=, text=, or css=.', false, { limitation: 'external-chrome-locator-syntax-v1' })
}

function locatorExpression(spec: LocatorSpec, mode: string, clear: boolean, deltaX: number, deltaY: number): string {
  return `(() => {
    const spec=${JSON.stringify(spec)}, mode=${JSON.stringify(mode)}, shouldClear=${JSON.stringify(clear)};
    const normalize=value=>String(value??'').replace(/\\s+/g,' ').trim();
    const inferredRole=element=>element.getAttribute('role')||({A:'link',BUTTON:'button',TEXTAREA:'textbox',SELECT:'combobox'}[element.tagName])||(element.tagName==='INPUT'?(({button:'button',submit:'button',reset:'button',checkbox:'checkbox',radio:'radio',range:'slider'}[element.type])||'textbox'):null);
    const name=element=>normalize(element.getAttribute('aria-label')||element.getAttribute('title')||(element.labels&&Array.from(element.labels).map(label=>label.innerText).join(' '))||element.getAttribute('alt')||element.innerText||element.getAttribute('value')||element.getAttribute('name'));
    const documents=[]; const visit=(doc,offsetX,offsetY)=>{ if(!doc||documents.length>=32)return; documents.push({doc,offsetX,offsetY}); for(const frame of Array.from(doc.querySelectorAll('iframe,frame'))){ try{const child=frame.contentDocument;if(child){const rect=frame.getBoundingClientRect();visit(child,offsetX+rect.left,offsetY+rect.top);}}catch{}} }; visit(document,0,0);
    let matches=[];
    try { for(const entry of documents){ let elements;
      if(spec.kind==='css') elements=Array.from(entry.doc.querySelectorAll(spec.value));
      else if(spec.kind==='role') elements=Array.from(entry.doc.querySelectorAll('*')).filter(element=>inferredRole(element)===spec.value&&(!spec.name||name(element)===normalize(spec.name)));
      else { const query=normalize(spec.value); elements=Array.from(entry.doc.querySelectorAll('body *')).filter(element=>normalize(element.innerText).includes(query)&&!Array.from(element.children).some(child=>normalize(child.innerText).includes(query))); }
      for(const element of elements){ const style=element.ownerDocument.defaultView.getComputedStyle(element); const rect=element.getBoundingClientRect(); if(style.visibility==='hidden'||style.display==='none'||rect.width<=0||rect.height<=0)continue; matches.push({entry,element}); }
    }} catch(error){ return {kind:'invalid-selector',count:0,message:String(error).slice(0,512)}; }
    if(matches.length!==1)return {kind:'match',count:matches.length};
    const match=matches[0], element=match.element; element.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    const rect=element.getBoundingClientRect(); const editable=(element instanceof element.ownerDocument.defaultView.HTMLTextAreaElement)||(element instanceof element.ownerDocument.defaultView.HTMLInputElement&&!new Set(['button','checkbox','color','file','hidden','image','radio','range','reset','submit']).has(element.type))||element.isContentEditable;
    const allowed=editable&&!element.disabled&&!element.readOnly;
    if(mode==='type'){ element.focus(); if(allowed&&shouldClear){ if('value' in element){ const proto=element.tagName==='TEXTAREA'?element.ownerDocument.defaultView.HTMLTextAreaElement.prototype:element.ownerDocument.defaultView.HTMLInputElement.prototype; const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set; if(setter)setter.call(element,''); else element.value=''; } else element.textContent=''; element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'})); } }
    if(mode==='scroll'){ element.scrollBy({left:${JSON.stringify(deltaX)},top:${JSON.stringify(deltaY)},behavior:'instant'}); return {kind:'match',count:1,scrollX:element.scrollLeft,scrollY:element.scrollTop}; }
    return {kind:'match',count:1,x:match.entry.offsetX+rect.left+rect.width/2,y:match.entry.offsetY+rect.top+rect.height/2,editable:allowed&&element.ownerDocument.activeElement===element};
  })()`
}

function snapshotExpression(): string {
  return `(() => {
    const limit=${BROWSER_AUTOMATION_MAX_INTERACTIVE_ELEMENTS}, textLimit=${BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_LENGTH};
    const documents=[]; const visit=(doc,offsetX,offsetY)=>{if(!doc||documents.length>=32)return;documents.push({doc,offsetX,offsetY});for(const frame of Array.from(doc.querySelectorAll('iframe,frame'))){try{const child=frame.contentDocument;if(child){const rect=frame.getBoundingClientRect();visit(child,offsetX+rect.left,offsetY+rect.top);}}catch{}}};visit(document,0,0);
    const selectorFor=element=>{if(element.id)return '#'+CSS.escape(element.id);for(const attribute of ['data-testid','name']){const value=element.getAttribute(attribute);if(value)return element.tagName.toLowerCase()+'['+attribute+'='+JSON.stringify(value)+']';}const parts=[];let current=element;while(current&&parts.length<8){const siblings=current.parentElement?Array.from(current.parentElement.children).filter(child=>child.tagName===current.tagName):[];const base=current.tagName.toLowerCase();parts.unshift(siblings.length>1?base+':nth-of-type('+(siblings.indexOf(current)+1)+')':base);current=current.parentElement;}return parts.join(' > ');};
    const elements=[];for(const entry of documents){for(const element of Array.from(entry.doc.querySelectorAll('a[href],button,input,textarea,select,[role],[tabindex]'))){if(elements.length>=limit)break;const style=element.ownerDocument.defaultView.getComputedStyle(element),rect=element.getBoundingClientRect();if(style.visibility==='hidden'||style.display==='none'||rect.width<=0||rect.height<=0)continue;elements.push({tag:element.tagName.toLowerCase(),role:element.getAttribute('role'),name:String(element.getAttribute('aria-label')||element.innerText||element.getAttribute('name')||'').slice(0,512),selector:selectorFor(element),x:entry.offsetX+rect.x,y:entry.offsetY+rect.y,width:rect.width,height:rect.height});}}
    return {url:location.href,title:document.title,loading:document.readyState!=='complete',visibleText:documents.map(entry=>entry.doc.body?.innerText||'').join('\\n').slice(0,textLimit),interactiveElements:elements};
  })()`
}

function focusedEditableExpression(clear: boolean): string {
  return `(() => { const element=document.activeElement; if(!element)return {found:false}; const editable=element instanceof HTMLTextAreaElement||(element instanceof HTMLInputElement&&!new Set(['button','checkbox','color','file','hidden','image','radio','range','reset','submit']).has(element.type))||element.isContentEditable; const allowed=editable&&!element.disabled&&!element.readOnly; if(allowed&&${JSON.stringify(clear)}){if('value' in element)element.value='';else element.textContent='';element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));} return {found:true,editable:allowed}; })()`
}
function windowScrollExpression(x: number, y: number): string { return `(() => { window.scrollBy({left:${JSON.stringify(x)},top:${JSON.stringify(y)},behavior:'instant'}); return {scrollX:window.scrollX,scrollY:window.scrollY}; })()` }
function bodyTextExpression(text: string): string { return `(() => { const query=${JSON.stringify(text)}; const docs=[]; const visit=doc=>{if(!doc||docs.length>=32)return;docs.push(doc);for(const frame of Array.from(doc.querySelectorAll('iframe,frame'))){try{visit(frame.contentDocument)}catch{}}};visit(document);return docs.some(doc=>(doc.body?.innerText||'').includes(query)); })()` }

function pointerClickSequence(clientX: number, clientY: number): SyntheticTrustedEventSignature[] {
  const modifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
  return [
    { kind: 'pointer', phase: 'pointermove', clientX, clientY, button: -1, buttons: 0, pointerType: 'mouse', isPrimary: true, ...modifiers },
    { kind: 'pointer', phase: 'pointerdown', clientX, clientY, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, ...modifiers },
    { kind: 'pointer', phase: 'pointerup', clientX, clientY, button: 0, buttons: 0, pointerType: 'mouse', isPrimary: true, ...modifiers },
  ]
}

function keyPressSequence(down: Record<string, unknown>): SyntheticTrustedEventSignature[] {
  const modifierBits = typeof down.modifiers === 'number' ? down.modifiers : 0
  const common = {
    key: String(down.key ?? ''),
    code: String(down.code ?? ''),
    location: 0,
    repeat: false,
    altKey: (modifierBits & 1) !== 0,
    ctrlKey: (modifierBits & 2) !== 0,
    metaKey: (modifierBits & 4) !== 0,
    shiftKey: (modifierBits & 8) !== 0,
  }
  return [
    { kind: 'key', phase: 'keydown', ...common },
    { kind: 'key', phase: 'keyup', ...common },
  ]
}

function keyEvent(key: string, modifiers: readonly string[]): { down: Record<string, unknown>; up: Record<string, unknown> } {
  const bits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
  const modifierBits = modifiers.reduce((sum, value) => sum | (bits[value] ?? 0), 0)
  const named: Record<string, { code: string; virtualKeyCode: number }> = {
    Enter: { code: 'Enter', virtualKeyCode: 13 }, Tab: { code: 'Tab', virtualKeyCode: 9 }, Escape: { code: 'Escape', virtualKeyCode: 27 },
    Backspace: { code: 'Backspace', virtualKeyCode: 8 }, Delete: { code: 'Delete', virtualKeyCode: 46 }, Space: { code: 'Space', virtualKeyCode: 32 },
    ArrowLeft: { code: 'ArrowLeft', virtualKeyCode: 37 }, ArrowUp: { code: 'ArrowUp', virtualKeyCode: 38 }, ArrowRight: { code: 'ArrowRight', virtualKeyCode: 39 }, ArrowDown: { code: 'ArrowDown', virtualKeyCode: 40 },
  }
  const resolvedKey = key === 'Space' ? ' ' : key
  const resolved = named[key] ?? { code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : key, virtualKeyCode: resolvedKey.length === 1 ? resolvedKey.toUpperCase().charCodeAt(0) : 0 }
  const common = { key: resolvedKey, code: resolved.code, modifiers: modifierBits, windowsVirtualKeyCode: resolved.virtualKeyCode, nativeVirtualKeyCode: resolved.virtualKeyCode }
  return { down: { ...common, ...(resolvedKey.length === 1 ? { text: resolvedKey, unmodifiedText: resolvedKey } : {}) }, up: common }
}

function ambiguity(count: number): ExternalChromeOperationError {
  return new ExternalChromeOperationError('invalid-selector', `Locator resolved to ${count} targets; External Chrome requires exactly one.`, false, { reason: 'ambiguous-target', matchCount: count })
}
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    if (value.startsWith('"')) { try { return JSON.parse(value) as string } catch { return value.slice(1, -1) } }
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  }
  return value
}
function record(value: unknown): Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : {} }
function objectValue(value: unknown, label: string): unknown { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ExternalChromeOperationError('execution-failed', `${label} was malformed.`, true); return value }
function finiteNumber(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function positiveNumber(value: unknown, fallback: number): number { const resolved = finiteNumber(value, fallback); return resolved > 0 ? resolved : fallback }
function positiveInteger(value: unknown, fallback: number): number { return Math.max(1, Math.round(positiveNumber(value, fallback))) }
function base64Bytes(value: string): number { const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0; return Math.max(0, Math.floor(value.length * 3 / 4) - padding) }
function pngDimensions(base64: string): { width: number; height: number } | null {
  try {
    const binary = atob(base64.slice(0, 32))
    if (binary.length < 24 || binary.charCodeAt(0) !== 0x89 || binary.slice(1, 4) !== 'PNG') return null
    const read = (offset: number) => ((binary.charCodeAt(offset) << 24) | (binary.charCodeAt(offset + 1) << 16) | (binary.charCodeAt(offset + 2) << 8) | binary.charCodeAt(offset + 3)) >>> 0
    const width = read(16); const height = read(20)
    return width > 0 && height > 0 ? { width, height } : null
  } catch { return null }
}
function safeException(value: unknown): string { const details = record(value); const exception = record(details.exception); return String(exception.description ?? details.text ?? 'JavaScript evaluation failed').slice(0, 1_024) }
function boundedJsonArray(value: unknown, maximum: number): unknown[] { return Array.isArray(value) ? value.slice(0, maximum).map((entry) => boundJson(entry, 0)) : [] }
function boundJson(value: unknown, depth: number): unknown {
  if (depth >= 8) return '[truncated]'
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (typeof value === 'string') return value.slice(0, 2_048)
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => boundJson(entry, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 64).map(([key, entry]) => [key.slice(0, 128), boundJson(entry, depth + 1)]))
  return null
}
function validSnapshotElement(value: unknown): value is BrowserAutomationResultByOperation['snapshot']['interactiveElements'][number] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const element = value as Record<string, unknown>
  return typeof element.tag === 'string' && (element.role === null || typeof element.role === 'string') && typeof element.name === 'string' && typeof element.selector === 'string' &&
    ['x', 'y', 'width', 'height'].every((key) => typeof element[key] === 'number' && Number.isFinite(element[key]))
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
