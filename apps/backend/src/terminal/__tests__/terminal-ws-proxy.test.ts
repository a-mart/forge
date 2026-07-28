import { createServer, request as httpRequest, type Server } from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalRuntimeConfig } from '../terminal-config.js'
import { TerminalWsProxy } from '../terminal-ws-proxy.js'

const config: TerminalRuntimeConfig = {
  enabled: true,
  maxTerminalsPerManager: 5,
  defaultCols: 80,
  defaultRows: 24,
  scrollbackLines: 100,
  outputBatchIntervalMs: 5,
  snapshotIntervalMs: 60_000,
  journalMaxBytes: 1_048_576,
  shutdownSnapshotTimeoutMs: 1_000,
  restoreStartupConcurrency: 1,
  wsTicketTtlMs: 1_000,
  wsMaxBufferedAmountBytes: 32,
}

const descriptor = {
  terminalId: 'terminal-1',
  sessionAgentId: 'session-1',
  profileId: 'profile-1',
  name: 'Shell',
  shell: '/bin/sh',
  shellArgs: [],
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  state: 'running',
  pid: 1,
  exitCode: null,
  exitSignal: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const

type ClientCallbacks = {
  onData: (chunk: Buffer) => void
  onControl: (message: unknown) => void
}

function createService() {
  let callbacks: ClientCallbacks | undefined
  let detached = 0
  const handleInput = vi.fn(async () => {})
  const handleClientControl = vi.fn(async (input: { message: unknown; reply: (message: unknown) => void }) => {
    if ((input.message as { type?: string }).type === 'ping') {
      input.reply({ channel: 'control', type: 'pong' })
    }
  })
  const service = {
    validateWsTicket: vi.fn((input: { ticket: string; terminalId: string; sessionAgentId: string; requesterAgentId: string }) =>
      input.ticket === 'valid-ticket' &&
      input.terminalId === 'terminal-1' &&
      input.sessionAgentId === 'session-1' &&
      input.requesterAgentId === 'requester-1'),
    getTerminal: vi.fn((input: { terminalId: string; sessionAgentId: string }) =>
      input.terminalId === 'terminal-1' && input.sessionAgentId === 'requester-1' ? descriptor : undefined),
    attachClient: vi.fn(async (input: ClientCallbacks) => {
      callbacks = input
      return () => {
        detached += 1
      }
    }),
    handleInput,
    handleClientControl,
  }
  return {
    service,
    emitData: (chunk: Buffer) => callbacks?.onData(chunk),
    emitControl: (message: unknown) => callbacks?.onControl(message),
    get detached() {
      return detached
    },
  }
}

async function startProxy(service: ReturnType<typeof createService>) {
  const proxy = new TerminalWsProxy({ terminalService: service.service as never, runtimeConfig: config })
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname
    proxy.handleUpgrade(request, socket, head, pathname)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return { proxy, server, port: address.port }
}

function wsUrl(port: number, ticket = 'valid-ticket', requesterAgentId = 'requester-1'): string {
  return `ws://127.0.0.1:${port}/terminal/ws/terminal-1?sessionAgentId=session-1&requesterAgentId=${requesterAgentId}&ticket=${ticket}`
}

async function upgradeStatus(port: number, ticket: string, requesterAgentId: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: new URL(wsUrl(port, ticket, requesterAgentId)).pathname + new URL(wsUrl(port, ticket, requesterAgentId)).search,
      headers: { connection: 'Upgrade', upgrade: 'websocket', host: `127.0.0.1:${port}`, origin },
    }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.once('error', reject)
    request.end()
  })
}

async function closeServer(server: Server, proxy: TerminalWsProxy): Promise<void> {
  await proxy.stop().catch(() => undefined)
  if (server.listening) {
    server.close()
    await once(server, 'close')
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TerminalWsProxy over a real HTTP upgrade', () => {
  it('rejects invalid, expired, and wrong-owner tickets and disallowed origins', async () => {
    const service = createService()
    const { server, port } = await startProxy(service)
    try {
      const cases = [
        ['invalid', 'not-a-ticket', 'requester-1', 'http://127.0.0.1'],
        ['expired', 'expired-ticket', 'requester-1', 'http://127.0.0.1'],
        ['wrong owner', 'valid-ticket', 'other-agent', 'http://127.0.0.1'],
        ['bad origin', '', 'requester-1', 'https://evil.example'],
      ] as const

      for (const [label, ticket, requester, origin] of cases) {
        const status = await upgradeStatus(port, ticket, requester, origin)
        expect(status, label).toBe(403)
        expect(service.service.attachClient).not.toHaveBeenCalled()
      }
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })

  it('transports binary I/O and control frames, and detaches on close', async () => {
    const service = createService()
    const { server, proxy, port } = await startProxy(service)
    const client = new WebSocket(wsUrl(port), { origin: 'http://127.0.0.1' })
    try {
      await once(client, 'open')
      const received: Array<{ binary: boolean; data: Buffer }> = []
      client.on('message', (data, isBinary) => received.push({ binary: isBinary, data: Buffer.from(data as Buffer) }))

      service.emitData(Buffer.from([0, 1, 2, 255]))
      await vi.waitFor(() => expect(received).toContainEqual({ binary: true, data: Buffer.from([0, 1, 2, 255]) }))

      client.send(Buffer.from('input'))
      await vi.waitFor(() => expect(service.service.handleInput).toHaveBeenCalledWith('terminal-1', Buffer.from('input'), 'requester-1'))

      client.send(JSON.stringify({ channel: 'control', type: 'ping' }))
      client.send(JSON.stringify({ channel: 'control', type: 'resize', cols: 100, rows: 30 }))
      await vi.waitFor(() => expect(service.service.handleClientControl).toHaveBeenCalledTimes(2))
      expect(service.service.handleClientControl).toHaveBeenLastCalledWith(expect.objectContaining({
        message: { channel: 'control', type: 'resize', cols: 100, rows: 30 },
      }))

      client.close()
      await once(client, 'close')
      await vi.waitFor(() => expect(service.detached).toBe(1))
    } finally {
      if (client.readyState === WebSocket.OPEN) client.close()
      await closeServer(server, proxy)
    }
  })

  it('closes overloaded clients and detaches when the proxy stops', async () => {
    const service = createService()
    const { server, proxy, port } = await startProxy(service)
    const client = new WebSocket(wsUrl(port), { origin: 'http://127.0.0.1' })
    let bufferedAmountDescriptor: PropertyDescriptor | undefined
    try {
      await once(client, 'open')
      await vi.waitFor(() => expect(service.service.attachClient).toHaveBeenCalledTimes(1))
      bufferedAmountDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')
      Object.defineProperty(WebSocket.prototype, 'bufferedAmount', { configurable: true, get: () => config.wsMaxBufferedAmountBytes + 1 })
      let closeCode: number | undefined
      client.on('close', (code) => { closeCode = code })
      service.emitData(Buffer.from('overload'))
      await vi.waitFor(() => expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(client.readyState))
      client.terminate()
      await vi.waitFor(() => expect(closeCode).toBe(1013))
      await vi.waitFor(() => expect(service.detached).toBe(1))

    } finally {
      if (bufferedAmountDescriptor) {
        Object.defineProperty(WebSocket.prototype, 'bufferedAmount', bufferedAmountDescriptor)
      } else {
        delete (WebSocket.prototype as { bufferedAmount?: unknown }).bufferedAmount
      }
      await closeServer(server, proxy)
    }
  })
})
