import { describe, expect, it, vi } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import { PAYLOAD_VERSION } from '../src/runtime/identity.js'
import { LeaseManager } from '../src/runtime/lease-manager.js'
import { FakePort, FakeStorage, fakeChrome } from './fakes.js'

const identity = { directory: `${PAYLOAD_VERSION}-${'a'.repeat(64)}`, sha256: 'a'.repeat(64) }
const tab = { id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }

function nativePort(): FakePort {
  const port = new FakePort()
  port.onPost = (message) => {
    const request = message as { id?: string; method?: string }
    if (request.method !== 'forge.runtime.hello') return
    port.emitMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: 1,
        desktopInstanceId: 'desktop-restart',
        heartbeatMs: 1_000,
        maxMessageBytes: 262_144,
        requiredShellAbi: 1,
      },
    })
  }
  return port
}

describe('service-worker restart debugger reconciliation', () => {
  it('detaches a positively owned debugger left by suspension while retaining logical idle authority', async () => {
    const session = new FakeStorage()
    const local = new FakeStorage()
    const chrome = fakeChrome({ tabs: [tab], session, local })
    const persisted = new LeaseManager(chrome, PAYLOAD_VERSION)
    await persisted.acquire({ tabId: 7, ownerId: 'lease', ownerEpoch: 1, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    await persisted.beginAgentControl('lease', 1, 7)
    chrome.attached.add(7)
    const port = nativePort()
    chrome.runtime.connectNative = () => port

    const runtime = new Runtime({ chrome })
    await runtime.initialize(identity)
    expect(chrome.attached).toEqual(new Set())
    expect(runtime.diagnostics()).toMatchObject({
      authorities: [{ tabId: 7, ownerId: 'lease', ownerEpoch: 1, state: 'idle' }],
      debuggerSessions: [],
    })
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({
      method: 'browser.leaseChanged',
      params: expect.objectContaining({ leaseId: 'lease', leaseEpoch: 1, state: 'acquired', tabIds: [7] }),
    })))

    const released = await (runtime as unknown as {
      handleDesktopRequest(message: Record<string, unknown>): Promise<Record<string, unknown>>
    }).handleDesktopRequest({
      jsonrpc: '2.0', id: 'release-after-restart', method: 'forge.browser.release',
      params: { protocolVersion: 1, leaseId: 'lease', leaseEpoch: 1, reason: 'desktop-restart' },
    })
    expect(released).toMatchObject({ releasedTabIds: [7] })
    await runtime.shutdown()
  })

  it('treats a foreign recovered debugger as preemption, never detaches it, and writes an exact terminal receipt', async () => {
    const session = new FakeStorage()
    const local = new FakeStorage()
    const chrome = fakeChrome({
      tabs: [tab],
      session,
      local,
      debuggerTargets: [{ tabId: 7, attached: true, extensionId: 'foreign-devtools' }],
    })
    chrome.debugger.sendCommand = async () => { throw new Error('Debugger is not attached to the tab with id: 7.') }
    const persisted = new LeaseManager(chrome, PAYLOAD_VERSION)
    await persisted.acquire({ tabId: 7, ownerId: 'lease', ownerEpoch: 2, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    const port = nativePort()
    chrome.runtime.connectNative = () => port

    const runtime = new Runtime({ chrome })
    await runtime.initialize(identity)
    expect(runtime.diagnostics().authorities).toEqual([])
    expect(chrome.attached).toEqual(new Set())
    const authorities = runtime as unknown as {
      authorities: { releaseScope(ownerId: string, ownerEpoch: number): number[] }
    }
    expect(authorities.authorities.releaseScope('lease', 2)).toEqual([7])
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({
      method: 'browser.leaseChanged',
      params: expect.objectContaining({ leaseId: 'lease', leaseEpoch: 2, state: 'released', tabIds: [7] }),
    })))
    expect(local.values['forge.externalChrome.releaseReceipts.v2']).toMatchObject({
      receipts: [expect.objectContaining({ ownerId: 'lease', ownerEpoch: 2, tabIds: [7] })],
    })
    await runtime.shutdown()
  })
})
