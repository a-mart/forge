import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BellOff,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Edit3,
  EyeOff,
  GitFork,
  History,
  Pause,
  Pin,
  Play,
  Settings,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { isSessionRunning } from '@/lib/agent-hierarchy'
import { cn } from '@/lib/utils'
import { SessionStatusDot, HighlightedText } from './shared'
import { WorkerRow } from './WorkerRow'
import { getAgentLiveStatus } from './utils'
import { MAX_VISIBLE_WORKERS } from './constants'
import type { SessionRowItemProps } from './types'

export function SessionRowItem({
  session,
  statuses,
  unreadCount,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,
  isWorkerListExpanded,
  onToggleCollapse,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onStop,
  onResume,
  onDelete,
  onRename,
  onFork,
  onMarkUnread,
  onStopWorker,
  onResumeWorker,
  highlightQuery,
  onPinSession,
  onPromoteToProjectAgent,
  onOpenProjectAgentSettings,
  onDemoteProjectAgent,
  onViewCreationHistory,
  isMutedSession,
  onToggleMute,
  getCreatorAttribution,
}: SessionRowItemProps) {
  const { sessionAgent, workers, isDefault } = session
  const running = isSessionRunning(sessionAgent)
  const isSelected = !isSettingsActive && selectedAgentId === sessionAgent.agentId
  const label = sessionAgent.sessionLabel || (isDefault ? 'Main' : sessionAgent.displayName || sessionAgent.agentId)
  const workerCount = session.sessionAgent.workerCount ?? workers.length
  const hasWorkers = workerCount > 0
  const showUnread = unreadCount > 0
  const streamingWorkerCount = workers.filter((w) => getAgentLiveStatus(w, statuses).status === 'streaming').length
    || sessionAgent.activeWorkerCount
    || 0
  const managerStreaming = getAgentLiveStatus(sessionAgent, statuses).status === 'streaming'
  const hasPendingChoice = (sessionAgent.pendingChoiceCount ?? 0) > 0
  const isProjectAgent = Boolean(sessionAgent.projectAgent)
  const isAgentCreator = sessionAgent.sessionPurpose === 'agent_creator'
  const isPinned = Boolean(sessionAgent.pinnedAt)
  const creatorLabel = sessionAgent.creatorAgentId && getCreatorAttribution
    ? getCreatorAttribution(sessionAgent.creatorAgentId)
    : null

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'relative flex items-center rounded-md transition-colors',
              isSelected
                ? 'bg-white/[0.04] text-sidebar-foreground ring-1 ring-sidebar-ring/30'
                : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
            )}
          >
            {/* Expand/collapse toggle (only show if has workers) */}
            {hasWorkers ? (
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} session workers`}
                aria-expanded={!isCollapsed}
                className={cn(
                  'absolute left-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition',
                  'hover:text-sidebar-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                )}
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="size-3" aria-hidden="true" />
                )}
              </button>
            ) : null}

            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSelect(sessionAgent.agentId)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1.5 text-left',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      hasWorkers ? 'pl-7' : 'pl-5',
                    )}
                  >
                    {streamingWorkerCount > 0 ? (
                      <span
                        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 border-amber-500 bg-transparent"
                        style={{ animation: 'subtle-glow-pulse 2s ease-in-out infinite' }}
                        aria-label={`${streamingWorkerCount} worker${streamingWorkerCount !== 1 ? 's' : ''} active`}
                      >
                        <span className="text-[8px] font-bold leading-none text-amber-500">
                          {streamingWorkerCount}
                        </span>
                      </span>
                    ) : hasPendingChoice ? (
                      <span
                        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 border-blue-400 bg-transparent"
                        style={{ boxShadow: '0 0 6px rgba(96,165,250,0.5)' }}
                        aria-label="Awaiting your response"
                      >
                        <span className="text-[8px] font-bold leading-none text-blue-400">?</span>
                      </span>
                    ) : managerStreaming ? (
                      <span
                        className="inline-flex size-3 shrink-0 rounded-full border-2 border-amber-500 bg-transparent"
                        style={{ animation: 'subtle-glow-pulse 2s ease-in-out infinite' }}
                        aria-label="Manager streaming"
                      />
                    ) : isAgentCreator ? (
                      <Sparkles className="size-3 shrink-0 text-violet-400" aria-label="Agent Creator" />
                    ) : (
                      <SessionStatusDot running={running} />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="block truncate text-sm leading-5">
                        {highlightQuery ? <HighlightedText text={label} query={highlightQuery} /> : label}
                      </span>
                      {creatorLabel ? (
                        <span className="block truncate text-[10px] leading-tight text-muted-foreground/50">
                          @{creatorLabel}
                        </span>
                      ) : null}
                    </span>
                    {isPinned && !isProjectAgent && sessionAgent.profileId ? (
                      <Pin className="size-3 shrink-0 text-muted-foreground/60" aria-label="Pinned" />
                    ) : null}
                    {isMutedSession ? (
                      <BellOff className="size-3 shrink-0 text-muted-foreground opacity-60" aria-label="Muted" />
                    ) : null}
                    {isProjectAgent ? (
                      <Zap className="size-3 shrink-0 text-blue-400 dark:text-blue-400" aria-label="Project Agent" />
                    ) : null}
                    {hasPendingChoice ? (
                      <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white">
                        ?
                      </span>
                    ) : showUnread ? (
                      <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium tabular-nums leading-none text-white">
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    ) : null}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={6} className="px-2 py-1 text-[10px]">
                  <p className="font-medium">{label}</p>
                  <p className="opacity-80">{sessionAgent.model.provider}/{sessionAgent.model.modelId}</p>
                  {sessionAgent.model.thinkingLevel ? (
                    <p className="opacity-80">reasoning: {sessionAgent.model.thinkingLevel}</p>
                  ) : null}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              const sessionDir = sessionAgent.sessionFile.replace(/\/[^/]+$/, '')
              navigator.clipboard.writeText(sessionDir)
            }}
          >
            <Copy className="mr-2 size-3.5" />
            Copy path
          </ContextMenuItem>
          {onPinSession && sessionAgent.profileId ? (
            <ContextMenuItem onClick={() => onPinSession(sessionAgent.agentId, !isPinned)}>
              <Pin className="mr-2 size-3.5" />
              {isPinned ? 'Unpin' : 'Pin'}
            </ContextMenuItem>
          ) : null}
          {onToggleMute ? (
            <ContextMenuItem onClick={onToggleMute}>
              <BellOff className="mr-2 size-3.5" />
              {isMutedSession ? 'Unmute' : 'Mute'}
            </ContextMenuItem>
          ) : null}
          {onRename ? (
            <ContextMenuItem onClick={onRename}>
              <Edit3 className="mr-2 size-3.5" />
              Rename
            </ContextMenuItem>
          ) : null}
          {onFork ? (
            <ContextMenuItem onClick={onFork}>
              <GitFork className="mr-2 size-3.5" />
              Fork
            </ContextMenuItem>
          ) : null}
          {running && onStop ? (
            <ContextMenuItem onClick={onStop}>
              <Pause className="mr-2 size-3.5" />
              Stop
            </ContextMenuItem>
          ) : null}
          {!running && onResume ? (
            <ContextMenuItem onClick={onResume}>
              <Play className="mr-2 size-3.5" />
              Resume
            </ContextMenuItem>
          ) : null}
          {onMarkUnread ? (
            <ContextMenuItem onClick={onMarkUnread}>
              <EyeOff className="mr-2 size-3.5" />
              Mark as unread
            </ContextMenuItem>
          ) : null}
          {onPromoteToProjectAgent && !isProjectAgent ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onPromoteToProjectAgent}>
                <ArrowUpFromLine className="mr-2 size-3.5" />
                Promote to Project Agent
              </ContextMenuItem>
            </>
          ) : null}
          {isProjectAgent && onOpenProjectAgentSettings ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onOpenProjectAgentSettings}>
                <Settings className="mr-2 size-3.5" />
                Project Agent Settings
              </ContextMenuItem>
            </>
          ) : null}
          {isProjectAgent && onViewCreationHistory ? (
            <ContextMenuItem onClick={onViewCreationHistory}>
              <History className="mr-2 size-3.5" />
              View Creation History
            </ContextMenuItem>
          ) : null}
          {isProjectAgent && onDemoteProjectAgent ? (
            <ContextMenuItem onClick={onDemoteProjectAgent}>
              <ArrowDownToLine className="mr-2 size-3.5" />
              Demote to Session
            </ContextMenuItem>
          ) : null}
          {!isDefault && onDelete ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="mr-2 size-3.5" />
                Delete
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {/* Workers nested under session */}
      {hasWorkers && !isCollapsed ? (
        <div className="relative mt-0.5">
          {(() => {
            const needsWorkerTruncation = workers.length > MAX_VISIBLE_WORKERS
            let visibleWorkers: typeof workers
            let hiddenWorkerCount = 0

            if (isWorkerListExpanded || !needsWorkerTruncation) {
              visibleWorkers = workers
            } else {
              const topWorkers = workers.slice(0, MAX_VISIBLE_WORKERS)
              const selectedWorkerInTop = !selectedAgentId || isSettingsActive || topWorkers.some(
                (w) => w.agentId === selectedAgentId,
              )

              if (selectedWorkerInTop) {
                visibleWorkers = topWorkers
              } else {
                const selectedWorker = workers.find((w) => w.agentId === selectedAgentId)
                if (selectedWorker) {
                  visibleWorkers = [...topWorkers.slice(0, MAX_VISIBLE_WORKERS - 1), selectedWorker]
                } else {
                  visibleWorkers = topWorkers
                }
              }
              hiddenWorkerCount = workers.length - visibleWorkers.length
            }

            return (
              <>
                <ul className="space-y-0.5">
                  {visibleWorkers.map((worker) => {
                    const workerLiveStatus = getAgentLiveStatus(worker, statuses)
                    const workerIsSelected = !isSettingsActive && selectedAgentId === worker.agentId

                    return (
                      <li key={worker.agentId}>
                        <WorkerRow
                          agent={worker}
                          liveStatus={workerLiveStatus}
                          isSelected={workerIsSelected}
                          onSelect={() => onSelect(worker.agentId)}
                          onDelete={() => onDeleteAgent(worker.agentId)}
                          onStop={onStopWorker ? () => onStopWorker(worker.agentId) : undefined}
                          onResume={onResumeWorker ? () => onResumeWorker(worker.agentId) : undefined}
                          highlightQuery={highlightQuery}
                        />
                      </li>
                    )
                  })}
                </ul>
                {needsWorkerTruncation ? (
                  <button
                    type="button"
                    onClick={onToggleWorkerListExpanded}
                    className={cn(
                      'relative z-10 mt-0.5 flex w-full items-center gap-1 rounded-md py-1 pl-12 pr-1.5 text-left text-[11px] text-muted-foreground/70 transition-colors',
                      'hover:text-muted-foreground hover:bg-sidebar-accent/30',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                    )}
                  >
                    {isWorkerListExpanded ? (
                      <>
                        <ChevronUp className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show less</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show {hiddenWorkerCount} more</span>
                      </>
                    )}
                  </button>
                ) : null}
              </>
            )
          })()}
        </div>
      ) : null}
    </li>
  )
}
