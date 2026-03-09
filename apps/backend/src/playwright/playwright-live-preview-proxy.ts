import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { validateLivePreviewWebSocketOrigin } from './playwright-live-preview-access.js'
import { PlaywrightLivePreviewService } from './playwright-live-preview-service.js'

const CONTROLLER_PATH_PATTERN = /^\/playwright-live\/ws\/controller\/([^/]+)$/

interface ProxyConnectionPair {
  client: WebSocket
  upstream: WebSocket
  unregisterCleanup: () => void
  closed: boolean
}

export class PlaywrightLivePreviewProxy {
  private readonly livePreviewService: PlaywrightLivePreviewService
  private readonly wss: WebSocketServer
  private readonly connectionsByPreviewId = new Map<string, Set<ProxyConnectionPair>>()

  constructor(options: { livePreviewService: PlaywrightLivePreviewService }) {
    this.livePreviewService = options.livePreviewService
    this.wss = new WebSocketServer({ noServer: true })
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
    for (const previewId of Array.from(this.connectionsByPreviewId.keys())) {
      this.closePreviewConnections(previewId, 1012, 'Preview proxy shutting down')
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
    const upstreamControllerUrl = this.livePreviewService.getUpstreamControllerUrl(previewId)
    if (!upstreamControllerUrl) {
      client.close(1011, 'Preview expired')
      return
    }

    const upstream = new WebSocket(upstreamControllerUrl)
    const pendingClientMessages: Array<{ data: RawData; isBinary: boolean }> = []

    const pair: ProxyConnectionPair = {
      client,
      upstream,
      unregisterCleanup: () => {},
      closed: false,
    }

    pair.unregisterCleanup = this.livePreviewService.registerPreviewCleanup(previewId, () => {
      this.closeConnectionPair(pair, 1000, 'Preview released')
    })
    this.trackConnection(previewId, pair)

    client.on('message', (data, isBinary) => {
      this.livePreviewService.touchPreview(previewId)
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary })
        return
      }

      pendingClientMessages.push({ data, isBinary })
    })

    client.on('close', () => {
      this.closeConnectionPair(pair)
    })

    client.on('error', () => {
      this.closeConnectionPair(pair)
    })

    upstream.on('open', () => {
      this.livePreviewService.touchPreview(previewId)
      for (const message of pendingClientMessages.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary })
      }
    })

    upstream.on('message', (data, isBinary) => {
      this.livePreviewService.touchPreview(previewId)
      if (client.readyState !== WebSocket.OPEN) {
        return
      }

      const sanitized = sanitizeUpstreamMessage(data, isBinary)
      client.send(sanitized.data, { binary: sanitized.isBinary })
    })

    upstream.on('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason.toString())
      }
      this.closeConnectionPair(pair)
    })

    upstream.on('error', () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1011, 'Upstream controller error')
      }
      this.closeConnectionPair(pair)
    })
  }

  private trackConnection(previewId: string, pair: ProxyConnectionPair): void {
    const existing = this.connectionsByPreviewId.get(previewId)
    if (existing) {
      existing.add(pair)
      return
    }

    this.connectionsByPreviewId.set(previewId, new Set([pair]))
  }

  private closePreviewConnections(previewId: string, code = 1000, reason = 'Preview released'): void {
    const pairs = this.connectionsByPreviewId.get(previewId)
    if (!pairs) {
      return
    }

    for (const pair of Array.from(pairs)) {
      this.closeConnectionPair(pair, code, reason)
    }
  }

  private closeConnectionPair(pair: ProxyConnectionPair, code = 1000, reason = 'Closing'): void {
    if (pair.closed) {
      return
    }
    pair.closed = true

    pair.unregisterCleanup()
    this.removeConnectionPair(pair)

    closeSocket(pair.client, code, reason)
    closeSocket(pair.upstream, code, reason)
  }

  private removeConnectionPair(pair: ProxyConnectionPair): void {
    for (const [previewId, pairs] of this.connectionsByPreviewId.entries()) {
      if (!pairs.delete(pair)) {
        continue
      }

      if (pairs.size === 0) {
        this.connectionsByPreviewId.delete(previewId)
      }
      return
    }
  }
}

function sanitizeUpstreamMessage(data: RawData, isBinary: boolean): { data: RawData; isBinary: boolean } {
  if (isBinary) {
    return { data, isBinary }
  }

  const text = typeof data === 'string' ? data : data.toString()

  try {
    const payload = JSON.parse(text) as unknown
    const sanitized = sanitizeInspectorUrls(payload)
    return {
      data: Buffer.from(JSON.stringify(sanitized)),
      isBinary: false,
    }
  } catch {
    return { data, isBinary: false }
  }
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

function closeSocket(socket: WebSocket, code?: number, reason?: string): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return
  }

  socket.close(code, reason)
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
