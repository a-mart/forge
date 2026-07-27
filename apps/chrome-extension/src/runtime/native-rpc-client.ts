import {
  BROWSER_AUTOMATION_OPERATIONS,
  EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
  EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES,
  EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES,
  EXTERNAL_CHROME_METHODS,
  EXTERNAL_CHROME_PROTOCOL_MAX_VERSION,
  EXTERNAL_CHROME_PROTOCOL_MIN_VERSION,
  EXTERNAL_CHROME_SUPPORTED_OPERATIONS,
  EXTERNAL_CHROME_EXTENSION_ID,
  parseExternalChromeJsonRpcFrame,
  type ExternalChromeHelloParams,
  type ExternalChromeJsonRpcMessage,
  type ExternalChromeRequestMethod,
  type ExternalChromeWelcomeResult,
} from '@forge/protocol'
import type { ChromeRuntimePort } from './chrome-api.js'
import { NATIVE_HOST_NAME, PAYLOAD_VERSION, SHELL_ABI } from './identity.js'

export interface NativeRpcScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

const browserScheduler: NativeRpcScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
}

export interface NativeRpcClientOptions {
  connect: (hostName: string) => ChromeRuntimePort
  extensionInstanceId: string
  chromeVersion: string
  payloadSha256?: string
  profileAlias?: string
  scheduler?: NativeRpcScheduler
  randomId?: () => string
  onConnected?: (welcome: ExternalChromeWelcomeResult) => void
  onDisconnected?: (reason: string) => void
  onRequest?: (message: ExternalChromeJsonRpcMessage) => unknown | Promise<unknown>
}

interface PendingRequest {
  method: ExternalChromeRequestMethod
  resolve: (message: ExternalChromeJsonRpcMessage) => void
  reject: (error: Error) => void
  timer: unknown
}

function serializeMessage(message: unknown): { serialized: string; bytes: number } {
  const serialized = JSON.stringify(message)
  if (typeof serialized !== 'string') throw new Error('message is not JSON serializable')
  return { serialized, bytes: new TextEncoder().encode(serialized).byteLength }
}

export class NativeRpcClient {
  private readonly scheduler: NativeRpcScheduler
  private readonly randomId: () => string
  private port: ChromeRuntimePort | null = null
  private stopped = true
  private reconnectAttempt = 0
  private reconnectTimer: unknown = null
  private heartbeatTimer: unknown = null
  private heartbeatMs = 10_000
  private inboundMessageLimit = Math.min(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES)
  private outboundMessageLimit = Math.min(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES)
  private lastInboundAt = 0
  private requestSequence = 0
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly options: NativeRpcClientOptions) {
    this.scheduler = options.scheduler ?? browserScheduler
    this.randomId = options.randomId ?? (() => crypto.randomUUID())
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.rejectPending('native port stopped')
    this.resetNegotiatedState()
    const port = this.port
    this.port = null
    if (port !== null) port.disconnect()
  }

  isConnected(): boolean {
    return this.port !== null && this.reconnectAttempt === 0 && this.lastInboundAt > 0
  }

  sendNotification(method: string, params: Record<string, unknown>): void {
    this.postBounded({ jsonrpc: '2.0', method, params })
  }

  private connect(): void {
    if (this.stopped || this.port !== null) return
    let port: ChromeRuntimePort
    try {
      port = this.options.connect(NATIVE_HOST_NAME)
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : 'connectNative failed')
      return
    }
    this.port = port
    port.onMessage.addListener((message) => this.receive(message))
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return
      this.port = null
      this.resetNegotiatedState()
      this.rejectPending('native port disconnected')
      this.options.onDisconnected?.('native port disconnected')
      this.scheduleReconnect('native port disconnected')
    })
    void this.negotiate().catch((error: unknown) => {
      if (this.port === port) {
        this.port = null
        this.resetNegotiatedState()
        this.rejectPending('native negotiation failed')
        port.disconnect()
      }
      this.scheduleReconnect(error instanceof Error ? error.message : 'negotiation failed')
    })
  }

  private hello(): ExternalChromeHelloParams {
    const supported = new Set<string>(EXTERNAL_CHROME_SUPPORTED_OPERATIONS)
    return {
      protocol: { min: EXTERNAL_CHROME_PROTOCOL_MIN_VERSION, max: EXTERNAL_CHROME_PROTOCOL_MAX_VERSION },
      shellAbi: SHELL_ABI,
      payloadVersion: PAYLOAD_VERSION,
      payloadSha256: this.options.payloadSha256 ?? '0'.repeat(64),
      extensionId: EXTERNAL_CHROME_EXTENSION_ID,
      extensionInstanceId: this.options.extensionInstanceId,
      ...(this.options.profileAlias ? { profileAlias: this.options.profileAlias } : {}),
      chromeVersion: this.options.chromeVersion,
      methods: [...EXTERNAL_CHROME_METHODS],
      maxMessageBytes: EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
      operations: BROWSER_AUTOMATION_OPERATIONS.map((operation) => ({
        operation,
        supported: supported.has(operation),
        ...(supported.has(operation) ? {} : { reason: 'External Chrome does not qualify physical viewport control or recording in M4' }),
      })),
      features: {
        resize: false,
        recording: false,
        downloadEvents: false,
        downloadArtifacts: false,
        downloadOpen: false,
        oopif: true,
        humanInterruption: true,
        groups: false,
      },
    }
  }

  private async negotiate(): Promise<void> {
    const response = await this.request('forge.runtime.hello', this.hello())
    if (!('result' in response)) throw new Error('native hello was rejected')
    const welcome = response.result as ExternalChromeWelcomeResult
    if (welcome.requiredShellAbi !== SHELL_ABI) {
      throw new Error(`native host requires shell ABI ${welcome.requiredShellAbi}; extension provides ${SHELL_ABI}`)
    }
    this.inboundMessageLimit = Math.min(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES, welcome.maxMessageBytes)
    this.outboundMessageLimit = Math.min(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES, welcome.maxMessageBytes)
    this.heartbeatMs = welcome.heartbeatMs
    this.reconnectAttempt = 0
    this.lastInboundAt = this.scheduler.now()
    this.options.onConnected?.(welcome)
    this.scheduleHeartbeat()
  }

  private request(method: ExternalChromeRequestMethod, params: object): Promise<ExternalChromeJsonRpcMessage> {
    const id = `ext-${++this.requestSequence}-${this.randomId()}`.slice(0, 128)
    return new Promise((resolve, reject) => {
      const timer = this.scheduler.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 10_000)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.postBounded({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        this.scheduler.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('message send failed'))
      }
    })
  }

  private receive(raw: unknown): void {
    let serialized: string
    try {
      const encoded = serializeMessage(raw)
      serialized = encoded.serialized
      if (encoded.bytes > this.inboundMessageLimit) throw new Error('native message exceeds negotiated bound')
    } catch {
      this.disconnectInvalid('malformed or oversized native message')
      return
    }
    const id = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).id === 'string'
      ? (raw as Record<string, unknown>).id as string
      : undefined
    const pending = id === undefined ? undefined : this.pending.get(id)
    let parsed: ExternalChromeJsonRpcMessage
    try {
      parsed = parseExternalChromeJsonRpcFrame(serialized, pending === undefined ? {} : { expectedResponseMethod: pending.method })
    } catch {
      this.disconnectInvalid('native message failed JSON-RPC validation')
      return
    }
    this.lastInboundAt = this.scheduler.now()
    if (id !== undefined && pending !== undefined && !('method' in parsed)) {
      this.pending.delete(id)
      this.scheduler.clearTimeout(pending.timer)
      pending.resolve(parsed)
      return
    }
    if ('method' in parsed && 'id' in parsed) {
      const handler = this.options.onRequest
      if (handler === undefined) {
        this.postBounded({ jsonrpc: '2.0', id: parsed.id, error: { code: -32601, message: 'Extension method is unavailable' } })
        return
      }
      void Promise.resolve(handler(parsed)).then(
        (result) => this.postBounded({ jsonrpc: '2.0', id: parsed.id, result }),
        (error: unknown) => this.postBounded({
          jsonrpc: '2.0', id: parsed.id, error: {
            code: -32050,
            message: error instanceof Error ? error.message.slice(0, 256) : 'Extension request failed',
          },
        }),
      ).catch(() => this.disconnectInvalid('failed to send extension response'))
      return
    }
    this.options.onRequest?.(parsed)
  }

  private postBounded(message: unknown): void {
    if (serializeMessage(message).bytes > this.outboundMessageLimit) throw new Error('outbound native message exceeds negotiated bound')
    if (this.port === null) throw new Error('native port is unavailable')
    this.port.postMessage(message)
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.scheduler.clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = this.scheduler.setTimeout(() => {
      this.heartbeatTimer = null
      if (this.stopped || this.port === null) return
      if (this.scheduler.now() - this.lastInboundAt > this.heartbeatMs * 3) {
        this.disconnectInvalid('heartbeat grace expired')
        return
      }
      void this.request('forge.runtime.ping', {
        protocolVersion: 1,
        nonce: this.randomId().slice(0, 128),
        sentAt: new Date(this.scheduler.now()).toISOString(),
      }).then(() => this.scheduleHeartbeat()).catch(() => this.disconnectInvalid('heartbeat failed'))
    }, this.heartbeatMs)
  }

  private disconnectInvalid(reason: string): void {
    const port = this.port
    this.port = null
    this.resetNegotiatedState()
    this.rejectPending(reason)
    if (port !== null) port.disconnect()
    this.options.onDisconnected?.(reason)
    this.scheduleReconnect(reason)
  }

  private scheduleReconnect(_reason: string): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const delay = Math.min(30_000, 250 * 2 ** Math.min(this.reconnectAttempt, 7))
    this.reconnectAttempt += 1
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private resetNegotiatedState(): void {
    this.heartbeatMs = 10_000
    this.inboundMessageLimit = Math.min(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES)
    this.outboundMessageLimit = Math.min(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES)
    this.lastInboundAt = 0
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pending.values()) {
      this.scheduler.clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.scheduler.clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer !== null) this.scheduler.clearTimeout(this.heartbeatTimer)
    this.reconnectTimer = null
    this.heartbeatTimer = null
  }
}
