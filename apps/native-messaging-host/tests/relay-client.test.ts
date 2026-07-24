import { describe, expect, it } from 'vitest'
import { authenticateRecord, RelayAuthenticationError, ReplayGuard } from '../src/auth.js'
import { HOST_MAX_NEGOTIATED_MESSAGE_BYTES } from '../src/constants.js'
import type { JsonObject } from '../src/framing.js'
import { AuthenticatedRelayClient, type RelayClientDependencies } from '../src/relay-client.js'
import {
  DesktopUnavailableError,
  type RelayRecordTransport,
  type RendezvousDocument,
} from '../src/transport.js'

const KEY = Buffer.alloc(32, 0x5a)
const EPOCH = 'epoch_1234567890abcdef'
const CLIENT_NONCE = 'c'.repeat(43)
const SERVER_NONCE = 's'.repeat(43)
const RENDEZVOUS: RendezvousDocument = {
  schemaVersion: 1,
  endpoint: '/tmp/forge-test.sock',
  epoch: EPOCH,
  expiresAt: '2030-01-01T00:00:00.000Z',
  keyId: 'test-key',
  userScope: 'test-user',
}

class FakeTransport implements RelayRecordTransport {
  readonly sent: JsonObject[] = []
  closed = false

  constructor(readonly incoming: Array<JsonObject | null>) {}

  async send(record: JsonObject): Promise<void> {
    this.sent.push(record)
  }

  async receive(): Promise<JsonObject | null> {
    return this.incoming.shift() ?? null
  }

  close(): void {
    this.closed = true
  }
}

function challenge(overrides: JsonObject = {}): JsonObject {
  return authenticateRecord({
    type: 'challenge',
    epoch: EPOCH,
    sequence: 0,
    clientNonce: CLIENT_NONCE,
    serverNonce: SERVER_NONCE,
    protocolVersion: 1,
    maxMessageBytes: HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
    ...overrides,
  }, KEY)
}

function ready(overrides: JsonObject = {}): JsonObject {
  return authenticateRecord({
    type: 'ready',
    epoch: EPOCH,
    sequence: 1,
    clientNonce: CLIENT_NONCE,
    serverNonce: SERVER_NONCE,
    protocolVersion: 1,
    maxMessageBytes: HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
    ...overrides,
  }, KEY)
}

function relay(sequence: number, payload: JsonObject): JsonObject {
  return authenticateRecord({
    type: 'relay',
    direction: 'desktop-to-extension',
    epoch: EPOCH,
    sequence,
    clientNonce: CLIENT_NONCE,
    serverNonce: SERVER_NONCE,
    protocolVersion: 1,
    payload,
  }, KEY)
}

function dependencies(transport: FakeTransport, overrides: Partial<RelayClientDependencies> = {}): RelayClientDependencies {
  return {
    rendezvous: { read: async () => ({ ...RENDEZVOUS }) },
    secrets: { getSecret: async () => Buffer.from(KEY) },
    connector: { connect: async () => transport },
    expectedUserScope: 'test-user',
    platform: 'darwin',
    now: () => Date.parse('2029-01-01T00:00:00.000Z'),
    nonce: () => CLIENT_NONCE,
    maxAttempts: 1,
    ...overrides,
  }
}

describe('authenticated relay client', () => {
  it('negotiates, authenticates, and relays in both directions', async () => {
    const transport = new FakeTransport([challenge(), ready(), relay(2, { response: true })])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    await client.send({ request: true })
    await expect(client.receive()).resolves.toEqual({ response: true })
    expect(transport.sent.map((record) => record.type)).toEqual(['hello', 'authenticate', 'relay'])
    expect(transport.sent.every((record) => typeof record.mac === 'string')).toBe(true)
  })

  it('rejects a stale rendezvous before connecting', async () => {
    const transport = new FakeTransport([])
    const deps = dependencies(transport, {
      rendezvous: { read: async () => ({ ...RENDEZVOUS, expiresAt: '2028-01-01T00:00:00.000Z' }) },
    })
    await expect(AuthenticatedRelayClient.connect(deps)).rejects.toThrow(DesktopUnavailableError)
    expect(transport.sent).toEqual([])
  })

  it('rejects a stale desktop epoch', async () => {
    const transport = new FakeTransport([challenge({ epoch: 'different_epoch_12345' })])
    await expect(AuthenticatedRelayClient.connect(dependencies(transport))).rejects.toThrowError(/stale rendezvous epoch/u)
    expect(transport.closed).toBe(true)
  })

  it('rejects an HMAC mismatch', async () => {
    const invalid = challenge()
    invalid.mac = 'A'.repeat(43)
    await expect(AuthenticatedRelayClient.connect(dependencies(new FakeTransport([invalid])))).rejects.toMatchObject({
      code: 'hmac-mismatch',
    })
  })

  it('rejects a server nonce replay across connections', async () => {
    const guard = new ReplayGuard()
    const first = await AuthenticatedRelayClient.connect(dependencies(new FakeTransport([challenge(), ready()]), {
      serverNonceGuard: guard,
    }))
    first.close()
    await expect(AuthenticatedRelayClient.connect(dependencies(new FakeTransport([challenge()]), {
      serverNonceGuard: guard,
    }))).rejects.toMatchObject({ code: 'nonce-replay' })
  })

  it('rejects an inbound sequence replay', async () => {
    const client = await AuthenticatedRelayClient.connect(dependencies(new FakeTransport([
      challenge(),
      ready(),
      relay(1, { stale: true }),
    ])))
    await expect(client.receive()).rejects.toMatchObject({ code: 'sequence-replay' })
  })

  it('cleans up after relay disconnect', async () => {
    const transport = new FakeTransport([challenge(), ready(), null])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    await expect(client.receive()).resolves.toBeNull()
    expect(transport.closed).toBe(true)
    await expect(client.send({ late: true })).rejects.toThrow(DesktopUnavailableError)
  })

  it('enforces the negotiated bound beneath both Chrome transport limits', async () => {
    const selectedBound = 64
    const transport = new FakeTransport([
      challenge({ maxMessageBytes: selectedBound }),
      ready({ maxMessageBytes: selectedBound }),
    ])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    expect(client.maxMessageBytes).toBe(selectedBound)
    await expect(client.send({ content: 'x'.repeat(selectedBound) })).rejects.toThrowError(/negotiated bound/u)
  })

  it('rejects protocol skew without overlap', async () => {
    const transport = new FakeTransport([challenge({ protocolVersion: 2 })])
    await expect(AuthenticatedRelayClient.connect(dependencies(transport))).rejects.toThrowError(/do not overlap/u)
  })

  it('does not retry authentication failures', async () => {
    let connects = 0
    const invalid = challenge()
    invalid.mac = 'A'.repeat(43)
    const transport = new FakeTransport([invalid])
    await expect(AuthenticatedRelayClient.connect(dependencies(transport, {
      maxAttempts: 3,
      connector: {
        connect: async () => {
          connects += 1
          return transport
        },
      },
    }))).rejects.toBeInstanceOf(RelayAuthenticationError)
    expect(connects).toBe(1)
  })
})
