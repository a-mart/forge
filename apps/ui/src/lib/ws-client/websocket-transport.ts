// ---------------------------------------------------------------------------
// WebSocketTransport — thin, generic WebSocket connection manager
//
// Owns ONLY:
//   • Socket lifecycle (open / close)
//   • Reconnect with configurable delay
//   • Optional heartbeat via periodic ping command
//   • JSON parse / send / error plumbing
//   • Connection-state tracking
//   • Callbacks: onOpen, onClose, onMessage(parsed), onError
//
// Does NOT contain domain behaviour (request tracking, reducers, subscriptions).
// Both Builder (ManagerWsClient) and Collab (CollabWsClient) use this transport.
// ---------------------------------------------------------------------------

export interface WebSocketTransportOptions {
  /** WebSocket URL (ws:// or wss://) */
  url: string

  /**
   * If set, sends a `{ type: "ping" }` JSON message at this interval (ms)
   * while connected.  Set to 0 or omit to disable heartbeat.
   */
  heartbeatIntervalMs?: number

  /** Base delay before reconnect (ms). Default: 1 200 ms. */
  reconnectDelayMs?: number

  // --- callbacks ---
  onOpen?: () => void
  onClose?: (event: CloseEvent) => void
  onMessage?: (data: unknown) => void
  onError?: (error: Event) => void
}

export class WebSocketTransport {
  // --- configuration (immutable after construction) ---
  private readonly url: string
  private readonly heartbeatIntervalMs: number
  private readonly reconnectDelayMs: number
  private readonly onOpen?: () => void
  private readonly onCloseCallback?: (event: CloseEvent) => void
  private readonly onMessage?: (data: unknown) => void
  private readonly onErrorCallback?: (error: Event) => void

  // --- state ---
  private socket: WebSocket | null = null
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private started = false
  private destroyed = false

  constructor(options: WebSocketTransportOptions) {
    this.url = options.url
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_200
    this.onOpen = options.onOpen
    this.onCloseCallback = options.onClose
    this.onMessage = options.onMessage
    this.onErrorCallback = options.onError
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Begin the connection cycle.  Safe to call multiple times — subsequent
   * calls are no-ops until {@link disconnect} is called.
   */
  connect(delayMs?: number): void {
    if (this.started || this.destroyed) return

    this.started = true
    this.scheduleConnect(delayMs ?? 0)
  }

  /**
   * Permanently tear down the transport. After this call the instance is
   * unusable — create a new one if you need to reconnect.
   */
  disconnect(): void {
    this.destroyed = true
    this.started = false
    this.stopHeartbeat()

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }

    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
  }

  /**
   * JSON-serialise `data` and send it over the socket.
   * Returns `false` if the socket is not open.
   */
  send(data: unknown): boolean {
    if (!this.isConnected()) return false

    try {
      this.socket!.send(JSON.stringify(data))
      return true
    } catch {
      return false
    }
  }

  /** True when the underlying WebSocket is in the OPEN state. */
  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN
  }

  /** Expose the raw socket for callers that need readyState checks, etc. */
  getSocket(): WebSocket | null {
    return this.socket
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private scheduleConnect(delayMs: number): void {
    if (this.destroyed || !this.started || this.connectTimer) return

    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined
      if (!this.destroyed && this.started) {
        this.doConnect()
      }
    }, delayMs)
  }

  private doConnect(): void {
    if (this.destroyed) return

    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.addEventListener('open', () => {
      this.startHeartbeat()
      this.onOpen?.()
    })

    socket.addEventListener('message', (event) => {
      this.handleRawMessage(event.data)
    })

    socket.addEventListener('close', (event) => {
      this.stopHeartbeat()
      this.onCloseCallback?.(event as CloseEvent)
      this.scheduleConnect(this.reconnectDelayMs)
    })

    socket.addEventListener('error', (event) => {
      this.onErrorCallback?.(event)
    })
  }

  private handleRawMessage(raw: unknown): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      // Silently ignore non-JSON frames — callers can add logging in onError
      return
    }
    this.onMessage?.(parsed)
  }

  // --- heartbeat ---

  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0) return

    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' })
    }, this.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }
}
