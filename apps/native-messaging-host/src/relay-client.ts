import { randomBytes } from 'node:crypto'
import {
  authenticateRecord,
  RelayAuthenticationError,
  ReplayGuard,
  verifyAuthenticatedRecord,
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
  type RendezvousProvider,
  validateRendezvous,
} from './transport.js'

export interface RelayClientDependencies {
  rendezvous: RendezvousProvider
  secrets: RelaySecretProvider
  connector: RelayConnector
  expectedUserScope: string
  platform: Platform
  now?: () => number
  nonce?: () => string
  sleep?: (milliseconds: number) => Promise<void>
  serverNonceGuard?: ReplayGuard
  maxAttempts?: number
  retryDelayMs?: number
  connectBudgetMs?: number
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

export class AuthenticatedRelayClient {
  private outboundSequence = 2
  private closed = false

  private constructor(
    private readonly transport: RelayRecordTransport,
    private readonly key: Uint8Array,
    private readonly epoch: string,
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
    const startedAt = now()
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts && now() - startedAt <= connectBudgetMs; attempt += 1) {
      let transport: RelayRecordTransport | undefined
      try {
        const rendezvous = await dependencies.rendezvous.read()
        validateRendezvous(rendezvous, dependencies.expectedUserScope, dependencies.platform, now())
        const key = await dependencies.secrets.getSecret(rendezvous.keyId)
        if (key.byteLength < 32) throw new RelayAuthenticationError('malformed-auth-record', 'relay secret is too short')
        transport = await dependencies.connector.connect(rendezvous.endpoint)
        return await AuthenticatedRelayClient.handshake(
          transport,
          key,
          rendezvous.epoch,
          nonce(),
          dependencies.serverNonceGuard ?? new ReplayGuard(),
        )
      } catch (error) {
        transport?.close()
        if (error instanceof RelayAuthenticationError) throw error
        lastError = error
        if (attempt < maxAttempts && now() - startedAt + retryDelayMs <= connectBudgetMs) await sleep(retryDelayMs)
      }
    }
    throw new DesktopUnavailableError(lastError instanceof Error ? lastError.message : undefined)
  }

  private static async handshake(
    transport: RelayRecordTransport,
    key: Uint8Array,
    epoch: string,
    clientNonce: string,
    serverNonceGuard: ReplayGuard,
  ): Promise<AuthenticatedRelayClient> {
    const hello = authenticateRecord({
      type: 'hello',
      epoch,
      sequence: 0,
      clientNonce,
      protocolMin: HOST_PROTOCOL_MIN_VERSION,
      protocolMax: HOST_PROTOCOL_MAX_VERSION,
      maxMessageBytes: HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
    }, key)
    await transport.send(hello)

    const challengeRaw = await transport.receive()
    if (challengeRaw === null) throw new DesktopUnavailableError('relay disconnected during challenge')
    const challenge = verifyAuthenticatedRecord(challengeRaw, key)
    const inboundGuard = new ReplayGuard()
    inboundGuard.acceptSequence(numberField(challenge, 'sequence'))
    if (stringField(challenge, 'type') !== 'challenge') throw new RelayAuthenticationError('malformed-auth-record', 'expected challenge')
    if (stringField(challenge, 'epoch') !== epoch) throw new RelayAuthenticationError('malformed-auth-record', 'stale rendezvous epoch')
    if (stringField(challenge, 'clientNonce') !== clientNonce) throw new RelayAuthenticationError('nonce-replay', 'challenge client nonce mismatch')
    const serverNonce = stringField(challenge, 'serverNonce')
    serverNonceGuard.acceptNonce(serverNonce)
    const protocolVersion = numberField(challenge, 'protocolVersion')
    if (protocolVersion < HOST_PROTOCOL_MIN_VERSION || protocolVersion > HOST_PROTOCOL_MAX_VERSION) {
      throw new RelayAuthenticationError('malformed-auth-record', 'relay protocol versions do not overlap')
    }
    const maxMessageBytes = numberField(challenge, 'maxMessageBytes')
    if (maxMessageBytes <= 0 || maxMessageBytes > HOST_MAX_NEGOTIATED_MESSAGE_BYTES) {
      throw new RelayAuthenticationError('malformed-auth-record', 'relay selected an invalid message bound')
    }

    await transport.send(authenticateRecord({
      type: 'authenticate',
      epoch,
      sequence: 1,
      clientNonce,
      serverNonce,
      protocolVersion,
      maxMessageBytes,
    }, key))

    const readyRaw = await transport.receive()
    if (readyRaw === null) throw new DesktopUnavailableError('relay disconnected before ready')
    const ready = verifyAuthenticatedRecord(readyRaw, key)
    inboundGuard.acceptSequence(numberField(ready, 'sequence'))
    if (
      stringField(ready, 'type') !== 'ready'
      || stringField(ready, 'epoch') !== epoch
      || stringField(ready, 'clientNonce') !== clientNonce
      || stringField(ready, 'serverNonce') !== serverNonce
      || numberField(ready, 'protocolVersion') !== protocolVersion
      || numberField(ready, 'maxMessageBytes') !== maxMessageBytes
    ) {
      throw new RelayAuthenticationError('malformed-auth-record', 'relay ready acknowledgement does not match negotiation')
    }

    return new AuthenticatedRelayClient(
      transport,
      key,
      epoch,
      clientNonce,
      serverNonce,
      inboundGuard,
      protocolVersion,
      maxMessageBytes,
    )
  }

  async send(message: JsonObject): Promise<void> {
    this.assertOpen()
    this.assertMessageBound(message)
    const record = authenticateRecord({
      type: 'relay',
      direction: 'extension-to-desktop',
      epoch: this.epoch,
      sequence: this.outboundSequence,
      clientNonce: this.clientNonce,
      serverNonce: this.serverNonce,
      protocolVersion: this.protocolVersion,
      payload: message,
    }, this.key)
    this.outboundSequence += 1
    await this.transport.send(record)
  }

  async receive(): Promise<JsonObject | null> {
    this.assertOpen()
    const raw = await this.transport.receive()
    if (raw === null) {
      this.close()
      return null
    }
    const record = verifyAuthenticatedRecord(raw, this.key)
    this.inboundGuard.acceptSequence(numberField(record, 'sequence'))
    if (
      stringField(record, 'type') !== 'relay'
      || stringField(record, 'direction') !== 'desktop-to-extension'
      || stringField(record, 'epoch') !== this.epoch
      || stringField(record, 'clientNonce') !== this.clientNonce
      || stringField(record, 'serverNonce') !== this.serverNonce
      || numberField(record, 'protocolVersion') !== this.protocolVersion
    ) {
      throw new RelayAuthenticationError('malformed-auth-record', 'relay routing metadata does not match the authenticated session')
    }
    const message = objectField(record, 'payload')
    this.assertMessageBound(message)
    return message
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
    this.key.fill(0)
  }

  private assertOpen(): void {
    if (this.closed) throw new DesktopUnavailableError('relay is closed')
  }

  private assertMessageBound(message: JsonObject): void {
    const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
    if (bytes > this.maxMessageBytes) throw new Error(`relay message length ${bytes} exceeds negotiated bound ${this.maxMessageBytes}`)
  }
}
