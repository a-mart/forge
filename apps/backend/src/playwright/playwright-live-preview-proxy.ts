import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { PlaywrightLivePreviewService } from './playwright-live-preview-service.js'

const CONTROLLER_PATH_PATTERN = /^\/playwright-live\/ws\/controller\/([^/]+)$/

export class PlaywrightLivePreviewProxy {
  private readonly livePreviewService: PlaywrightLivePreviewService
  private readonly wss: WebSocketServer

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

    client.on('message', (data, isBinary) => {
      this.livePreviewService.touchPreview(previewId)
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary })
        return
      }

      pendingClientMessages.push({ data, isBinary })
    })

    client.on('close', () => {
      closeSocket(upstream)
    })

    client.on('error', () => {
      closeSocket(upstream)
    })

    upstream.on('open', () => {
      this.livePreviewService.touchPreview(previewId)
      for (const message of pendingClientMessages.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary })
      }
    })

    upstream.on('message', (data, isBinary) => {
      this.livePreviewService.touchPreview(previewId)
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary })
      }
    })

    upstream.on('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason.toString())
      }
    })

    upstream.on('error', () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1011, 'Upstream controller error')
      }
    })
  }
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return
  }

  socket.close()
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
