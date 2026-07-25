import { afterEach, describe, expect, it } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import type { DebuggerController } from '../src/runtime/debugger-controller.js'
import type { LeaseManager } from '../src/runtime/lease-manager.js'
import { fakeChrome } from './fakes.js'

const previousChrome = (globalThis as Record<string, unknown>).chrome

afterEach(() => {
  if (previousChrome === undefined) delete (globalThis as Record<string, unknown>).chrome
  else (globalThis as Record<string, unknown>).chrome = previousChrome
})

describe('leased-frame navigation observer recovery', () => {
  it('reinjects the trusted-input observer only into committed leased frames', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' }] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const runtime = new Runtime()
    const leases = (runtime as unknown as { leases: LeaseManager }).leases
    await leases.claim({ leaseId: 'lease-nav', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9], childPolicy: 'manual' })

    runtime.onShellEvent('navigation.committed', [{ tabId: 10, frameId: 0 }])
    runtime.onShellEvent('navigation.committed', [{ tabId: 9, frameId: 7 }])
    await viFlush()

    expect(chrome.injections).toEqual([expect.objectContaining({
      target: { tabId: 9, frameIds: [7] },
      world: 'ISOLATED',
    })])
  })

  it.each(['success', 'failure', 'timeout'] as const)('CAS-returns navigation to human control after %s', async (exit) => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' }] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const runtime = new Runtime()
    const internals = runtime as unknown as {
      leases: LeaseManager
      debuggers: DebuggerController
      executeDesktopRequest(params: Record<string, unknown>): Promise<Record<string, unknown>>
    }
    await internals.leases.claim({ leaseId: 'lease-nav', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9], childPolicy: 'manual' })
    await internals.debuggers.attach(9)
    if (exit === 'failure') {
      const original = chrome.debugger.sendCommand
      chrome.debugger.sendCommand = async (target, method, params) => {
        if (method === 'Page.navigate') throw new Error('synthetic navigation failure')
        return original(target, method, params)
      }
    }
    const result = await internals.executeDesktopRequest(navigateParams(exit === 'timeout' ? 'load' : 'none', exit === 'timeout' ? 2 : 1_000))
    expect(result).toMatchObject({ ok: exit === 'success' })
    expect(internals.leases.current()).toMatchObject({ state: exit === 'success' ? 'LEASED_HUMAN' : 'LOST', controlEpoch: 0 })
  })

  it('serializes same-tab control epochs so two concurrent valid operations complete in order', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' }] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const runtime = new Runtime()
    const internals = runtime as unknown as {
      leases: LeaseManager
      debuggers: DebuggerController
      executeDesktopRequest(params: Record<string, unknown>): Promise<Record<string, unknown>>
    }
    await internals.leases.claim({ leaseId: 'lease-nav', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9], childPolicy: 'manual' })
    await internals.debuggers.attach(9)
    const order: string[] = []
    let releaseFirst!: () => void
    const original = chrome.debugger.sendCommand
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Runtime.evaluate' && params?.expression === 'first') {
        order.push('first:start')
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        order.push('first:end')
        return { result: { value: 1 } }
      }
      if (method === 'Runtime.evaluate' && params?.expression === 'second') {
        order.push('second:start')
        return { result: { value: 2 } }
      }
      return original(target, method, params)
    }
    const first = internals.executeDesktopRequest(evaluateParams('first', 'one'))
    const second = internals.executeDesktopRequest(evaluateParams('second', 'two'))
    while (!order.includes('first:start')) await viFlush()
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, result: expect.objectContaining({ value: 1 }) }),
      expect.objectContaining({ ok: true, result: expect.objectContaining({ value: 2 }) }),
    ])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    expect(internals.leases.current()).toMatchObject({ state: 'LEASED_HUMAN', controlEpoch: 0 })
  })

  it('cancels queued work before start when trusted input changes its captured authority', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' }] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const runtime = new Runtime()
    const internals = runtime as unknown as {
      leases: LeaseManager
      debuggers: DebuggerController
      executeDesktopRequest(params: Record<string, unknown>): Promise<Record<string, unknown>>
    }
    await internals.leases.claim({ leaseId: 'lease-nav', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9], childPolicy: 'manual' })
    await internals.debuggers.attach(9)
    let releaseFirst!: () => void
    let secondStarted = false
    const original = chrome.debugger.sendCommand
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Runtime.evaluate' && params?.expression === 'first') await new Promise<void>((resolve) => { releaseFirst = resolve })
      if (method === 'Runtime.evaluate' && params?.expression === 'second') secondStarted = true
      if (method === 'Runtime.evaluate') return { result: { value: true } }
      return original(target, method, params)
    }
    const first = internals.executeDesktopRequest(evaluateParams('first', 'one'))
    const second = internals.executeDesktopRequest(evaluateParams('second', 'two'))
    while (!releaseFirst) await viFlush()
    await internals.leases.trustedHumanInput(9)
    releaseFirst()
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
    await expect(second).resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
    expect(secondStarted).toBe(false)
  })

  it('revokes and settles the entire multi-tab debugger scope when one tab times out', async () => {
    const chrome = fakeChrome({ tabs: [
      { id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' },
      { id: 10, windowId: 1, groupId: 2, url: 'https://fixture.invalid/other' },
    ] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const runtime = new Runtime()
    const internals = runtime as unknown as {
      leases: LeaseManager
      debuggers: DebuggerController
      executeDesktopRequest(params: Record<string, unknown>): Promise<Record<string, unknown>>
    }
    await internals.leases.claim({ leaseId: 'lease-nav', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9, 10], childPolicy: 'manual' })
    await Promise.all([internals.debuggers.attach(9), internals.debuggers.attach(10)])
    let releaseEvaluate!: () => void
    const originalSend = chrome.debugger.sendCommand
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (target.tabId === 9 && method === 'Runtime.evaluate' && params?.expression === 'stalled') {
        await new Promise<void>((resolve) => { releaseEvaluate = resolve })
        return { result: { value: 'late' } }
      }
      return originalSend(target, method, params)
    }
    const originalDetach = chrome.debugger.detach
    chrome.debugger.detach = async (target) => {
      if (target.tabId === 9) releaseEvaluate?.()
      await originalDetach(target)
    }

    await expect(internals.executeDesktopRequest({
      ...evaluateParams('stalled', 'multi-tab-timeout'),
      deadlineAt: new Date(Date.now() + 5).toISOString(),
    })).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(internals.leases.current()).toMatchObject({ state: 'LOST', tabIds: [9, 10] })
    expect(chrome.attached.size).toBe(0)
    expect(internals.debuggers.state(9)).toBe('UNATTACHED')
    expect(internals.debuggers.state(10)).toBe('UNATTACHED')
  })

  it('preserves diagnostics only for same-lease HANDOFF and clears them before a second lease reuses the tab', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' }] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const original = chrome.debugger.sendCommand
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('interactiveElements')) return {
        result: { value: { url: 'https://fixture.invalid/', title: 'Fixture', loading: false, visibleText: '', interactiveElements: [] } },
      }
      if (method === 'Runtime.evaluate' && params?.expression === 'window.devicePixelRatio') return { result: { value: 1 } }
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 400, clientHeight: 300, pageX: 0, pageY: 0, scale: 1 } }
      if (method === 'Page.captureScreenshot') return { data: pngBase64(2, 2) }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      return original(target, method, params)
    }
    const runtime = new Runtime()
    const internals = runtime as unknown as {
      leases: LeaseManager
      debuggers: DebuggerController
      operations: { onCdpEvent(tabId: number, route: { targetId: string }, method: string, raw: unknown): void }
      executeDesktopRequest(params: Record<string, unknown>): Promise<any>
      handleDesktopRequest(request: Record<string, unknown>): Promise<any>
      attachTab(tabId: number): Promise<void>
    }
    await internals.leases.claim({ leaseId: 'lease-one', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9], childPolicy: 'manual' })
    await internals.attachTab(9)
    internals.operations.onCdpEvent(9, { targetId: 'target-tab-9' }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'lease-one-diagnostic' }] })
    await internals.handleDesktopRequest(turnEndedRequest('lease-one', 1, 'turn-handoff', [], [9]))
    await expect(internals.executeDesktopRequest(snapshotParams('lease-one', 1, 'handoff-snapshot')))
      .resolves.toMatchObject({ ok: true, result: { consoleEntries: [{ text: 'lease-one-diagnostic' }] } })
    await internals.handleDesktopRequest(turnEndedRequest('lease-one', 1, 'turn-final', [9], []))

    await internals.leases.claim({ leaseId: 'lease-two', leaseEpoch: 2, sessionAgentId: 'session-b', tabIds: [9], childPolicy: 'manual' })
    await internals.attachTab(9)
    const second = await internals.executeDesktopRequest(snapshotParams('lease-two', 2, 'second-lease'))
    expect(second).toMatchObject({ ok: true, result: { consoleEntries: [], networkEntries: [] } })
    expect(second.result.actionTimeline).toHaveLength(1)
  })

  it('does not overwrite a newer human interruption while cancelling navigation', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, groupId: 2, url: 'https://fixture.invalid/' }] })
    ;(globalThis as Record<string, unknown>).chrome = chrome
    const runtime = new Runtime()
    const internals = runtime as unknown as {
      leases: LeaseManager
      debuggers: DebuggerController
      executeDesktopRequest(params: Record<string, unknown>): Promise<Record<string, unknown>>
    }
    await internals.leases.claim({ leaseId: 'lease-nav', leaseEpoch: 1, sessionAgentId: 'session-a', tabIds: [9], childPolicy: 'manual' })
    await internals.debuggers.attach(9)
    let releaseNavigate!: () => void
    const original = chrome.debugger.sendCommand
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Page.navigate') await new Promise<void>((resolve) => { releaseNavigate = resolve })
      return original(target, method, params)
    }
    const navigating = internals.executeDesktopRequest(navigateParams('none', 1_000))
    while (internals.leases.current()?.state !== 'CONTROLLING_AGENT') await viFlush()
    await internals.leases.trustedHumanInput(9)
    releaseNavigate()
    await expect(navigating).resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
    expect(internals.leases.current()).toMatchObject({ state: 'LOST', controlEpoch: 1 })
  })
})

function turnEndedRequest(leaseId: string, leaseEpoch: number, turnId: string, finalTabs: number[], handoffTabs: number[]): Record<string, unknown> {
  return { jsonrpc: '2.0', id: turnId, method: 'forge.browser.turnEnded', params: { protocolVersion: 1, leaseId, leaseEpoch, turnId, finalTabs, handoffTabs } }
}

function snapshotParams(leaseId: string, leaseEpoch: number, suffix: string): Record<string, unknown> {
  return {
    protocolVersion: 1, requestId: `request-snapshot-${suffix}`, leaseId, leaseEpoch,
    tabId: 9, operation: 'snapshot', deadlineAt: new Date(Date.now() + 1_000).toISOString(), input: {},
  }
}

function evaluateParams(expression: string, suffix: string): Record<string, unknown> {
  return {
    protocolVersion: 1, requestId: `request-evaluate-${suffix}`, leaseId: 'lease-nav', leaseEpoch: 1,
    tabId: 9, operation: 'evaluate', deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    input: { expression, awaitPromise: true, returnByValue: true },
  }
}

function navigateParams(readiness: 'load' | 'none', timeoutMs: number): Record<string, unknown> {
  return {
    protocolVersion: 1, requestId: `request-${readiness}`, leaseId: 'lease-nav', leaseEpoch: 1,
    tabId: 9, operation: 'navigate', deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    input: { url: 'https://fixture.invalid/next', readiness, timeoutMs },
  }
}

function pngBase64(width: number, height: number): string {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return Buffer.from(bytes).toString('base64')
}

async function viFlush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
