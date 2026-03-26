import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Maximize2, Minimize2, Plus, X } from 'lucide-react'
import type { TerminalDescriptor } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { TerminalPanelMode } from '@/hooks/useTerminalPanel'
import { cn } from '@/lib/utils'

interface TerminalTabBarProps {
  terminals: TerminalDescriptor[]
  activeTerminalId: string | null
  panelMode: TerminalPanelMode
  isMobile: boolean
  maxTerminalsPerSession: number
  editingTerminalId: string | null
  renameDraft: string
  onSelectTerminal: (terminalId: string) => void
  onCreateTerminal: () => void
  onCloseTerminal: (terminalId: string) => void
  onStartRenameTerminal: (terminalId: string) => void
  onRenameDraftChange: (value: string) => void
  onCommitRenameTerminal: () => void
  onCancelRenameTerminal: () => void
  onCollapsePanel: () => void
  onRestorePanel: () => void
  onMaximizePanel: () => void
  onHidePanel: () => void
}

function getTerminalIndicatorVariant(
  terminal: TerminalDescriptor,
  isRestored: boolean,
): { dotClassName: string; label: string } {
  if (isRestored) {
    return { dotClassName: 'bg-amber-400', label: 'Restored' }
  }

  if (terminal.state === 'restore_failed' || (terminal.state === 'exited' && (terminal.exitCode ?? 0) !== 0)) {
    return { dotClassName: 'bg-red-500', label: 'Error' }
  }

  if (terminal.state === 'exited') {
    return { dotClassName: 'bg-zinc-500', label: 'Exited' }
  }

  return { dotClassName: 'bg-emerald-500', label: 'Running' }
}

export function TerminalTabBar({
  terminals,
  activeTerminalId,
  panelMode,
  isMobile,
  maxTerminalsPerSession,
  editingTerminalId,
  renameDraft,
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
}: TerminalTabBarProps) {
  const [restoredIndicators, setRestoredIndicators] = useState<Record<string, boolean>>({})
  const terminalCount = terminals.length
  const createDisabled = terminalCount >= maxTerminalsPerSession
  const isViewportOpen = panelMode === 'open' || panelMode === 'maximized'

  useEffect(() => {
    const restored = terminals.filter((terminal) => terminal.recoveredFromPersistence)
    if (restored.length === 0) {
      return undefined
    }

    const timeouts = restored.map((terminal) => {
      setRestoredIndicators((previous) => ({ ...previous, [terminal.terminalId]: true }))
      return window.setTimeout(() => {
        setRestoredIndicators((previous) => {
          if (!previous[terminal.terminalId]) {
            return previous
          }
          const next = { ...previous }
          delete next[terminal.terminalId]
          return next
        })
      }, 5_000)
    })

    return () => {
      for (const timeout of timeouts) {
        window.clearTimeout(timeout)
      }
    }
  }, [terminals])

  const activeTerminal = useMemo(
    () => terminals.find((terminal) => terminal.terminalId === activeTerminalId) ?? terminals[0] ?? null,
    [activeTerminalId, terminals],
  )

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-card/80 px-2 backdrop-blur-sm">
      {isMobile ? (
        <div className="min-w-0 flex-1">
          <Select value={activeTerminal?.terminalId} onValueChange={onSelectTerminal}>
            <SelectTrigger className="h-7 w-full border-white/10 bg-black/20 text-xs text-zinc-100 hover:bg-black/25">
              <SelectValue placeholder="Select terminal" />
            </SelectTrigger>
            <SelectContent>
              {terminals.map((terminal) => (
                <SelectItem key={terminal.terminalId} value={terminal.terminalId}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        'inline-block size-2 rounded-full',
                        getTerminalIndicatorVariant(terminal, Boolean(restoredIndicators[terminal.terminalId])).dotClassName,
                      )}
                    />
                    <span className="truncate">{terminal.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {terminals.map((terminal) => {
            const isActive = terminal.terminalId === activeTerminalId
            const isEditing = terminal.terminalId === editingTerminalId
            const indicator = getTerminalIndicatorVariant(terminal, Boolean(restoredIndicators[terminal.terminalId]))

            return (
              <div
                key={terminal.terminalId}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                className={cn(
                  'group flex h-6 min-w-0 max-w-[180px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-colors cursor-pointer',
                  isActive && isViewportOpen
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : isActive
                      ? 'border-border/60 bg-accent/40 text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
                onClick={() => onSelectTerminal(terminal.terminalId)}
                onDoubleClick={() => onStartRenameTerminal(terminal.terminalId)}
                onMouseDown={(event) => {
                  if (event.button === 1) {
                    event.preventDefault()
                    onCloseTerminal(terminal.terminalId)
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelectTerminal(terminal.terminalId)
                  }
                }}
                title={terminal.name}
              >
                <span className={cn('inline-block size-1.5 shrink-0 rounded-full', indicator.dotClassName)} aria-hidden="true" />

                {isEditing ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(event) => onRenameDraftChange(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={() => void onCommitRenameTerminal()}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void onCommitRenameTerminal()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        onCancelRenameTerminal()
                      }
                    }}
                    className="min-w-0 flex-1 rounded border border-border/60 bg-background px-1 py-0 text-[11px] text-foreground outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{terminal.name}</span>
                )}

                <button
                  type="button"
                  className={cn(
                    'inline-flex size-3.5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                    isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseTerminal(terminal.terminalId)
                  }}
                  aria-label={`Close ${terminal.name}`}
                >
                  <X className="size-2.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-0.5">
        {isMobile && activeTerminal ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                  onClick={() => onCloseTerminal(activeTerminal.terminalId)}
                  aria-label={`Close ${activeTerminal.name}`}
                >
                  <X className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Close {activeTerminal.name}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}

        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                onClick={onCreateTerminal}
                disabled={createDisabled}
                aria-label="New terminal"
              >
                <Plus className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {createDisabled
                ? `Maximum ${maxTerminalsPerSession} terminals per session.`
                : 'New terminal'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {isViewportOpen ? (
          <>
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                    onClick={onCollapsePanel}
                    aria-label="Collapse to tab strip"
                  >
                    <ChevronDown className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Collapse
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                    onClick={panelMode === 'maximized' ? onRestorePanel : onMaximizePanel}
                    aria-label={panelMode === 'maximized' ? 'Restore terminal size' : 'Maximize terminal panel'}
                  >
                    {panelMode === 'maximized' ? (
                      <Minimize2 className="size-3" />
                    ) : (
                      <Maximize2 className="size-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {panelMode === 'maximized' ? 'Restore' : 'Maximize'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        ) : (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                  onClick={onRestorePanel}
                  aria-label="Expand terminal panel"
                >
                  <ChevronUp className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Expand
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                onClick={onHidePanel}
                aria-label="Hide terminal panel"
              >
                <X className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Hide
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}
