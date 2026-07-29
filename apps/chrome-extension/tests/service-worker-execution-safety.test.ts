import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
  EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES,
} from '@forge/protocol'
import { Runtime } from '../src/payload/service-worker/index.js'
import { fakeChrome } from './fakes.js'

afterEach(() => vi.unstubAllGlobals())

describe('service-worker execution safety evidence', () => {
  it('emits exact pre-mutation evidence only for a proven initial debugger attach conflict', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    chrome.attached.add(7)
    vi.stubGlobal('chrome', chrome)
    const { execute } = await authorizedRuntime()

    await expect(execute(clickRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'debugger-unavailable',
        details: EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
      },
    })
    expect(chrome.injections).toEqual([])
    expect(chrome.commands).toEqual([])
  })

  it('keeps generic attach errors as execution failures without replay-safe evidence', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    chrome.debugger.attach = async () => { throw new Error('Cannot attach to this target') }
    vi.stubGlobal('chrome', chrome)
    const { execute } = await authorizedRuntime()

    const response = await execute(clickRequest()) as { ok: false; error: { code: string; details?: unknown } }
    expect(response).toMatchObject({ ok: false, error: { code: 'execution-failed' } })
    expect(response.error.details).toBeUndefined()
    expect(chrome.injections).toEqual([])
  })

  it('fails closed when an eligible network-error tab rejects injection after FrameTree succeeds', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://unresolvable.invalid/' }] })
    chrome.scripting.executeScript = async () => { throw new Error('Frame with ID 0 is showing error page') }
    vi.stubGlobal('chrome', chrome)
    const { execute } = await authorizedRuntime()

    await expect(execute(navigateRequest())).resolves.toMatchObject({
      ok: false, error: { code: 'execution-failed', message: 'Frame with ID 0 is showing error page' },
    })
    await expect(execute({ ...navigateRequest(), requestId: 'request-snapshot', operation: 'snapshot', input: {} })).resolves.toMatchObject({
      ok: false, error: { code: 'execution-failed', message: 'Frame with ID 0 is showing error page' },
    })
    expect(chrome.commands.filter(({ method }) => method === 'Page.getFrameTree')).toHaveLength(2)
    expect(chrome.commands.filter(({ method }) => method === 'Page.navigate')).toEqual([])
    expect(chrome.attached).toEqual(new Set())
  })

  it('returns canonical bounded screenshot overflow through the worker and releases debugger authority', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    const screenshot = oversizedPng(EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES)
    chrome.debugger.sendCommand = async (target, method, params) => {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: `target-tab-${String(target.tabId)}`, type: 'page', attached: true } }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-tab-${String(target.tabId)}` } } }
      if (method === 'Runtime.evaluate') {
        if (params?.expression === 'window.devicePixelRatio') return { result: { type: 'number', value: 1 } }
        return { result: { type: 'object', value: { url: 'https://fixture.invalid/', title: 'Fixture', loading: false, visibleText: '', interactiveElements: [] } } }
      }
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 400, clientHeight: 300, pageX: 0, pageY: 0, scale: 1 } }
      if (method === 'Page.captureScreenshot') return { data: screenshot }
      if (method === 'Accessibility.getFullAXTree') throw new Error('AX must not run after the early screenshot bound')
      return {}
    }
    vi.stubGlobal('chrome', chrome)
    const { execute } = await authorizedRuntime()

    await expect(execute({
      protocolVersion: 1, requestId: 'request-snapshot', leaseId: 'lease-1', leaseEpoch: 1, tabId: 7,
      operation: 'snapshot', input: {}, deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    })).resolves.toMatchObject({
      protocolVersion: 1, requestId: 'request-snapshot', leaseId: 'lease-1', leaseEpoch: 1, tabId: 7,
      operation: 'snapshot', ok: false,
      error: {
        code: 'response-too-large', retryable: false,
        details: {
          limitation: 'screenshot-only-envelope-overflow', screenshotByteUnit: 'decoded-png',
          screenshotBytes: 24 + EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES,
          maximumBytes: EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES, maximumByteUnit: 'decoded-png',
        },
      },
    })
    expect(chrome.attached).toEqual(new Set())
  })

  it('keeps failures after page-command dispatch free of attach-conflict evidence', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    const sendCommand = chrome.debugger.sendCommand.bind(chrome.debugger)
    chrome.debugger.sendCommand = async (target, method, params) => {
      const result = await sendCommand(target, method, params)
      if (method === 'Page.navigate') throw new Error('Another debugger is already attached')
      return result
    }
    vi.stubGlobal('chrome', chrome)
    const { execute } = await authorizedRuntime()

    const response = await execute(navigateRequest()) as { ok: false; error: { code: string; details?: unknown } }
    expect(response).toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(response.error.details).toBeUndefined()
    expect(chrome.commands).toContainEqual({
      target: { tabId: 7 }, method: 'Page.navigate', params: { url: 'https://fixture.invalid/next' },
    })
    expect(chrome.attached.has(7)).toBe(false)
  })
})

async function authorizedRuntime(): Promise<{ execute(input: unknown): Promise<unknown> }> {
  const runtime = new Runtime()
  const authority = (runtime as unknown as { authorities: { acquire(input: unknown): Promise<unknown> } }).authorities
  await authority.acquire({ tabId: 7, ownerId: 'lease-1', ownerEpoch: 1, sessionAgentId: 'session-1', expectedOwnerEpoch: 0 })
  return {
    execute: (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime),
  }
}

function clickRequest(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: 'request-click',
    leaseId: 'lease-1',
    leaseEpoch: 1,
    tabId: 7,
    operation: 'click',
    input: { x: 1, y: 1, timeoutMs: 1_000 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
  }
}

function oversizedPng(additionalBytes: number): string {
  const bytes = new Uint8Array(24 + additionalBytes)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  new DataView(bytes.buffer).setUint32(16, 4)
  new DataView(bytes.buffer).setUint32(20, 3)
  return Buffer.from(bytes).toString('base64')
}

function navigateRequest(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: 'request-navigate',
    leaseId: 'lease-1',
    leaseEpoch: 1,
    tabId: 7,
    operation: 'navigate',
    input: { url: 'https://fixture.invalid/next', readiness: 'load', timeoutMs: 1_000 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
  }
}
