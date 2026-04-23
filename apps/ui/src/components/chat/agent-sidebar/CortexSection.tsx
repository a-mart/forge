import {
  BellOff,
  Brain,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDashed,
  Edit3,
  Pause,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { isSessionRunning } from '@/lib/agent-hierarchy'
import { cn } from '@/lib/utils'
import { SessionRowItem } from './SessionRowItem'
import { getAgentLiveStatus } from './utils'
import { MAX_VISIBLE_SESSIONS } from './constants'
import type { SessionRow } from '@/lib/agent-hierarchy'
import type { CortexSectionProps } from './types'

export function CortexSection({
  cortexRow,
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,
  collapsedSessionIds,
  visibleSessionLimit,
  expandedWorkerListSessionIds,
  onToggleCollapsed,
  onToggleSessionCollapsed,
  onShowMoreSessions,
  onShowLessSessions,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onOpenCortexReview,
  outstandingReviewCount,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onRequestRenameSession,
  onRequestRenameProfile,
  onForkSession,
  onMarkUnread,
  onMarkAllRead,
  onChangeModel,
  highlightQuery,
  mutedAgents,
  onToggleMute,
  onMuteAllSessions,
}: CortexSectionProps) {
  const { profile, sessions } = cortexRow
  const reviewRunSessions = sessions.filter((session) => session.sessionAgent.sessionPurpose === 'cortex_review')
  const primarySessions = sessions.filter((session) => session.sessionAgent.sessionPurpose !== 'cortex_review')
  const selectedReviewRunSession = reviewRunSessions.find(
    (session) =>
      session.sessionAgent.agentId === selectedAgentId ||
      session.workers.some((worker) => worker.agentId === selectedAgentId),
  )
  const isSearchActive = Boolean(highlightQuery?.trim())
  const visibleSessions = isSearchActive
    ? sessions
    : selectedReviewRunSession
      ? [selectedReviewRunSession, ...primarySessions]
      : primarySessions

  const defaultSession = visibleSessions.find((s) => s.isDefault) ?? sessions.find((s) => s.isDefault)
  const targetId = visibleSessions[0]?.sessionAgent.agentId ?? sessions[0]?.sessionAgent.agentId
  const isHeaderSelected = !isSettingsActive && selectedAgentId === targetId
  const hasAnySessions = visibleSessions.length > 0

  // Unread: aggregate when collapsed, root-only when expanded
  const totalUnread = visibleSessions.reduce(
    (sum, s) => sum + (unreadCounts[s.sessionAgent.agentId] ?? 0), 0,
  )
  const rootUnread = targetId ? (unreadCounts[targetId] ?? 0) : 0
  const displayUnread = isCollapsed ? totalUnread : rootUnread
  const showUnread = displayUnread > 0

  // Activity
  const activeReviewRunCount = reviewRunSessions.filter((session) => {
    const reviewStatus = getAgentLiveStatus(session.sessionAgent, statuses).status
    return reviewStatus === 'streaming' || session.workers.some((worker) => getAgentLiveStatus(worker, statuses).status === 'streaming')
  }).length
  const activeSessionCount = visibleSessions.filter((s) => isSessionRunning(s.sessionAgent)).length

  // Root session status
  const cortexAgent = defaultSession?.sessionAgent ?? visibleSessions[0]?.sessionAgent ?? sessions[0]?.sessionAgent
  const cortexStatus = cortexAgent ? getAgentLiveStatus(cortexAgent, statuses).status : null
  const cortexRunning = cortexStatus === 'idle' || cortexStatus === 'streaming'

  return (
    <div className="border-b border-sidebar-border px-2 pb-2">
      {/* Cortex header */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative flex items-center rounded-lg border border-white/[0.04] bg-white/[0.03]">
            {hasAnySessions ? (
              <button
                type="button"
                onClick={() => onToggleCollapsed()}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} Cortex`}
                aria-expanded={!isCollapsed}
                className={cn(
                  'group absolute left-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition',
                  'hover:text-sidebar-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                )}
              >
                <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                  <Brain
                    aria-hidden="true"
                    className={cn(
                      'size-3.5 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0',
                      isHeaderSelected ? 'text-blue-500' : 'text-blue-400',
                    )}
                  />
                  {isCollapsed ? (
                    <ChevronRight
                      aria-hidden="true"
                      className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                    />
                  ) : (
                    <ChevronDown
                      aria-hidden="true"
                      className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                    />
                  )}
                </span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => targetId && onSelect(targetId)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 pr-2 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                hasAnySessions ? 'pl-7' : 'px-2',
                isHeaderSelected
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
              )}
              title="Cortex — Knowledge Intelligence"
            >
              {!hasAnySessions ? (
                <Brain className={cn('size-4 shrink-0', isHeaderSelected ? 'text-blue-500' : 'text-blue-400')} aria-hidden="true" />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
                {profile.displayName}
              </span>
              {isCollapsed && visibleSessions.length > 1 ? (
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {activeSessionCount}/{visibleSessions.length}
                </span>
              ) : null}
              {typeof outstandingReviewCount === 'number' && outstandingReviewCount > 0 && !isSearchActive ? (
                <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  Review {outstandingReviewCount}
                </span>
              ) : null}
              {activeReviewRunCount > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-500">
                  <CircleDashed className="size-2.5 animate-spin" aria-hidden="true" />
                  Running
                </span>
              ) : null}
              {showUnread ? (
                <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium tabular-nums leading-none text-white">
                  {displayUnread > 99 ? '99+' : displayUnread}
                </span>
              ) : null}
            </button>

            {/* New session button */}
            {onCreateSession ? (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onCreateSession(profile.profileId)
                      }}
                      className={cn(
                        'mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition',
                        'hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      )}
                      aria-label="New Cortex session"
                    >
                      <Plus className="size-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
                    New session
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {onCreateSession ? (
            <ContextMenuItem onClick={() => onCreateSession(profile.profileId)}>
              <Plus className="mr-2 size-3.5" />
              New Session
            </ContextMenuItem>
          ) : null}
          {onRequestRenameProfile ? (
            <ContextMenuItem onClick={() => onRequestRenameProfile(profile.profileId)}>
              <Edit3 className="mr-2 size-3.5" />
              Rename
            </ContextMenuItem>
          ) : null}
          {onChangeModel ? (
            <ContextMenuItem onClick={() => onChangeModel(profile.profileId)}>
              <RefreshCw className="mr-2 size-3.5" />
              Change Model
            </ContextMenuItem>
          ) : null}
          {cortexRunning && onStopSession && targetId ? (
            <ContextMenuItem onClick={() => onStopSession(targetId)}>
              <Pause className="mr-2 size-3.5" />
              Stop Root Session
            </ContextMenuItem>
          ) : null}
          {onMarkAllRead && visibleSessions.some((s) => (unreadCounts[s.sessionAgent.agentId] ?? 0) > 0) ? (
            <ContextMenuItem onClick={() => onMarkAllRead(profile.profileId)}>
              <CheckCheck className="mr-2 size-3.5" />
              Mark All as Read
            </ContextMenuItem>
          ) : null}
          {onMuteAllSessions ? (() => {
            const sessionIds = visibleSessions.map((s) => s.sessionAgent.agentId)
            const allMuted = sessionIds.length > 0 && sessionIds.every((id) => mutedAgents?.has(id))
            return (
              <ContextMenuItem onClick={() => onMuteAllSessions(sessionIds, !allMuted)}>
                <BellOff className="mr-2 size-3.5" />
                {allMuted ? 'Unmute All Sessions' : 'Mute All Sessions'}
              </ContextMenuItem>
            )
          })() : null}
        </ContextMenuContent>
      </ContextMenu>

      {/* Sessions list (same pattern as ProfileGroup) */}
      {!isCollapsed && hasAnySessions ? (
        <div className="relative mt-1">
          {(() => {
            const hasMore = visibleSessions.length > visibleSessionLimit
            const isExpanded = visibleSessionLimit > MAX_VISIBLE_SESSIONS
            let renderedSessions: SessionRow[]
            let hiddenCount = 0

            if (!hasMore) {
              renderedSessions = visibleSessions
            } else {
              const topSessions = visibleSessions.slice(0, visibleSessionLimit)
              const selectedSessionInTop = !selectedAgentId || isSettingsActive || topSessions.some(
                (s) =>
                  s.sessionAgent.agentId === selectedAgentId ||
                  s.workers.some((w) => w.agentId === selectedAgentId),
              )

              if (selectedSessionInTop) {
                renderedSessions = topSessions
              } else {
                const selectedSession = visibleSessions.find(
                  (s) =>
                    s.sessionAgent.agentId === selectedAgentId ||
                    s.workers.some((w) => w.agentId === selectedAgentId),
                )
                if (selectedSession) {
                  renderedSessions = [...topSessions.slice(0, visibleSessionLimit - 1), selectedSession]
                } else {
                  renderedSessions = topSessions
                }
              }
              hiddenCount = visibleSessions.length - renderedSessions.length
            }

            return (
              <>
                <ul className="space-y-0.5">
                  {renderedSessions.map((session) => {
                    const sid = session.sessionAgent.agentId
                    const sessionCollapsed = !collapsedSessionIds.has(sid)

                    return (
                      <SessionRowItem
                        key={sid}
                        session={session}
                        statuses={statuses}
                        unreadCount={unreadCounts[sid] ?? 0}
                        selectedAgentId={selectedAgentId}
                        isSettingsActive={isSettingsActive}
                        isCollapsed={sessionCollapsed}
                        isWorkerListExpanded={expandedWorkerListSessionIds.has(sid)}
                        onToggleCollapse={() => onToggleSessionCollapsed(sid)}
                        onToggleWorkerListExpanded={() => onToggleWorkerListExpanded(sid)}
                        onSelect={onSelect}
                        onDeleteAgent={onDeleteAgent}
                        onStop={onStopSession ? () => onStopSession(sid) : undefined}
                        onResume={onResumeSession ? () => onResumeSession(sid) : undefined}
                        onDelete={onDeleteSession ? () => onDeleteSession(sid) : undefined}
                        onRename={onRequestRenameSession ? () => onRequestRenameSession(sid) : undefined}
                        onFork={onForkSession ? () => onForkSession(sid) : undefined}
                        onMarkUnread={onMarkUnread ? () => onMarkUnread(sid) : undefined}
                        onStopWorker={onStopSession}
                        onResumeWorker={onResumeSession}
                        highlightQuery={highlightQuery}
                        isMutedSession={mutedAgents?.has(sid)}
                        onToggleMute={onToggleMute ? () => onToggleMute(sid) : undefined}
                      />
                    )
                  })}
                </ul>
                {hasMore || isExpanded ? (
                  <div className="relative z-10 mt-0.5 flex items-center gap-2 pl-5 pr-1.5">
                    {hasMore ? (
                      <button
                        type="button"
                        onClick={() => onShowMoreSessions()}
                        className={cn(
                          'flex items-center gap-1 rounded-md py-1 text-left text-[11px] text-muted-foreground/70 transition-colors',
                          'hover:text-muted-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                        )}
                      >
                        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show {hiddenCount} more</span>
                      </button>
                    ) : null}
                    {isExpanded ? (
                      <button
                        type="button"
                        onClick={() => onShowLessSessions()}
                        className={cn(
                          'flex items-center gap-1 rounded-md py-1 text-left text-[11px] text-muted-foreground/70 transition-colors',
                          'hover:text-muted-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                        )}
                      >
                        <ChevronUp className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show less</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {reviewRunSessions.length > 0 && !selectedReviewRunSession ? (
                  onOpenCortexReview && targetId ? (
                    <button
                      type="button"
                      className={cn(
                        'px-5 pt-1 text-left text-[10px] text-muted-foreground/70 transition-colors',
                        'hover:text-muted-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      )}
                      onClick={() => onOpenCortexReview(targetId)}
                    >
                      {reviewRunSessions.length} review run{reviewRunSessions.length === 1 ? '' : 's'} hidden here — open them from Cortex Review.
                    </button>
                  ) : (
                    <p className="px-5 pt-1 text-[10px] text-muted-foreground/70">
                      {reviewRunSessions.length} review run{reviewRunSessions.length === 1 ? '' : 's'} hidden here — open them from Cortex Review.
                    </p>
                  )
                ) : null}
              </>
            )
          })()}
        </div>
      ) : null}
    </div>
  )
}
