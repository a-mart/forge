import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalDescriptor, TerminalIssueTicketResponse } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { TerminalTabBar } from '@/components/terminal/TerminalTabBar'
import { TerminalViewport, type TerminalSelectionContext } from '@/components/terminal/TerminalViewport'
import type { TerminalPanelMode } from '@/hooks/useTerminalPanel'
import { cn } from '@/lib/utils'

interface TerminalPanelProps {
  wsUrl: string
  sessionAgentId: string | null
  terminals: TerminalDescriptor[]
  panelMode: TerminalPanelMode
  activeTerminalId: string | null
  panelHeight: number
  isMobile: boolean
  maxTerminalsPerManager: number
  editingTerminalId: string | null
  renameDraft: string
  initialTickets: Record<string, { ticket: string; ticketExpiresAt: string }>
  onSelectTerminal: (terminalId: string) => void
  onCreateTerminal: () => void
  onCloseTerminal: (terminalId: string) => Promise<void>
  onStartRenameTerminal: (terminalId: string) => void
  onRenameDraftChange: (value: string) => void
  onCommitRenameTerminal: () => Promise<void>
  onCancelRenameTerminal: () => void
  onCollapsePanel: () => void
  onRestorePanel: () => void
  onMaximizePanel: () => void
  onHidePanel: () => void
  onPanelHeightChange: (height: number) => void
  onFocusChatInput: () => void
  onAddToChat?: (context: TerminalSelectionContext) => void
  issueTicket: (terminalId: string, sessionAgentId: string) => Promise<TerminalIssueTicketResponse>
}

const HANDLE_HEIGHT_PX = 6
const MIN_EXPANDED_HEIGHT_PX = 120

export function TerminalPanel({
  wsUrl,
  sessionAgentId,
  terminals,
  panelMode,
  activeTerminalId,
  panelHeight,
  isMobile,
  maxTerminalsPerManager,
  editingTerminalId,
  renameDraft,
  initialTickets,
  onSelectTerminal,
  onCreateTerminal,
  onCloseTerminal,
  onStartRenameTerminal,
  onRenameDraftChange,
  onCommitRenameTerminal,
  onCancelRenameTerminal,
  onCollapsePanel,
  onRestorePanel,
  onMaximizePanel,
  onHidePanel,
  onPanelHeightChange,
  onFocusChatInput,
  onAddToChat,
  issueTicket,
}: TerminalPanelProps) {
  const [isDragging, setIsDragging] = useState(false)
  const handleNodeRef = useRef<HTMLDivElement | null>(null)
  const startYRef = useRef(0)
  const startHeightRef = useRef(panelHeight)

  const activeTerminal = terminals.find((terminal) => terminal.terminalId === activeTerminalId) ?? terminals[0] ?? null
  const isViewportVisible = panelMode === 'open' || panelMode === 'maximized'
  const isMobileTabsOnly = isMobile && panelMode === 'tabs-only'

  // On Escape from the terminal viewport, collapse to tabs-only and focus chat
  const handleEscapeFromTerminal = useCallback(() => {
    onCollapsePanel()
    onFocusChatInput()
  }, [onCollapsePanel, onFocusChatInput])

  const beginResize = useCallback((event: PointerEvent) => {
    if (isMobile) {
      return
    }

    event.preventDefault()
    
    // Capture pointer to prevent flickering during fast drags
    const target = event.currentTarget as HTMLElement
    if (target && target.setPointerCapture) {
      target.setPointerCapture(event.pointerId)
    }

    startYRef.current = event.clientY
    startHeightRef.current = panelMode === 'maximized'
      ? Math.round(window.innerHeight * 0.7)
      : Math.max(panelHeight, MIN_EXPANDED_HEIGHT_PX)

    if (panelMode === 'maximized') {
      onRestorePanel()
    }

    setIsDragging(true)
  }, [isMobile, onRestorePanel, panelHeight, panelMode])

  useEffect(() => {
    const node = handleNodeRef.current
    if (!node) {
      return undefined
    }

    node.addEventListener('pointerdown', beginResize as (event: Event) => void)
    return () => {
      node.removeEventListener('pointerdown', beginResize as (event: Event) => void)
    }
  }, [beginResize])

  useEffect(() => {
    if (!isDragging || isMobile) {
      return undefined
    }

    const onPointerMove = (event: PointerEvent) => {
      const delta = startYRef.current - event.clientY
      // Use window.innerHeight instead of parent height to prevent feedback loop
      const maxHeight = Math.max(MIN_EXPANDED_HEIGHT_PX, Math.floor(window.innerHeight * 0.8))
      const proposedHeight = startHeightRef.current + delta

      if (proposedHeight <= MIN_EXPANDED_HEIGHT_PX - 30) {
        onCollapsePanel()
        return
      }

      if (proposedHeight >= maxHeight + 30) {
        onMaximizePanel()
        return
      }

      onRestorePanel()
      onPanelHeightChange(Math.min(maxHeight, Math.max(MIN_EXPANDED_HEIGHT_PX, proposedHeight)))
    }

    const onPointerUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'

    return () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isDragging, isMobile, onCollapsePanel, onMaximizePanel, onPanelHeightChange, onRestorePanel])

  if (!sessionAgentId || panelMode === 'hidden') {
    return null
  }

  // Compute the panel height based on mode
  const computedHeight = panelMode === 'tabs-only'
    ? 36 // Just the tab strip
    : panelMode === 'maximized'
      ? undefined // flex-1 takes over
      : Math.max(panelHeight, HANDLE_HEIGHT_PX + 36)

  const sheetContent = (
    <div
      className={cn(
        'forge-terminal-panel flex min-h-0 flex-col overflow-hidden',
        // Tabs-only: minimal rounded strip with subtle padding
        panelMode === 'tabs-only' && !isMobile && 'shrink-0 rounded-lg px-2',
        // Open: viewport with subtle border and rounded corners
        panelMode === 'open' && !isMobile && 'shrink-0 rounded-lg border border-border/40 bg-card/40 shadow-lg',
        // Maximized: full height
        panelMode === 'maximized' && !isMobile && 'min-h-0 flex-1 border-t bg-card/40 shadow-2xl',
        // Mobile
        isMobileTabsOnly && 'h-9 rounded-t-2xl border',
        isMobile && !isMobileTabsOnly && 'h-[60vh] rounded-t-2xl border border-b-0',
        // Smooth transitions
        !isDragging && !isMobile && 'transition-[height,opacity] duration-200 ease-out',
      )}
      style={
        panelMode === 'maximized' && !isMobile
          ? undefined
          : { height: isMobileTabsOnly ? 36 : isMobile ? '60vh' : computedHeight }
      }
    >
      {/* Resize handle — only shown when viewport is open (not tabs-only) */}
      {!isMobile && isViewportVisible ? (
        <div
          ref={handleNodeRef}
          className={cn(
            'group relative shrink-0 cursor-row-resize transition-colors',
            isDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border/80',
          )}
          style={{ height: HANDLE_HEIGHT_PX }}
          onDoubleClick={() => {
            if (panelMode === 'maximized') {
              onRestorePanel()
            } else {
              onMaximizePanel()
            }
          }}
          aria-label="Resize terminal panel"
        >
          <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
            <div className="h-0.5 w-16 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/20" />
          </div>
        </div>
      ) : null}

      <TerminalTabBar
        terminals={terminals}
        activeTerminalId={activeTerminal?.terminalId ?? null}
        panelMode={panelMode}
        isMobile={isMobile}
        maxTerminalsPerManager={maxTerminalsPerManager}
        editingTerminalId={editingTerminalId}
        renameDraft={renameDraft}
        onSelectTerminal={onSelectTerminal}
        onCreateTerminal={onCreateTerminal}
        onCloseTerminal={(terminalId) => {
          void onCloseTerminal(terminalId)
        }}
        onStartRenameTerminal={onStartRenameTerminal}
        onRenameDraftChange={onRenameDraftChange}
        onCommitRenameTerminal={() => {
          void onCommitRenameTerminal()
        }}
        onCancelRenameTerminal={onCancelRenameTerminal}
        onCollapsePanel={onCollapsePanel}
        onRestorePanel={onRestorePanel}
        onMaximizePanel={onMaximizePanel}
        onHidePanel={onHidePanel}
      />

      {isViewportVisible ? (
        activeTerminal ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <TerminalViewport
              key={activeTerminal.terminalId}
              wsUrl={wsUrl}
              terminal={activeTerminal}
              sessionAgentId={sessionAgentId}
              onFocusChatInput={handleEscapeFromTerminal}
              onAddToChat={onAddToChat}
              issueTicket={issueTicket}
              initialTicket={initialTickets[activeTerminal.terminalId]}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center bg-[#141726] p-6 text-center text-sm text-zinc-300">
            <div className="space-y-3">
              <p>No terminals open. Press + to create one.</p>
              <Button type="button" size="sm" onClick={onCreateTerminal}>
                New Terminal
              </Button>
            </div>
          </div>
        )
      ) : null}
    </div>
  )

  if (isMobile) {
    if (isMobileTabsOnly) {
      return (
        <div className="fixed inset-x-0 bottom-0 z-40 px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] md:hidden">
          {sheetContent}
        </div>
      )
    }

    return (
      <div className="fixed inset-0 z-40 md:hidden">
        <button
          type="button"
          className="absolute inset-0 bg-black/45"
          onClick={onHidePanel}
          aria-label="Dismiss terminal panel"
        />
        <div className="absolute inset-x-0 bottom-0 px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
          {sheetContent}
        </div>
      </div>
    )
  }

  return sheetContent
}
