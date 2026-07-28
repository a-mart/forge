import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS } from '@forge/protocol'
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
