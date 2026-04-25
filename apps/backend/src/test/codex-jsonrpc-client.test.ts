import { afterEach, describe, expect, it, vi } from 'vitest'
import { StdioJsonRpcClient, type JsonRpcRequestMessage } from '../swarm/stdio-jsonrpc-client.js'

const activeClients = new Set<StdioJsonRpcClient>()

function createClient(options: {
  script: string
  onRequest?: (request: JsonRpcRequestMessage) => Promise<unknown>
  onExit?: (error: Error) => void
}): StdioJsonRpcClient {
  const client = new StdioJsonRpcClient({
    command: process.execPath,
    args: ['-e', options.script],
    onRequest: options.onRequest,
    onExit: options.onExit,
  })

  activeClients.add(client)
  return client
}

afterEach(() => {
  for (const client of activeClients) {
    client.dispose()
  }
  activeClients.clear()
})

describe('StdioJsonRpcClient', () => {
  it('resolves request/response happy-path results', async () => {
    const client = createClient({
      script: String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'sum') {
    const numbers = Array.isArray(message.params?.numbers) ? message.params.numbers : [];
    const total = numbers.reduce((acc, value) => acc + Number(value || 0), 0);
    send({ id: message.id, result: { total } });
  }
});
`,
    })

    const result = await client.request<{ total: number }>('sum', { numbers: [1, 2, 3, 4] })
    expect(result).toEqual({ total: 10 })
  })

  it('times out requests and still handles later requests after the timeout', async () => {
    const client = createClient({
      script: String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'slow') {
    setTimeout(() => {
      send({ id: message.id, result: { slow: true } });
    }, 80);
    return;
  }

  if (message.method === 'fast') {
    send({ id: message.id, result: { fast: true } });
  }
});
`,
    })

    await expect(client.request('slow', undefined, 15)).rejects.toThrow('JSON-RPC request timed out: slow')

    const fastResult = await client.request<{ fast: boolean }>('fast', undefined, 1_000)
    expect(fastResult).toEqual({ fast: true })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const secondFastResult = await client.request<{ fast: boolean }>('fast', undefined, 1_000)
    expect(secondFastResult).toEqual({ fast: true })
  })

  it('maps JSON-RPC error payloads to Error instances with code and data', async () => {
    const client = createClient({
      script: String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'fail') {
    send({
      id: message.id,
      error: {
        code: 401,
        message: 'auth failed',
        data: { provider: 'openai' }
      }
    });
  }
});
`,
    })

    await expect(client.request('fail')).rejects.toMatchObject({
      message: 'auth failed',
      code: 401,
      data: { provider: 'openai' },
    })
  })

  it('returns -32601 when receiving a server request and no onRequest handler is set', async () => {
    const client = createClient({
      script: String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let waitingRequestId = null;

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'probe-unsupported') {
    waitingRequestId = message.id;
    send({ id: 'server-unsupported', method: 'server/unsupported', params: { reason: 'ping' } });
    return;
  }

  if (message.id === 'server-unsupported' && waitingRequestId !== null) {
    send({ id: waitingRequestId, result: message });
  }
});
`,
    })

    const result = await client.request<{ error: { code: number; message: string } }>('probe-unsupported')
    expect(result).toMatchObject({
      error: {
        code: -32601,
        message: 'Unsupported server request: server/unsupported',
      },
    })
  })

  it('wires onRequest success and errors back to server-request responses', async () => {
    const onRequest = vi.fn(async (request: JsonRpcRequestMessage) => {
      if (request.method === 'server/success') {
        const value = (request.params as { value?: number } | undefined)?.value ?? 0
        return { accepted: true, value: value + 1 }
      }

      throw new Error('blocked by policy')
    })

    const client = createClient({
      onRequest,
      script: String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const requestByServerId = new Map();

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'probe-success') {
    requestByServerId.set('server-success', message.id);
    send({ id: 'server-success', method: 'server/success', params: { value: 41 } });
    return;
  }

  if (message.method === 'probe-error') {
    requestByServerId.set('server-error', message.id);
    send({ id: 'server-error', method: 'server/fail' });
    return;
  }

  const messageId = typeof message.id === 'string' ? message.id : String(message.id);
  const originalRequestId = requestByServerId.get(messageId);
  if (originalRequestId !== undefined) {
    send({ id: originalRequestId, result: message });
  }
});
`,
    })

    const successResult = await client.request<{ result: { accepted: boolean; value: number } }>('probe-success')
    expect(successResult).toMatchObject({
      result: {
        accepted: true,
        value: 42,
      },
    })

    const errorResult = await client.request<{ error: { code: number; message: string } }>('probe-error')
    expect(errorResult).toMatchObject({
      error: {
        code: -32000,
        message: 'blocked by policy',
      },
    })

    expect(onRequest).toHaveBeenCalledTimes(2)
  })

  it('rejects all pending requests when the child process exits unexpectedly', async () => {
    const onExit = vi.fn()

    const client = createClient({
      onExit,
      script: String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'hang') {
    setTimeout(() => process.exit(0), 20);
  }
});
`,
    })

    await expect(client.request('hang', undefined, 5_000)).rejects.toThrow('JSON-RPC subprocess exited')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('dispose() is idempotent and rejects pending requests with the disposal reason', async () => {
    const client = createClient({
      script: String.raw`
const readline = require('node:readline');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', () => {
  // Keep the request pending forever.
});
`,
    })

    const pending = client.request('never', undefined, 5_000)
    client.dispose()

    await expect(pending).rejects.toThrow('JSON-RPC client disposed')

    expect(() => client.dispose()).not.toThrow()
    expect(() => client.notify('after-dispose')).toThrow('JSON-RPC client is disposed')
  })
})
