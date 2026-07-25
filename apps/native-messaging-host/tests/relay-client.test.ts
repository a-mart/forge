import { describe, expect, it } from 'vitest'
import {
  authenticateRecord,
  createHandshakeProof,
  deriveRelaySessionKey,
  RelayAuthenticationError,
  ReplayGuard,
  verifyHandshakeProof,
} from '../src/auth.js'
import {
  HOST_EXTENSION_ORIGIN,
  HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
  HOST_PROTOCOL_MAX_VERSION,
  HOST_PROTOCOL_MIN_VERSION,
} from '../src/constants.js'
import type { JsonObject } from '../src/framing.js'
import { AuthenticatedRelayClient, type RelayClientDependencies } from '../src/relay-client.js'
import {
  DesktopUnavailableError,
  type RelayRecordTransport,
  type RendezvousDocument,
} from '../src/transport.js'

const KEY = Buffer.alloc(32, 0x5a)
const EPOCH = 'epoch_1234567890abcdef'
const DESKTOP_INSTANCE_ID = 'desktop_1234567890abcdef'
const CLIENT_NONCE = 'c'.repeat(43)
const OTHER_CLIENT_NONCE = 'd'.repeat(43)
const SERVER_NONCE = 's'.repeat(43)
const OTHER_SERVER_NONCE = 't'.repeat(43)
const RENDEZVOUS: RendezvousDocument = {
  schemaVersion: 1,
  endpoint: '/tmp/forge-test.sock',
  epoch: EPOCH,
  expiresAt: '2030-01-01T00:00:00.000Z',
  keyId: 'test-key',
  userScope: 'test-user',
  desktopInstanceId: DESKTOP_INSTANCE_ID,
  desktopPid: 4242,
  protocolMin: HOST_PROTOCOL_MIN_VERSION,
  protocolMax: HOST_PROTOCOL_MAX_VERSION,
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

interface SessionFixture {
  challenge: JsonObject
  ready: JsonObject
  relay(sequence: number, payload: JsonObject): JsonObject
  sessionKey: Buffer
}

function sessionFixture(options: {
  clientNonce?: string
  serverNonce?: string
  challengeOverrides?: JsonObject
  readyOverrides?: JsonObject
  rendezvous?: RendezvousDocument
} = {}): SessionFixture {
  const rendezvous = options.rendezvous ?? RENDEZVOUS
  const clientNonce = options.clientNonce ?? CLIENT_NONCE
  const serverNonce = options.serverNonce ?? SERVER_NONCE
  const challengeFields: JsonObject = {
    type: 'challenge',
    sequence: 0,
    epoch: rendezvous.epoch,
    desktopInstanceId: rendezvous.desktopInstanceId,
    extensionOrigin: HOST_EXTENSION_ORIGIN,
    clientNonce,
    serverNonce,
    clientProtocolMin: HOST_PROTOCOL_MIN_VERSION,
    clientProtocolMax: HOST_PROTOCOL_MAX_VERSION,
    desktopProtocolMin: rendezvous.protocolMin,
    desktopProtocolMax: rendezvous.protocolMax,
    protocolVersion: HOST_PROTOCOL_MIN_VERSION,
    maxMessageBytes: HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
    ...options.challengeOverrides,
  }
  const challenge = {
    ...challengeFields,
    proof: createHandshakeProof('desktop-challenge', challengeFields, KEY),
  }
  const sessionKey = deriveRelaySessionKey(challengeFields, KEY)
  const ready = authenticateRecord({
    type: 'ready',
    epoch: String(challengeFields.epoch),
    desktopInstanceId: String(challengeFields.desktopInstanceId),
    extensionOrigin: String(challengeFields.extensionOrigin),
    sequence: 1,
    clientNonce: String(challengeFields.clientNonce),
    serverNonce: String(challengeFields.serverNonce),
    protocolVersion: Number(challengeFields.protocolVersion),
    maxMessageBytes: Number(challengeFields.maxMessageBytes),
    ...options.readyOverrides,
  }, sessionKey)
  return {
    challenge,
    ready,
    sessionKey,
    relay: (sequence, payload) => authenticateRecord({
      type: 'relay',
      direction: 'desktop-to-extension',
      epoch: String(challengeFields.epoch),
      desktopInstanceId: String(challengeFields.desktopInstanceId),
      extensionOrigin: String(challengeFields.extensionOrigin),
      sequence,
      clientNonce: String(challengeFields.clientNonce),
      serverNonce: String(challengeFields.serverNonce),
      protocolVersion: Number(challengeFields.protocolVersion),
      payload,
    }, sessionKey),
  }
}

function dependencies(
  transport: FakeTransport,
  overrides: Partial<RelayClientDependencies> = {},
): RelayClientDependencies {
  return {
    rendezvous: { read: async () => ({ ...RENDEZVOUS }) },
    secrets: { getSecret: async () => Buffer.from(KEY) },
    connector: { connect: async () => transport },
    expectedUserScope: 'test-user',
    expectedExtensionOrigin: HOST_EXTENSION_ORIGIN,
    platform: 'darwin',
    now: () => Date.parse('2029-01-01T00:00:00.000Z'),
    nonce: () => CLIENT_NONCE,
    maxAttempts: 1,
    ...overrides,
  }
}

function clientSessionKey(client: AuthenticatedRelayClient): Buffer {
  return (client as unknown as { sessionKey: Buffer }).sessionKey
}

describe('authenticated relay client', () => {
  it('uses the long-lived secret only for the bound challenge handshake and a derived key for ready/relay', async () => {
    const fixture = sessionFixture()
    const transport = new FakeTransport([fixture.challenge, fixture.ready, fixture.relay(2, { response: true })])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    await client.send({ request: true })
    await expect(client.receive()).resolves.toEqual({ response: true })

    expect(transport.sent.map((record) => record.type)).toEqual(['hello', 'authenticate', 'relay'])
    expect(transport.sent[0]).not.toHaveProperty('mac')
    expect(transport.sent[0]).not.toHaveProperty('proof')
    expect(transport.sent[1]).toHaveProperty('proof')
    expect(transport.sent[1]).not.toHaveProperty('mac')
    const { proof, ...authenticateFields } = transport.sent[1] ?? {}
    expect(() => verifyHandshakeProof('native-host-authenticate', authenticateFields, proof, KEY)).not.toThrow()
    expect(transport.sent[2]).toHaveProperty('mac')
    expect(clientSessionKey(client)).toEqual(fixture.sessionKey)
    expect(clientSessionKey(client)).not.toEqual(KEY)
    fixture.sessionKey.fill(0)
    client.close()
  })

  it('binds protocol ranges, pinned origin, Desktop instance, epoch, and both nonces exactly', async () => {
    const fixture = sessionFixture()
    const transport = new FakeTransport([fixture.challenge, fixture.ready])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    expect(transport.sent[0]).toMatchObject({
      extensionOrigin: HOST_EXTENSION_ORIGIN,
      desktopInstanceId: DESKTOP_INSTANCE_ID,
      epoch: EPOCH,
      clientNonce: CLIENT_NONCE,
      clientProtocolMin: HOST_PROTOCOL_MIN_VERSION,
      clientProtocolMax: HOST_PROTOCOL_MAX_VERSION,
      desktopProtocolMin: HOST_PROTOCOL_MIN_VERSION,
      desktopProtocolMax: HOST_PROTOCOL_MAX_VERSION,
    })
    expect(transport.sent[1]).toMatchObject({
      extensionOrigin: HOST_EXTENSION_ORIGIN,
      desktopInstanceId: DESKTOP_INSTANCE_ID,
      epoch: EPOCH,
      clientNonce: CLIENT_NONCE,
      serverNonce: SERVER_NONCE,
    })
    client.close()
    fixture.sessionKey.fill(0)
  })

  it('rejects a stale rendezvous before connecting', async () => {
    const transport = new FakeTransport([])
    const deps = dependencies(transport, {
      rendezvous: { read: async () => ({ ...RENDEZVOUS, expiresAt: '2028-01-01T00:00:00.000Z' }) },
    })
    await expect(AuthenticatedRelayClient.connect(deps)).rejects.toThrow(DesktopUnavailableError)
    expect(transport.sent).toEqual([])
  })

  it.each([
    ['epoch', { epoch: 'different_epoch_12345' }, /stale rendezvous epoch/u],
    ['Desktop instance', { desktopInstanceId: 'different_desktop_12345' }, /stale Desktop instance/u],
    ['origin', { extensionOrigin: 'chrome-extension://wrongwrongwrongwrongwrongwrong12/' }, /extension origin/u],
    ['client nonce', { clientNonce: OTHER_CLIENT_NONCE }, /client nonce mismatch/u],
  ])('rejects a correctly signed challenge with stale or wrong %s binding', async (_name, challengeOverrides, expected) => {
    const fixture = sessionFixture({ challengeOverrides })
    const transport = new FakeTransport([fixture.challenge])
    await expect(AuthenticatedRelayClient.connect(dependencies(transport))).rejects.toThrowError(expected)
    expect(transport.closed).toBe(true)
    fixture.sessionKey.fill(0)
  })

  it('rejects a challenge proof mismatch and exact-field violations', async () => {
    const invalidProof = sessionFixture()
    invalidProof.challenge.proof = 'A'.repeat(43)
    await expect(AuthenticatedRelayClient.connect(dependencies(new FakeTransport([invalidProof.challenge])))).rejects.toMatchObject({
      code: 'hmac-mismatch',
    })
    invalidProof.sessionKey.fill(0)

    const extraField = sessionFixture()
    extraField.challenge.unexpected = true
    await expect(AuthenticatedRelayClient.connect(dependencies(new FakeTransport([extraField.challenge])))).rejects.toMatchObject({
      code: 'malformed-auth-record',
    })
    extraField.sessionKey.fill(0)
  })

  it('rejects server and client nonce replay', async () => {
    const serverGuard = new ReplayGuard()
    const firstFixture = sessionFixture()
    const first = await AuthenticatedRelayClient.connect(dependencies(
      new FakeTransport([firstFixture.challenge, firstFixture.ready]),
      { serverNonceGuard: serverGuard },
    ))
    first.close()
    firstFixture.sessionKey.fill(0)

    const replayFixture = sessionFixture({ clientNonce: OTHER_CLIENT_NONCE })
    await expect(AuthenticatedRelayClient.connect(dependencies(
      new FakeTransport([replayFixture.challenge]),
      { nonce: () => OTHER_CLIENT_NONCE, serverNonceGuard: serverGuard },
    ))).rejects.toMatchObject({ code: 'nonce-replay' })
    replayFixture.sessionKey.fill(0)

    let connects = 0
    await expect(AuthenticatedRelayClient.connect(dependencies(new FakeTransport([]), {
      maxAttempts: 2,
      connector: {
        connect: async () => {
          connects += 1
          throw new Error('retryable connect failure')
        },
      },
    }))).rejects.toMatchObject({ code: 'nonce-replay' })
    expect(connects).toBe(1)
  })

  it('rejects protocol skew in rendezvous and in a signed challenge', async () => {
    const transport = new FakeTransport([])
    await expect(AuthenticatedRelayClient.connect(dependencies(transport, {
      rendezvous: { read: async () => ({ ...RENDEZVOUS, protocolMin: 2, protocolMax: 2 }) },
    }))).rejects.toThrowError(/do not overlap/u)
    expect(transport.sent).toEqual([])

    const fixture = sessionFixture({ challengeOverrides: { protocolVersion: 2 } })
    await expect(AuthenticatedRelayClient.connect(dependencies(new FakeTransport([fixture.challenge])))).rejects.toThrowError(/do not overlap/u)
    fixture.sessionKey.fill(0)
  })

  it('rejects inbound sequence replay and closes with a zeroed session key', async () => {
    const fixture = sessionFixture()
    const transport = new FakeTransport([fixture.challenge, fixture.ready, fixture.relay(1, { stale: true })])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    const ownedKey = clientSessionKey(client)
    await expect(client.receive()).rejects.toMatchObject({ code: 'sequence-replay' })
    expect(transport.closed).toBe(true)
    expect(ownedKey.every((byte) => byte === 0)).toBe(true)
    fixture.sessionKey.fill(0)
  })

  it('rejects a record replayed across independently keyed connections', async () => {
    const firstFixture = sessionFixture()
    const replayedRecord = firstFixture.relay(2, { replayed: true })
    const first = await AuthenticatedRelayClient.connect(dependencies(new FakeTransport([
      firstFixture.challenge,
      firstFixture.ready,
    ])))
    first.close()

    const secondFixture = sessionFixture({
      clientNonce: OTHER_CLIENT_NONCE,
      serverNonce: OTHER_SERVER_NONCE,
    })
    const second = await AuthenticatedRelayClient.connect(dependencies(new FakeTransport([
      secondFixture.challenge,
      secondFixture.ready,
      replayedRecord,
    ]), { nonce: () => OTHER_CLIENT_NONCE }))
    await expect(second.receive()).rejects.toMatchObject({ code: 'hmac-mismatch' })
    firstFixture.sessionKey.fill(0)
    secondFixture.sessionKey.fill(0)
  })

  it('zeroes supplied long-lived secret copies on success and every failure path', async () => {
    const successSecret = Buffer.from(KEY)
    const successFixture = sessionFixture()
    const client = await AuthenticatedRelayClient.connect(dependencies(
      new FakeTransport([successFixture.challenge, successFixture.ready]),
      { secrets: { getSecret: async () => successSecret } },
    ))
    expect(successSecret.every((byte) => byte === 0)).toBe(true)
    client.close()
    successFixture.sessionKey.fill(0)

    const failureSecret = Buffer.from(KEY)
    const failedFixture = sessionFixture()
    failedFixture.challenge.proof = 'A'.repeat(43)
    await expect(AuthenticatedRelayClient.connect(dependencies(
      new FakeTransport([failedFixture.challenge]),
      { secrets: { getSecret: async () => failureSecret } },
    ))).rejects.toBeInstanceOf(RelayAuthenticationError)
    expect(failureSecret.every((byte) => byte === 0)).toBe(true)
    failedFixture.sessionKey.fill(0)
  })

  it('cleans up after relay disconnect', async () => {
    const fixture = sessionFixture()
    const transport = new FakeTransport([fixture.challenge, fixture.ready, null])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    const ownedKey = clientSessionKey(client)
    await expect(client.receive()).resolves.toBeNull()
    expect(transport.closed).toBe(true)
    expect(ownedKey.every((byte) => byte === 0)).toBe(true)
    await expect(client.send({ late: true })).rejects.toThrow(DesktopUnavailableError)
    fixture.sessionKey.fill(0)
  })

  it('enforces the negotiated bound beneath both Chrome transport limits', async () => {
    const selectedBound = 64
    const fixture = sessionFixture({ challengeOverrides: { maxMessageBytes: selectedBound } })
    const transport = new FakeTransport([fixture.challenge, fixture.ready])
    const client = await AuthenticatedRelayClient.connect(dependencies(transport))
    expect(client.maxMessageBytes).toBe(selectedBound)
    await expect(client.send({ content: 'x'.repeat(selectedBound) })).rejects.toThrowError(/negotiated bound/u)
    client.close()
    fixture.sessionKey.fill(0)
  })

  it('does not retry authentication failures', async () => {
    let connects = 0
    const fixture = sessionFixture()
    fixture.challenge.proof = 'A'.repeat(43)
    const transport = new FakeTransport([fixture.challenge])
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
    fixture.sessionKey.fill(0)
  })
})
