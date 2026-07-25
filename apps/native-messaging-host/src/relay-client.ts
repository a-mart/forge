import { randomBytes } from 'node:crypto'
import {
  authenticateRecord,
  createHandshakeProof,
  deriveRelaySessionKey,
  RelayAuthenticationError,
  ReplayGuard,
  verifyAuthenticatedRecord,
  verifyHandshakeProof,
} from './auth.js'
import {
  HOST_CONNECT_BUDGET_MS,
  HOST_CONNECT_MAX_ATTEMPTS,
  HOST_CONNECT_RETRY_DELAY_MS,
  HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
  HOST_PROTOCOL_MAX_VERSION,
  HOST_PROTOCOL_MIN_VERSION,
} from './constants.js'
import type { JsonObject } from './framing.js'
import type { Platform } from './platform.js'
import {
  DesktopUnavailableError,
  type RelayConnector,
  type RelayRecordTransport,
  type RelaySecretProvider,
  type RendezvousDocument,
  type RendezvousProvider,
  validateRendezvous,
} from './transport.js'

export interface RelayClientDependencies {
  rendezvous: RendezvousProvider
  secrets: RelaySecretProvider
  connector: RelayConnector
  expectedUserScope: string
  expectedExtensionOrigin: string
  platform: Platform
  now?: () => number
  nonce?: () => string
  sleep?: (milliseconds: number) => Promise<void>
  clientNonceGuard?: ReplayGuard
  serverNonceGuard?: ReplayGuard
  maxAttempts?: number
  retryDelayMs?: number
  connectBudgetMs?: number
}

const CHALLENGE_FIELDS = [
  'clientNonce',
  'clientProtocolMax',
  'clientProtocolMin',
  'desktopInstanceId',
  'desktopProtocolMax',
  'desktopProtocolMin',
  'epoch',
  'extensionOrigin',
  'maxMessageBytes',
  'proof',
  'protocolVersion',
  'sequence',
  'serverNonce',
  'type',
] as const

const READY_FIELDS = [
  'clientNonce',
  'desktopInstanceId',
  'epoch',
  'extensionOrigin',
  'mac',
  'maxMessageBytes',
  'protocolVersion',
  'sequence',
  'serverNonce',
  'type',
] as const

const RELAY_FIELDS = [
  'clientNonce',
  'desktopInstanceId',
  'direction',
  'epoch',
  'extensionOrigin',
  'mac',
  'payload',
  'protocolVersion',
  'sequence',
  'serverNonce',
  'type',
] as const

function assertExactFields(record: JsonObject, expected: readonly string[], recordName: string): void {
  const actual = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length || actual.some((field, index) => field !== sortedExpected[index])) {
    throw new RelayAuthenticationError('malformed-auth-record', `${recordName} fields do not exactly match the protocol`)
  }
}

function stringField(record: JsonObject, name: string): string {
  const value = record[name]
  if (typeof value !== 'string') throw new RelayAuthenticationError('malformed-auth-record', `${name} is missing`)
  return value
}

function numberField(record: JsonObject, name: string): number {
  const value = record[name]
  if (!Number.isSafeInteger(value)) throw new RelayAuthenticationError('malformed-auth-record', `${name} is invalid`)
  return value as number
}

function objectField(record: JsonObject, name: string): JsonObject {
  const value = record[name]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RelayAuthenticationError('malformed-auth-record', `${name} is invalid`)
  }
  return value as JsonObject
}

function defaultNonce(): string {
  return randomBytes(32).toString('base64url')
}

function challengeContext(
  rendezvous: RendezvousDocument,
  extensionOrigin: string,
  clientNonce: string,
  serverNonce: string,
  protocolVersion: number,
  maxMessageBytes: number,
  type: 'challenge' | 'authenticate',
  sequence: 0 | 1,
): JsonObject {
  return {
    type,
    sequence,
    epoch: rendezvous.epoch,
    desktopInstanceId: rendezvous.desktopInstanceId,
    extensionOrigin,
    clientNonce,
    serverNonce,
    clientProtocolMin: HOST_PROTOCOL_MIN_VERSION,
    clientProtocolMax: HOST_PROTOCOL_MAX_VERSION,
    desktopProtocolMin: rendezvous.protocolMin,
    desktopProtocolMax: rendezvous.protocolMax,
    protocolVersion,
    maxMessageBytes,
  }
}

export class AuthenticatedRelayClient {
  private outboundSequence = 2
  private closed = false

  private constructor(
    private readonly transport: RelayRecordTransport,
    private readonly sessionKey: Buffer,
    private readonly epoch: string,
    private readonly desktopInstanceId: string,
    private readonly extensionOrigin: string,
    private readonly clientNonce: string,
    private readonly serverNonce: string,
    private readonly inboundGuard: ReplayGuard,
    readonly protocolVersion: number,
    readonly maxMessageBytes: number,
  ) {}

  static async connect(dependencies: RelayClientDependencies): Promise<AuthenticatedRelayClient> {
    const now = dependencies.now ?? Date.now
    const nonce = dependencies.nonce ?? defaultNonce
    const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    const maxAttempts = dependencies.maxAttempts ?? HOST_CONNECT_MAX_ATTEMPTS
    const retryDelayMs = dependencies.retryDelayMs ?? HOST_CONNECT_RETRY_DELAY_MS
    const connectBudgetMs = dependencies.connectBudgetMs ?? HOST_CONNECT_BUDGET_MS
    const clientNonceGuard = dependencies.clientNonceGuard ?? new ReplayGuard()
    const serverNonceGuard = dependencies.serverNonceGuard ?? new ReplayGuard()
    const startedAt = now()
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts && now() - startedAt <= connectBudgetMs; attempt += 1) {
      let transport: RelayRecordTransport | undefined
      let secret: Buffer | undefined
      try {
        const rendezvous = await dependencies.rendezvous.read()
        validateRendezvous(rendezvous, dependencies.expectedUserScope, dependencies.platform, now())
        if (
          rendezvous.protocolMax < HOST_PROTOCOL_MIN_VERSION
          || rendezvous.protocolMin > HOST_PROTOCOL_MAX_VERSION
        ) {
          throw new RelayAuthenticationError('malformed-auth-record', 'relay protocol ranges do not overlap')
        }
        const clientNonce = nonce()
        clientNonceGuard.acceptNonce(clientNonce)
        transport = await dependencies.connector.connect(rendezvous.endpoint)
        const suppliedSecret = await dependencies.secrets.getSecret(rendezvous.keyId)
        secret = Buffer.from(suppliedSecret)
        suppliedSecret.fill(0)
        if (secret.byteLength < 32) throw new RelayAuthenticationError('malformed-auth-record', 'relay secret is too short')
        return await AuthenticatedRelayClient.handshake(
          transport,
          secret,
          rendezvous,
          dependencies.expectedExtensionOrigin,
          clientNonce,
          serverNonceGuard,
        )
      } catch (error) {
        transport?.close()
        if (error instanceof RelayAuthenticationError) throw error
        lastError = error
        if (attempt < maxAttempts && now() - startedAt + retryDelayMs <= connectBudgetMs) await sleep(retryDelayMs)
      } finally {
        secret?.fill(0)
      }
    }
    throw new DesktopUnavailableError(lastError instanceof Error ? lastError.message : undefined)
  }

  private static async handshake(
    transport: RelayRecordTransport,
    secret: Uint8Array,
    rendezvous: RendezvousDocument,
    extensionOrigin: string,
    clientNonce: string,
    serverNonceGuard: ReplayGuard,
  ): Promise<AuthenticatedRelayClient> {
    await transport.send({
      type: 'hello',
      sequence: 0,
      epoch: rendezvous.epoch,
      desktopInstanceId: rendezvous.desktopInstanceId,
      extensionOrigin,
      clientNonce,
      clientProtocolMin: HOST_PROTOCOL_MIN_VERSION,
      clientProtocolMax: HOST_PROTOCOL_MAX_VERSION,
      desktopProtocolMin: rendezvous.protocolMin,
      desktopProtocolMax: rendezvous.protocolMax,
      maxMessageBytes: HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
    })

    const challengeRaw = await transport.receive()
    if (challengeRaw === null) throw new DesktopUnavailableError('relay disconnected during challenge')
    assertExactFields(challengeRaw, CHALLENGE_FIELDS, 'challenge')
    const { proof, ...challengeFields } = challengeRaw
    verifyHandshakeProof('desktop-challenge', challengeFields, proof, secret)

    const inboundGuard = new ReplayGuard()
    inboundGuard.acceptSequence(numberField(challengeRaw, 'sequence'))
    if (stringField(challengeRaw, 'type') !== 'challenge') {
      throw new RelayAuthenticationError('malformed-auth-record', 'expected challenge')
    }
    if (stringField(challengeRaw, 'epoch') !== rendezvous.epoch) {
      throw new RelayAuthenticationError('malformed-auth-record', 'stale rendezvous epoch')
    }
    if (stringField(challengeRaw, 'desktopInstanceId') !== rendezvous.desktopInstanceId) {
      throw new RelayAuthenticationError('malformed-auth-record', 'stale Desktop instance')
    }
    if (stringField(challengeRaw, 'extensionOrigin') !== extensionOrigin) {
      throw new RelayAuthenticationError('malformed-auth-record', 'relay extension origin mismatch')
    }
    if (stringField(challengeRaw, 'clientNonce') !== clientNonce) {
      throw new RelayAuthenticationError('nonce-replay', 'challenge client nonce mismatch')
    }
    const serverNonce = stringField(challengeRaw, 'serverNonce')
    serverNonceGuard.acceptNonce(serverNonce)
    if (
      numberField(challengeRaw, 'clientProtocolMin') !== HOST_PROTOCOL_MIN_VERSION
      || numberField(challengeRaw, 'clientProtocolMax') !== HOST_PROTOCOL_MAX_VERSION
      || numberField(challengeRaw, 'desktopProtocolMin') !== rendezvous.protocolMin
      || numberField(challengeRaw, 'desktopProtocolMax') !== rendezvous.protocolMax
    ) {
      throw new RelayAuthenticationError('malformed-auth-record', 'relay protocol range binding does not match rendezvous')
    }
    const protocolVersion = numberField(challengeRaw, 'protocolVersion')
    const negotiatedMin = Math.max(HOST_PROTOCOL_MIN_VERSION, rendezvous.protocolMin)
    const negotiatedMax = Math.min(HOST_PROTOCOL_MAX_VERSION, rendezvous.protocolMax)
    if (protocolVersion < negotiatedMin || protocolVersion > negotiatedMax) {
      throw new RelayAuthenticationError('malformed-auth-record', 'relay protocol ranges do not overlap')
    }
    const maxMessageBytes = numberField(challengeRaw, 'maxMessageBytes')
    if (maxMessageBytes <= 0 || maxMessageBytes > HOST_MAX_NEGOTIATED_MESSAGE_BYTES) {
      throw new RelayAuthenticationError('malformed-auth-record', 'relay selected an invalid message bound')
    }

    let sessionKey: Buffer | undefined = deriveRelaySessionKey(challengeFields, secret)
    try {
      const authenticateFields = challengeContext(
        rendezvous,
        extensionOrigin,
        clientNonce,
        serverNonce,
        protocolVersion,
        maxMessageBytes,
        'authenticate',
        1,
      )
      await transport.send({
        ...authenticateFields,
        proof: createHandshakeProof('native-host-authenticate', authenticateFields, secret),
      })

      const readyRaw = await transport.receive()
      if (readyRaw === null) throw new DesktopUnavailableError('relay disconnected before ready')
      assertExactFields(readyRaw, READY_FIELDS, 'ready')
      const ready = verifyAuthenticatedRecord(readyRaw, sessionKey)
      inboundGuard.acceptSequence(numberField(ready, 'sequence'))
      if (
        stringField(ready, 'type') !== 'ready'
        || stringField(ready, 'epoch') !== rendezvous.epoch
        || stringField(ready, 'desktopInstanceId') !== rendezvous.desktopInstanceId
        || stringField(ready, 'extensionOrigin') !== extensionOrigin
        || stringField(ready, 'clientNonce') !== clientNonce
        || stringField(ready, 'serverNonce') !== serverNonce
        || numberField(ready, 'protocolVersion') !== protocolVersion
        || numberField(ready, 'maxMessageBytes') !== maxMessageBytes
      ) {
        throw new RelayAuthenticationError('malformed-auth-record', 'relay ready acknowledgement does not match negotiation')
      }

      const client = new AuthenticatedRelayClient(
        transport,
        sessionKey,
        rendezvous.epoch,
        rendezvous.desktopInstanceId,
        extensionOrigin,
        clientNonce,
        serverNonce,
        inboundGuard,
        protocolVersion,
        maxMessageBytes,
      )
      sessionKey = undefined
      return client
    } finally {
      sessionKey?.fill(0)
    }
  }

  async send(message: JsonObject): Promise<void> {
    this.assertOpen()
    try {
      this.assertMessageBound(message)
      const record = authenticateRecord({
        type: 'relay',
        direction: 'extension-to-desktop',
        epoch: this.epoch,
        desktopInstanceId: this.desktopInstanceId,
        extensionOrigin: this.extensionOrigin,
        sequence: this.outboundSequence,
        clientNonce: this.clientNonce,
        serverNonce: this.serverNonce,
        protocolVersion: this.protocolVersion,
        payload: message,
      }, this.sessionKey)
      this.outboundSequence += 1
      await this.transport.send(record)
    } catch (error) {
      this.close()
      throw error
    }
  }

  async receive(): Promise<JsonObject | null> {
    this.assertOpen()
    try {
      const raw = await this.transport.receive()
      if (raw === null) {
        this.close()
        return null
      }
      assertExactFields(raw, RELAY_FIELDS, 'relay')
      const record = verifyAuthenticatedRecord(raw, this.sessionKey)
      this.inboundGuard.acceptSequence(numberField(record, 'sequence'))
      if (
        stringField(record, 'type') !== 'relay'
        || stringField(record, 'direction') !== 'desktop-to-extension'
        || stringField(record, 'epoch') !== this.epoch
        || stringField(record, 'desktopInstanceId') !== this.desktopInstanceId
        || stringField(record, 'extensionOrigin') !== this.extensionOrigin
        || stringField(record, 'clientNonce') !== this.clientNonce
        || stringField(record, 'serverNonce') !== this.serverNonce
        || numberField(record, 'protocolVersion') !== this.protocolVersion
      ) {
        throw new RelayAuthenticationError('malformed-auth-record', 'relay routing metadata does not match the authenticated session')
      }
      const message = objectField(record, 'payload')
      this.assertMessageBound(message)
      return message
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
    this.sessionKey.fill(0)
  }

  private assertOpen(): void {
    if (this.closed) throw new DesktopUnavailableError('relay is closed')
  }

  private assertMessageBound(message: JsonObject): void {
    const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
    if (bytes > this.maxMessageBytes) throw new Error(`relay message length ${bytes} exceeds negotiated bound ${this.maxMessageBytes}`)
  }
}
