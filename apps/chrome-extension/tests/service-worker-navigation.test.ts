import { afterEach, describe, expect, it, vi } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import type { ChromeTab } from '../src/runtime/chrome-api.js'
import { fakeChrome } from './fakes.js'

afterEach(() => vi.unstubAllGlobals())

describe('service-worker navigation orchestration', () => {
  it('acquires before Runtime navigation, injects only after attach, and always detaches', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const authority = (runtime as unknown as { authorities: { acquire(input: unknown): Promise<unknown> } }).authorities
    await authority.acquire({ tabId: 7, ownerId: 'owner', ownerEpoch: 1, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)

    const response = await execute(navigateRequest({ readiness: 'none' })) as Record<string, unknown>
    expect(response).toMatchObject({ ok: true, operation: 'navigate', result: { readiness: 'none' } })
    expect(chrome.injections).toHaveLength(1)
    expect(chrome.commands.map(({ method }) => method)).toContain('Page.navigate')
    expect(chrome.attached).toEqual(new Set())
    expect((runtime as unknown as { authorities: { forTab(id: number): { state: string } | null } }).authorities.forTab(7)).toMatchObject({ state: 'human' })
  })

  it('navigates a freshly allocated placeholder after Chrome turns it into an error page', async () => {
    const tabs: ChromeTab[] = []
    const chrome = fakeChrome({ tabs })
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const sendCommand = chrome.debugger.sendCommand.bind(chrome.debugger)
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting)
    let showingErrorPage = false
    chrome.debugger.sendCommand = async (target, method, params) => {
      const result = await sendCommand(target, method, params)
      if (method === 'Page.getFrameTree' && showingErrorPage) {
        throw new Error('Frame with ID 0 is showing error page')
      }
      if (method === 'Page.navigate') {
        showingErrorPage = false
        const tab = tabs.find((candidate) => candidate.id === target.tabId)
        if (tab) tab.url = String(params?.url ?? '')
        queueMicrotask(() => runtime.onShellEvent('debugger.event', [target, 'Page.loadEventFired', {}]))
      }
      return result
    }
    chrome.scripting.executeScript = async (injection) => {
      if (showingErrorPage) throw new Error('Chrome cannot inject into an error page')
      return executeScript(injection)
    }
    const handleDesktopRequest = (runtime as unknown as {
      handleDesktopRequest(input: unknown): Promise<Record<string, unknown>>
    }).handleDesktopRequest.bind(runtime)
    const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)

    const acquired = await handleDesktopRequest({
      jsonrpc: '2.0',
      id: 'desktop-acquire-placeholder',
      method: 'forge.browser.acquire',
      params: {
        protocolVersion: 1,
        sessionAgentId: 'session',
        leaseId: 'owner',
        leaseEpoch: 1,
        reuseFocused: false,
      },
    })
    expect(acquired).toMatchObject({ created: true, tab: { tabId: 1, url: 'https://forge.invalid/' } })
    showingErrorPage = true

    await expect(execute({
      ...navigateRequest({ requestId: 'snapshot-error-page', tabId: 1 }),
      operation: 'snapshot',
      input: {},
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution-failed', message: 'Frame with ID 0 is showing error page' },
    })

    const destination = 'http://localhost:3100/candidates?page=1&search=little'
    await expect(execute(navigateRequest({
      requestId: 'navigate-from-error-page',
      tabId: 1,
      input: { url: destination, readiness: 'load', timeoutMs: 1_000 },
    }))).resolves.toMatchObject({
      ok: true,
      result: { readiness: 'load', tab: { tabId: '1', url: destination } },
    })
    expect(chrome.commands.filter(({ method }) => method === 'Page.navigate')).toEqual([
      { target: { tabId: 1 }, method: 'Page.navigate', params: { url: destination } },
    ])
    expect(chrome.injections).toEqual([])
    expect(chrome.attached).toEqual(new Set())
  })

  it('rejects an expired request without attaching, injecting, or replaying navigation', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 9, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const authority = (runtime as unknown as { authorities: { acquire(input: unknown): Promise<unknown> } }).authorities
    await authority.acquire({ tabId: 9, ownerId: 'owner', ownerEpoch: 3, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)

    await expect(execute(navigateRequest({ tabId: 9, leaseEpoch: 3, requestId: 'expired', deadlineAt: new Date(Date.now() - 1).toISOString() }))).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(chrome.injections).toEqual([])
    expect(chrome.commands).toEqual([])
    expect(chrome.attached).toEqual(new Set())
  })
})

function navigateRequest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: 'request-navigate',
    leaseId: 'owner',
    leaseEpoch: 1,
    tabId: 7,
    operation: 'navigate',
    input: { url: 'https://fixture.invalid/next', readiness: 'none', timeoutMs: 1_000 },
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    ...overrides,
  }
}
