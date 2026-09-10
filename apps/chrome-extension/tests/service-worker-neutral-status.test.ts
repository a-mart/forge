import { describe, expect, it, vi } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import type { LeaseManager } from '../src/runtime/lease-manager.js'
import { fakeChrome } from './fakes.js'

describe('created neutral target status through the shared response parser', () => {
  async function acquireHiddenNeutralTarget() {
    const chrome = fakeChrome()
    const get = chrome.tabs.get.bind(chrome.tabs)
    chrome.tabs.get = async (tabId) => ({ ...await get(tabId), url: undefined, pendingUrl: undefined })
    const runtime = new Runtime({ chrome })
    ;(runtime as unknown as { extensionInstanceId: string }).extensionInstanceId = 'neutral-status-fixture'
    const acquired = await runtime.handleIsolatedFixtureRequest({
      jsonrpc: '2.0', id: 'acquire-hidden-neutral', method: 'forge.browser.acquire',
      params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'owner', leaseEpoch: 1, createIfNeeded: true },
    })
    expect(acquired.parsed).toMatchObject({ result: { created: true, tab: { tabId: 1, url: 'about:blank' } } })
    return { chrome, runtime }
  }

  function statusRequest(runtime: Runtime) {
    return runtime.handleIsolatedFixtureRequest({
      jsonrpc: '2.0', id: 'status-hidden-neutral', method: 'forge.browser.execute',
      params: {
        protocolVersion: 1, requestId: 'status-hidden-neutral', leaseId: 'owner', leaseEpoch: 1,
        tabId: 1, operation: 'status', input: {}, deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      },
    })
  }

  it.each(['ordinary', 'already-navigated'] as const)(
    'rejects a hidden-URL %s lease even when the top frame reports about:blank', async (kind) => {
      const chrome = fakeChrome({ tabs: kind === 'ordinary'
        ? [{ id: 1, windowId: 1, active: true, url: 'https://example.com/' }]
        : [] })
      const runtime = new Runtime({ chrome })
      ;(runtime as unknown as { extensionInstanceId: string }).extensionInstanceId = 'neutral-status-fixture'
      const acquired = await runtime.handleIsolatedFixtureRequest({
        jsonrpc: '2.0', id: 'acquire-control', method: 'forge.browser.acquire',
        params: {
          protocolVersion: 1, sessionAgentId: 'session', leaseId: 'owner', leaseEpoch: 1,
          ...(kind === 'ordinary' ? { tabId: 1, createIfNeeded: false } : { createIfNeeded: true }),
        },
      })
      expect(acquired.parsed).toMatchObject({
        result: { created: kind === 'already-navigated', tab: { tabId: 1 } },
      })
      const authorities = (runtime as unknown as { authorities: LeaseManager }).authorities
      if (kind === 'already-navigated') {
        await chrome.tabs.update(1, { url: 'https://example.com/' })
        await expect(authorities.completeInitialNavigation('owner', 1, 1)).resolves.toMatchObject({
          createdByForge: true, initialNavigationPending: false,
        })
      }
      expect(authorities.forTab(1)).toMatchObject({
        createdByForge: kind === 'already-navigated', initialNavigationPending: false,
      })
      const get = chrome.tabs.get.bind(chrome.tabs)
      chrome.tabs.get = async (tabId) => ({ ...await get(tabId), url: undefined, pendingUrl: undefined })
      const getFrame = vi.fn(async () => ({ url: 'about:blank' }))
      chrome.webNavigation.getFrame = getFrame
      const updatesBeforeStatus = structuredClone(chrome.updates)

      const status = await statusRequest(runtime)
      expect(status.parsed).toMatchObject({ result: { ok: false, error: { code: 'restricted-target' } } })
      expect(status.parsed).not.toHaveProperty('result.result')
      expect(getFrame).not.toHaveBeenCalled()
      expect(chrome.updates).toEqual(updatesBeforeStatus)
      expect(chrome.injections).toEqual([])
      expect(chrome.attached).toEqual(new Set())
      expect(chrome.commands).toEqual([])
    },
  )

  it.each([
    { label: 'url', url: 'https://example.com/current', pendingUrl: undefined, expected: 'https://example.com/current' },
    { label: 'pendingUrl', url: undefined, pendingUrl: 'https://example.com/pending', expected: 'https://example.com/pending' },
    { label: 'url before pendingUrl', url: 'https://example.com/current', pendingUrl: 'https://example.com/pending', expected: 'https://example.com/current' },
  ])('preserves the provided $label without consulting frame proof', async ({ url, pendingUrl, expected }) => {
    const { chrome, runtime } = await acquireHiddenNeutralTarget()
    const get = chrome.tabs.get.bind(chrome.tabs)
    chrome.tabs.get = async (tabId) => ({ ...await get(tabId), url, pendingUrl })
    const getFrame = vi.fn(async () => ({ url: 'about:blank' }))
    chrome.webNavigation.getFrame = getFrame

    const status = await statusRequest(runtime)
    expect(status.parsed).toMatchObject({ result: { ok: true, result: { selectedTab: { url: expected } } } })
    expect(getFrame).not.toHaveBeenCalled()
    expect(chrome.updates).toEqual([])
    expect(chrome.injections).toEqual([])
    expect(chrome.attached).toEqual(new Set())
    expect(chrome.commands).toEqual([])
  })

  it('returns a parsed lease failure when scope is revoked during the frame read', async () => {
    const { chrome, runtime } = await acquireHiddenNeutralTarget()
    const authorities = (runtime as unknown as { authorities: { markLost(tabId: number): Promise<void> } }).authorities
    const getFrame = vi.fn(async () => {
      await authorities.markLost(1)
      return { url: 'about:blank' }
    })
    chrome.webNavigation.getFrame = getFrame

    const status = await statusRequest(runtime)
    expect(getFrame).toHaveBeenCalledWith({ tabId: 1, frameId: 0 })
    expect(status.parsed).toMatchObject({ result: { ok: false, error: { code: 'lease-lost' } } })
    expect(status.parsed).not.toHaveProperty('result.result')
  })

  it.each(['missing', 'different-url', 'read-failed'] as const)(
    'returns a parsed failure without fabricating blank when the frame is %s', async (condition) => {
      const { chrome, runtime } = await acquireHiddenNeutralTarget()
      const getFrame = vi.fn(async () => {
        if (condition === 'read-failed') throw new Error('frame unavailable')
        return condition === 'missing' ? null : { url: 'https://example.com/' }
      })
      chrome.webNavigation.getFrame = getFrame

      const status = await statusRequest(runtime)
      expect(getFrame).toHaveBeenCalledWith({ tabId: 1, frameId: 0 })
      expect(status.parsed).toMatchObject({ result: { ok: false, error: { code: 'restricted-target' } } })
      expect(status.parsed).not.toHaveProperty('result.result')
      expect(chrome.updates).toEqual([])
      expect(chrome.injections).toEqual([])
      expect(chrome.attached).toEqual(new Set())
      expect(chrome.commands).toEqual([])
    },
  )

  it('returns about:blank when tabs hides both URLs and the top frame proves the created neutral target', async () => {
    const chrome = fakeChrome()
    const get = chrome.tabs.get.bind(chrome.tabs)
    chrome.tabs.get = async (tabId) => ({ ...await get(tabId), url: undefined, pendingUrl: undefined })
    const getFrame = vi.fn(chrome.webNavigation.getFrame.bind(chrome.webNavigation))
    chrome.webNavigation.getFrame = getFrame
    const runtime = new Runtime({ chrome })
    // Supply fixture identity without initializing the native connection lifecycle.
    ;(runtime as unknown as { extensionInstanceId: string }).extensionInstanceId = 'neutral-status-fixture'

    const acquired = await runtime.handleIsolatedFixtureRequest({
      jsonrpc: '2.0', id: 'acquire-hidden-neutral', method: 'forge.browser.acquire',
      params: { protocolVersion: 1, sessionAgentId: 'session', leaseId: 'owner', leaseEpoch: 1, createIfNeeded: true },
    })
    expect(acquired.parsed).toMatchObject({
      result: { created: true, tab: { tabId: 1, url: 'about:blank' } },
    })
    expect(await chrome.tabs.get(1)).toMatchObject({ url: undefined, pendingUrl: undefined })
    expect(getFrame).toHaveBeenCalledWith({ tabId: 1, frameId: 0 })
    expect(await chrome.webNavigation.getFrame({ tabId: 1, frameId: 0 })).toMatchObject({ url: 'about:blank' })
    getFrame.mockClear()

    // Exercise Runtime's normal response compaction and production shared parser.
    const status = await runtime.handleIsolatedFixtureRequest({
      jsonrpc: '2.0', id: 'status-hidden-neutral', method: 'forge.browser.execute',
      params: {
        protocolVersion: 1, requestId: 'status-hidden-neutral', leaseId: 'owner', leaseEpoch: 1,
        tabId: 1, operation: 'status', input: {}, deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      },
    })
    expect(status.parsed).toMatchObject({
      result: { ok: true, result: { selectedTab: { url: 'about:blank' } } },
    })
    expect(getFrame).toHaveBeenCalledWith({ tabId: 1, frameId: 0 })
    expect(chrome.updates).toEqual([])
    expect(chrome.injections).toEqual([])
    expect(chrome.attached).toEqual(new Set())
    expect(chrome.commands).toEqual([])
  })
})
