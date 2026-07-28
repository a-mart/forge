import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAYLOAD_VERSION } from '../src/runtime/identity.js'
import { Runtime } from '../src/payload/service-worker/index.js'
import { FakePort, fakeChrome } from './fakes.js'

afterEach(() => vi.unstubAllGlobals())

describe('service-worker native relay recovery', () => {
  it('restarts native negotiation from the durable transport-grace alarm after Desktop disconnect', async () => {
    const chrome = fakeChrome()
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

    ports[0]!.emitDisconnect()
    expect(graceAlarms).toEqual([{ name: 'forge.externalChrome.transportGrace.v2', delayInMinutes: 0.5 }])
    runtime.onShellEvent('alarm', [{ name: 'forge.externalChrome.transportGrace.v2' }])
    expect(attempts).toBe(3)

    runtime.shutdown()
  })
})
