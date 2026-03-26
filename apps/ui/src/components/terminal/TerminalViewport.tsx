import { useEffect, useRef, useState } from 'react'
import type { TerminalDescriptor, TerminalIssueTicketResponse } from '@forge/protocol'
import { Skeleton } from '@/components/ui/skeleton'
import { TerminalOverlay } from '@/components/terminal/TerminalOverlay'
import { TerminalWsClient, type TerminalWsState } from '@/lib/terminal-ws-client'

interface TerminalViewportProps {
  wsUrl: string
  terminal: TerminalDescriptor
  sessionAgentId: string
  onFocusChatInput: () => void
  issueTicket: (terminalId: string, sessionAgentId: string) => Promise<TerminalIssueTicketResponse>
  initialTicket?: { ticket: string; ticketExpiresAt: string }
}

const TERMINAL_FONT_FAMILY = 'Geist Mono, SFMono-Regular, SF Mono, Menlo, Monaco, Cascadia Code, Fira Code, JetBrains Mono, Consolas, monospace'
const TERMINAL_THEME = {
  background: '#141726',
  foreground: '#edf2ff',
  cursor: '#ffffff',
  cursorAccent: '#141726',
  selectionBackground: 'rgba(96, 165, 250, 0.28)',
  black: '#111827',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#fb7185',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f9fafb',
} as const

export function TerminalViewport({
  wsUrl,
  terminal,
  sessionAgentId,
  onFocusChatInput,
  issueTicket,
  initialTicket,
}: TerminalViewportProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const clientRef = useRef<TerminalWsClient | null>(null)
  const terminalInstanceRef = useRef<{ focus(): void } | null>(null)
  const terminalStateRef = useRef(terminal.state)
  const [connectionState, setConnectionState] = useState<TerminalWsState | 'loading'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showRestoredBanner, setShowRestoredBanner] = useState(terminal.recoveredFromPersistence)

  useEffect(() => {
    terminalStateRef.current = terminal.state
  }, [terminal.state])

  useEffect(() => {
    setShowRestoredBanner(terminal.recoveredFromPersistence)
    if (!terminal.recoveredFromPersistence) {
      return undefined
    }

    const timer = window.setTimeout(() => {
      setShowRestoredBanner(false)
    }, 5_000)

    return () => window.clearTimeout(timer)
  }, [terminal.recoveredFromPersistence, terminal.terminalId])

  const focusTerminalInput = () => {
    terminalInstanceRef.current?.focus()
    hostRef.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()
  }

  useEffect(() => {
    let disposed = false
    let terminalInstance: {
      open(node: HTMLElement): void
      focus(): void
      write(data: string): void
      dispose(): void
      loadAddon(addon: unknown): void
      attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
      onData(listener: (data: string) => void): { dispose(): void }
      onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void }
      cols: number
      rows: number
      element?: HTMLElement
    } | null = null
    let fitAddon: { fit(): void } | null = null
    let resizeObserver: ResizeObserver | null = null
    let dataDisposable: { dispose(): void } | null = null
    let resizeDisposable: { dispose(): void } | null = null
    let webglAddon: { dispose(): void } | null = null
    let resizeFrame = 0

    const boot = async () => {
      const host = hostRef.current
      if (!host) {
        return
      }

      setConnectionState('loading')
      setLoadError(null)

      try {
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
        ])

        if (disposed) {
          return
        }

        fitAddon = new FitAddon()
        const xterm = new Terminal({
          cursorBlink: true,
          cursorStyle: 'block',
          fontSize: 13,
          fontFamily: TERMINAL_FONT_FAMILY,
          theme: TERMINAL_THEME,
          scrollback: 5_000,
        }) as NonNullable<typeof terminalInstance>
        terminalInstance = xterm
        terminalInstanceRef.current = xterm

        xterm.loadAddon(fitAddon)
        xterm.loadAddon(new WebLinksAddon())

        try {
          const { WebglAddon } = await import('@xterm/addon-webgl')
          if (!disposed && terminalInstance) {
            webglAddon = new WebglAddon()
            terminalInstance.loadAddon(webglAddon)
          }
        } catch {
          // WebGL is optional; xterm falls back to the default renderer.
        }

        if (disposed || !terminalInstance) {
          return
        }

        terminalInstance.open(host)
        terminalInstance.attachCustomKeyEventHandler((event) => {
          if (
            event.type === 'keydown' &&
            event.key === 'Escape' &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
          ) {
            event.preventDefault()
            onFocusChatInput()
            return false
          }

          return true
        })

        clientRef.current = new TerminalWsClient({
          wsUrl,
          terminalId: terminal.terminalId,
          sessionAgentId,
          ticketProvider: {
            getTicket: ({ terminalId, sessionAgentId }) => issueTicket(terminalId, sessionAgentId),
          },
          initialTicket,
        })

        clientRef.current.onOutput = (chunk) => {
          terminalInstance?.write(chunk)
        }
        clientRef.current.onStateChange = (nextState) => {
          setConnectionState(nextState)
        }
        clientRef.current.onError = (_code, message) => {
          setLoadError(message)
        }

        dataDisposable = terminalInstance.onData((data) => {
          if (terminalStateRef.current !== 'running') {
            return
          }
          clientRef.current?.sendInput(data)
        })

        resizeDisposable = terminalInstance.onResize(({ cols, rows }) => {
          clientRef.current?.sendResize(cols, rows)
        })

        const runFit = () => {
          if (!fitAddon || !terminalInstance || !hostRef.current) {
            return
          }

          fitAddon.fit()
          if (terminalInstance.cols > 0 && terminalInstance.rows > 0) {
            clientRef.current?.sendResize(terminalInstance.cols, terminalInstance.rows)
          }
        }

        resizeObserver = new ResizeObserver(() => {
          if (resizeFrame) {
            cancelAnimationFrame(resizeFrame)
          }
          resizeFrame = requestAnimationFrame(() => {
            resizeFrame = 0
            runFit()
          })
        })
        resizeObserver.observe(host)

        requestAnimationFrame(() => {
          runFit()
          focusTerminalInput()
        })

        await clientRef.current.connect()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to initialize terminal.'
        setConnectionState('failed')
        setLoadError(message)
      }
    }

    void boot()

    return () => {
      disposed = true
      if (resizeFrame) {
        cancelAnimationFrame(resizeFrame)
      }
      resizeObserver?.disconnect()
      resizeDisposable?.dispose()
      dataDisposable?.dispose()
      webglAddon?.dispose()
      clientRef.current?.destroy()
      clientRef.current = null
      terminalInstanceRef.current = null
      terminalInstance?.dispose()
    }
  }, [initialTicket, issueTicket, onFocusChatInput, sessionAgentId, terminal.terminalId, wsUrl])

  return (
    <div className="forge-terminal-surface relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#141726] p-1">
      <div
        ref={hostRef}
        className="forge-terminal-host min-h-0 flex-1 overflow-hidden"
        onMouseDown={() => {
          focusTerminalInput()
        }}
        onClick={() => {
          focusTerminalInput()
        }}
      />

      <TerminalOverlay
        terminal={terminal}
        connectionState={connectionState}
        errorMessage={loadError}
        onRetry={() => clientRef.current?.retryNow()}
        showRestoredBanner={showRestoredBanner}
      />

      {connectionState === 'loading' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#141726] px-4">
          <div className="w-full max-w-lg space-y-3">
            <Skeleton className="h-4 w-40 bg-white/10" />
            <Skeleton className="h-4 w-full bg-white/8" />
            <Skeleton className="h-4 w-[92%] bg-white/8" />
            <Skeleton className="h-4 w-[68%] bg-white/8" />
          </div>
        </div>
      ) : null}
    </div>
  )
}
