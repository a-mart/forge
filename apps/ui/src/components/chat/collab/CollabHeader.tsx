import { useMemo } from 'react'
import type { CollaborationChannel } from '@forge/protocol'
import {
  Bot,
  ChevronRight,
  Loader2,
  Minimize2,
  MoreHorizontal,
  ScrollText,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { UserAvatarPopover } from '@/components/chat/collab-sidebar/UserAvatarPopover'
import type { CollaborationBootstrapCurrentUser } from '@forge/protocol'

export type CollabMessageSourceView = 'web' | 'all'

interface CollabHeaderProps {
  channel: CollaborationChannel
  workspaceDisplayName?: string
  categoryName?: string
  memberCount?: number
  /** Current message source view filter */
  channelView: CollabMessageSourceView
  onChannelViewChange: (view: CollabMessageSourceView) => void
  /** Read-only AI prompt preview action */
  onViewPrompt?: () => void
  /** Compact context action */
  onCompact?: () => void
  compactInProgress?: boolean
  /** Smart compact action */
  onSmartCompact?: () => void
  smartCompactInProgress?: boolean
  /** Clear conversation action */
  onClearConversation?: () => void
  clearInProgress?: boolean
  /** Worker history panel controls */
  workerCount?: number
  isWorkerPanelOpen?: boolean
  onToggleWorkerPanel?: () => void
  /** User profile popover (top-right) */
  wsUrl?: string
  currentUser?: CollaborationBootstrapCurrentUser | null
  onOpenSettings?: () => void
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

export function CollabHeader({
  channel,
  workspaceDisplayName,
  categoryName,
  memberCount,
  channelView,
  onChannelViewChange,
  onViewPrompt,
  onCompact,
  compactInProgress = false,
  onSmartCompact,
  smartCompactInProgress = false,
  onClearConversation,
  clearInProgress = false,
  workerCount = 0,
  isWorkerPanelOpen = false,
  onToggleWorkerPanel,
  wsUrl,
  currentUser,
  onOpenSettings,
}: CollabHeaderProps) {
  const breadcrumb = useMemo(() => {
    if (!categoryName) {
      return null
    }

    return [workspaceDisplayName, categoryName].filter(Boolean) as string[]
  }, [categoryName, workspaceDisplayName])

  const anyCompactionInProgress = compactInProgress || smartCompactInProgress
  const hasConversationActions = Boolean(onViewPrompt || onCompact || onSmartCompact || onClearConversation)

  return (
    <>
      <header className="sticky top-0 z-10 flex min-h-[72px] w-full shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/80 px-4 py-3 backdrop-blur md:px-5">
        <div className="min-w-0 flex-1">
          {breadcrumb ? (
            <div className="mb-1 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              {breadcrumb.map((segment, index) => (
                <div key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
                  {index > 0 ? <ChevronRight className="size-3 shrink-0" /> : null}
                  <span className="truncate">{segment}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight text-foreground md:text-xl">
              #{channel.name}
            </h1>
            {typeof memberCount === 'number' ? (
              <div className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 text-[11px] text-muted-foreground">
                <Users className="size-3.5" />
                <span>{memberCount}</span>
              </div>
            ) : null}
          </div>

          {channel.description ? (
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {channel.description}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* ── Web / All filter toggle ── */}
          <div className="hidden sm:inline-flex h-7 items-center rounded-md border border-border/60 bg-muted/30 p-0.5">
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

          {/* ── Workers toggle ── */}
          {workerCount > 0 && onToggleWorkerPanel ? (
            <>
              <Separator orientation="vertical" className="hidden sm:block mx-0.5 h-4 bg-border/60" />
              <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'relative size-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                      isWorkerPanelOpen && 'bg-accent/70 text-foreground',
                    )}
                    onClick={onToggleWorkerPanel}
                    aria-label={isWorkerPanelOpen ? 'Hide workers' : 'Show workers'}
                    aria-pressed={isWorkerPanelOpen}
                  >
                    <Bot className="size-4" />
                    <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-muted-foreground/80 text-[8px] font-bold leading-none text-background">
                      {workerCount > 99 ? '99' : workerCount}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {isWorkerPanelOpen ? 'Hide workers' : `Show workers (${workerCount})`}
                </TooltipContent>
              </Tooltip>
              </TooltipProvider>
            </>
          ) : null}

          {/* ── Conversation actions menu ── */}
          {hasConversationActions ? (
            <>
              <Separator orientation="vertical" className="hidden sm:block mx-0.5 h-4 bg-border/60" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'size-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                      anyCompactionInProgress && 'relative',
                    )}
                    aria-label={anyCompactionInProgress ? 'Compaction in progress' : 'Conversation actions'}
                  >
                    {anyCompactionInProgress ? (
                      <Loader2 className="size-4 animate-spin text-amber-500" />
                    ) : (
                      <MoreHorizontal className="size-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="min-w-44">
                  {onViewPrompt ? (
                    <DropdownMenuItem
                      onSelect={onViewPrompt}
                      className="gap-2 text-xs"
                    >
                      <ScrollText className="size-3.5" />
                      View AI prompt
                    </DropdownMenuItem>
                  ) : null}
                  {onCompact ? (
                    <DropdownMenuItem
                      onSelect={onCompact}
                      disabled={anyCompactionInProgress || clearInProgress}
                      className="gap-2 text-xs"
                    >
                      {compactInProgress ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Minimize2 className="size-3.5" />
                      )}
                      {compactInProgress ? 'Compacting…' : 'Compact context'}
                    </DropdownMenuItem>
                  ) : null}
                  {onSmartCompact ? (
                    <DropdownMenuItem
                      onSelect={onSmartCompact}
                      disabled={anyCompactionInProgress || clearInProgress}
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
                  {onClearConversation ? (
                    <DropdownMenuItem
                      onSelect={onClearConversation}
                      disabled={anyCompactionInProgress || clearInProgress}
                      className="gap-2 text-xs"
                    >
                      {clearInProgress ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                      {clearInProgress ? 'Clearing…' : 'Clear conversation'}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}

          {/* ── User profile avatar (top-right) ── */}
          {wsUrl ? (
            <>
              <Separator orientation="vertical" className="hidden sm:block mx-0.5 h-4 bg-border/60" />
              <TooltipProvider delayDuration={200}>
                <UserAvatarPopover
                  wsUrl={wsUrl}
                  currentUser={currentUser ?? null}
                  onOpenSettings={onOpenSettings}
                />
              </TooltipProvider>
            </>
          ) : null}

        </div>
      </header>
    </>
  )
}
