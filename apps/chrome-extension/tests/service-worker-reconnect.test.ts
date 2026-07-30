import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAYLOAD_VERSION } from '../src/runtime/identity.js'
import { Runtime } from '../src/payload/service-worker/index.js'
import { FakePort, fakeChrome } from './fakes.js'

afterEach(() => vi.unstubAllGlobals())

describe('service-worker native relay recovery', () => {
  it('restarts native negotiation from the durable transport-grace alarm after Desktop disconnect', async () => {
    const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/' }] })
    const send = chrome.debugger.sendCommand.bind(chrome.debugger)
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Runtime.evaluate') {
        chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
        return { result: { type: 'number', value: 1 } }
      }
      return send(target, method, params)
    }
    const graceAlarms: Array<{ name: string; delayInMinutes?: number }> = []
    chrome.alarms.create = (name, info) => { if (name === 'forge.externalChrome.transportGrace.v2') graceAlarms.push({ name, delayInMinutes: info.delayInMinutes }) }
    const ports: FakePort[] = []
    let attempts = 0
    chrome.runtime.connectNative = () => {
      attempts += 1
      if (attempts === 2) throw new Error('Desktop is still unavailable')
      const port = new FakePort()
      port.onPost = (message) => {
        const request = message as { id?: string; method?: string }
        if (request.method === 'forge.runtime.hello') {
          port.emitMessage({
            jsonrpc: '2.0', id: request.id,
            result: { protocolVersion: 1, desktopInstanceId: 'desktop-after-restart', heartbeatMs: 1_000, maxMessageBytes: 262_144, requiredShellAbi: 1 },
          })
        }
      }
      ports.push(port)
      return port
    }
    vi.stubGlobal('chrome', chrome)
    const runtime = new Runtime()
    const sha256 = 'a'.repeat(64)
    await runtime.initialize({ directory: `${PAYLOAD_VERSION}-${sha256}`, sha256 })
    await Promise.resolve()
    expect(attempts).toBe(1)
    const internals = runtime as unknown as {
      authorities: {
        acquire(input: Record<string, unknown>): Promise<unknown>
        forTab(tabId: number): unknown
        releaseScope(ownerId: string, ownerEpoch: number): number[]
      }
      execute(input: Record<string, unknown>): Promise<unknown>
    }
    await internals.authorities.acquire({ tabId: 7, ownerId: 'lease', ownerEpoch: 1, sessionAgentId: 'session', expectedOwnerEpoch: 0 })
    await expect(internals.execute({
      protocolVersion: 1, requestId: 'evaluate-before-disconnect', leaseId: 'lease', leaseEpoch: 1, tabId: 7,
      operation: 'evaluate', input: { expression: '1', awaitPromise: true, returnByValue: true },
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    })).resolves.toMatchObject({ ok: true })
    expect(chrome.attached).toEqual(new Set([7]))

    ports[0]!.emitDisconnect()
    await vi.waitFor(() => expect(internals.authorities.forTab(7)).toBeNull())
    expect(chrome.attached).toEqual(new Set())
    expect(internals.authorities.releaseScope('lease', 1)).toEqual([7])
    expect(runtime.diagnostics().debuggerMetrics.detachReasons).toMatchObject({ 'transport-uncertain': 1 })
    expect(graceAlarms).toEqual([{ name: 'forge.externalChrome.transportGrace.v2', delayInMinutes: 0.5 }])
    runtime.onShellEvent('alarm', [{ name: 'forge.externalChrome.transportGrace.v2' }])
    expect(attempts).toBe(3)
    await vi.waitFor(() => expect(ports[1]?.sent).toContainEqual(expect.objectContaining({
      method: 'browser.leaseChanged', params: expect.objectContaining({ state: 'released', tabIds: [7] }),
    })))

    await runtime.shutdown()
  })
})
