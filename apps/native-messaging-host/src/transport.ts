import { createConnection, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { ExternalChromeRendezvousDocument } from '@forge/protocol'
import {
  HOST_MAX_QUEUED_RELAY_BYTES,
  HOST_MAX_QUEUED_RELAY_RECORDS,
} from './constants.js'
import { encodeNativeMessage, NativeMessageDecoder, type JsonObject } from './framing.js'
import type { Platform } from './platform.js'

export type RendezvousDocument = ExternalChromeRendezvousDocument

export interface RendezvousProvider {
  read(): Promise<RendezvousDocument>
}

export interface RelaySecretProvider {
  /** Returns an owned copy. The relay client zeroes it immediately after copying. */
  getSecret(keyId: string): Promise<Uint8Array>
}

export interface RelayRecordTransport {
  send(record: JsonObject): Promise<void>
  receive(): Promise<JsonObject | null>
  close(): void
}

export interface RelayConnector {
  connect(endpoint: string): Promise<RelayRecordTransport>
}

export class DesktopUnavailableError extends Error {
  constructor(message = 'Forge Desktop is unavailable') {
    super(message)
    this.name = 'DesktopUnavailableError'
  }
}

export class RelayBackpressureError extends DesktopUnavailableError {
  constructor(message = 'relay receive queue exceeded its bounded high-water mark') {
    super(message)
    this.name = 'RelayBackpressureError'
  }
}

const RENDEZVOUS_FIELDS = [
  'desktopInstanceId',
  'desktopPid',
  'endpoint',
  'epoch',
  'expiresAt',
  'keyId',
  'protocolMax',
  'protocolMin',
  'schemaVersion',
  'userScope',
] as const

function hasExactFields(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((field, index) => field === sortedExpected[index])
}

export function validateRendezvous(
  document: RendezvousDocument,
  expectedUserScope: string,
  platform: Platform,
  nowMs: number,
): void {
  if (!hasExactFields(document, RENDEZVOUS_FIELDS)) throw new DesktopUnavailableError('rendezvous fields are malformed')
  if (document.schemaVersion !== 1) throw new DesktopUnavailableError('unsupported rendezvous schema')
  if (document.userScope !== expectedUserScope) throw new DesktopUnavailableError('rendezvous belongs to another user scope')
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(document.epoch)) throw new DesktopUnavailableError('rendezvous epoch is malformed')
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(document.desktopInstanceId)) {
    throw new DesktopUnavailableError('Desktop instance identifier is malformed')
  }
  if (!Number.isSafeInteger(document.desktopPid) || document.desktopPid <= 0) {
    throw new DesktopUnavailableError('Desktop process identifier is malformed')
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(document.keyId)) throw new DesktopUnavailableError('rendezvous key identifier is malformed')
  if (
    !Number.isSafeInteger(document.protocolMin)
    || !Number.isSafeInteger(document.protocolMax)
    || document.protocolMin < 1
    || document.protocolMin > document.protocolMax
  ) {
    throw new DesktopUnavailableError('rendezvous protocol range is malformed')
  }
  const expiry = Date.parse(document.expiresAt)
  if (!Number.isFinite(expiry) || expiry <= nowMs) throw new DesktopUnavailableError('rendezvous is stale')
  if (platform === 'win32') {
    if (!document.endpoint.startsWith('\\\\.\\pipe\\') || document.endpoint.includes('://')) {
      throw new DesktopUnavailableError('rendezvous must use a Windows named pipe')
    }
  } else if (!document.endpoint.startsWith('/') || document.endpoint.includes('://')) {
    throw new DesktopUnavailableError('rendezvous must use a Unix-domain socket')
  }
}

interface PendingReceiver {
  resolve(value: JsonObject | null): void
  reject(error: Error): void
}

interface PendingWriter {
  reject(error: Error): void
  settled: boolean
}

export interface RelayQueueLimits {
  maxRecords: number
  maxDecodedBytes: number
}

export class FramedSocketTransport implements RelayRecordTransport {
  private readonly decoder: NativeMessageDecoder
  private readonly queued: Array<{ record: JsonObject; bytes: number }> = []
  private readonly receivers: PendingReceiver[] = []
  private readonly writers = new Set<PendingWriter>()
  private ended = false
  private decoderEnded = false
  private failure: Error | undefined
  private decodedBytes = 0

  constructor(
    private readonly socket: Duplex,
    private readonly maxRecordBytes: number,
    private readonly queueLimits: RelayQueueLimits = {
      maxRecords: HOST_MAX_QUEUED_RELAY_RECORDS,
      maxDecodedBytes: HOST_MAX_QUEUED_RELAY_BYTES,
    },
  ) {
    if (!Number.isSafeInteger(queueLimits.maxRecords) || queueLimits.maxRecords < 1) {
      throw new RangeError('relay queue record limit must be a positive integer')
    }
    if (!Number.isSafeInteger(queueLimits.maxDecodedBytes) || queueLimits.maxDecodedBytes < 1) {
      throw new RangeError('relay queue byte limit must be a positive integer')
    }
    this.decoder = new NativeMessageDecoder(maxRecordBytes)
    socket.on('data', (chunk: Buffer) => {
      if (this.ended) return
      try {
        for (const record of this.decoder.push(chunk)) this.deliver(record)
      } catch (error) {
        this.fail(error)
      }
    })
    socket.once('end', () => this.finish())
    socket.once('close', () => this.finish())
    socket.once('error', (error) => this.fail(error))
  }

  get queuedRecordCount(): number {
    return this.queued.length
  }

  get queuedDecodedBytes(): number {
    return this.decodedBytes
  }

  async send(record: JsonObject): Promise<void> {
    if (this.ended) throw this.failure ?? new DesktopUnavailableError('relay socket is closed')
    const frame = encodeNativeMessage(record, this.maxRecordBytes)
    await new Promise<void>((resolve, reject) => {
      const pending: PendingWriter = { reject, settled: false }
      this.writers.add(pending)
      const settle = (error?: Error | null): void => {
        if (pending.settled) return
        pending.settled = true
        this.writers.delete(pending)
        if (error) reject(error)
        else if (this.ended) reject(this.failure ?? new DesktopUnavailableError('relay socket closed during write'))
        else resolve()
      }
      try {
        this.socket.write(frame, settle)
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  receive(): Promise<JsonObject | null> {
    const queued = this.queued.shift()
    if (queued !== undefined) {
      this.decodedBytes -= queued.bytes
      return Promise.resolve(queued.record)
    }
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.ended) return Promise.resolve(null)
    return new Promise<JsonObject | null>((resolve, reject) => this.receivers.push({ resolve, reject }))
  }

  close(): void {
    if (!this.ended) {
      this.ended = true
      this.socket.destroy()
    }
    this.clearQueue()
    this.rejectWriters(this.failure ?? new DesktopUnavailableError('relay socket is closed'))
    for (const receiver of this.receivers.splice(0)) receiver.resolve(null)
  }

  private deliver(record: JsonObject): void {
    if (this.ended) return
    const receiver = this.receivers.shift()
    if (receiver !== undefined) {
      receiver.resolve(record)
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8')
    if (
      this.queued.length + 1 > this.queueLimits.maxRecords
      || this.decodedBytes + bytes > this.queueLimits.maxDecodedBytes
    ) {
      this.fail(new RelayBackpressureError())
      return
    }
    this.queued.push({ record, bytes })
    this.decodedBytes += bytes
  }

  private finish(): void {
    if (this.failure !== undefined) return
    if (!this.decoderEnded) {
      this.decoderEnded = true
      try {
        this.decoder.end()
      } catch (error) {
        this.fail(error)
        return
      }
    }
    if (this.ended) return
    this.ended = true
    this.clearQueue()
    this.rejectWriters(new DesktopUnavailableError('relay socket reached EOF'))
    for (const receiver of this.receivers.splice(0)) receiver.resolve(null)
    this.socket.destroy()
  }

  private fail(error: unknown): void {
    if (this.failure !== undefined) return
    this.failure = error instanceof Error ? error : new Error(String(error))
    this.ended = true
    this.clearQueue()
    this.rejectWriters(this.failure)
    for (const receiver of this.receivers.splice(0)) receiver.reject(this.failure)
    this.socket.destroy()
  }

  private clearQueue(): void {
    this.queued.length = 0
    this.decodedBytes = 0
  }

  private rejectWriters(error: Error): void {
    for (const writer of this.writers) {
      if (writer.settled) continue
      writer.settled = true
      writer.reject(error)
    }
    this.writers.clear()
  }
}

export class NodeSocketConnector implements RelayConnector {
  constructor(
    private readonly maxRecordBytes: number,
    private readonly queueLimits?: RelayQueueLimits,
  ) {}

  connect(endpoint: string): Promise<RelayRecordTransport> {
    return new Promise((resolve, reject) => {
      const socket: Socket = createConnection({ path: endpoint })
      const onError = (error: Error): void => reject(error)
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        resolve(new FramedSocketTransport(socket, this.maxRecordBytes, this.queueLimits))
      })
    })
  }
}
