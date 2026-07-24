import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import type { JsonObject } from './framing.js'

export interface RelayUnsignedRecord extends JsonObject {
  type: string
  epoch: string
  sequence: number
}

export interface RelayAuthenticatedRecord extends RelayUnsignedRecord {
  mac: string
}

export type HandshakeProofRole = 'desktop-challenge' | 'native-host-authenticate'

export class RelayAuthenticationError extends Error {
  constructor(
    readonly code: 'hmac-mismatch' | 'nonce-replay' | 'sequence-replay' | 'malformed-auth-record',
    message: string,
  ) {
    super(message)
    this.name = 'RelayAuthenticationError'
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RelayAuthenticationError('malformed-auth-record', 'non-finite number in record')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`
  }
  throw new RelayAuthenticationError('malformed-auth-record', 'record contains a non-JSON value')
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength < 32) throw new RelayAuthenticationError('malformed-auth-record', 'authentication key must contain at least 256 bits')
}

function hmacBase64Url(key: Uint8Array, domain: string, value: JsonObject): string {
  assertKey(key)
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalize(value), 'utf8')
    .digest('base64url')
}

function verifyProof(actual: unknown, expected: string): void {
  if (typeof actual !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(actual)) {
    throw new RelayAuthenticationError('malformed-auth-record', 'authentication proof is malformed')
  }
  const actualBytes = Buffer.from(actual, 'base64url')
  const expectedBytes = Buffer.from(expected, 'base64url')
  if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new RelayAuthenticationError('hmac-mismatch', 'relay handshake authentication failed')
  }
}

/**
 * The installed per-user secret is used only for these domain-separated handshake proofs.
 * Ready and relay records must use deriveRelaySessionKey() instead.
 */
export function createHandshakeProof(role: HandshakeProofRole, fields: JsonObject, secret: Uint8Array): string {
  return hmacBase64Url(secret, `forge-external-chrome/handshake/v1/${role}`, fields)
}

export function verifyHandshakeProof(
  role: HandshakeProofRole,
  fields: JsonObject,
  proof: unknown,
  secret: Uint8Array,
): void {
  verifyProof(proof, createHandshakeProof(role, fields, secret))
}

/**
 * Derive a connection-unique 256-bit relay key with HKDF-SHA-256. The salt is a
 * domain-separated HMAC of the exact authenticated challenge transcript and the
 * HKDF info identifies the relay-record purpose. Both nonces, protocol ranges,
 * selected protocol, pinned origin, Desktop instance, and rendezvous epoch are
 * therefore bound into the derived key. Callers own and must zero the result.
 */
export function deriveRelaySessionKey(challengeFields: JsonObject, secret: Uint8Array): Buffer {
  assertKey(secret)
  const transcript = Buffer.from(canonicalize(challengeFields), 'utf8')
  const salt = createHmac('sha256', secret)
    .update('forge-external-chrome/session-salt/v1\0', 'utf8')
    .update(transcript)
    .digest()
  try {
    return Buffer.from(hkdfSync(
      'sha256',
      secret,
      salt,
      Buffer.from('forge-external-chrome/relay-record-key/v1', 'utf8'),
      32,
    ))
  } finally {
    salt.fill(0)
    transcript.fill(0)
  }
}

export function authenticateRecord<T extends RelayUnsignedRecord>(record: T, key: Uint8Array): T & { mac: string } {
  const mac = hmacBase64Url(key, 'forge-external-chrome/relay-record/v1', record)
  return { ...record, mac }
}

export function verifyAuthenticatedRecord(record: JsonObject, key: Uint8Array): RelayAuthenticatedRecord {
  const { mac, ...unsigned } = record
  const expected = hmacBase64Url(key, 'forge-external-chrome/relay-record/v1', unsigned)
  verifyProof(mac, expected)
  return record as RelayAuthenticatedRecord
}

export class ReplayGuard {
  private readonly nonces = new Set<string>()
  private readonly nonceOrder: string[] = []
  private lastSequence = -1

  constructor(private readonly maxRememberedNonces = 256) {}

  acceptNonce(nonce: string): void {
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)) {
      throw new RelayAuthenticationError('malformed-auth-record', 'relay nonce is malformed')
    }
    if (this.nonces.has(nonce)) throw new RelayAuthenticationError('nonce-replay', 'relay nonce was already used')
    this.nonces.add(nonce)
    this.nonceOrder.push(nonce)
    if (this.nonceOrder.length > this.maxRememberedNonces) {
      const removed = this.nonceOrder.shift()
      if (removed !== undefined) this.nonces.delete(removed)
    }
  }

  acceptSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence !== this.lastSequence + 1) {
      throw new RelayAuthenticationError('sequence-replay', 'relay sequence is repeated, stale, or non-contiguous')
    }
    this.lastSequence = sequence
  }
}
