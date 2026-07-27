import { afterEach, describe, expect, it, vi } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import { fakeChrome } from './fakes.js'

afterEach(() => vi.unstubAllGlobals())

describe('Chrome-backed Browser reveal', () => {
  it('activates and focuses only the currently authorized tab', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 2, active: false, url: 'https://fixture.invalid/' }] })
    const updateTab = vi.fn(async () => undefined)
    const updateWindow = vi.fn(async () => undefined)
    ;(chrome.tabs as unknown as { update: typeof updateTab }).update = updateTab
    ;(chrome.windows as unknown as { update: typeof updateWindow }).update = updateWindow
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const authority = (runtime as unknown as { authorities: { acquire(input: unknown): Promise<unknown> } }).authorities
    await authority.acquire({ tabId: 7, ownerId: 'lease-1', ownerEpoch: 4, sessionAgentId: 'session-1', expectedOwnerEpoch: 0 })
    const handle = (runtime as unknown as { handleDesktopRequest(input: unknown): Promise<unknown> }).handleDesktopRequest.bind(runtime)

    await expect(handle({
      jsonrpc: '2.0', id: 'reveal-1', method: 'forge.browser.reveal',
      params: { protocolVersion: 1, leaseId: 'lease-1', leaseEpoch: 4, tabId: 7 },
    })).resolves.toEqual({ protocolVersion: 1, leaseId: 'lease-1', leaseEpoch: 4, tabId: 7, revealed: true })
    expect(updateTab).toHaveBeenCalledWith(7, { active: true })
    expect(updateWindow).toHaveBeenCalledWith(2, { focused: true })
  })
})
