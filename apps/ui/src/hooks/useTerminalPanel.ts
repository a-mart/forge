import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TerminalCreateResponse,
  TerminalDescriptor,
  TerminalIssueTicketResponse,
} from '@forge/protocol'
import '@/lib/electron-bridge'
import {
  closeTerminal as closeTerminalRequest,
  createTerminal as createTerminalRequest,
  issueTerminalTicket,
  renameTerminal as renameTerminalRequest,
} from '@/lib/terminal-api'

const PANEL_HEIGHT_STORAGE_KEY = 'forge-terminal-panel-height'
const DEFAULT_PANEL_HEIGHT = 250
const MIN_PANEL_HEIGHT = 120
const TABS_ONLY_HEIGHT = 36
const MOBILE_MEDIA_QUERY = '(max-width: 767px)'
const MAX_TERMINALS_PER_MANAGER = 10

/**
 * Panel modes:
 * - `hidden`   — panel not rendered at all
 * - `tabs-only` — compact tab strip visible, no viewport
 * - `open`     — tab strip + terminal viewport (~250px)
 * - `maximized` — full-height terminal viewport
 */
export type TerminalPanelMode = 'hidden' | 'tabs-only' | 'open' | 'maximized'

export interface TerminalTicketCacheEntry {
  ticket: string
  ticketExpiresAt: string
}

interface UseTerminalPanelOptions {
  wsUrl: string
  sessionAgentId: string | null
  sessionCwd?: string | null
  terminals: TerminalDescriptor[]
  enabled?: boolean
  onError?: (message: string) => void
}

interface UseTerminalPanelResult {
  panelMode: TerminalPanelMode
  activeTerminalId: string | null
  panelHeight: number
  isMobile: boolean
  initialTickets: Record<string, TerminalTicketCacheEntry>
  editingTerminalId: string | null
  renameDraft: string
  maxTerminalsPerManager: number
  isPanelVisible: boolean
  activeTerminal: TerminalDescriptor | null
  setPanelHeight: (height: number) => void
  setActiveTerminalId: (terminalId: string) => void
  togglePanel: () => void
  hidePanel: () => void
  collapsePanel: () => void
  expandPanel: () => void
  maximizePanel: () => void
  restorePanel: () => void
  selectPreviousTerminal: () => void
  selectNextTerminal: () => void
  createTerminal: () => Promise<TerminalCreateResponse | null>
  closeTerminal: (terminalId: string) => Promise<void>
  startRenameTerminal: (terminalId: string) => void
  setRenameDraft: (value: string) => void
  commitRenameTerminal: () => Promise<void>
  cancelRenameTerminal: () => void
  issueTicket: (terminalId: string, sessionAgentId: string) => Promise<TerminalIssueTicketResponse>
}

function clampPanelHeight(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PANEL_HEIGHT
  }

  // Cap at 90vh to prevent terminal from filling entire screen
  const maxHeight = typeof window !== 'undefined' ? Math.floor(window.innerHeight * 0.9) : 800
  return Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, Math.round(value)))
}

function loadStoredPanelHeight(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_PANEL_HEIGHT
  }

  try {
    const stored = window.localStorage.getItem(PANEL_HEIGHT_STORAGE_KEY)
    if (!stored) {
      return DEFAULT_PANEL_HEIGHT
    }

    return clampPanelHeight(Number.parseInt(stored, 10))
  } catch {
    return DEFAULT_PANEL_HEIGHT
  }
}

function persistPanelHeight(height: number): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(PANEL_HEIGHT_STORAGE_KEY, String(clampPanelHeight(height)))
  } catch {
    // Ignore localStorage failures.
  }
}

function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    return window.matchMedia(MOBILE_MEDIA_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY)
    const update = () => setIsMobile(mediaQuery.matches)
    update()
    mediaQuery.addEventListener('change', update)
    return () => mediaQuery.removeEventListener('change', update)
  }, [])

  return isMobile
}

export function useTerminalPanel({
  wsUrl,
  sessionAgentId,
  sessionCwd,
  terminals,
  enabled = true,
  onError,
}: UseTerminalPanelOptions): UseTerminalPanelResult {
  const isMobile = useIsMobileViewport()
  const [panelMode, setPanelMode] = useState<TerminalPanelMode>('hidden')
  const [panelHeight, setPanelHeightState] = useState<number>(loadStoredPanelHeight)
  const [activeTerminalId, setActiveTerminalIdState] = useState<string | null>(null)
  const [initialTickets, setInitialTickets] = useState<Record<string, TerminalTicketCacheEntry>>({})
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null)
  const [renameDraft, setRenameDraftState] = useState('')
  const autoHiddenRef = useRef(false)
  const previousSessionIdRef = useRef<string | null>(sessionAgentId)

  const activeTerminal = useMemo(
    () => terminals.find((terminal) => terminal.terminalId === activeTerminalId) ?? null,
    [activeTerminalId, terminals],
  )

  const setPanelHeight = useCallback((height: number) => {
    const nextHeight = clampPanelHeight(height)
    setPanelHeightState(nextHeight)
    persistPanelHeight(nextHeight)
  }, [])

  // Click a terminal tab: toggle open/tabs-only, or switch terminal
  const setActiveTerminalId = useCallback((terminalId: string) => {
    if (panelMode === 'hidden') {
      // From hidden, open the panel with this terminal
      setActiveTerminalIdState(terminalId)
      setPanelMode('open')
    } else if (panelMode === 'tabs-only') {
      // From tabs-only, open viewport for the clicked terminal
      setActiveTerminalIdState(terminalId)
      setPanelMode('open')
    } else if ((panelMode === 'open' || panelMode === 'maximized') && activeTerminalId === terminalId) {
      // Clicking the active tab collapses to tabs-only
      setPanelMode('tabs-only')
    } else {
      // Clicking a different tab — just switch
      setActiveTerminalIdState(terminalId)
    }
  }, [panelMode, activeTerminalId])

  const hidePanel = useCallback(() => {
    autoHiddenRef.current = false
    setPanelMode('hidden')
  }, [])

  const collapsePanel = useCallback(() => {
    setPanelMode('tabs-only')
  }, [])

  const expandPanel = useCallback(() => {
    setPanelMode('open')
  }, [])

  const maximizePanel = useCallback(() => {
    setPanelMode('maximized')
  }, [])

  const restorePanel = useCallback(() => {
    setPanelMode('open')
  }, [])

  const handleError = useCallback((message: string) => {
    onError?.(message)
  }, [onError])

  const createTerminal = useCallback(async (): Promise<TerminalCreateResponse | null> => {
    if (!sessionAgentId) {
      handleError('Open a manager session before creating a terminal.')
      return null
    }

    if (terminals.length >= MAX_TERMINALS_PER_MANAGER) {
      handleError(`Maximum ${MAX_TERMINALS_PER_MANAGER} terminals per manager.`)
      return null
    }

    try {
      const response = await createTerminalRequest(wsUrl, {
        sessionAgentId,
        cwd: sessionCwd ?? undefined,
      })

      setInitialTickets((previous) => ({
        ...previous,
        [response.terminal.terminalId]: {
          ticket: response.ticket,
          ticketExpiresAt: response.ticketExpiresAt,
        },
      }))
      setActiveTerminalIdState(response.terminal.terminalId)
      setPanelMode('open')
      return response
    } catch (error) {
      handleError(error instanceof Error ? error.message : 'Failed to create terminal.')
      return null
    }
  }, [handleError, sessionAgentId, sessionCwd, terminals.length, wsUrl])

  const closeTerminal = useCallback(async (terminalId: string): Promise<void> => {
    if (!sessionAgentId) {
      return
    }

    try {
      await closeTerminalRequest(wsUrl, terminalId, { sessionAgentId })
      setInitialTickets((previous) => {
        if (!(terminalId in previous)) {
          return previous
        }
        const next = { ...previous }
        delete next[terminalId]
        return next
      })
      if (activeTerminalId === terminalId) {
        const remaining = terminals.filter((terminal) => terminal.terminalId !== terminalId)
        setActiveTerminalIdState(remaining[0]?.terminalId ?? null)
      }
    } catch (error) {
      handleError(error instanceof Error ? error.message : 'Failed to close terminal.')
    }
  }, [activeTerminalId, handleError, sessionAgentId, terminals, wsUrl])

  const startRenameTerminal = useCallback((terminalId: string) => {
    const terminal = terminals.find((entry) => entry.terminalId === terminalId)
    if (!terminal) {
      return
    }

    setEditingTerminalId(terminalId)
    setRenameDraftState(terminal.name)
  }, [terminals])

  const cancelRenameTerminal = useCallback(() => {
    setEditingTerminalId(null)
    setRenameDraftState('')
  }, [])

  const commitRenameTerminal = useCallback(async (): Promise<void> => {
    if (!editingTerminalId || !sessionAgentId) {
      return
    }

    const nextName = renameDraft.trim()
    if (!nextName) {
      cancelRenameTerminal()
      return
    }

    try {
      await renameTerminalRequest(wsUrl, editingTerminalId, {
        sessionAgentId,
        name: nextName,
      })
      cancelRenameTerminal()
    } catch (error) {
      handleError(error instanceof Error ? error.message : 'Failed to rename terminal.')
    }
  }, [cancelRenameTerminal, editingTerminalId, handleError, renameDraft, sessionAgentId, wsUrl])

  const togglePanel = useCallback(() => {
    if (panelMode === 'hidden') {
      if (terminals.length === 0) {
        void createTerminal()
        return
      }

      // Show tab strip (tabs-only), not fully open
      setPanelMode('tabs-only')
      return
    }

    autoHiddenRef.current = false
    setPanelMode('hidden')
  }, [createTerminal, panelMode, terminals.length])

  const selectTerminalRelative = useCallback((direction: 1 | -1) => {
    if (terminals.length === 0) {
      return
    }

    const currentIndex = activeTerminalId
      ? terminals.findIndex((terminal) => terminal.terminalId === activeTerminalId)
      : -1
    const nextIndex = currentIndex >= 0
      ? (currentIndex + direction + terminals.length) % terminals.length
      : 0

    const nextTerminal = terminals[nextIndex]
    if (!nextTerminal) {
      return
    }

    setActiveTerminalIdState(nextTerminal.terminalId)
    if (panelMode === 'hidden') {
      setPanelMode('open')
    } else if (panelMode === 'tabs-only') {
      setPanelMode('open')
    }
  }, [activeTerminalId, panelMode, terminals])

  const selectPreviousTerminal = useCallback(() => {
    selectTerminalRelative(-1)
  }, [selectTerminalRelative])

  const selectNextTerminal = useCallback(() => {
    selectTerminalRelative(1)
  }, [selectTerminalRelative])

  // Session change — reset ephemeral state
  useEffect(() => {
    if (previousSessionIdRef.current !== sessionAgentId) {
      previousSessionIdRef.current = sessionAgentId
      setInitialTickets({})
      setEditingTerminalId(null)
      setRenameDraftState('')
    }
  }, [sessionAgentId])

  // Auto-show/hide based on terminal list
  useEffect(() => {
    if (terminals.length === 0) {
      autoHiddenRef.current = true
      setActiveTerminalIdState(null)
      setPanelMode('hidden')
      return
    }

    // If we auto-hid because terminals disappeared and now they're back, show tabs-only
    if (panelMode === 'hidden' && autoHiddenRef.current) {
      autoHiddenRef.current = false
      setPanelMode('tabs-only')
    }

    const hasActiveTerminal = activeTerminalId != null && terminals.some((terminal) => terminal.terminalId === activeTerminalId)
    if (!hasActiveTerminal) {
      setActiveTerminalIdState(terminals[0]?.terminalId ?? null)
    }
  }, [activeTerminalId, panelMode, terminals])

  // Prune stale ticket cache entries
  useEffect(() => {
    setInitialTickets((previous) => {
      if (Object.keys(previous).length === 0) {
        return previous
      }

      const validTerminalIds = new Set(terminals.map((terminal) => terminal.terminalId))
      const nextEntries = Object.entries(previous).filter(([terminalId]) => validTerminalIds.has(terminalId))
      if (nextEntries.length === Object.keys(previous).length) {
        return previous
      }

      return Object.fromEntries(nextEntries)
    })
  }, [terminals])

  // Keyboard shortcuts
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return undefined
    }

    const handler = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const isEditing = target
        ? target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
        : false
      const isTerminalInput = target?.closest('.forge-terminal-host, .xterm, .xterm-helper-textarea') != null

      if (isEditing && !isTerminalInput && event.code !== 'Escape') {
        return
      }

      if (event.code === 'Backquote' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (event.shiftKey) {
          void createTerminal()
        } else {
          togglePanel()
        }
        return
      }

      if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey) {
        if (event.code === 'BracketLeft') {
          event.preventDefault()
          selectPreviousTerminal()
          return
        }

        if (event.code === 'BracketRight') {
          event.preventDefault()
          selectNextTerminal()
        }
      }
    }

    window.addEventListener('keydown', handler)
    const unsubscribeElectron = window.electronBridge?.onTerminalShortcut?.((shortcut) => {
      switch (shortcut.action) {
        case 'toggle':
          togglePanel()
          break
        case 'new':
          void createTerminal()
          break
        case 'prev':
          selectPreviousTerminal()
          break
        case 'next':
          selectNextTerminal()
          break
      }
    })

    return () => {
      window.removeEventListener('keydown', handler)
      unsubscribeElectron?.()
    }
  }, [createTerminal, enabled, selectNextTerminal, selectPreviousTerminal, togglePanel])

  const issueTicket = useCallback((terminalId: string, requestSessionAgentId: string) => {
    return issueTerminalTicket(wsUrl, terminalId, { sessionAgentId: requestSessionAgentId })
  }, [wsUrl])

  return {
    panelMode,
    activeTerminalId,
    panelHeight: panelMode === 'tabs-only' ? TABS_ONLY_HEIGHT : panelHeight,
    isMobile,
    initialTickets,
    editingTerminalId,
    renameDraft,
    maxTerminalsPerManager: MAX_TERMINALS_PER_MANAGER,
    isPanelVisible: panelMode !== 'hidden',
    activeTerminal,
    setPanelHeight,
    setActiveTerminalId,
    togglePanel,
    hidePanel,
    collapsePanel,
    expandPanel,
    maximizePanel,
    restorePanel,
    selectPreviousTerminal,
    selectNextTerminal,
    createTerminal,
    closeTerminal,
    startRenameTerminal,
    setRenameDraft: setRenameDraftState,
    commitRenameTerminal,
    cancelRenameTerminal,
    issueTicket,
  }
}
