import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalDescriptor, TerminalIssueTicketResponse } from '@forge/protocol'
import { Skeleton } from '@/components/ui/skeleton'
import { TerminalOverlay } from '@/components/terminal/TerminalOverlay'
import { TerminalSelectionAction } from '@/components/terminal/TerminalSelectionAction'
import { TerminalWsClient, type TerminalWsState } from '@/lib/terminal-ws-client'

export interface TerminalSelectionContext {
  text: string
  terminalName: string
  lineRange: string
}

interface TerminalViewportProps {
  wsUrl: string
  terminal: TerminalDescriptor
  sessionAgentId: string
  onFocusChatInput: () => void
  onAddToChat?: (context: TerminalSelectionContext) => void
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

/** Measure a single character's dimensions using the terminal font. */
function measureCellDimensions(container: HTMLElement): { width: number; height: number } | null {
  const span = document.createElement('span')
  span.style.fontFamily = TERMINAL_FONT_FAMILY
  span.style.fontSize = '13px'
  span.style.position = 'absolute'
  span.style.visibility = 'hidden'
  span.style.whiteSpace = 'pre'
  span.textContent = 'W' // monospace — any char works
  container.appendChild(span)
  const rect = span.getBoundingClientRect()
  container.removeChild(span)
  if (rect.width === 0 || rect.height === 0) return null
  return { width: rect.width, height: rect.height }
}

export function TerminalViewport({
  wsUrl,
  terminal,
  sessionAgentId,
  onFocusChatInput,
  onAddToChat,
  issueTicket,
  initialTicket,
}: TerminalViewportProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const clientRef = useRef<TerminalWsClient | null>(null)
  const terminalInstanceRef = useRef<{ focus(): void } | null>(null)
  const terminalStateRef = useRef(terminal.state)
  const [connectionState, setConnectionState] = useState<TerminalWsState | 'loading'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showRestoredBanner, setShowRestoredBanner] = useState(terminal.recoveredFromPersistence)
  const [selectionButton, setSelectionButton] = useState<{ top: number; left: number } | null>(null)

  // Ref to the xterm Terminal instance for selection APIs
  const xtermRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const cellDimsRef = useRef<{ width: number; height: number } | null>(null)
  const selectionShowTimerRef = useRef<number>(0)

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

  const computeSelectionButtonPosition = useCallback(() => {
    const xterm = xtermRef.current
    const surface = surfaceRef.current
    const cellDims = cellDimsRef.current
    if (!xterm || !surface || !cellDims || !xterm.hasSelection()) {
      return null
    }
    const range = xterm.getSelectionPosition()
    if (!range) return null

    const viewportY = xterm.buffer.active.viewportY
    // xterm's IBufferCellPosition documents x/y as 1-based
    const endRowViewport = range.end.y - 1 - viewportY

    // Selection is off-screen
    if (endRowViewport < 0 || endRowViewport >= xterm.rows) return null

    // Find the xterm viewport element inside the host to measure its offset
    const host = hostRef.current
    if (!host) return null
    const xtermScreen = host.querySelector('.xterm-screen') as HTMLElement | null
    const offsetLeft = xtermScreen?.offsetLeft ?? 0
    const offsetTop = xtermScreen?.offsetTop ?? 0

    const pixelX = offsetLeft + (range.end.x - 1) * cellDims.width
    const pixelY = offsetTop + endRowViewport * cellDims.height

    // Position above-right of selection end, clamped to surface bounds
    const buttonWidth = 130 // approximate button width
    const buttonHeight = 28
    const surfaceRect = surface.getBoundingClientRect()
    let left = Math.min(pixelX + 8, surfaceRect.width - buttonWidth - 8)
    left = Math.max(4, left)
    const top = Math.max(4, pixelY - buttonHeight - 4)

    return { top, left }
  }, [])

  const updateSelectionButton = useCallback(() => {
    if (selectionShowTimerRef.current) {
      clearTimeout(selectionShowTimerRef.current)
      selectionShowTimerRef.current = 0
    }

    const xterm = xtermRef.current
    if (!xterm || !xterm.hasSelection() || !xterm.getSelection().trim()) {
      setSelectionButton(null)
      return
    }

    // Small delay to avoid flickering during click-drag
    selectionShowTimerRef.current = window.setTimeout(() => {
      selectionShowTimerRef.current = 0
      const pos = computeSelectionButtonPosition()
      setSelectionButton(pos)
    }, 150)
  }, [computeSelectionButtonPosition])

  const handleAddToChat = useCallback(() => {
    const xterm = xtermRef.current
    if (!xterm || !onAddToChat) return

    const text = xterm.getSelection()
    if (!text.trim()) return

    const range = xterm.getSelectionPosition()
    let lineRange = ''
    if (range) {
      // xterm's IBufferCellPosition is 1-based — use directly for display
      const startLine = range.start.y
      const endLine = range.end.y
      lineRange = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`
    }

    onAddToChat({
      text,
      terminalName: terminal.name || `Terminal ${terminal.terminalId.slice(-4)}`,
      lineRange,
    })

    xterm.clearSelection()
    setSelectionButton(null)
  }, [onAddToChat, terminal.name, terminal.terminalId])

  const focusTerminalInput = () => {
    terminalInstanceRef.current?.focus()
    hostRef.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()
  }

  useEffect(() => {
    let disposed = false
    let terminalInstance: import('@xterm/xterm').Terminal | null = null
    let fitAddon: (import('@xterm/xterm').ITerminalAddon & { fit(): void }) | null = null
    let resizeObserver: ResizeObserver | null = null
    let dataDisposable: { dispose(): void } | null = null
    let resizeDisposable: { dispose(): void } | null = null
    let webglAddon: import('@xterm/xterm').ITerminalAddon | null = null
    let resizeFrame = 0
    let selectionDisposable: { dispose(): void } | null = null
    let scrollDisposable: { dispose(): void } | null = null

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
        })
        terminalInstance = xterm
        terminalInstanceRef.current = xterm
        xtermRef.current = xterm

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

        // Measure cell dimensions for selection button positioning
        cellDimsRef.current = measureCellDimensions(host)

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

        // Selection change detection
        selectionDisposable = xterm.onSelectionChange(() => {
          updateSelectionButton()
        })

        // Hide/recompute button on scroll
        scrollDisposable = xterm.onScroll(() => {
          if (xtermRef.current?.hasSelection()) {
            const pos = computeSelectionButtonPosition()
            setSelectionButton(pos)
          } else {
            setSelectionButton(null)
          }
        })

        resizeObserver = new ResizeObserver(() => {
          if (resizeFrame) {
            cancelAnimationFrame(resizeFrame)
          }
          resizeFrame = requestAnimationFrame(() => {
            resizeFrame = 0
            runFit()
            // Remeasure cells and recompute selection button after resize
            if (hostRef.current) {
              cellDimsRef.current = measureCellDimensions(hostRef.current)
            }
            if (xtermRef.current?.hasSelection()) {
              const pos = computeSelectionButtonPosition()
              setSelectionButton(pos)
            }
          })
        })
        resizeObserver.observe(host)

        requestAnimationFrame(() => {
          runFit()
          focusTerminalInput()
          // Re-measure after fit
          cellDimsRef.current = measureCellDimensions(host)
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
      if (selectionShowTimerRef.current) {
        clearTimeout(selectionShowTimerRef.current)
        selectionShowTimerRef.current = 0
      }
      if (resizeFrame) {
        cancelAnimationFrame(resizeFrame)
      }
      selectionDisposable?.dispose()
      scrollDisposable?.dispose()
      resizeObserver?.disconnect()
      resizeDisposable?.dispose()
      dataDisposable?.dispose()
      webglAddon?.dispose()
      clientRef.current?.destroy()
      clientRef.current = null
      terminalInstanceRef.current = null
      xtermRef.current = null
      terminalInstance?.dispose()
    }
  }, [initialTicket, issueTicket, onFocusChatInput, sessionAgentId, terminal.terminalId, wsUrl, updateSelectionButton, computeSelectionButtonPosition])

  return (
    <div ref={surfaceRef} className="forge-terminal-surface relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#141726] p-1">
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

      {selectionButton && onAddToChat ? (
        <TerminalSelectionAction
          top={selectionButton.top}
          left={selectionButton.left}
          onAddToChat={handleAddToChat}
        />
      ) : null}

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
