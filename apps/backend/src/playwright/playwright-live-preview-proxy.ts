import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { validateLivePreviewWebSocketOrigin } from './playwright-live-preview-access.js'
import { PlaywrightLivePreviewService } from './playwright-live-preview-service.js'

const CONTROLLER_PATH_PATTERN = /^\/playwright-live\/ws\/controller\/([^/]+)$/

interface ReplayMessage {
  data: RawData
  isBinary: boolean
}

interface PreviewUpstreamChannel {
  previewId: string
  upstream: WebSocket
  clients: Set<WebSocket>
  pendingClientMessages: Array<{ data: RawData; isBinary: boolean }>
  unregisterCleanup: () => void
  closed: boolean
  lastTabsMessage: ReplayMessage | null
  lastFrameMessage: ReplayMessage | null
}

interface SanitizedUpstreamMessage {
  data: RawData
  isBinary: boolean
  messageType: string | null
}

export class PlaywrightLivePreviewProxy {
  private readonly livePreviewService: PlaywrightLivePreviewService
  private readonly wss: WebSocketServer
  private readonly channelsByPreviewId = new Map<string, PreviewUpstreamChannel>()

  constructor(options: { livePreviewService: PlaywrightLivePreviewService }) {
    this.livePreviewService = options.livePreviewService
    this.wss = new WebSocketServer({ noServer: true })

    this.livePreviewService.on('preview_started', (event) => {
      const previewId = typeof event?.previewId === 'string' ? event.previewId.trim() : ''
      if (!previewId) {
        return
      }

      void this.ensurePreviewChannel(previewId)
    })
  }

  canHandleUpgrade(pathname: string): boolean {
    return CONTROLLER_PATH_PATTERN.test(pathname)
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    pathname: string,
  ): boolean {
    const match = pathname.match(CONTROLLER_PATH_PATTERN)
    if (!match) {
      return false
    }

    const originValidation = validateLivePreviewWebSocketOrigin(request)
    if (!originValidation.ok) {
      writeUpgradeError(socket, 403, originValidation.errorMessage)
      return true
    }

    const previewId = decodeURIComponent(match[1] ?? '').trim()
    if (!previewId || !this.livePreviewService.getUpstreamControllerUrl(previewId)) {
      writeUpgradeError(socket, 410, 'Unknown or expired preview')
      return true
    }

    this.wss.handleUpgrade(request, socket, head, (client) => {
      void this.handleProxyConnection(client, previewId)
    })
    return true
  }

  async stop(): Promise<void> {
    for (const previewId of Array.from(this.channelsByPreviewId.keys())) {
      this.disposePreviewChannel(previewId, 1012, 'Preview proxy shutting down')
    }

    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  private async handleProxyConnection(client: WebSocket, previewId: string): Promise<void> {
    const channel = await this.ensurePreviewChannel(previewId)
    if (!channel) {
      client.close(1011, 'Preview expired')
      return
    }

    channel.clients.add(client)
    this.livePreviewService.touchPreview(previewId)
    this.replayBufferedMessages(channel, client)

    client.on('message', (data, isBinary) => {
      this.livePreviewService.touchPreview(previewId)
      if (channel.upstream.readyState === WebSocket.OPEN) {
        channel.upstream.send(data, { binary: isBinary })
        return
      }

      channel.pendingClientMessages.push({ data, isBinary })
    })

    client.on('close', () => {
      this.detachClient(channel, client)
    })

    client.on('error', () => {
      this.detachClient(channel, client)
    })
  }

  private async ensurePreviewChannel(previewId: string): Promise<PreviewUpstreamChannel | null> {
    const existing = this.channelsByPreviewId.get(previewId)
    if (existing && !existing.closed) {
      return existing
    }

    const upstreamControllerUrl = this.livePreviewService.getUpstreamControllerUrl(previewId)
    if (!upstreamControllerUrl) {
      return null
    }

    const upstream = new WebSocket(upstreamControllerUrl)
    const channel: PreviewUpstreamChannel = {
      previewId,
      upstream,
      clients: new Set(),
      pendingClientMessages: [],
      unregisterCleanup: () => {},
      closed: false,
      lastTabsMessage: null,
      lastFrameMessage: null,
    }

    channel.unregisterCleanup = this.livePreviewService.registerPreviewCleanup(previewId, () => {
      this.disposePreviewChannel(previewId, 1000, 'Preview released')
    })
    this.channelsByPreviewId.set(previewId, channel)

    upstream.on('open', () => {
      if (channel.closed) {
        return
      }

      if (channel.clients.size > 0) {
        this.livePreviewService.touchPreview(previewId)
      }

      for (const message of channel.pendingClientMessages.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary })
      }
    })

    upstream.on('message', (data, isBinary) => {
      if (channel.closed) {
        return
      }

      if (channel.clients.size > 0) {
        this.livePreviewService.touchPreview(previewId)
      }

      const sanitized = sanitizeUpstreamMessage(data, isBinary)
      this.captureReplayMessage(channel, sanitized)
      this.broadcastToClients(channel, sanitized)
    })

    upstream.on('close', (code, reason) => {
      if (channel.closed) {
        return
      }

      const closeCode = normalizeCloseCode(code, 1011)
      const closeReason = toCloseReason(reason.toString(), closeCode === 1000 ? 'Upstream controller closed' : 'Upstream controller error')

      for (const client of Array.from(channel.clients)) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close(closeCode, closeReason)
        }
      }

      this.disposePreviewChannel(previewId, closeCode, closeReason, { closeUpstream: false })
    })

    upstream.on('error', () => {
      if (channel.closed) {
        return
      }

      for (const client of Array.from(channel.clients)) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close(1011, 'Upstream controller error')
        }
      }

      this.disposePreviewChannel(previewId, 1011, 'Upstream controller error', { closeUpstream: false })
    })

    return channel
  }

  private detachClient(channel: PreviewUpstreamChannel, client: WebSocket): void {
    channel.clients.delete(client)
  }

  private replayBufferedMessages(channel: PreviewUpstreamChannel, client: WebSocket): void {
    if (client.readyState !== WebSocket.OPEN) {
      return
    }

    for (const message of [channel.lastTabsMessage, channel.lastFrameMessage]) {
      if (!message) {
        continue
      }

      client.send(cloneRawData(message.data), { binary: message.isBinary })
    }
  }

  private captureReplayMessage(channel: PreviewUpstreamChannel, message: SanitizedUpstreamMessage): void {
    if (message.messageType === 'tabs') {
      channel.lastTabsMessage = cloneReplayMessage(message)
      return
    }

    if (message.messageType === 'frame') {
      channel.lastFrameMessage = cloneReplayMessage(message)
    }
  }

  private broadcastToClients(channel: PreviewUpstreamChannel, message: SanitizedUpstreamMessage): void {
    for (const client of Array.from(channel.clients)) {
      if (client.readyState !== WebSocket.OPEN) {
        channel.clients.delete(client)
        continue
      }

      client.send(cloneRawData(message.data), { binary: message.isBinary })
    }
  }

  private disposePreviewChannel(
    previewId: string,
    code = 1000,
    reason = 'Closing',
    options: { closeUpstream?: boolean } = {},
  ): void {
    const channel = this.channelsByPreviewId.get(previewId)
    if (!channel || channel.closed) {
      return
    }
    channel.closed = true

    this.channelsByPreviewId.delete(previewId)
    channel.unregisterCleanup()
    channel.pendingClientMessages.length = 0
    channel.lastTabsMessage = null
    channel.lastFrameMessage = null

    for (const client of Array.from(channel.clients)) {
      closeSocket(client, code, reason)
    }
    channel.clients.clear()

    if (options.closeUpstream !== false) {
      closeSocket(channel.upstream, code, reason)
    }
  }
}

function sanitizeUpstreamMessage(data: RawData, isBinary: boolean): SanitizedUpstreamMessage {
  if (isBinary) {
    return { data, isBinary, messageType: null }
  }

  const text = typeof data === 'string' ? data : data.toString()

  try {
    const payload = JSON.parse(text) as unknown
    const sanitized = sanitizeInspectorUrls(payload)
    return {
      data: Buffer.from(JSON.stringify(sanitized)),
      isBinary: false,
      messageType: getControllerMessageType(payload),
    }
  } catch {
    return { data, isBinary: false, messageType: null }
  }
}

function getControllerMessageType(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const message = value as { type?: unknown; method?: unknown }
  if (typeof message.type === 'string') {
    return message.type
  }

  return typeof message.method === 'string' ? message.method : null
}

function sanitizeInspectorUrls(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeInspectorUrls(entry))
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'inspectorUrl') {
      sanitized[key] = null
      continue
    }

    sanitized[key] = sanitizeInspectorUrls(entry)
  }
  return sanitized
}

function cloneReplayMessage(message: ReplayMessage): ReplayMessage {
  return {
    data: cloneRawData(message.data),
    isBinary: message.isBinary,
  }
}

function cloneRawData(data: RawData): RawData {
  if (typeof data === 'string') {
    return data
  }

  if (Buffer.isBuffer(data)) {
    return Buffer.from(data)
  }

  if (Array.isArray(data)) {
    return data.map((chunk) => Buffer.from(chunk))
  }

  if (data instanceof ArrayBuffer) {
    return data.slice(0)
  }

  return Buffer.from(data as ArrayBuffer)
}

function closeSocket(socket: WebSocket, code?: number, reason?: string): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return
  }

  socket.close(normalizeCloseCode(code, 1000), toCloseReason(reason, 'Closing'))
}

function normalizeCloseCode(code: number | undefined, fallback: number): number {
  if (typeof code !== 'number') {
    return fallback
  }

  if (code < 1000 || code > 4999 || code === 1004 || code === 1005 || code === 1006 || code === 1015) {
    return fallback
  }

  return code
}

function toCloseReason(reason: string | undefined, fallback: string): string {
  const trimmed = reason?.trim() || fallback
  return trimmed.length > 123 ? trimmed.slice(0, 123) : trimmed
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      '\r\n' +
      message,
  )
  socket.destroy()
}
