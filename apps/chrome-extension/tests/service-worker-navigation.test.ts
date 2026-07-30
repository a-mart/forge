import { EXTERNAL_CHROME_NAVIGATION_NOT_DISPATCHED_DETAILS } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import type { ChromeTab } from '../src/runtime/chrome-api.js'
import { fakeChrome } from './fakes.js'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('service-worker navigation orchestration', () => {
  it('acquires before Runtime navigation, injects only after attach, and retains an idle reusable attachment', async () => {
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
    expect(chrome.attached).toEqual(new Set([7]))
    expect((runtime as unknown as { authorities: { forTab(id: number): { state: string } | null } }).authorities.forTab(7)).toMatchObject({ state: 'idle' })
  })

  it('does not dispatch navigation when content preflight crosses the request deadline', async () => {
    const startedAt = Date.parse('2026-01-01T00:00:00.000Z')
    let currentTime = startedAt
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    const runtime = new Runtime({ chrome, now: () => currentTime })
    const authority = (runtime as unknown as { authorities: { acquire(input: unknown): Promise<unknown> } }).authorities
    await authority.acquire({ tabId: 7, ownerId: 'owner', ownerEpoch: 1, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = async (injection) => {
      const result = await executeScript(injection)
      currentTime = startedAt + 100
      return result
    }
    const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)

    await expect(execute(navigateRequest({
      requestId: 'deadline-crossed-during-injection',
      deadlineAt: new Date(startedAt + 100).toISOString(),
      input: { url: 'https://fixture.invalid/expired-preflight', readiness: 'load', timeoutMs: 1_000 },
    }))).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'timeout',
        details: EXTERNAL_CHROME_NAVIGATION_NOT_DISPATCHED_DETAILS,
      },
    })
    expect(chrome.injections).toHaveLength(1)
    expect(chrome.commands.filter(({ method }) => method === 'Page.navigate')).toEqual([])
    expect(chrome.attached).toEqual(new Set())
  })

  it('transitions a fresh neutral target once before using normal page authority', async () => {
    const tabs: ChromeTab[] = []
    const chrome = fakeChrome({ tabs })
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const handleDesktopRequest = (runtime as unknown as {
      handleDesktopRequest(input: unknown): Promise<Record<string, unknown>>
    }).handleDesktopRequest.bind(runtime)
    const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)
    const destination = 'http://localhost:3100/candidates?page=1&search=little'
    const injectionUrls: string[] = []
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting)
    chrome.scripting.executeScript = async (injection) => {
      injectionUrls.push((await chrome.tabs.get(injection.target.tabId)).url ?? '')
      return executeScript(injection)
    }
    const sendCommand = chrome.debugger.sendCommand.bind(chrome.debugger)
    chrome.debugger.sendCommand = async (target, method, params) => {
      const result = await sendCommand(target, method, params)
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('interactiveElements')) {
        return value({ url: destination, title: 'Candidates', loading: false, visibleText: 'Candidates', interactiveElements: [] })
      }
      if (method === 'Runtime.evaluate' && params?.expression === 'window.devicePixelRatio') return value(1)
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 320, clientHeight: 200, pageX: 0, pageY: 0 } }
      if (method === 'Page.captureScreenshot') return { data: pngBase64(2, 2) }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      return result
    }
    let debuggerAttachCalls = 0
    const attach = chrome.debugger.attach.bind(chrome.debugger)
    chrome.debugger.attach = async (target, requiredVersion) => {
      debuggerAttachCalls += 1
      return attach(target, requiredVersion)
    }
    const update = chrome.tabs.update.bind(chrome.tabs)
    chrome.tabs.update = async (tabId, properties) => {
      expect(tabs.find((tab) => tab.id === tabId)).toMatchObject({ url: 'about:blank', active: false })
      expect(debuggerAttachCalls).toBe(0)
      expect(chrome.injections).toEqual([])
      const updated = await update(tabId, properties)
      queueMicrotask(() => {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (tab) tab.status = 'complete'
        const details = { tabId, frameId: 0, documentId: `document-${tabId}`, url: properties.url }
        runtime.onShellEvent('navigation.committed', [details])
        runtime.onShellEvent('navigation.domContentLoaded', [details])
        runtime.onShellEvent('navigation.completed', [details])
      })
      return updated
    }

    const acquired = await handleDesktopRequest({
      jsonrpc: '2.0', id: 'desktop-acquire-neutral', method: 'forge.browser.acquire',
      params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'owner', leaseEpoch: 1, createIfNeeded: true },
    })
    expect(acquired).toMatchObject({ created: true, tab: { tabId: 1, url: 'about:blank', active: false } })
    expect(chrome.attached).toEqual(new Set())
    expect(chrome.injections).toEqual([])
    await handleDesktopRequest({
      jsonrpc: '2.0', id: 'release-neutral-before-navigation', method: 'forge.browser.release',
      params: { protocolVersion: 1, leaseId: 'owner', leaseEpoch: 1, reason: 'idle' },
    })
    await expect(handleDesktopRequest({
      jsonrpc: '2.0', id: 'reacquire-neutral', method: 'forge.browser.acquire',
      params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'next-owner', leaseEpoch: 2, tabId: 1, createIfNeeded: false },
    })).resolves.toMatchObject({ created: false, tab: { tabId: 1, url: 'about:blank', active: false } })

    await expect(execute({
      ...navigateRequest({ requestId: 'snapshot-neutral', tabId: 1, leaseId: 'next-owner', leaseEpoch: 2 }), operation: 'snapshot', input: {},
    })).resolves.toMatchObject({ ok: false, error: { code: 'restricted-target' } })
    expect(debuggerAttachCalls).toBe(0)
    expect(chrome.injections).toEqual([])
    const internals = runtime as unknown as {
      activeOperations: Map<number, Promise<void>>
      injectContentScript(details: unknown): Promise<boolean>
    }
    internals.activeOperations.set(1, Promise.resolve())
    await expect(internals.injectContentScript({ tabId: 1, frameId: 0, url: 'about:blank' })).resolves.toBe(false)
    internals.activeOperations.delete(1)
    expect(chrome.injections).toEqual([])

    await expect(execute(navigateRequest({
      requestId: 'navigate-from-neutral', tabId: 1, leaseId: 'next-owner', leaseEpoch: 2,
      input: { url: destination, readiness: 'load', timeoutMs: 1_000 },
    }))).resolves.toMatchObject({
      ok: true,
      result: { readiness: 'load', tab: { tabId: '1', url: destination } },
    })
    expect(chrome.updates).toEqual([{ tabId: 1, properties: { url: destination } }])
    expect(chrome.commands.filter(({ method }) => method === 'Page.navigate')).toEqual([])
    expect(debuggerAttachCalls).toBe(0)
    expect(injectionUrls).toEqual([destination])

    const guard = trustedInputGuard(runtime, 1)
    guard.emitHumanInput()
    await vi.waitFor(() => expect((runtime as unknown as {
      authorities: { forTab(id: number): { controlEpoch: number } | null }
    }).authorities.forTab(1)).toMatchObject({ controlEpoch: 1 }))
    await vi.waitFor(() => expect(chrome.attached).toEqual(new Set()))
    await expect(execute({
      ...navigateRequest({ requestId: 'snapshot-destination', tabId: 1, leaseId: 'next-owner', leaseEpoch: 2 }), operation: 'snapshot', input: {},
    })).resolves.toMatchObject({ ok: true, result: { tabId: '1', url: destination } })
    await expect(execute({
      ...navigateRequest({ requestId: 'click-destination', tabId: 1, leaseId: 'next-owner', leaseEpoch: 2 }),
      operation: 'click', input: { x: 0, y: 0, timeoutMs: 1_000 },
    })).resolves.toMatchObject({ ok: true, result: { tabId: '1', point: { x: 0, y: 0 } } })
    expect(guard.syntheticStarts).toBe(1)
    expect(debuggerAttachCalls).toBe(1)
    expect(injectionUrls).toEqual([destination, destination, destination])
    expect(chrome.commands.filter(({ method }) => method === 'Page.navigate')).toEqual([])
    expect(chrome.attached).toEqual(new Set([1]))
    expect((runtime as unknown as { authorities: { forTab(id: number): { state: string; initialNavigationPending: boolean } | null } }).authorities.forTab(1))
      .toMatchObject({ state: 'idle', initialNavigationPending: false })
  })

  it.each(['none', 'domContentLoaded', 'load'] as const)(
    'uses the exact %s milestone for a neutral target without debugger navigation',
    async (readiness) => {
      const tabs: ChromeTab[] = []
      const chrome = fakeChrome({ tabs })
      vi.stubGlobal('chrome', chrome)
      const runtime = new Runtime()
      const handleDesktopRequest = (runtime as unknown as {
        handleDesktopRequest(input: unknown): Promise<Record<string, unknown>>
      }).handleDesktopRequest.bind(runtime)
      const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)
      await handleDesktopRequest({
        jsonrpc: '2.0', id: `acquire-${readiness}`, method: 'forge.browser.acquire',
        params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'owner', leaseEpoch: 1, createIfNeeded: true },
      })
      const update = chrome.tabs.update.bind(chrome.tabs)
      chrome.tabs.update = (tabId, properties) => update(tabId, properties)

      let settled = false
      const execution = execute(navigateRequest({
        requestId: `navigate-${readiness}`, tabId: 1,
        input: { url: 'https://destination.example.test/', readiness, timeoutMs: 1_000 },
      }))
      void execution.then(() => { settled = true }, () => { settled = true })
      await vi.waitFor(() => expect(chrome.updates).toHaveLength(1))
      const details = { tabId: 1, frameId: 0, documentId: `document-${readiness}`, url: 'https://destination.example.test/' }

      if (readiness === 'none') {
        await expect(execution).resolves.toMatchObject({ ok: true, result: { readiness: 'none' } })
        expect(chrome.injections).toEqual([])
        runtime.onShellEvent('navigation.committed', [details])
        await vi.waitFor(() => expect((runtime as unknown as {
          authorities: { forTab(id: number): { initialNavigationPending: boolean } | null }
        }).authorities.forTab(1)).toMatchObject({ initialNavigationPending: false }))
      } else {
        runtime.onShellEvent('navigation.committed', [details])
        await vi.waitFor(() => expect(chrome.injections).toHaveLength(1))
        expect(settled).toBe(false)
        if (readiness === 'load') {
          runtime.onShellEvent('navigation.domContentLoaded', [details])
          await Promise.resolve()
          expect(settled).toBe(false)
          runtime.onShellEvent('navigation.completed', [details])
        } else {
          runtime.onShellEvent('navigation.domContentLoaded', [details])
        }
        await expect(execution).resolves.toMatchObject({ ok: true, result: { readiness } })
      }
      await vi.waitFor(() => expect(chrome.injections).toHaveLength(1))
      expect(chrome.updates).toHaveLength(1)
      expect(chrome.commands).toEqual([])
      expect(chrome.attached).toEqual(new Set())
    },
  )

  it.each(['expired', 'interrupted'] as const)(
    'does not dispatch tabs.update when initial authority is %s immediately before mutation',
    async (mode) => {
      const start = Date.parse('2026-01-01T00:00:00.000Z')
      if (mode === 'expired') { vi.useFakeTimers(); vi.setSystemTime(start) }
      const chrome = fakeChrome()
      vi.stubGlobal('chrome', chrome)
      const runtime = new Runtime()
      const handleDesktopRequest = (runtime as unknown as {
        handleDesktopRequest(input: unknown): Promise<Record<string, unknown>>
      }).handleDesktopRequest.bind(runtime)
      await handleDesktopRequest({
        jsonrpc: '2.0', id: `acquire-${mode}`, method: 'forge.browser.acquire',
        params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'owner', leaseEpoch: 1, createIfNeeded: true },
      })
      const authorities = (runtime as unknown as {
        authorities: {
          beginAgentControl(ownerId: string, ownerEpoch: number, tabId: number, expectedControlEpoch?: number): Promise<number>
          trustedHumanInput(tabId: number): Promise<unknown>
        }
      }).authorities
      const beginAgentControl = authorities.beginAgentControl.bind(authorities)
      authorities.beginAgentControl = async (...args) => {
        const epoch = await beginAgentControl(...args)
        if (mode === 'expired') vi.setSystemTime(start + 101)
        else await authorities.trustedHumanInput(1)
        return epoch
      }
      const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)

      await expect(execute(navigateRequest({
        requestId: `preflight-${mode}`, tabId: 1,
        deadlineAt: new Date((mode === 'expired' ? start : Date.now()) + 100).toISOString(),
        input: { url: 'https://destination.example.test/', readiness: 'none', timeoutMs: 1_000 },
      }))).resolves.toMatchObject({
        ok: false, error: { code: mode === 'expired' ? 'timeout' : 'request-cancelled' },
      })
      expect(chrome.updates).toEqual([])
      expect(chrome.injections).toEqual([])
      expect(chrome.commands).toEqual([])
    },
  )

  it('does not create a target unless acquisition explicitly requests creation', async () => {
    const tabs: ChromeTab[] = []
    const chrome = fakeChrome({ tabs })
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const handleDesktopRequest = (runtime as unknown as {
      handleDesktopRequest(input: unknown): Promise<Record<string, unknown>>
    }).handleDesktopRequest.bind(runtime)

    await expect(handleDesktopRequest({
      jsonrpc: '2.0', id: 'acquire-without-target', method: 'forge.browser.acquire',
      params: {
        protocolVersion: 1, sessionAgentId: 'session', leaseId: 'owner', leaseEpoch: 1,
        createIfNeeded: false,
      },
    })).rejects.toMatchObject({ code: 'target-not-found' })
    expect(tabs).toEqual([])
    expect(chrome.updates).toEqual([])
  })

  it('never replays an ambiguous initial tabs.update failure', async () => {
    const chrome = fakeChrome()
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const handleDesktopRequest = (runtime as unknown as {
      handleDesktopRequest(input: unknown): Promise<Record<string, unknown>>
    }).handleDesktopRequest.bind(runtime)
    const execute = (runtime as unknown as { execute(input: unknown): Promise<unknown> }).execute.bind(runtime)
    await handleDesktopRequest({
      jsonrpc: '2.0', id: 'acquire-neutral-failure', method: 'forge.browser.acquire',
      params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'owner', leaseEpoch: 1, createIfNeeded: true },
    })
    const update = chrome.tabs.update.bind(chrome.tabs)
    chrome.tabs.update = async (tabId, properties) => {
      await update(tabId, properties)
      throw new Error('tabs.update acknowledgement lost')
    }

    await expect(execute(navigateRequest({ tabId: 1, requestId: 'ambiguous-initial-update' }))).resolves.toMatchObject({
      ok: false, error: { code: 'timeout' },
    })
    expect(chrome.updates).toHaveLength(1)
    expect(chrome.commands).toEqual([])
    expect(chrome.injections).toEqual([])
    expect(chrome.attached).toEqual(new Set())
  })

  it('inventories and explicitly acquires an ordinary tab after focus returns to Forge', async () => {
    const first: ChromeTab = {
      id: 7, windowId: 1, active: true, title: 'Candidates', url: 'https://orthoar.example.test/candidates', lastAccessed: 200,
    }
    const second: ChromeTab = {
      id: 8, windowId: 1, active: false, title: 'Patient', url: 'https://orthoar.example.test/patient', lastAccessed: 100,
    }
    const tabs = [first, second]
    const windows = [{ id: 1, focused: false, type: 'normal' as const, tabs }]
    const chrome = fakeChrome({ tabs, windows })
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const handleDesktopRequest = (runtime as unknown as {
      handleDesktopRequest(input: unknown): Promise<Record<string, unknown>>
    }).handleDesktopRequest.bind(runtime)

    await expect(handleDesktopRequest({
      jsonrpc: '2.0', id: 'inventory', method: 'forge.browser.inventory',
      params: { protocolVersion: 1, sessionAgentId: 'session' },
    })).resolves.toMatchObject({
      tabs: [{ tabId: 7, active: true, windowFocused: false }, { tabId: 8, active: false, windowFocused: false }],
      truncated: false,
    })
    await expect(handleDesktopRequest({
      jsonrpc: '2.0', id: 'acquire-existing', method: 'forge.browser.acquire',
      params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'owner', leaseEpoch: 1, tabId: 8, createIfNeeded: false },
    })).resolves.toMatchObject({
      created: false, tab: { tabId: 8, url: 'https://orthoar.example.test/patient', active: false },
    })
    expect(chrome.attached).toEqual(new Set())
    expect(chrome.injections).toEqual([])
    expect(chrome.updates).toEqual([])
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

function value(result: unknown): Record<string, unknown> {
  return { result: { type: typeof result, value: result } }
}

function pngBase64(width: number, height: number): string {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return Buffer.from(bytes).toString('base64')
}

function trustedInputGuard(runtime: Runtime, tabId: number): { syntheticStarts: number; emitHumanInput(): void } {
  const nonce = '00000000-0000-4000-8000-000000000001'
  const state = { syntheticStarts: 0 }
  let onMessage: ((message: unknown) => void) | undefined
  const port = {
    name: `forge-leased-frame:${nonce}`,
    sender: { tab: { id: tabId }, frameId: 0, documentId: `document-${tabId}` },
    postMessage: (message: unknown) => {
      if (typeof message !== 'object' || message === null) return
      const record = message as Record<string, unknown>
      if (record.type !== 'synthetic-start') return
      state.syntheticStarts += 1
      queueMicrotask(() => onMessage?.({
        type: 'synthetic-ack', nonce, operationId: record.operationId, controlEpoch: record.controlEpoch,
      }))
    },
    disconnect: () => undefined,
    onMessage: { addListener: (listener: (message: unknown) => void) => { onMessage = listener } },
    onDisconnect: { addListener: (_listener: () => void) => undefined },
  }
  runtime.onShellEvent('runtime.connect', [port])
  onMessage?.({ type: 'content-ready', nonce })
  return {
    get syntheticStarts() { return state.syntheticStarts },
    emitHumanInput: () => onMessage?.({ type: 'trusted-human-input', nonce, controlEpoch: 0, event: 'pointer' }),
  }
}

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
