import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES,
  type ExternalChromeExecuteParams,
} from '@forge/protocol'
import { DebuggerController } from '../src/runtime/debugger-controller.js'
import { ExternalChromeOperationExecutor } from '../src/runtime/operation-executor.js'
import { fakeChrome } from './fakes.js'

function authority(controller: DebuggerController, tabId = 7) {
  return { navigationGeneration: controller.navigationGeneration(tabId), isCurrent: () => true, wasHumanInterrupted: () => false, cancelOutstanding: async () => undefined }
}

function request(operation: string, input: Record<string, unknown>, timeoutMs = 1_000): ExternalChromeExecuteParams {
  return {
    protocolVersion: 1, requestId: `request-${operation}`, leaseId: 'lease-1', leaseEpoch: 1, tabId: 7,
    operation, input, deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
  } as ExternalChromeExecuteParams
}

async function harness(handler: (target: { tabId?: number; sessionId?: string }, method: string, params?: Record<string, unknown>) => unknown | Promise<unknown>) {
  const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, url: 'https://fixture.test/page', title: 'Fixture' }] })
  const original = chrome.debugger.sendCommand
  chrome.debugger.sendCommand = async (target, method, params) => {
    const handled = await handler(target, method, params)
    return handled === PASS ? original(target, method, params) : handled
  }
  const controller = new DebuggerController(chrome.debugger)
  await controller.attach(7)
  return { chrome, controller, executor: new ExternalChromeOperationExecutor(controller, (tabId) => chrome.tabs.get(tabId)) }
}
const PASS = Symbol('pass')

function value(value: unknown) { return { result: { type: typeof value, value } } }

function locatorResult(expression: string, target: { sessionId?: string }) {
  if (expression.includes('const spec=')) {
    const isCrossOrigin = expression.includes('Cross frame')
    if (isCrossOrigin && target.sessionId !== 'session-oopif') return value({ kind: 'match', count: 0 })
    return value({ kind: 'match', count: 1, x: target.sessionId ? 21 : 41, y: target.sessionId ? 22 : 42, editable: true, scrollX: 3, scrollY: 90 })
  }
  return PASS
}

describe('ExternalChromeOperationExecutor', () => {
  it.each([
    ['role=button[name="Save"]', 'role'],
    ['text=Save changes', 'text'],
    ['css=#save', 'css'],
  ])('resolves and clicks one %s semantic target', async (locator) => {
    const { chrome, controller, executor } = await harness((target, method, params) => {
      if (method === 'Runtime.evaluate') return locatorResult(String(params?.expression), target)
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1 } }
      return PASS
    })
    const result = await executor.execute(request('click', { locator, timeoutMs: 100 }), authority(controller))
    expect(result).toMatchObject({ ok: true, result: { point: { x: 41, y: 42 } } })
    expect(chrome.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent').map(({ params }) => params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('enforces actual CSS viewport coordinate bounds', async () => {
    const { controller, executor } = await harness((_target, method) => method === 'Page.getLayoutMetrics'
      ? { cssVisualViewport: { clientWidth: 320, clientHeight: 200, scale: 2 } }
      : PASS)
    await expect(executor.execute(request('click', { x: 320, y: 10, timeoutMs: 100 }), authority(controller)))
      .resolves.toMatchObject({ ok: false, error: { code: 'coordinates-outside-viewport', details: { viewportWidth: 320, viewportHeight: 200 } } })
  })

  it('returns deterministic invalid, ambiguous, and non-editable target errors', async () => {
    const { controller, executor } = await harness((_target, method, params) => {
      if (method !== 'Runtime.evaluate') return PASS
      const expression = String(params?.expression)
      if (expression.includes('bad-css')) return value({ kind: 'invalid-selector', count: 0, message: 'invalid selector' })
      if (expression.includes('Many buttons')) return value({ kind: 'match', count: 2 })
      return value({ kind: 'match', count: 1, x: 10, y: 20, editable: false })
    })
    await expect(executor.execute(request('click', { locator: 'css=bad-css', timeoutMs: 100 }), authority(controller)))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-selector' } })
    await expect(executor.execute(request('click', { locator: 'text=Many buttons', timeoutMs: 100 }), authority(controller)))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-selector', details: { reason: 'ambiguous-target', matchCount: 2 } } })
    await expect(executor.execute(request('type', { locator: 'role=textbox', text: 'hello', clear: false, timeoutMs: 100 }), authority(controller)))
      .resolves.toMatchObject({ ok: false, error: { code: 'target-not-editable' } })
  })

  it('types, presses, and scrolls with deterministic typed results', async () => {
    const { chrome, controller, executor } = await harness((target, method, params) => {
      if (method === 'Runtime.evaluate') return locatorResult(String(params?.expression), target)
      return PASS
    })
    await expect(executor.execute(request('type', { selector: '#field', text: 'hello', clear: true, timeoutMs: 100 }), authority(controller)))
      .resolves.toMatchObject({ ok: true, result: { characters: 5, cleared: true } })
    await expect(executor.execute(request('press', { key: 'Enter', modifiers: ['Control'] }), authority(controller)))
      .resolves.toMatchObject({ ok: true, result: { key: 'Enter', modifiers: ['Control'] } })
    await expect(executor.execute(request('scroll', { locator: 'role=list', deltaY: 80 }), authority(controller)))
      .resolves.toMatchObject({ ok: true, result: { deltaY: 80, scrollX: 3, scrollY: 90 } })
    expect(chrome.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'Input.insertText', params: { text: 'hello' } }),
      expect.objectContaining({ method: 'Input.dispatchKeyEvent', params: expect.objectContaining({ type: 'keyDown', key: 'Enter' }) }),
    ]))
  })

  it('awaits evaluate promises, enforces result bounds, and recovers its queue after timeout', async () => {
    let oversized = false
    let slow = true
    let terminationCalled = false
    const { controller, executor } = await harness(async (_target, method, params) => {
      if (method === 'Runtime.terminateExecution') { slow = false; terminationCalled = true; return {} }
      if (method === 'Runtime.evaluate' && params?.expression === 'slowPromise') {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 30))
        return value('late')
      }
      if (method === 'Runtime.evaluate') return value(oversized ? 'x'.repeat(70_000) : { answer: 42 })
      return PASS
    })
    await expect(executor.execute(request('evaluate', { expression: 'slowPromise', awaitPromise: true, returnByValue: true }, 5), authority(controller)))
      .resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(terminationCalled).toBe(true)
    await expect(executor.execute(request('evaluate', { expression: 'ok', awaitPromise: true, returnByValue: true }), authority(controller)))
      .resolves.toMatchObject({ ok: true, result: { value: { answer: 42 } } })
    oversized = true
    await expect(executor.execute(request('evaluate', { expression: 'large', awaitPromise: true, returnByValue: true }), authority(controller)))
      .resolves.toMatchObject({ ok: false, error: { code: 'result-too-large' } })
  })

  it('polls combined wait conditions and returns a typed timeout', async () => {
    let probes = 0
    const { controller, executor } = await harness((_target, method, params) => {
      if (method !== 'Runtime.evaluate') return PASS
      const expression = String(params?.expression)
      if (expression.includes('const spec=')) return value({ kind: 'match', count: ++probes >= 2 ? 1 : 0, x: 1, y: 1 })
      if (expression.includes('const query=')) return value(!expression.includes('Never'))
      return value(false)
    })
    await expect(executor.execute(request('waitFor', { locator: 'css=#ready', text: 'Ready', urlIncludes: '/page', timeoutMs: 300 }), authority(controller)))
      .resolves.toMatchObject({ ok: true, result: { matched: true } })
    await expect(executor.execute(request('waitFor', { text: 'Never', timeoutMs: 2 }, 50), authority(controller)))
      .resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
  })

  it('captures bounded DOM, accessibility, diagnostics, actual viewport, and PNG data', async () => {
    const png = pngBase64(4, 3)
    const { controller, executor } = await harness((_target, method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('interactiveElements')) return value({
        url: 'https://fixture.test/page', title: 'Fixture', loading: false, visibleText: 'Visible fixture text',
        interactiveElements: [{ tag: 'button', role: 'button', name: 'Save', selector: '#save', x: 1, y: 2, width: 20, height: 10 }],
      })
      if (method === 'Runtime.evaluate' && params?.expression === 'window.devicePixelRatio') return value(2)
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 900, clientHeight: 700, pageX: 0, pageY: 0, scale: 1.25 } }
      if (method === 'Page.captureScreenshot') return { data: png }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ role: { value: 'button' }, name: { value: 'Save' } }] }
      return PASS
    })
    executor.onCdpEvent(7, { targetId: 'target-tab-7' }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'diagnostic' }], timestamp: Date.now() })
    const result = await executor.execute(request('snapshot', {}), authority(controller))
    expect(result).toMatchObject({ ok: true, result: {
      viewport: { width: 900, height: 700, deviceScaleFactor: 2 }, visibleText: 'Visible fixture text',
      interactiveElements: [{ role: 'button', name: 'Save' }], consoleEntries: [{ text: 'diagnostic' }],
      screenshot: { mimeType: 'image/png', data: png, width: 4, height: 3 },
    } })
  })

  it('rejects oversized decoded PNGs with canonical envelope-overflow details before AX capture', async () => {
    const oversized = pngBase64(4, 3, EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES)
    let accessibilityCalls = 0
    const { chrome, controller, executor } = await harness((_target, method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('interactiveElements')) return value({
        url: 'https://fixture.test/', title: 'Fixture', loading: false, visibleText: '', interactiveElements: [],
      })
      if (method === 'Runtime.evaluate' && params?.expression === 'window.devicePixelRatio') return value(1)
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 400, clientHeight: 300, pageX: 0, pageY: 0, scale: 1 } }
      if (method === 'Page.captureScreenshot') return { data: oversized }
      if (method === 'Accessibility.getFullAXTree') { accessibilityCalls += 1; return { nodes: [] } }
      return PASS
    })
    const result = await executor.execute(request('snapshot', {}), authority(controller))
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'response-too-large', retryable: false,
        details: {
          limitation: 'screenshot-only-envelope-overflow', screenshotBytes: 24 + EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES,
          screenshotByteUnit: 'decoded-png', maximumBytes: EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES, maximumByteUnit: 'decoded-png',
        },
      },
    })
    expect(accessibilityCalls).toBe(0)
    expect(chrome.attached.has(7)).toBe(true)
  })

  it('routes a cross-origin OOPIF only after leased-root ancestry proof', async () => {
    const { chrome, controller, executor } = await harness((target, method, params) => {
      if (method === 'Runtime.evaluate') return locatorResult(String(params?.expression), target)
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 55 }
      if (method === 'DOM.getBoxModel') return { model: { content: [100, 200, 500, 200, 500, 500, 100, 500] } }
      return PASS
    })
    await controller.onEvent({ tabId: 7 }, 'Page.frameAttached', { frameId: 'target-oopif', parentFrameId: 'frame-tab-7' })
    await controller.onEvent({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'session-oopif', targetInfo: { targetId: 'target-oopif', type: 'iframe', attached: true },
    })
    const result = await executor.execute(request('click', { locator: 'text=Cross frame', timeoutMs: 100 }), authority(controller))
    expect(result).toMatchObject({ ok: true, result: { point: { x: 121, y: 222 } } })
    expect(chrome.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent')).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { tabId: 7 } }),
    ]))

    await controller.onEvent({ tabId: 7, sessionId: 'session-oopif' }, 'Target.targetInfoChanged', {
      targetInfo: { targetId: 'migrated-target', type: 'iframe', attached: true },
    })
    expect(controller.routes(7)).toEqual([{ targetId: 'target-tab-7' }])
  })

  it('settles a stalled snapshot command by debugger reset before the tab queue recovers', async () => {
    let stalled = true
    let releaseStalled!: () => void
    let activeSnapshotCommands = 0
    let maximumActive = 0
    const { chrome, controller, executor } = await harness(async (_target, method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('interactiveElements')) {
        activeSnapshotCommands += 1
        maximumActive = Math.max(maximumActive, activeSnapshotCommands)
        if (stalled) await new Promise<void>((resolve) => { releaseStalled = resolve })
        activeSnapshotCommands -= 1
        return value({ url: 'https://fixture.test/', title: 'Fixture', loading: false, visibleText: '', interactiveElements: [] })
      }
      if (method === 'Runtime.evaluate' && params?.expression === 'window.devicePixelRatio') return value(1)
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 400, clientHeight: 300, pageX: 0, pageY: 0, scale: 1 } }
      if (method === 'Page.captureScreenshot') return { data: pngBase64(2, 2) }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      return PASS
    })
    const originalDetach = chrome.debugger.detach
    chrome.debugger.detach = async (target) => {
      stalled = false
      releaseStalled?.()
      await originalDetach(target)
    }
    const cancellingAuthority = {
      ...authority(controller),
      cancelOutstanding: () => controller.reset(7),
    }
    await expect(executor.execute(request('snapshot', {}, 5), cancellingAuthority))
      .resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(activeSnapshotCommands).toBe(0)
    await controller.attach(7)
    await expect(executor.execute(request('snapshot', {}), authority(controller)))
      .resolves.toMatchObject({ ok: true })
    expect(maximumActive).toBe(1)
  })

  it('does not let a stalled Runtime.terminateExecution delay debugger cancellation', async () => {
    let releaseEvaluate!: () => void
    let releaseTermination!: () => void
    let terminationStarted = false
    const { chrome, controller, executor } = await harness(async (_target, method, params) => {
      if (method === 'Runtime.evaluate' && params?.expression === 'never') {
        await new Promise<void>((resolve) => { releaseEvaluate = resolve })
        return value('late')
      }
      if (method === 'Runtime.terminateExecution') {
        terminationStarted = true
        await new Promise<void>((resolve) => { releaseTermination = resolve })
        return {}
      }
      return PASS
    })
    const originalDetach = chrome.debugger.detach
    chrome.debugger.detach = async (target) => {
      releaseEvaluate?.()
      releaseTermination?.()
      await originalDetach(target)
    }

    await expect(executor.execute(request('evaluate', {
      expression: 'never', awaitPromise: true, returnByValue: true,
    }, 5), {
      ...authority(controller),
      cancelOutstanding: () => controller.reset(7),
    })).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(terminationStarted).toBe(true)
    expect(controller.state(7)).toBe('UNATTACHED')
  })

  it('maps nested OOPIF snapshots, locator clicks, and focused typing to the proven top-level route', async () => {
    const { chrome, controller, executor } = await harness((target, method, params) => {
      const expression = String(params?.expression ?? '')
      if (method === 'Runtime.evaluate' && expression.includes('interactiveElements')) {
        const deep = target.sessionId === 'session-deep'
        return value({
          url: 'https://fixture.test/', title: 'Fixture', loading: false, visibleText: deep ? 'Deep frame' : '',
          interactiveElements: deep ? [{ tag: 'input', role: 'textbox', name: 'Deep', selector: '#deep', x: 5, y: 6, width: 20, height: 10 }] : [],
        })
      }
      if (method === 'Runtime.evaluate' && expression.includes('const spec=')) {
        return value(target.sessionId === 'session-deep'
          ? { kind: 'match', count: 1, x: 5, y: 6, editable: true }
          : { kind: 'match', count: 0 })
      }
      if (method === 'Runtime.evaluate' && expression.includes('document.activeElement')) {
        return value(target.sessionId === 'session-deep' ? { found: true, editable: true } : { found: true, editable: false })
      }
      if (method === 'Runtime.evaluate' && params?.expression === 'window.devicePixelRatio') return value(2)
      if (method === 'DOM.getFrameOwner') return { backendNodeId: params?.frameId === 'target-deep' ? 2 : 1 }
      if (method === 'DOM.getBoxModel') return { model: { content: params?.backendNodeId === 2
        ? [30, 40, 230, 40, 230, 140, 30, 140]
        : [100, 200, 500, 200, 500, 500, 100, 500] } }
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0, scale: 1.25 } }
      if (method === 'Page.captureScreenshot') return { data: pngBase64(2, 2) }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      return PASS
    })
    await controller.onEvent({ tabId: 7 }, 'Page.frameAttached', { frameId: 'target-parent', parentFrameId: 'frame-tab-7' })
    await controller.onEvent({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'session-parent', targetInfo: { targetId: 'target-parent', type: 'iframe', attached: true },
    })
    await controller.onEvent({ tabId: 7, sessionId: 'session-parent' }, 'Page.frameAttached', { frameId: 'target-deep', parentFrameId: 'target-parent' })
    await controller.onEvent({ tabId: 7, sessionId: 'session-parent' }, 'Target.attachedToTarget', {
      sessionId: 'session-deep', targetInfo: { targetId: 'target-deep', type: 'iframe', attached: true },
    })

    await expect(executor.execute(request('snapshot', {}), authority(controller))).resolves.toMatchObject({
      ok: true, result: { viewport: { deviceScaleFactor: 2 }, interactiveElements: [{ name: 'Deep', x: 135, y: 246 }] },
    })
    await expect(executor.execute(request('click', { locator: 'css=#deep', timeoutMs: 100 }), authority(controller)))
      .resolves.toMatchObject({ ok: true, result: { point: { x: 135, y: 246 } } })
    await expect(executor.execute(request('type', { text: 'typed', clear: false, timeoutMs: 100 }), authority(controller)))
      .resolves.toMatchObject({ ok: true, result: { characters: 5 } })
    expect(chrome.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent' || method === 'Input.insertText'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ target: { tabId: 7 } })]))
  })

  it('clears diagnostic and action caches before the same tab is used by a new lease', async () => {
    const png = pngBase64(2, 2)
    const { controller, executor } = await harness((_target, method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('interactiveElements')) return value({
        url: 'https://fixture.test/', title: 'Fixture', loading: false, visibleText: '', interactiveElements: [],
      })
      if (method === 'Runtime.evaluate' && params?.expression === 'window.devicePixelRatio') return value(1)
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 400, clientHeight: 300, pageX: 0, pageY: 0, scale: 1 } }
      if (method === 'Page.captureScreenshot') return { data: png }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      return PASS
    })
    executor.onCdpEvent(7, { targetId: 'target-tab-7' }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'lease-one-secret' }] })
    await expect(executor.execute({ ...request('snapshot', {}), leaseId: 'lease-one' }, authority(controller)))
      .resolves.toMatchObject({ ok: true, result: { consoleEntries: [{ text: 'lease-one-secret' }] } })
    executor.clear(7)
    const second = await executor.execute({ ...request('snapshot', {}), leaseId: 'lease-two', leaseEpoch: 2 }, authority(controller))
    expect(second).toMatchObject({ ok: true, result: { consoleEntries: [], networkEntries: [] } })
    expect(second.ok && 'actionTimeline' in second.result ? second.result.actionTimeline : []).toHaveLength(1)
  })

  it('cancels stale work after navigation or trusted-human authority change', async () => {
    const { controller, executor } = await harness((_target, method) => method === 'Runtime.evaluate' ? value(true) : PASS)
    const stale = authority(controller)
    await controller.onEvent({ tabId: 7 }, 'Page.frameNavigated', { frame: { id: 'frame-tab-7', url: 'https://fixture.test/redirect' } })
    await expect(executor.execute(request('evaluate', { expression: '1', awaitPromise: true, returnByValue: true }), stale))
      .resolves.toMatchObject({ ok: false, error: { code: 'request-cancelled', details: { reason: 'navigation' } } })
    const interrupted = { navigationGeneration: controller.navigationGeneration(7), isCurrent: () => false, wasHumanInterrupted: () => true, cancelOutstanding: async () => undefined }
    await expect(executor.execute(request('evaluate', { expression: '1', awaitPromise: true, returnByValue: true }), interrupted))
      .resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
  })
})

function pngBase64(width: number, height: number, additionalBytes = 0): string {
  const bytes = new Uint8Array(24 + additionalBytes)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return Buffer.from(bytes).toString('base64')
}
