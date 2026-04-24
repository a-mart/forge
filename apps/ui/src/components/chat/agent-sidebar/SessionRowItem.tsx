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
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react'
import React from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { isSessionRunning } from '@/lib/agent-hierarchy'
import { cn } from '@/lib/utils'
import { SessionStatusDot, HighlightedText } from './shared'
import { WorkerRow } from './WorkerRow'
import { getAgentLiveStatus } from './utils'
import { MAX_VISIBLE_WORKERS } from './constants'
import type { SessionRowItemProps } from './types'

/**
 * Exhaustive prop list for the memo comparator. Typed against
 * SessionRowItemProps so adding a new prop to the interface without
 * updating this list produces a visible review signal (or a type error
 * if the key is required and missing from the array literal).
 */
const SESSION_ROW_REF_EQUAL_KEYS: (keyof SessionRowItemProps)[] = [
  'session',
  'statuses',
  'unreadCount',
  'selectedAgentId',
  'isSettingsActive',
  'isCollapsed',
  'isWorkerListExpanded',
  'onToggleCollapse',
  'onToggleWorkerListExpanded',
  'onSelect',
  'onDeleteAgent',
  'onStop',
  'onResume',
  'onDelete',
  'onRename',
  'onFork',
  'onMarkUnread',
  'onStopWorker',
  'onResumeWorker',
  'highlightQuery',
  'onPinSession',
  'onPromoteToProjectAgent',
  'onOpenProjectAgentSettings',
  'onDemoteProjectAgent',
  'onViewCreationHistory',
  'onChangeSessionModel',
  'onUseProjectDefault',
  'isMutedSession',
  'onToggleMute',
  'getCreatorAttribution',
]

/**
 * Custom React.memo comparison for SessionRowItem.
 * Uses reference equality for all props in the explicit list above.
 */
function areSessionRowItemPropsEqual(
  prev: SessionRowItemProps,
  next: SessionRowItemProps,
): boolean {
  for (const key of SESSION_ROW_REF_EQUAL_KEYS) {
    if (prev[key] !== next[key]) return false
  }
  return true
}

export const SessionRowItem = React.memo(function SessionRowItem({
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
  onChangeSessionModel,
  onUseProjectDefault,
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
  const hasPendingChoice = (sessionAgent.pendingChoiceCount ?? 0) > 0
  const isProjectAgent = Boolean(sessionAgent.projectAgent)
  const isAgentCreator = sessionAgent.sessionPurpose === 'agent_creator'
  const isPinned = Boolean(sessionAgent.pinnedAt)
  const isModelOverridden = sessionAgent.modelOrigin === 'session_override'
  const creatorLabel = sessionAgent.creatorAgentId && getCreatorAttribution
    ? getCreatorAttribution(sessionAgent.creatorAgentId)
    : null

  // Pre-compute whether each context-menu group has visible items so
  // separators are only rendered between non-empty groups.
  const hasGroup2 = Boolean(onRename)
    || (Boolean(onFork) && sessionAgent.sessionPurpose !== 'agent_creator')
    || (running && Boolean(onStop))
    || (!running && Boolean(onResume))
  const hasGroup3 = Boolean(onChangeSessionModel)
    || (isModelOverridden && Boolean(onUseProjectDefault))
    || (Boolean(onPromoteToProjectAgent) && !isProjectAgent && sessionAgent.sessionPurpose !== 'cortex_review' && sessionAgent.sessionPurpose !== 'agent_creator')
    || (isProjectAgent && Boolean(onOpenProjectAgentSettings))
    || (isProjectAgent && Boolean(onViewCreationHistory))
    || (isProjectAgent && Boolean(onDemoteProjectAgent))

  // Compute streaming state from statuses map
  const managerStreaming = getAgentLiveStatus(sessionAgent, statuses).status === 'streaming'
  const streamingWorkerCount = workers.filter(
    (w) => getAgentLiveStatus(w, statuses).status === 'streaming',
  ).length || sessionAgent.activeWorkerCount || 0

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
                onClick={() => onToggleCollapse()}
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
                  <p className="opacity-60">{isModelOverridden ? 'session override' : 'project default'}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {/* ── Group 1: Quick state / visibility ── */}
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
            <ContextMenuItem onClick={() => onToggleMute()}>
              <BellOff className="mr-2 size-3.5" />
              {isMutedSession ? 'Unmute' : 'Mute'}
            </ContextMenuItem>
          ) : null}
          {onMarkUnread ? (
            <ContextMenuItem onClick={() => onMarkUnread()}>
              <EyeOff className="mr-2 size-3.5" />
              Mark as unread
            </ContextMenuItem>
          ) : null}

          {/* ── Group 2: Session operations ── */}
          {hasGroup2 ? <ContextMenuSeparator /> : null}
          {onRename ? (
            <ContextMenuItem onClick={() => onRename()}>
              <Edit3 className="mr-2 size-3.5" />
              Rename
            </ContextMenuItem>
          ) : null}
          {onFork && sessionAgent.sessionPurpose !== 'agent_creator' ? (
            <ContextMenuItem onClick={() => onFork()}>
              <GitFork className="mr-2 size-3.5" />
              Fork
            </ContextMenuItem>
          ) : null}
          {running && onStop ? (
            <ContextMenuItem onClick={() => onStop()}>
              <Pause className="mr-2 size-3.5" />
              Stop
            </ContextMenuItem>
          ) : null}
          {!running && onResume ? (
            <ContextMenuItem onClick={() => onResume()}>
              <Play className="mr-2 size-3.5" />
              Resume
            </ContextMenuItem>
          ) : null}

          {/* ── Group 3: Configuration & agent lifecycle ── */}
          {hasGroup3 ? <ContextMenuSeparator /> : null}
          {onChangeSessionModel ? (
            <ContextMenuItem onClick={() => onChangeSessionModel()}>
              <RefreshCw className="mr-2 size-3.5" />
              {isModelOverridden ? 'Change Session Model' : 'Override Session Model'}
            </ContextMenuItem>
          ) : null}
          {isModelOverridden && onUseProjectDefault ? (
            <ContextMenuItem onClick={() => onUseProjectDefault()}>
              <RotateCcw className="mr-2 size-3.5" />
              Use Project Default
            </ContextMenuItem>
          ) : null}
          {onPromoteToProjectAgent && !isProjectAgent && sessionAgent.sessionPurpose !== 'cortex_review' && sessionAgent.sessionPurpose !== 'agent_creator' ? (
            <ContextMenuItem onClick={() => onPromoteToProjectAgent()}>
              <ArrowUpFromLine className="mr-2 size-3.5" />
              Promote to Project Agent
            </ContextMenuItem>
          ) : null}
          {isProjectAgent && onOpenProjectAgentSettings ? (
            <ContextMenuItem onClick={() => onOpenProjectAgentSettings()}>
              <Settings className="mr-2 size-3.5" />
              Project Agent Settings
            </ContextMenuItem>
          ) : null}
          {isProjectAgent && onViewCreationHistory ? (
            <ContextMenuItem onClick={() => onViewCreationHistory()}>
              <History className="mr-2 size-3.5" />
              View Creation History
            </ContextMenuItem>
          ) : null}
          {isProjectAgent && onDemoteProjectAgent ? (
            <ContextMenuItem onClick={() => {
              try {
                void Promise.resolve(onDemoteProjectAgent()).catch((err) => {
                  console.error('Failed to demote project agent:', err)
                })
              } catch (err) {
                console.error('Failed to demote project agent:', err)
              }
            }}>
              <ArrowDownToLine className="mr-2 size-3.5" />
              Demote to Session
            </ContextMenuItem>
          ) : null}

          {/* ── Group 4: Destructive ── */}
          {!isDefault && onDelete ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => onDelete()}>
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
                    const workerIsSelected = !isSettingsActive && selectedAgentId === worker.agentId

                    return (
                      <li key={worker.agentId}>
                        <WorkerRow
                          agent={worker}
                          liveStatus={getAgentLiveStatus(worker, statuses)}
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
                    onClick={() => onToggleWorkerListExpanded()}
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
}, areSessionRowItemPropsEqual)
