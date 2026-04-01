import { useState } from 'react'
import { FolderOpen, GitBranch, Loader2, Menu, Minimize2, MoreHorizontal, PanelRight, ScrollText, Sparkles, Square, SquareTerminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { ContextWindowIndicator } from '@/components/chat/ContextWindowIndicator'
import { PinNavigator } from '@/components/chat/PinNavigator'
import { SystemPromptDialog } from '@/components/chat/message-list/SystemPromptDialog'
import { MessageFeedback } from '@/components/chat/message-list/MessageFeedback'
import { cn } from '@/lib/utils'
import type { AgentStatus, AgentSessionPurpose } from '@forge/protocol'

export type ChannelView = 'web' | 'all'

interface ChatHeaderProps {
  connected: boolean
  activeAgentId: string | null
  activeAgentLabel: string
  wsUrl?: string
  activeAgentProfileName?: string
  activeAgentSessionLabel?: string
  totalUnreadCount?: number
  activeAgentArchetypeId?: string | null
  activeAgentSessionPurpose?: AgentSessionPurpose | null
  activeAgentStatus: AgentStatus | null
  channelView: ChannelView
  onChannelViewChange: (view: ChannelView) => void
  contextWindowUsage: { usedTokens: number; contextWindow: number } | null
  compactionCount?: number
  showCompact: boolean
  compactInProgress: boolean
  onCompact: () => void
  showSmartCompact: boolean
  smartCompactInProgress: boolean
  onSmartCompact: () => void
  autoCompactionInProgress?: boolean
  pinnedCount?: number
  pinnedMessageIds?: string[]
  onScrollToMessage?: (messageId: string) => void
  onClearAllPins?: () => void
  showStopAll: boolean
  stopAllInProgress: boolean
  stopAllDisabled: boolean
  onStopAll: () => void
  showNewChat: boolean
  onNewChat: () => void
  isArtifactsPanelOpen: boolean
  onToggleArtifactsPanel: () => void
  isTerminalPanelOpen?: boolean
  terminalCount?: number
  onToggleTerminalPanel?: () => void
  onOpenDiffViewer?: () => void
  diffViewerAvailable?: boolean
  isFileBrowserOpen?: boolean
  onToggleFileBrowser?: () => void
  fileBrowserAvailable?: boolean
  onToggleMobileSidebar?: () => void
  sessionFeedbackVote?: 'up' | 'down' | null
  sessionFeedbackHasComment?: boolean
  onSessionFeedbackVote?: (
    scope: 'message' | 'session',
    targetId: string,
    value: 'up' | 'down',
    reasonCodes?: string[],
    comment?: string,
  ) => Promise<void>
  onSessionFeedbackComment?: (
    scope: 'message' | 'session',
    targetId: string,
    comment: string,
  ) => Promise<void>
  onSessionFeedbackClearComment?: (scope: 'message' | 'session', targetId: string) => Promise<void>
  isFeedbackSubmitting?: boolean
}

function formatAgentStatus(status: AgentStatus | null): string {
  if (!status) return 'Idle'

  switch (status) {
    case 'streaming':
      return 'Streaming'
    case 'idle':
      return 'Idle'
    case 'terminated':
      return 'Terminated'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return 'Error'
  }
}

function ChannelToggleButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'h-[22px] min-w-10 rounded-[4px] px-2 text-[11px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}

export function ChatHeader({
  connected,
  activeAgentId,
  activeAgentLabel,
  wsUrl,
  activeAgentProfileName,
  activeAgentSessionLabel,
  totalUnreadCount = 0,
  activeAgentArchetypeId,
  activeAgentSessionPurpose,
  activeAgentStatus,
  channelView,
  onChannelViewChange,
  contextWindowUsage,
  compactionCount,
  showCompact,
  compactInProgress,
  onCompact,
  showSmartCompact,
  smartCompactInProgress,
  onSmartCompact,
  autoCompactionInProgress = false,
  pinnedCount = 0,
  pinnedMessageIds,
  onScrollToMessage,
  onClearAllPins,
  showStopAll,
  stopAllInProgress,
  stopAllDisabled,
  onStopAll,
  showNewChat,
  onNewChat,
  isArtifactsPanelOpen,
  onToggleArtifactsPanel,
  isTerminalPanelOpen = false,
  terminalCount = 0,
  onToggleTerminalPanel,
  onOpenDiffViewer,
  diffViewerAvailable = true,
  isFileBrowserOpen = false,
  onToggleFileBrowser,
  fileBrowserAvailable = true,
  onToggleMobileSidebar,
  sessionFeedbackVote,
  sessionFeedbackHasComment,
  onSessionFeedbackVote,
  onSessionFeedbackComment,
  onSessionFeedbackClearComment,
  isFeedbackSubmitting,
}: ChatHeaderProps) {
  const isStreaming = connected && activeAgentStatus === 'streaming'
  const statusLabel = connected ? formatAgentStatus(activeAgentStatus) : 'Reconnecting'
  const isAgentCreator = activeAgentSessionPurpose === 'agent_creator'
  const archetypeLabel = isAgentCreator ? null : activeAgentArchetypeId?.trim()
  const isCortex = activeAgentArchetypeId === 'cortex'
  const panelLabel = isCortex ? 'Dashboard' : 'Artifacts'
  const anyCompactionInProgress = compactInProgress || smartCompactInProgress || autoCompactionInProgress
  const electronPlatform = typeof window !== 'undefined' ? (window.electronBridge?.platform ?? '') : ''
  const platform = electronPlatform || (typeof window !== 'undefined' ? (window.navigator.platform ?? '') : '')
  const normalizedPlatform = platform.toLowerCase()
  const isMacPlatform = normalizedPlatform.includes('mac') || normalizedPlatform.includes('darwin')
  const isFramelessDesktop = false
  const terminalShortcutLabel = isMacPlatform ? '⌘`' : 'Ctrl+`'
  const [promptOpen, setPromptOpen] = useState(false)

  return (
    <header
      className={cn(
        'sticky top-0 z-10 flex h-[62px] w-full shrink-0 items-center justify-between gap-2 overflow-hidden border-b bg-card/80 px-2 backdrop-blur md:px-4',
        isAgentCreator
          ? 'border-b-2 border-violet-500/40'
          : 'border-border/80',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
        {/* Mobile hamburger */}
        {onToggleMobileSidebar ? (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'relative size-11 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground md:hidden',
              isFramelessDesktop && '[-webkit-app-region:no-drag]',
            )}
            onClick={onToggleMobileSidebar}
            aria-label="Open sidebar"
          >
            <Menu className="size-5" />
            {totalUnreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">
                {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
              </span>
            )}
          </Button>
        ) : null}

        <div
          className="relative inline-flex size-5 shrink-0 items-center justify-center"
          aria-label={`Agent status: ${statusLabel.toLowerCase()}`}
        >
          <span
            className={cn(
              'absolute inline-flex size-4 rounded-full',
              isStreaming
                ? isAgentCreator ? 'animate-ping bg-violet-500/45' : 'animate-ping bg-emerald-500/45'
                : 'bg-transparent',
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              'relative inline-flex size-2.5 rounded-full',
              isStreaming
                ? isAgentCreator ? 'bg-violet-500' : 'bg-emerald-500'
                : 'bg-muted-foreground/45',
            )}
            aria-hidden="true"
          />
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          <h1
            className="min-w-0 truncate text-sm font-bold text-foreground"
            title={activeAgentId ?? activeAgentLabel}
          >
            {/* Mobile: show only session label if available, Desktop: full breadcrumb */}
            {activeAgentProfileName && activeAgentSessionLabel ? (
              <>
                <span className="md:hidden">{activeAgentSessionLabel}</span>
                <span className="hidden md:inline">{activeAgentLabel}</span>
              </>
            ) : (
              activeAgentLabel
            )}
          </h1>
          {isAgentCreator ? (
            <Badge
              variant="outline"
              className="hidden h-5 shrink-0 gap-1 border-violet-500/30 bg-violet-500/10 px-1.5 text-[10px] font-medium text-violet-400 md:inline-flex"
            >
              <Sparkles className="size-3" />
              <span>Agent Architect</span>
            </Badge>
          ) : archetypeLabel ? (
            <Badge
              variant="outline"
              className="hidden h-5 max-w-32 shrink-0 border-border/60 bg-muted/40 px-1.5 text-[10px] font-medium text-muted-foreground md:inline-flex"
              title={archetypeLabel}
            >
              <span className="truncate">{archetypeLabel}</span>
            </Badge>
          ) : null}
          <span aria-hidden="true" className="hidden shrink-0 text-muted-foreground md:inline">
            ·
          </span>
          <span className="hidden shrink-0 whitespace-nowrap text-xs font-mono text-muted-foreground md:inline">
            {statusLabel}
          </span>
          {activeAgentId && onSessionFeedbackVote ? (
            <div
              className={cn(
                'hidden shrink-0 items-center gap-1.5 md:flex',
                isFramelessDesktop && '[-webkit-app-region:no-drag]',
              )}
            >
              <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                ·
              </span>
              <MessageFeedback
                targetId={activeAgentId}
                currentVote={sessionFeedbackVote ?? null}
                hasComment={sessionFeedbackHasComment}
                onVote={onSessionFeedbackVote}
                onComment={onSessionFeedbackComment}
                onClearComment={onSessionFeedbackClearComment}
                isSubmitting={isFeedbackSubmitting}
                scope="session"
                size="md"
              />
            </div>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          'flex shrink-0 items-center gap-1.5',
          isFramelessDesktop && '[-webkit-app-region:no-drag]',
        )}
      >
        {/* ── Inline: channel toggle + context window ── */}
        <div className="hidden sm:inline-flex items-center gap-1">
          {channelView === 'all' && activeAgentId ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                    onClick={() => setPromptOpen(true)}
                    aria-label="View system prompt"
                  >
                    <ScrollText className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  View system prompt
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}

          <div className="inline-flex h-7 items-center rounded-md border border-border/60 bg-muted/30 p-0.5">
            <ChannelToggleButton
              label="Web"
              active={channelView === 'web'}
              onClick={() => onChannelViewChange('web')}
            />
            <ChannelToggleButton
              label="All"
              active={channelView === 'all'}
              onClick={() => onChannelViewChange('all')}
            />
          </div>

          {contextWindowUsage ? (
            <ContextWindowIndicator
              usedTokens={contextWindowUsage.usedTokens}
              contextWindow={contextWindowUsage.contextWindow}
              compactionCount={compactionCount}
            />
          ) : null}
        </div>

        {/* ── Pinned message navigator ── */}
        {pinnedCount > 0 && pinnedMessageIds && onScrollToMessage && onClearAllPins ? (
          <>
            <Separator orientation="vertical" className="hidden sm:block mx-0.5 h-4 bg-border/60" />
            <PinNavigator
              pinnedMessageIds={pinnedMessageIds}
              onScrollToMessage={onScrollToMessage}
              onClearAllPins={onClearAllPins}
            />
          </>
        ) : null}

        {/* ── Three-dots dropdown: secondary actions ── */}
        {(showCompact || showSmartCompact || showNewChat || showStopAll) ? (
          <>
            <Separator orientation="vertical" className="hidden sm:block mx-0.5 h-4 bg-border/60" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "size-9 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground md:size-7",
                    anyCompactionInProgress && "relative"
                  )}
                  aria-label={anyCompactionInProgress ? "Compaction in progress" : "More actions"}
                >
                  {anyCompactionInProgress ? (
                    <Loader2 className="size-4 animate-spin text-amber-500" />
                  ) : (
                    <MoreHorizontal className="size-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="min-w-44">
                {showCompact ? (
                  <DropdownMenuItem
                    onClick={onCompact}
                    disabled={anyCompactionInProgress}
                    className="gap-2 text-xs"
                  >
                    {compactInProgress || (autoCompactionInProgress && !smartCompactInProgress) ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Minimize2 className="size-3.5" />
                    )}
                    {compactInProgress ? 'Compacting…' : autoCompactionInProgress && !smartCompactInProgress ? 'Auto-compacting…' : 'Compact context'}
                  </DropdownMenuItem>
                ) : null}

                {showSmartCompact ? (
                  <DropdownMenuItem
                    onClick={onSmartCompact}
                    disabled={anyCompactionInProgress}
                    className="gap-2 text-xs"
                  >
                    {smartCompactInProgress ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="size-3.5" />
                    )}
                    {smartCompactInProgress ? 'Smart compacting…' : 'Smart compact'}
                  </DropdownMenuItem>
                ) : null}

                {showNewChat ? (
                  <DropdownMenuItem
                    onClick={onNewChat}
                    className="gap-2 text-xs"
                  >
                    <Trash2 className="size-3.5" />
                    Clear conversation
                  </DropdownMenuItem>
                ) : null}

                {showStopAll ? (
                  <DropdownMenuItem
                    onClick={onStopAll}
                    disabled={stopAllDisabled || stopAllInProgress}
                    className="gap-2 text-xs text-destructive focus:text-destructive"
                  >
                    {stopAllInProgress ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                    {stopAllInProgress ? 'Stopping…' : 'Stop All'}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}

        {/* ── Inline: file browser + diff viewer + artifacts/dashboard toggle ── */}
        <div className="inline-flex items-center gap-0.5">
          {onToggleTerminalPanel ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'relative size-7 shrink-0 transition-colors',
                      isTerminalPanelOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                    )}
                    onClick={onToggleTerminalPanel}
                    aria-label={isTerminalPanelOpen ? 'Hide terminal panel' : 'Open terminal panel'}
                    aria-pressed={isTerminalPanelOpen}
                  >
                    <SquareTerminal className="size-3.5" />
                    {!isTerminalPanelOpen && terminalCount > 0 ? (
                      <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                        {terminalCount > 9 ? '9+' : terminalCount}
                      </span>
                    ) : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {isTerminalPanelOpen ? 'Hide terminal panel' : `Terminal (${terminalShortcutLabel})`}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {onToggleFileBrowser && fileBrowserAvailable ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'size-7 shrink-0 transition-colors',
                      isFileBrowserOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                    )}
                    onClick={onToggleFileBrowser}
                    aria-label={isFileBrowserOpen ? 'Close file browser' : 'Browse Files'}
                    aria-pressed={isFileBrowserOpen}
                  >
                    <FolderOpen className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {isFileBrowserOpen ? 'Close file browser' : 'Browse Files'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {onOpenDiffViewer && diffViewerAvailable ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                    onClick={onOpenDiffViewer}
                    aria-label="View Changes (⌘⇧D)"
                  >
                    <GitBranch className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  View Changes (⌘⇧D)
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'size-7 shrink-0 transition-colors',
                    isArtifactsPanelOpen
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                  )}
                  onClick={onToggleArtifactsPanel}
                  aria-label={isArtifactsPanelOpen ? `Close ${panelLabel.toLowerCase()}` : panelLabel}
                  aria-pressed={isArtifactsPanelOpen}
                >
                  <PanelRight className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {isArtifactsPanelOpen ? `Close ${panelLabel.toLowerCase()}` : panelLabel}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      {/* Spacer for frameless window controls (minimize/maximize/close) */}
      {isFramelessDesktop && <div className="w-[140px] shrink-0" />}

      {activeAgentId ? (
        <SystemPromptDialog
          open={promptOpen}
          onOpenChange={setPromptOpen}
          agentId={activeAgentId}
          agentLabel={activeAgentLabel}
          wsUrl={wsUrl}
        />
      ) : null}
    </header>
  )
}
