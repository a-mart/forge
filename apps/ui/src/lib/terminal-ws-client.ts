import type {
  TerminalCloseReason,
  TerminalIssueTicketResponse,
  TerminalWsClientControlMessage,
  TerminalWsServerControlMessage,
} from '@forge/protocol'

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const
const PING_INTERVAL_MS = 20_000

export type TerminalWsState = 'connecting' | 'connected' | 'disconnected' | 'failed'

export interface TerminalTicketProvider {
  getTicket(input: { terminalId: string; sessionAgentId: string }): Promise<TerminalIssueTicketResponse>
}

function isTicketExpired(ticketExpiresAt: string, skewMs = 5_000): boolean {
  const expiresAt = Date.parse(ticketExpiresAt)
  if (!Number.isFinite(expiresAt)) {
    return true
  }

  return expiresAt <= Date.now() + skewMs
}

function buildTerminalWsUrl(input: {
  wsUrl: string
  terminalId: string
  sessionAgentId: string
  ticket: string
}): string {
  const base = new URL(input.wsUrl)
  const url = new URL(`/terminal/ws/${encodeURIComponent(input.terminalId)}`, base)
  url.searchParams.set('sessionAgentId', input.sessionAgentId)
  url.searchParams.set('ticket', input.ticket)
  return url.toString()
}

async function parseServerControlMessage(raw: string): Promise<TerminalWsServerControlMessage> {
  const parsed = JSON.parse(raw) as TerminalWsServerControlMessage
  if (!parsed || typeof parsed !== 'object' || !('channel' in parsed) || parsed.channel !== 'control') {
    throw new Error('Received invalid terminal control message from backend.')
  }
  return parsed
}

export class TerminalWsClient {
  private readonly wsUrl: string
  private readonly terminalId: string
  private readonly sessionAgentId: string
  private readonly ticketProvider: TerminalTicketProvider

  private socket: WebSocket | null = null
  private destroyed = false
  private connectionAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private connectPromise: Promise<void> | null = null
  private resolveConnectPromise: (() => void) | null = null
  private rejectConnectPromise: ((error: Error) => void) | null = null
  private initialTicket?: { ticket: string; ticketExpiresAt: string }
  private shouldReconnect = true
  private hasReachedReady = false
  private state: TerminalWsState = 'disconnected'

  onOutput: ((chunk: string) => void) | null = null
  onStateChange: ((state: TerminalWsState) => void) | null = null
  onReady: (() => void) | null = null
  onExit: ((exitCode: number | null, exitSignal: number | null) => void) | null = null
  onClosed: ((reason: TerminalCloseReason) => void) | null = null
  onError: ((code: string, message: string) => void) | null = null

  constructor(options: {
    wsUrl: string
    terminalId: string
    sessionAgentId: string
    ticketProvider: TerminalTicketProvider
    initialTicket?: { ticket: string; ticketExpiresAt: string }
  }) {
    this.wsUrl = options.wsUrl
    this.terminalId = options.terminalId
    this.sessionAgentId = options.sessionAgentId
    this.ticketProvider = options.ticketProvider
    this.initialTicket = options.initialTicket
  }

  connect(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('Terminal connection has been destroyed.'))
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    this.shouldReconnect = true
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnectPromise = resolve
      this.rejectConnectPromise = reject
    })

    void this.openSocket({ isReconnect: false })
    return this.connectPromise
  }

  sendInput(data: string): void {
    if (!data || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.socket.send(new TextEncoder().encode(data))
  }

  sendResize(cols: number, rows: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.sendControl({ channel: 'control', type: 'resize', cols, rows })
  }

  isConnected(): boolean {
    return this.state === 'connected' && this.socket?.readyState === WebSocket.OPEN
  }

  retryNow(): void {
    if (this.destroyed) {
      return
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return
    }

    this.connectionAttempt = 0
    this.hasReachedReady = false
    this.shouldReconnect = true
    this.setState('connecting')
    void this.openSocket({ isReconnect: true })
  }

  destroy(): void {
    this.destroyed = true
    this.shouldReconnect = false
    this.clearReconnectTimer()
    this.clearPingTimer()
    this.cleanupSocket()
    this.rejectPendingConnect(new Error('Terminal connection destroyed.'))
  }

  private async openSocket(options: { isReconnect: boolean }): Promise<void> {
    if (this.destroyed) {
      return
    }

    this.cleanupSocket()
    this.clearPingTimer()
    this.setState(options.isReconnect ? 'disconnected' : 'connecting')
    this.hasReachedReady = false

    try {
      const ticket = await this.getConnectTicket(options.isReconnect)
      if (this.destroyed) {
        return
      }

      const socket = new WebSocket(
        buildTerminalWsUrl({
          wsUrl: this.wsUrl,
          terminalId: this.terminalId,
          sessionAgentId: this.sessionAgentId,
          ticket: ticket.ticket,
        }),
      )
      socket.binaryType = 'arraybuffer'
      this.socket = socket

      socket.addEventListener('open', () => {
        if (this.socket !== socket) {
          return
        }
        this.startPingLoop()
      })

      socket.addEventListener('message', (event) => {
        if (this.socket !== socket) {
          return
        }
        void this.handleMessage(event.data).catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to process terminal data.'
          this.onError?.('INVALID_FRAME', message)
        })
      })

      socket.addEventListener('error', () => {
        if (this.socket !== socket) {
          return
        }
        if (!this.hasReachedReady) {
          this.rejectPendingConnect(new Error('Failed to connect to terminal.'))
        }
      })

      socket.addEventListener('close', (event) => {
        if (this.socket !== socket) {
          return
        }

        this.clearPingTimer()
        this.socket = null

        if (this.destroyed) {
          return
        }

        if (event.code !== 1000 && !this.hasReachedReady) {
          this.rejectPendingConnect(new Error('Terminal connection closed before becoming ready.'))
        }

        if (!this.shouldReconnect) {
          if (!this.hasReachedReady) {
            this.setState('failed')
          }
          return
        }

        this.scheduleReconnect()
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect to terminal.'
      if (!options.isReconnect) {
        this.rejectPendingConnect(new Error(message))
      }
      this.onError?.('CONNECT_FAILED', message)
      this.scheduleReconnect()
    }
  }

  private async handleMessage(data: string | ArrayBuffer | Blob): Promise<void> {
    if (typeof data === 'string') {
      const control = await parseServerControlMessage(data)
      this.handleControlMessage(control)
      return
    }

    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer()
      this.handleOutputChunk(buffer)
      return
    }

    this.handleOutputChunk(data)
  }

  private handleOutputChunk(raw: ArrayBuffer): void {
    const text = new TextDecoder().decode(raw)
    if (text.length > 0) {
      this.onOutput?.(text)
    }
  }

  private handleControlMessage(message: TerminalWsServerControlMessage): void {
    switch (message.type) {
      case 'ready':
        this.connectionAttempt = 0
        this.hasReachedReady = true
        this.setState('connected')
        this.resolvePendingConnect()
        this.onReady?.()
        return

      case 'pong':
        return

      case 'exit':
        this.onExit?.(message.exitCode, message.exitSignal)
        return

      case 'closed':
        this.shouldReconnect = false
        this.onClosed?.(message.reason)
        this.cleanupSocket()
        this.setState('disconnected')
        return

      case 'error':
        this.onError?.(message.code, message.message)
        if (!this.hasReachedReady) {
          this.rejectPendingConnect(new Error(message.message))
        }
        return
    }
  }

  private async getConnectTicket(isReconnect: boolean): Promise<TerminalIssueTicketResponse> {
    const canUseInitialTicket = !isReconnect && this.initialTicket && !isTicketExpired(this.initialTicket.ticketExpiresAt)
    if (canUseInitialTicket && this.initialTicket) {
      const ticket = this.initialTicket
      this.initialTicket = undefined
      return ticket
    }

    return this.ticketProvider.getTicket({
      terminalId: this.terminalId,
      sessionAgentId: this.sessionAgentId,
    })
  }

  private scheduleReconnect(): void {
    if (this.destroyed || !this.shouldReconnect) {
      return
    }

    this.clearReconnectTimer()

    const delay = RECONNECT_DELAYS_MS[Math.min(this.connectionAttempt, RECONNECT_DELAYS_MS.length - 1)]
    if (this.connectionAttempt >= RECONNECT_DELAYS_MS.length) {
      this.setState('failed')
      return
    }

    this.connectionAttempt += 1
    this.setState('disconnected')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.openSocket({ isReconnect: true })
    }, delay)
  }

  private sendControl(message: TerminalWsClientControlMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.socket.send(JSON.stringify(message))
  }

  private startPingLoop(): void {
    this.clearPingTimer()
    this.pingTimer = setInterval(() => {
      this.sendControl({ channel: 'control', type: 'ping' })
    }, PING_INTERVAL_MS)
  }

  private cleanupSocket(): void {
    const socket = this.socket
    this.socket = null
    if (!socket) {
      return
    }

    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private setState(nextState: TerminalWsState): void {
    if (this.state === nextState) {
      return
    }

    this.state = nextState
    this.onStateChange?.(nextState)
  }

  private resolvePendingConnect(): void {
    this.resolveConnectPromise?.()
    this.connectPromise = null
    this.resolveConnectPromise = null
    this.rejectConnectPromise = null
  }

  private rejectPendingConnect(error: Error): void {
    this.rejectConnectPromise?.(error)
    this.connectPromise = null
    this.resolveConnectPromise = null
    this.rejectConnectPromise = null
  }
}
