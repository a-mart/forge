import { createConnection, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { encodeNativeMessage, NativeMessageDecoder, type JsonObject } from './framing.js'
import type { Platform } from './platform.js'

export interface RendezvousDocument {
  schemaVersion: 1
  endpoint: string
  epoch: string
  expiresAt: string
  keyId: string
  userScope: string
}

export interface RendezvousProvider {
  read(): Promise<RendezvousDocument>
}

export interface RelaySecretProvider {
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

export function validateRendezvous(
  document: RendezvousDocument,
  expectedUserScope: string,
  platform: Platform,
  nowMs: number,
): void {
  if (document.schemaVersion !== 1) throw new DesktopUnavailableError('unsupported rendezvous schema')
  if (document.userScope !== expectedUserScope) throw new DesktopUnavailableError('rendezvous belongs to another user scope')
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(document.epoch)) throw new DesktopUnavailableError('rendezvous epoch is malformed')
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(document.keyId)) throw new DesktopUnavailableError('rendezvous key identifier is malformed')
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

export class FramedSocketTransport implements RelayRecordTransport {
  private readonly decoder: NativeMessageDecoder
  private readonly queued: JsonObject[] = []
  private readonly receivers: PendingReceiver[] = []
  private ended = false
  private failure: Error | undefined

  constructor(
    private readonly socket: Duplex,
    private readonly maxRecordBytes: number,
  ) {
    this.decoder = new NativeMessageDecoder(maxRecordBytes)
    socket.on('data', (chunk: Buffer) => {
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

  async send(record: JsonObject): Promise<void> {
    if (this.ended) throw this.failure ?? new DesktopUnavailableError('relay socket is closed')
    const frame = encodeNativeMessage(record, this.maxRecordBytes)
    await new Promise<void>((resolve, reject) => {
      this.socket.write(frame, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  receive(): Promise<JsonObject | null> {
    const queued = this.queued.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.ended) return Promise.resolve(null)
    return new Promise<JsonObject | null>((resolve, reject) => this.receivers.push({ resolve, reject }))
  }

  close(): void {
    this.ended = true
    this.socket.destroy()
    this.finish()
  }

  private deliver(record: JsonObject): void {
    const receiver = this.receivers.shift()
    if (receiver === undefined) this.queued.push(record)
    else receiver.resolve(record)
  }

  private finish(): void {
    if (this.ended && this.receivers.length === 0) return
    this.ended = true
    try {
      this.decoder.end()
    } catch (error) {
      this.fail(error)
      return
    }
    for (const receiver of this.receivers.splice(0)) receiver.resolve(null)
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error))
    this.ended = true
    this.socket.destroy()
    for (const receiver of this.receivers.splice(0)) receiver.reject(this.failure)
  }
}

export class NodeSocketConnector implements RelayConnector {
  constructor(private readonly maxRecordBytes: number) {}

  connect(endpoint: string): Promise<RelayRecordTransport> {
    return new Promise((resolve, reject) => {
      const socket: Socket = createConnection({ path: endpoint })
      const onError = (error: Error): void => reject(error)
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        resolve(new FramedSocketTransport(socket, this.maxRecordBytes))
      })
    })
  }
}
