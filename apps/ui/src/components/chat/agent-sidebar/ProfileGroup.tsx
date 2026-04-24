import {
  BellOff,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Edit3,
  FolderOpen,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import React from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { isCortexProfile } from '@/lib/agent-hierarchy'
import type { SessionRow } from '@/lib/agent-hierarchy'
import { cn } from '@/lib/utils'
import { SidebarModelIcon } from './shared'
import { SessionRowItem } from './SessionRowItem'
import { MAX_VISIBLE_SESSIONS } from './constants'
import type { ProfileGroupProps } from './types'

export const ProfileGroup = React.memo(function ProfileGroup({
  treeRow,
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,
  collapsedSessionIds,
  visibleSessionLimit,
  expandedWorkerListSessionIds,
  onToggleProfileCollapsed,
  onToggleSessionCollapsed,
  onShowMoreSessions,
  onShowLessSessions,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onDeleteManager,
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
  onChangeSessionModel,
  onUseProjectDefault,
  onChangeCwd,
  showModelIcons,
  highlightQuery,
  dragHandleRef,
  dragHandleListeners,
  onPinSession,
  onPromoteToProjectAgent,
  onOpenProjectAgentSettings,
  onDemoteProjectAgent,
  onCreateAgentCreator,
  mutedAgents,
  onToggleMute,
  onMuteAllSessions,
  getCreatorAttribution,
}: ProfileGroupProps) {
  const { profile, sessions } = treeRow
  const hasAnySessions = sessions.length > 0
  const defaultSession = sessions.find((s) => s.isDefault)

  // Profile summary for tooltip
  const representativeAgent = defaultSession?.sessionAgent ?? sessions[0]?.sessionAgent

  const profileTooltipLines: string[] = []
  if (sessions.length > 0) {
    profileTooltipLines.push(`${sessions.length} session${sessions.length !== 1 ? 's' : ''}`)
  }
  const defaultModel = profile.defaultModel
  if (defaultModel) {
    profileTooltipLines.push(`default: ${defaultModel.provider}/${defaultModel.modelId}`)
    if (defaultModel.thinkingLevel) {
      profileTooltipLines.push(`reasoning: ${defaultModel.thinkingLevel}`)
    }
  } else if (representativeAgent) {
    profileTooltipLines.push(`${representativeAgent.model.provider}/${representativeAgent.model.modelId}`)
    if (representativeAgent.model.thinkingLevel) {
      profileTooltipLines.push(`reasoning: ${representativeAgent.model.thinkingLevel}`)
    }
  }

  return (
    <>
      {/* Profile header */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative flex items-center rounded-lg border border-white/[0.04] bg-white/[0.03]">
            <button
              type="button"
              onClick={() => onToggleProfileCollapsed()}
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${profile.displayName}`}
              aria-expanded={!isCollapsed}
              className={cn(
                'group absolute left-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition',
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

            <TooltipProvider delayDuration={400}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    ref={dragHandleRef}
                    {...dragHandleListeners}
                    onClick={() => {
                      // Click profile header → select default session
                      const targetId = sessions[0]?.sessionAgent.agentId
                      if (targetId) onSelect(targetId)
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pl-5.5 pr-1.5 text-left transition-colors',
                      'hover:bg-sidebar-accent/50',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      dragHandleListeners ? 'cursor-grab active:cursor-grabbing' : '',
                    )}
                    style={dragHandleListeners ? { touchAction: 'none' } : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
                      {profile.displayName}
                    </span>
                    {showModelIcons && representativeAgent ? (
                      <span className="ml-1 shrink-0">
                        <SidebarModelIcon agent={representativeAgent} />
                      </span>
                    ) : null}
                  </button>
                </TooltipTrigger>
                {profileTooltipLines.length > 0 ? (
                  <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
                    {profileTooltipLines.map((line, i) => (
                      <p key={i} className={i === 0 ? 'font-medium' : 'opacity-80'}>{line}</p>
                    ))}
                  </TooltipContent>
                ) : null}
              </Tooltip>
            </TooltipProvider>

            {/* Inline "new session" button on profile header */}
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
                      aria-label={`New session for ${profile.displayName}`}
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
              Change Default Model
            </ContextMenuItem>
          ) : null}
          {onChangeCwd && !isCortexProfile(treeRow) ? (
            <ContextMenuItem onClick={() => onChangeCwd(profile.profileId)}>
              <FolderOpen className="mr-2 size-3.5" />
              Change Working Directory
            </ContextMenuItem>
          ) : null}
          {onCreateAgentCreator ? (
            <ContextMenuItem onClick={() => onCreateAgentCreator(profile.profileId)}>
              <Sparkles className="mr-2 size-3.5" />
              Create Project Agent
            </ContextMenuItem>
          ) : null}
          {onMarkAllRead && sessions.some((s) => (unreadCounts[s.sessionAgent.agentId] ?? 0) > 0) ? (
            <ContextMenuItem onClick={() => onMarkAllRead(profile.profileId)}>
              <CheckCheck className="mr-2 size-3.5" />
              Mark All as Read
            </ContextMenuItem>
          ) : null}
          {onMuteAllSessions ? (() => {
            const sessionIds = sessions.map((s) => s.sessionAgent.agentId)
            const allMuted = sessionIds.length > 0 && sessionIds.every((id) => mutedAgents?.has(id))
            return (
              <ContextMenuItem onClick={() => onMuteAllSessions(sessionIds, !allMuted)}>
                <BellOff className="mr-2 size-3.5" />
                {allMuted ? 'Unmute All Sessions' : 'Mute All Sessions'}
              </ContextMenuItem>
            )
          })() : null}
          {!isCortexProfile(treeRow) ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => onDeleteManager(profile.profileId)}>
                <Trash2 className="mr-2 size-3.5" />
                Delete Manager
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {/* Sessions list */}
      {!isCollapsed && hasAnySessions ? (
        <div className="relative mt-1">
          {(() => {
            // Build a set of all session agentIds in this profile for existence checks
            const sessionAgentIds = new Set(sessions.map((s) => s.sessionAgent.agentId))

            // Hide completed wizard sessions (agentCreatorResult is set) — always hidden
            const isCompletedWizard = (s: SessionRow) =>
              Boolean(s.sessionAgent.agentCreatorResult)

            // Split sessions into project agents (always visible) and regular sessions (subject to truncation)
            const projectAgentSessions = sessions.filter((s) => Boolean(s.sessionAgent.projectAgent))
            const pinnedSessions = sessions.filter((s) =>
              !s.sessionAgent.projectAgent &&
              Boolean(s.sessionAgent.pinnedAt) &&
              !isCompletedWizard(s)
            ).sort((a, b) => {
              const aPinned = a.sessionAgent.pinnedAt ?? ''
              const bPinned = b.sessionAgent.pinnedAt ?? ''
              return aPinned.localeCompare(bPinned)
            })
            const regularSessions = sessions.filter((s) =>
              !s.sessionAgent.projectAgent &&
              !s.sessionAgent.pinnedAt &&
              !isCompletedWizard(s)
            )

            const hasMore = regularSessions.length > visibleSessionLimit
            const isExpanded = visibleSessionLimit > MAX_VISIBLE_SESSIONS
            let visibleRegularSessions: SessionRow[]
            let hiddenCount = 0

            if (!hasMore) {
              visibleRegularSessions = regularSessions
            } else {
              // Take the top visibleSessionLimit, but guarantee the selected session is visible
              const topSessions = regularSessions.slice(0, visibleSessionLimit)
              const selectedSessionInTop = !selectedAgentId || isSettingsActive || topSessions.some(
                (s) =>
                  s.sessionAgent.agentId === selectedAgentId ||
                  s.workers.some((w) => w.agentId === selectedAgentId),
              )

              if (selectedSessionInTop) {
                visibleRegularSessions = topSessions
              } else {
                const selectedSession = regularSessions.find(
                  (s) =>
                    s.sessionAgent.agentId === selectedAgentId ||
                    s.workers.some((w) => w.agentId === selectedAgentId),
                )
                if (selectedSession) {
                  visibleRegularSessions = [...topSessions.slice(0, visibleSessionLimit - 1), selectedSession]
                } else {
                  visibleRegularSessions = topSessions
                }
              }
              hiddenCount = regularSessions.length - visibleRegularSessions.length
            }

            // Determine if sessions in this profile are eligible for project agent promotion
            // Cortex sessions are excluded at the profile level
            const isCortex = sessions.some((s) => s.sessionAgent.archetypeId === 'cortex')

            const renderSession = (session: SessionRow) => {
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
                  onPinSession={onPinSession}
                  onPromoteToProjectAgent={!isCortex && onPromoteToProjectAgent ? () => onPromoteToProjectAgent(sid) : undefined}
                  onOpenProjectAgentSettings={onOpenProjectAgentSettings ? () => onOpenProjectAgentSettings(sid) : undefined}
                  onDemoteProjectAgent={onDemoteProjectAgent ? () => { void onDemoteProjectAgent(sid) } : undefined}
                  onViewCreationHistory={
                    Boolean(session.sessionAgent.projectAgent?.creatorSessionId) &&
                    sessionAgentIds.has(session.sessionAgent.projectAgent!.creatorSessionId!)
                      ? () => onSelect(session.sessionAgent.projectAgent!.creatorSessionId!)
                      : undefined
                  }
                  onChangeSessionModel={onChangeSessionModel ? () => onChangeSessionModel(sid) : undefined}
                  onUseProjectDefault={onUseProjectDefault ? () => onUseProjectDefault(sid) : undefined}
                  isMutedSession={mutedAgents?.has(sid)}
                  onToggleMute={onToggleMute ? () => onToggleMute(sid) : undefined}
                  getCreatorAttribution={getCreatorAttribution}
                />
              )
            }

            return (
              <>
                <ul className="space-y-0.5">
                  {/* Project agents always pinned at top */}
                  {projectAgentSessions.map(renderSession)}
                  {/* Pinned sessions always visible, sorted by pin time */}
                  {pinnedSessions.map(renderSession)}
                  {/* Regular sessions below */}
                  {visibleRegularSessions.map(renderSession)}
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
              </>
            )
          })()}
        </div>
      ) : null}
    </>
  )
})
