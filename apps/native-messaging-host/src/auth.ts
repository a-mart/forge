import { createHmac, timingSafeEqual } from 'node:crypto'
import type { JsonObject } from './framing.js'

export interface RelayUnsignedRecord extends JsonObject {
  type: string
  epoch: string
  sequence: number
}

export interface RelayAuthenticatedRecord extends RelayUnsignedRecord {
  mac: string
}

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

export function authenticateRecord<T extends RelayUnsignedRecord>(record: T, key: Uint8Array): T & { mac: string } {
  if (key.byteLength < 32) throw new RelayAuthenticationError('malformed-auth-record', 'relay key must contain at least 256 bits')
  const mac = createHmac('sha256', key).update(canonicalize(record), 'utf8').digest('base64url')
  return { ...record, mac }
}

export function verifyAuthenticatedRecord(record: JsonObject, key: Uint8Array): RelayAuthenticatedRecord {
  const { mac, ...unsigned } = record
  if (typeof mac !== 'string' || mac.length !== 43) {
    throw new RelayAuthenticationError('malformed-auth-record', 'relay record has an invalid MAC')
  }
  const expected = authenticateRecord(unsigned as RelayUnsignedRecord, key).mac
  const actualBytes = Buffer.from(mac, 'base64url')
  const expectedBytes = Buffer.from(expected, 'base64url')
  if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new RelayAuthenticationError('hmac-mismatch', 'relay record authentication failed')
  }
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
