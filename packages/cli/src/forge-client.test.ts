import { EventEmitter } from 'node:events'

import type { CliWsCommand, ServerEvent } from '@forge/protocol'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'

import { ForgeClient, normalizeBaseUrl } from './forge-client.js'
import { EXIT_CODES } from './version.js'

describe('ForgeClient', () => {
  it('normalizes WebSocket URLs to HTTP URLs for CLI HTTP reads', () => {
    expect(normalizeBaseUrl('ws://127.0.0.1:47287').toString()).toBe('http://127.0.0.1:47287/')
    expect(normalizeBaseUrl('wss://forge.example').toString()).toBe('https://forge.example/')
  })

  it('always sends bearer auth and never retries unauthenticated', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret',
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers)
        calls.push({ url: String(url), auth: headers.get('authorization') })
        return Response.json({
          serverTime: 'now',
          serverVersion: '0.9.0',
          capabilities: { protocolVersion: 1, minCliVersion: '0.9.0', available: true, features: {} },
        })
      },
    })

    await client.getCapabilities()
    expect(calls).toEqual([{ url: 'http://127.0.0.1:47287/api/cli/capabilities', auth: 'Bearer secret' }])
  })

  it('redacts API keys from HTTP error messages', async () => {
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: async () => Response.json({ error: { code: 'bad', message: 'bad secret-token value' } }, { status: 500 }),
    })

    await expect(client.getStatus()).rejects.toMatchObject({
      message: 'bad <redacted> value',
      code: 'bad',
    })
  })

  it('maps 403 policy errors to usage, not auth', async () => {
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: async () => Response.json({ error: { code: 'system_profile', message: 'System profile is not writable.' } }, { status: 403 }),
    })

    await expect(client.getStatus()).rejects.toMatchObject({
      code: 'system_profile',
      exitCode: EXIT_CODES.usage,
    })
  })

  it('maps revoked CLI keys to auth failures even when the server returns 403', async () => {
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: async () => Response.json({ error: { code: 'revoked_token', message: 'CLI API key has been revoked' } }, { status: 403 }),
    })

    await expect(client.getStatus()).rejects.toMatchObject({
      code: 'revoked_token',
      exitCode: EXIT_CODES.auth,
    })
  })

  it('subscribes before dispatching run to avoid fast-output races', async () => {
    const socket = new FakeWebSocket()
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: statusFetch,
      WebSocketImpl: fakeWebSocketImpl(socket),
    })

    await expect(client.run({ command: 'run', target: { kind: 'session', agentId: 'session-1' }, text: 'hello' })).resolves.toMatchObject({
      status: 'success',
      finalMessage: 'fast done',
    })
    expect(socket.sent.map((command) => command.type).slice(0, 2)).toEqual(['subscribe_headless', 'cli_run'])
  })

  it('aborts run waits immediately when the CLI WebSocket disconnects', async () => {
    const socket = new FakeWebSocket({ closeAfterRunAck: true })
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: statusFetch,
      WebSocketImpl: fakeWebSocketImpl(socket),
    })

    await expect(client.run({ command: 'run', target: { kind: 'session', agentId: 'session-1' }, text: 'hello', timeoutMs: 60_000 })).rejects.toMatchObject({
      code: 'ws_closed',
      exitCode: EXIT_CODES.connection,
    })
  })

  it('rejects subscription waits immediately when the CLI WebSocket closes before headless_ready', async () => {
    const socket = new FakeWebSocket({ closeBeforeHeadlessReady: true })
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: statusFetch,
      WebSocketImpl: fakeWebSocketImpl(socket),
    })

    await expect(settleWithin(client.waitForSession('session-1', { timeoutMs: 60_000 }), 100)).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        code: 'ws_closed',
        exitCode: EXIT_CODES.connection,
      }),
    })
  })
})

async function statusFetch(): Promise<Response> {
  return Response.json({
    status: 'ok',
    serverTime: 'now',
    serverVersion: '0.9.0',
    runtimeTarget: 'builder',
    capabilities: {
      protocolVersion: 1,
      minCliVersion: '0.9.0',
      available: true,
      runtimeTarget: 'builder',
      features: {
        bearerAuth: true,
        headlessWs: true,
        cliSourceContext: true,
        cliSessionMetadata: true,
        choiceOwnerLookup: true,
        activeToolSnapshot: true,
        projectAgentRunTarget: true,
        sessionTranscript: true,
        builderRuntimeOnly: true,
      },
    },
    summary: { profileCount: 1, sessionCount: 1, agentCount: 1 },
  })
}

function fakeWebSocketImpl(socket: FakeWebSocket): typeof WebSocket {
  return function createFakeWebSocket() {
    queueMicrotask(() => socket.emit('open'))
    return socket
  } as unknown as typeof WebSocket
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<PromiseSettledResult<T> | { status: 'timed_out' }> {
  return Promise.race([
    promise.then(
      (value): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value }),
      (reason): PromiseRejectedResult => ({ status: 'rejected', reason }),
    ),
    new Promise<{ status: 'timed_out' }>((resolve) => setTimeout(() => resolve({ status: 'timed_out' }), timeoutMs)),
  ])
}

class FakeWebSocket extends EventEmitter {
  readonly sent: CliWsCommand[] = []
  readyState = WebSocket.OPEN

  constructor(private readonly options: { closeAfterRunAck?: boolean; closeBeforeHeadlessReady?: boolean } = {}) {
    super()
  }

  send(raw: string, callback?: (error?: Error) => void): void {
    const command = JSON.parse(raw) as CliWsCommand
    this.sent.push(command)
    callback?.()
    if (command.type === 'subscribe_headless') {
      if (this.options.closeBeforeHeadlessReady) {
        this.emit('close')
      } else {
        this.emitEvent({
          type: 'headless_ready',
          requestId: command.requestId,
          serverTime: 'now',
          capabilities: (statusPayload().capabilities),
          subscribed: { agentId: 'session-1', profileId: 'profile-1' },
          targetAgent: {
            agentId: 'session-1',
            managerId: 'session-1',
            role: 'manager',
            status: 'idle',
            displayName: 'Session 1',
            createdAt: 'now',
            updatedAt: 'now',
            cwd: '/tmp',
            model: { provider: 'openai', modelId: 'gpt-5.3' },
            sessionFile: '/tmp/session.jsonl',
            profileId: 'profile-1',
          },
          pendingChoices: [],
          workers: [],
          activeTools: [],
          status: { agentId: 'session-1', status: 'idle', pendingCount: 0 },
        })
      }
    }
    if (command.type === 'cli_run') {
      this.emitEvent({
        type: 'cli_request_success',
        requestId: command.requestId,
        commandType: command.type,
        result: { sessionAgentId: 'session-1', profileId: 'profile-1', messageId: 'message-1', acceptedAt: 'now' },
      })
      if (this.options.closeAfterRunAck) {
        this.emit('close')
      } else {
        this.emitEvent({ type: 'conversation_message', agentId: 'session-1', role: 'assistant', text: 'fast done', timestamp: 'now' })
      }
    }
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
  }

  private emitEvent(event: ServerEvent): void {
    this.emit('message', JSON.stringify(event))
  }
}

function statusPayload() {
  return {
    capabilities: {
      protocolVersion: 1,
      minCliVersion: '0.9.0',
      available: true,
      runtimeTarget: 'builder',
      features: {
        bearerAuth: true,
        headlessWs: true,
        cliSourceContext: true,
        cliSessionMetadata: true,
        choiceOwnerLookup: true,
        activeToolSnapshot: true,
        projectAgentRunTarget: true,
        sessionTranscript: true,
        builderRuntimeOnly: true,
      },
    },
  } as const
}
