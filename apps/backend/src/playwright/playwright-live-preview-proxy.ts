import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { validateLivePreviewWebSocketOrigin } from './playwright-live-preview-access.js'
import { PlaywrightLivePreviewService } from './playwright-live-preview-service.js'

const CONTROLLER_PATH_PATTERN = /^\/playwright-live\/ws\/controller\/([^/]+)$/
const UPSTREAM_BOOTSTRAP_TIMEOUT_MS = 2_000

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
  bootstrapPromise: Promise<void> | null
  nextInternalRpcId: number
  pendingInternalRpcCalls: Map<number, PendingUpstreamRpcCall>
  upstreamOpenPromise: Promise<void>
  resolveUpstreamOpen: () => void
  rejectUpstreamOpen: (error: Error) => void
}

interface PendingUpstreamRpcCall {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
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
    void this.ensureInitialTabsState(channel)

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
    let resolveUpstreamOpen!: () => void
    let rejectUpstreamOpen!: (error: Error) => void
    const upstreamOpenPromise = new Promise<void>((resolve, reject) => {
      resolveUpstreamOpen = resolve
      rejectUpstreamOpen = reject
    })
    upstreamOpenPromise.catch(() => {})
    const channel: PreviewUpstreamChannel = {
      previewId,
      upstream,
      clients: new Set(),
      pendingClientMessages: [],
      unregisterCleanup: () => {},
      closed: false,
      lastTabsMessage: null,
      lastFrameMessage: null,
      bootstrapPromise: null,
      nextInternalRpcId: -1,
      pendingInternalRpcCalls: new Map(),
      upstreamOpenPromise,
      resolveUpstreamOpen,
      rejectUpstreamOpen,
    }

    channel.unregisterCleanup = this.livePreviewService.registerPreviewCleanup(previewId, () => {
      this.disposePreviewChannel(previewId, 1000, 'Preview released')
    })
    this.channelsByPreviewId.set(previewId, channel)

    upstream.on('open', () => {
      if (channel.closed) {
        return
      }

      channel.resolveUpstreamOpen()

      if (channel.clients.size > 0) {
        this.livePreviewService.touchPreview(previewId)
      }

      for (const message of channel.pendingClientMessages.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary })
      }

      void this.ensureInitialTabsState(channel)
    })

    upstream.on('message', (data, isBinary) => {
      if (channel.closed) {
        return
      }

      if (this.tryResolveInternalRpcCall(channel, data, isBinary)) {
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
      channel.rejectUpstreamOpen(new Error(closeReason))
      this.rejectPendingInternalRpcCalls(channel, closeReason)

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

      const error = new Error('Upstream controller error')
      channel.rejectUpstreamOpen(error)
      this.rejectPendingInternalRpcCalls(channel, error.message)

      for (const client of Array.from(channel.clients)) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close(1011, error.message)
        }
      }

      this.disposePreviewChannel(previewId, 1011, error.message, { closeUpstream: false })
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

  private async ensureInitialTabsState(channel: PreviewUpstreamChannel): Promise<void> {
    if (channel.closed || channel.lastTabsMessage || channel.clients.size === 0) {
      return
    }

    if (channel.bootstrapPromise) {
      await channel.bootstrapPromise.catch(() => {})
      return
    }

    channel.bootstrapPromise = this.bootstrapTabsState(channel).finally(() => {
      channel.bootstrapPromise = null
    })
    await channel.bootstrapPromise.catch(() => {})
  }

  private async bootstrapTabsState(channel: PreviewUpstreamChannel): Promise<void> {
    try {
      await channel.upstreamOpenPromise
    } catch {
      return
    }

    if (channel.closed || channel.lastTabsMessage || channel.clients.size === 0) {
      return
    }

    const initialTabsResult = normalizeTabsResult(await this.callUpstream(channel, 'tabs'))
    if (!initialTabsResult || channel.closed || channel.lastTabsMessage) {
      return
    }

    let finalTabsResult = initialTabsResult
    const selectedTab = finalTabsResult.tabs.find((tab) => tab.selected)
    const firstTab = finalTabsResult.tabs[0]
    if (!selectedTab && firstTab?.pageId) {
      try {
        await this.callUpstream(channel, 'selectTab', { pageId: firstTab.pageId })
        const refreshedTabsResult = normalizeTabsResult(await this.callUpstream(channel, 'tabs'))
        finalTabsResult = refreshedTabsResult ?? forceSelectedTab(finalTabsResult, firstTab.pageId)
      } catch {
        finalTabsResult = forceSelectedTab(finalTabsResult, firstTab.pageId)
      }
    }

    if (channel.closed || channel.lastTabsMessage) {
      return
    }

    const syntheticTabsMessage = sanitizeUpstreamMessage(
      Buffer.from(JSON.stringify({ method: 'tabs', params: finalTabsResult })),
      false,
    )
    this.captureReplayMessage(channel, syntheticTabsMessage)
    this.broadcastToClients(channel, syntheticTabsMessage)
  }

  private async callUpstream(
    channel: PreviewUpstreamChannel,
    method: string,
    params: unknown = undefined,
  ): Promise<unknown> {
    if (channel.closed) {
      throw new Error('Preview channel closed')
    }

    await channel.upstreamOpenPromise

    if (channel.closed || channel.upstream.readyState !== WebSocket.OPEN) {
      throw new Error('Upstream controller is not open')
    }

    const id = channel.nextInternalRpcId
    channel.nextInternalRpcId -= 1
    const payload = JSON.stringify({ id, method, params })

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        channel.pendingInternalRpcCalls.delete(id)
        reject(new Error(`Timed out waiting for upstream ${method} response`))
      }, UPSTREAM_BOOTSTRAP_TIMEOUT_MS)
      timeout.unref?.()

      channel.pendingInternalRpcCalls.set(id, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
        timeout,
      })

      try {
        channel.upstream.send(payload)
      } catch (error) {
        channel.pendingInternalRpcCalls.delete(id)
        clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private tryResolveInternalRpcCall(channel: PreviewUpstreamChannel, data: RawData, isBinary: boolean): boolean {
    if (isBinary) {
      return false
    }

    const payload = parseJsonMessage(data)
    if (!payload || typeof payload.id !== 'number') {
      return false
    }

    const pending = channel.pendingInternalRpcCalls.get(payload.id)
    if (!pending) {
      return false
    }

    channel.pendingInternalRpcCalls.delete(payload.id)
    if ('error' in payload && payload.error !== undefined && payload.error !== null) {
      const errorMessage =
        typeof payload.error === 'string'
          ? payload.error
          : typeof payload.error === 'object' && payload.error && 'message' in payload.error && typeof payload.error.message === 'string'
            ? payload.error.message
            : `Upstream ${'method' in payload && typeof payload.method === 'string' ? payload.method : 'controller'} request failed`
      pending.reject(new Error(errorMessage))
      return true
    }

    pending.resolve(payload.result)
    return true
  }

  private rejectPendingInternalRpcCalls(channel: PreviewUpstreamChannel, reason: string): void {
    for (const [id, pending] of channel.pendingInternalRpcCalls.entries()) {
      channel.pendingInternalRpcCalls.delete(id)
      clearTimeout(pending.timeout)
      pending.reject(new Error(reason))
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
    this.rejectPendingInternalRpcCalls(channel, reason)

    for (const client of Array.from(channel.clients)) {
      closeSocket(client, code, reason)
    }
    channel.clients.clear()

    if (options.closeUpstream !== false) {
      closeSocket(channel.upstream, code, reason)
    }
  }
}

function parseJsonMessage(data: RawData): Record<string, unknown> | null {
  const text = typeof data === 'string' ? data : data.toString()
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function normalizeTabsResult(result: unknown): { tabs: Array<Record<string, unknown> & { pageId?: string; selected?: boolean }> } | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null
  }

  const tabs = (result as { tabs?: unknown }).tabs
  if (!Array.isArray(tabs)) {
    return null
  }

  return {
    ...(result as Record<string, unknown>),
    tabs: tabs
      .filter((tab): tab is Record<string, unknown> => Boolean(tab) && typeof tab === 'object' && !Array.isArray(tab))
      .map((tab) => ({ ...tab })),
  }
}

function forceSelectedTab(
  result: { tabs: Array<Record<string, unknown> & { pageId?: string; selected?: boolean }> },
  pageId: string,
): { tabs: Array<Record<string, unknown> & { pageId?: string; selected?: boolean }> } {
  return {
    ...result,
    tabs: result.tabs.map((tab) => ({
      ...tab,
      selected: tab.pageId === pageId,
    })),
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
