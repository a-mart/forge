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

  it('fetches session transcripts with feature-gated query options', async () => {
    const calls: string[] = []
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: async (url) => {
        calls.push(String(url))
        if (String(url).endsWith('/api/cli/status')) return statusFetch()
        return Response.json({
          session: { agentId: 'session-1' },
          options: { includeWorkerUpdates: true, limit: 5, offset: 10 },
          page: { total: 0, returned: 0, offset: 10, limit: 5, hasMore: false },
          messages: [],
        })
      },
    })

    await expect(client.getSessionTranscript('session-1', {
      includeWorkerUpdates: true,
      limit: 5,
      offset: 10,
    })).resolves.toMatchObject({ options: { includeWorkerUpdates: true, limit: 5, offset: 10 } })
    expect(calls).toEqual([
      'http://127.0.0.1:47287/api/cli/status',
      'http://127.0.0.1:47287/api/cli/sessions/session-1/transcript?includeWorkerUpdates=true&limit=5&offset=10',
    ])
  })

  it('sends first-class compaction WebSocket commands with custom instructions', async () => {
    const socket = new FakeWebSocket()
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: statusFetch,
      WebSocketImpl: fakeWebSocketImpl(socket),
    })

    await expect(client.compactSession('session-1', { customInstructions: 'Preserve pinned context' })).resolves.toMatchObject({
      action: 'compact',
      outcome: 'compacted',
      customInstructionsProvided: true,
    })
    await expect(client.smartCompactSession('session-1')).resolves.toMatchObject({
      action: 'smart_compact',
      outcome: 'skipped',
      reason: 'runtime_already_compacted',
    })
    expect(socket.sent).toEqual([
      expect.objectContaining({ type: 'compact_session', agentId: 'session-1', customInstructions: 'Preserve pinned context' }),
      expect.objectContaining({ type: 'smart_compact_session', agentId: 'session-1' }),
    ])
  })

  it('maps runtime compaction unsupported request errors to unsupported exit code', async () => {
    const socket = new FakeWebSocket({ compactionUnsupported: true })
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: statusFetch,
      WebSocketImpl: fakeWebSocketImpl(socket),
    })

    await expect(client.smartCompactSession('session-1')).rejects.toMatchObject({
      code: 'compaction_unsupported',
      exitCode: EXIT_CODES.unsupported,
    })
  })

  it('reports old servers without the session compaction capability as unsupported', async () => {
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: async () => {
        const status = await statusFetch()
        const payload = await status.json()
        payload.capabilities.features.sessionCompaction = false
        return Response.json(payload)
      },
    })

    await expect(client.compactSession('session-1')).rejects.toMatchObject({
      code: 'unsupported_capability',
      exitCode: EXIT_CODES.unsupported,
    })
  })

  it('reports old servers without the session transcript capability as unsupported', async () => {
    const calls: string[] = []
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: async (url) => {
        calls.push(String(url))
        const status = await statusFetch()
        const payload = await status.json()
        payload.capabilities.features.sessionTranscript = false
        return Response.json(payload)
      },
    })

    await expect(client.getSessionTranscript('session-1')).rejects.toMatchObject({
      code: 'unsupported_capability',
      exitCode: EXIT_CODES.unsupported,
    })
    expect(calls).toEqual(['http://127.0.0.1:47287/api/cli/status'])
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

  it('does not treat assistant_progress as the final run message', async () => {
    const socket = new FakeWebSocket({ progressOnlyAfterRun: true })
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret-token',
      fetchImpl: statusFetch,
      WebSocketImpl: fakeWebSocketImpl(socket),
    })

    await expect(client.run({ command: 'run', target: { kind: 'session', agentId: 'session-1' }, text: 'hello' })).resolves.toMatchObject({
      status: 'success',
      finalMessage: null,
    })
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
        sessionCompaction: true,
        builderRuntimeOnly: true,
      },
    },
    summary: { profileCount: 1, sessionCount: 1, agentCount: 1 },
  })
}

function fakeWebSocketImpl(socket: FakeWebSocket): typeof WebSocket {
  return function createFakeWebSocket() {
    socket.readyState = WebSocket.OPEN
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

  constructor(
    private readonly options: {
      closeAfterRunAck?: boolean
      closeBeforeHeadlessReady?: boolean
      compactionUnsupported?: boolean
      progressOnlyAfterRun?: boolean
    } = {},
  ) {
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
    if (command.type === 'compact_session' || command.type === 'smart_compact_session') {
      if (this.options.compactionUnsupported) {
        this.emitEvent({
          type: 'cli_request_error',
          requestId: command.requestId,
          commandType: command.type,
          code: 'compaction_unsupported',
          message: 'Runtime does not support compaction.',
          status: 501,
        })
      } else {
        this.emitEvent({
          type: 'cli_request_success',
          requestId: command.requestId,
          commandType: command.type,
          result: {
            action: command.type === 'compact_session' ? 'compact' : 'smart_compact',
            sessionAgentId: command.agentId,
            profileId: 'profile-1',
            outcome: command.type === 'compact_session' ? 'compacted' : 'skipped',
            compacted: command.type === 'compact_session',
            ...(command.type === 'smart_compact_session' ? { reason: 'runtime_already_compacted' } : {}),
            customInstructionsProvided: Boolean(command.customInstructions),
            completedAt: 'now',
          },
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
      } else if (this.options.progressOnlyAfterRun) {
        this.emitEvent({
          type: 'conversation_message',
          agentId: 'session-1',
          role: 'assistant',
          text: 'still working',
          timestamp: 'now',
          source: 'assistant_progress',
        })
      } else {
        this.emitEvent({
          type: 'conversation_message',
          agentId: 'session-1',
          role: 'assistant',
          text: 'fast done',
          timestamp: 'now',
          source: 'assistant_output',
        })
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
        sessionCompaction: true,
        builderRuntimeOnly: true,
      },
    },
  } as const
}
