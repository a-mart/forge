import { SquarePen, X } from 'lucide-react'
import { ChangeCwdDialog } from './ChangeCwdDialog'
import { ForkSessionDialog } from './ForkSessionDialog'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable'
import { buildProfileTreeRows } from '@/lib/agent-hierarchy'
import type { ProfileTreeRow } from '@/lib/agent-hierarchy'
import { inferModelPreset } from '@/lib/model-preset'
import { useProviderUsage } from '@/hooks/use-provider-usage'
import { toggleMute, getMutedAgents, setMutedAgents, MUTE_CHANGE_EVENT } from '@/lib/notification-service'
import { cn } from '@/lib/utils'
import type {
  ManagerModelPreset,
  ManagerReasoningLevel,
  ProjectAgentInfo,
} from '@forge/protocol'

// Extracted sub-components
import { SidebarSearch } from './agent-sidebar/SidebarSearch'
import { SidebarFooter } from './agent-sidebar/SidebarFooter'
import { ProfileGroup } from './agent-sidebar/ProfileGroup'
import { CortexSection } from './agent-sidebar/CortexSection'
import { SortableProfileGroup } from './agent-sidebar/SortableProfileGroup'
import {
  CreateSessionDialog,
  RenameSessionDialog,
  RenameProfileDialog,
  DeleteSessionDialog,
  ChangeModelDialog,
} from './agent-sidebar/dialogs'
import { ProjectAgentSettingsSheet } from './project-agent/ProjectAgentSettingsSheet'
import { injectGlowPulseStyle } from './agent-sidebar'
import { useCortexReviewBadge, useSidebarPrefs, useSidebarTreeState } from './agent-sidebar/hooks'
import type { AgentSidebarProps } from './agent-sidebar/types'

// Inject subtle glow pulse keyframes once
injectGlowPulseStyle()

export const AgentSidebar = React.memo(function AgentSidebar({
  connected,
  wsUrl,
  agents,
  profiles,
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isPlaywrightActive = false,
  isStatsActive = false,
  showPlaywrightNav = false,
  isMobileOpen = false,
  onMobileClose,
  onAddManager,
  onSelectAgent,
  onDeleteAgent,
  onDeleteManager,
  onOpenSettings,
  onOpenCortexReview,
  onOpenPlaywright,
  onOpenStats,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onRenameSession,
  onPinSession,
  onRenameProfile,
  onForkSession,
  onMarkUnread,
  onMarkAllRead,
  onUpdateManagerModel,
  onUpdateManagerCwd,
  onBrowseDirectory,
  onValidateDirectory,
  onRequestSessionWorkers,
  onReorderProfiles,
  onSetSessionProjectAgent,
  onGetProjectAgentConfig,
  onListProjectAgentReferences,
  onGetProjectAgentReference,
  onSetProjectAgentReference,
  onDeleteProjectAgentReference,
  onRequestProjectAgentRecommendations,
  onCreateAgentCreator,
}: AgentSidebarProps) {
  const treeRows = useMemo(() => buildProfileTreeRows(agents, profiles), [agents, profiles])
  const hasCortexProfile = useMemo(() => profiles.some((profile) => profile.profileId === 'cortex'), [profiles])

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const {
    collapsedProfileIds,
    toggleProfileCollapsed,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    showModelIcons,
    showProviderUsage,
  } = useSidebarPrefs()
  const {
    activeDragId,
    setActiveDragId,
    expandedSessionIds,
    expandedWorkerListSessionIds,
    regularRows,
    cortexRow,
    parsedSearch,
    isSearchActive,
    matchCount,
    toggleSessionCollapsed,
    showMoreSessions,
    showLessSessions,
    toggleWorkerListExpanded,
    getVisibleSessionLimit,
  } = useSidebarTreeState({
    treeRows,
    searchQuery,
    onRequestSessionWorkers,
  })
  const cortexOutstandingReviewCount = useCortexReviewBadge({ connected, hasCortexProfile, wsUrl })
  const [usagePanelOpen, setUsagePanelOpen] = useState(false)
  const handleToggleUsagePanel = useCallback(() => setUsagePanelOpen(prev => !prev), [])
  const handleCloseUsagePanel = useCallback(() => setUsagePanelOpen(false), [])
  const { data: providerUsage, loading: providerUsageLoading, refetch: refetchProviderUsage } = useProviderUsage(showProviderUsage)
  const [mutedAgentsState, setMutedAgentsState] = useState<Set<string>>(() => getMutedAgents())

  // Re-read mute state on custom event (same-tab) and storage event (cross-tab)
  useEffect(() => {
    const updateMuted = () => setMutedAgentsState(getMutedAgents())
    window.addEventListener(MUTE_CHANGE_EVENT, updateMuted)
    window.addEventListener('storage', updateMuted)
    return () => {
      window.removeEventListener(MUTE_CHANGE_EVENT, updateMuted)
      window.removeEventListener('storage', updateMuted)
    }
  }, [])

  const [createTarget, setCreateTarget] = useState<{ profileId: string; profileLabel: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ agentId: string; label: string } | null>(null)
  const [renameProfileTarget, setRenameProfileTarget] = useState<{ profileId: string; displayName: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ agentId: string; label: string } | null>(null)
  const [forkTarget, setForkTarget] = useState<{ sourceAgentId: string } | null>(null)
  const [changeModelTarget, setChangeModelTarget] = useState<{
    profileId: string
    profileLabel: string
    currentPreset: ManagerModelPreset | undefined
    currentReasoningLevel: ManagerReasoningLevel | undefined
  } | null>(null)
  const [changeCwdTarget, setChangeCwdTarget] = useState<{
    profileId: string
    profileLabel: string
    currentCwd: string
  } | null>(null)
  const [projectAgentTarget, setProjectAgentTarget] = useState<{
    agentId: string
    sessionLabel: string
    currentProjectAgent: ProjectAgentInfo | null
  } | null>(null)

  const handleForkSetTarget = useCallback((sourceAgentId: string) => setForkTarget({ sourceAgentId }), [])

  const getCreatorAttribution = useCallback((creatorAgentId: string): string | null => {
    const creator = agents.find((a) => a.agentId === creatorAgentId)
    if (!creator) return null
    if (creator.projectAgent?.handle) return creator.projectAgent.handle
    return creator.sessionLabel || creator.displayName || null
  }, [agents])

  const handleSelectAgent = useCallback((agentId: string) => {
    onSelectAgent(agentId)
    onMobileClose?.()
  }, [onSelectAgent, onMobileClose])

  const handleOpenSettings = useCallback(() => {
    onOpenSettings()
    onMobileClose?.()
  }, [onOpenSettings, onMobileClose])

  const handleOpenCortexReview = useCallback((agentId: string) => {
    onOpenCortexReview?.(agentId)
    onMobileClose?.()
  }, [onOpenCortexReview, onMobileClose])

  const handleOpenPlaywright = useCallback(() => {
    onOpenPlaywright?.()
    onMobileClose?.()
  }, [onOpenPlaywright, onMobileClose])

  const handleOpenStats = useCallback(() => {
    onOpenStats?.()
    onMobileClose?.()
  }, [onOpenStats, onMobileClose])

  const handleRequestCreateSession = useCallback((profileId: string) => {
    const profile = profiles.find((entry) => entry.profileId === profileId)
    setCreateTarget({
      profileId,
      profileLabel: profile?.displayName || profileId,
    })
  }, [profiles])

  const handleConfirmCreateSession = useCallback((profileId: string, name?: string) => {
    onCreateSession?.(profileId, name)
    setCreateTarget(null)
  }, [onCreateSession])

  const handleRequestRename = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setRenameTarget({
      agentId,
      label: agent.sessionLabel || agent.displayName || agent.agentId,
    })
  }, [agents])

  const handleConfirmRename = useCallback((agentId: string, label: string) => {
    onRenameSession?.(agentId, label)
    setRenameTarget(null)
  }, [onRenameSession])

  const handleRequestRenameProfile = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.profileId === profileId)
    if (!profile) return
    setRenameProfileTarget({
      profileId,
      displayName: profile.displayName,
    })
  }, [profiles])

  const handleConfirmRenameProfile = useCallback((profileId: string, displayName: string) => {
    onRenameProfile?.(profileId, displayName)
    setRenameProfileTarget(null)
  }, [onRenameProfile])

  const handleRequestDelete = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setDeleteTarget({
      agentId,
      label: agent.sessionLabel || agent.displayName || agent.agentId,
    })
  }, [agents])

  const handleConfirmDelete = useCallback((agentId: string) => {
    onDeleteSession?.(agentId)
    setDeleteTarget(null)
  }, [onDeleteSession])

  const handleRequestChangeModel = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.profileId === profileId)
    const defaultSession = agents.find(
      (a) => a.role === 'manager' && (a.profileId === profileId || a.agentId === profileId),
    )
    const currentPreset = defaultSession ? inferModelPreset(defaultSession) : undefined
    const currentReasoningLevel = defaultSession?.model.thinkingLevel as ManagerReasoningLevel | undefined
    setChangeModelTarget({
      profileId,
      profileLabel: profile?.displayName || profileId,
      currentPreset,
      currentReasoningLevel,
    })
  }, [agents, profiles])

  const handleConfirmChangeModel = useCallback((profileId: string, model: ManagerModelPreset, reasoningLevel?: ManagerReasoningLevel) => {
    onUpdateManagerModel?.(profileId, model, reasoningLevel)
    setChangeModelTarget(null)
  }, [onUpdateManagerModel])

  const handleRequestChangeCwd = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.profileId === profileId)
    const defaultSession = agents.find(
      (a) => a.role === 'manager' && (a.profileId === profileId || a.agentId === profileId),
    )
    setChangeCwdTarget({
      profileId,
      profileLabel: profile?.displayName || profileId,
      currentCwd: defaultSession?.cwd || '',
    })
  }, [agents, profiles])

  const handleConfirmChangeCwd = useCallback(async (profileId: string, cwd: string) => {
    if (!onUpdateManagerCwd) return
    await onUpdateManagerCwd(profileId, cwd)
    setChangeCwdTarget(null)
  }, [onUpdateManagerCwd])

  const handlePromoteToProjectAgent = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setProjectAgentTarget({
      agentId,
      sessionLabel: agent.sessionLabel || agent.displayName || agent.agentId,
      currentProjectAgent: null,
    })
  }, [agents])

  const handleOpenProjectAgentSettings = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setProjectAgentTarget({
      agentId,
      sessionLabel: agent.sessionLabel || agent.displayName || agent.agentId,
      currentProjectAgent: agent.projectAgent ?? null,
    })
  }, [agents])

  const handleDemoteProjectAgent = useCallback(async (agentId: string) => {
    await onSetSessionProjectAgent?.(agentId, null)
  }, [onSetSessionProjectAgent])

  const handleSaveProjectAgent = useCallback(async (agentId: string, projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string; capabilities?: import('@forge/protocol').ProjectAgentCapability[] }) => {
    await onSetSessionProjectAgent?.(agentId, projectAgent)
  }, [onSetSessionProjectAgent])

  const handleToggleMute = useCallback((agentId: string) => {
    toggleMute(agentId)
  }, [])

  const handleMuteAllSessions = useCallback((sessionAgentIds: string[], mute: boolean) => {
    const current = getMutedAgents()
    for (const id of sessionAgentIds) {
      if (mute) {
        current.add(id)
      } else {
        current.delete(id)
      }
    }
    setMutedAgents(current)
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = event
    if (!over || active.id === over.id || !onReorderProfiles) return

    const currentIds = regularRows.map((row) => row.profile.profileId)
    const oldIndex = currentIds.indexOf(active.id as string)
    const newIndex = currentIds.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return

    const newOrder = arrayMove(currentIds, oldIndex, newIndex)
    onReorderProfiles(newOrder)
  }, [onReorderProfiles, regularRows, setActiveDragId])

  const profileGroupContent = useCallback((treeRow: ProfileTreeRow, dragHandleRef?: (element: HTMLElement | null) => void, dragHandleListeners?: Record<string, unknown>) => (
    <ProfileGroup
      treeRow={treeRow}
      statuses={statuses}
      unreadCounts={unreadCounts}
      selectedAgentId={selectedAgentId}
      isSettingsActive={isSettingsActive}
      isCollapsed={isSearchActive ? false : collapsedProfileIds.has(treeRow.profile.profileId)}
      collapsedSessionIds={expandedSessionIds}
      visibleSessionLimit={getVisibleSessionLimit(treeRow.profile.profileId)}
      expandedWorkerListSessionIds={expandedWorkerListSessionIds}
      onToggleProfileCollapsed={toggleProfileCollapsed}
      onToggleSessionCollapsed={toggleSessionCollapsed}
      onShowMoreSessions={showMoreSessions}
      onShowLessSessions={showLessSessions}
      onToggleWorkerListExpanded={toggleWorkerListExpanded}
      onSelect={handleSelectAgent}
      onDeleteAgent={onDeleteAgent}
      onDeleteManager={onDeleteManager}
      onOpenSettings={handleOpenSettings}
      onCreateSession={onCreateSession ? handleRequestCreateSession : undefined}
      onStopSession={onStopSession}
      onResumeSession={onResumeSession}
      onDeleteSession={handleRequestDelete}
      onRequestRenameSession={handleRequestRename}
      onRequestRenameProfile={onRenameProfile ? handleRequestRenameProfile : undefined}
      onForkSession={onForkSession ? handleForkSetTarget : undefined}
      onMarkUnread={onMarkUnread}
      onMarkAllRead={onMarkAllRead}
      onChangeModel={onUpdateManagerModel ? handleRequestChangeModel : undefined}
      onChangeCwd={onUpdateManagerCwd ? handleRequestChangeCwd : undefined}
      showModelIcons={showModelIcons}
      highlightQuery={isSearchActive ? parsedSearch.term : undefined}
      dragHandleRef={dragHandleRef}
      dragHandleListeners={dragHandleListeners}
      onPromoteToProjectAgent={onSetSessionProjectAgent ? handlePromoteToProjectAgent : undefined}
      onOpenProjectAgentSettings={onSetSessionProjectAgent ? handleOpenProjectAgentSettings : undefined}
      onPinSession={onPinSession}
      onDemoteProjectAgent={onSetSessionProjectAgent ? handleDemoteProjectAgent : undefined}
      onCreateAgentCreator={onCreateAgentCreator}
      mutedAgents={mutedAgentsState}
      onToggleMute={handleToggleMute}
      onMuteAllSessions={handleMuteAllSessions}
      getCreatorAttribution={getCreatorAttribution}
    />
  ), [
    statuses, unreadCounts, selectedAgentId, isSettingsActive, isSearchActive,
    collapsedProfileIds, expandedSessionIds, expandedWorkerListSessionIds,
    toggleProfileCollapsed, toggleSessionCollapsed, showMoreSessions, showLessSessions,
    toggleWorkerListExpanded, handleSelectAgent, onDeleteAgent, onDeleteManager, handleOpenSettings,
    onCreateSession, handleRequestCreateSession, onStopSession, onResumeSession, handleRequestDelete,
    handleRequestRename, onRenameProfile, handleRequestRenameProfile, onForkSession, handleForkSetTarget,
    onMarkUnread, onMarkAllRead, onUpdateManagerModel, handleRequestChangeModel,
    onUpdateManagerCwd, handleRequestChangeCwd, showModelIcons, parsedSearch.term,
    getVisibleSessionLimit,
    onSetSessionProjectAgent, handlePromoteToProjectAgent, handleOpenProjectAgentSettings,
    onPinSession, handleDemoteProjectAgent, onCreateAgentCreator, mutedAgentsState,
    handleToggleMute, handleMuteAllSessions, getCreatorAttribution,
  ])

  const sidebarContent = (
    <aside
      data-tour="sidebar"
      className={cn(
        'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        'max-md:w-full md:w-[20rem] md:min-w-[20rem] md:shrink-0',
      )}
    >
      <div className="mb-2 flex h-[62px] shrink-0 items-center gap-2 border-b border-sidebar-border px-2">
        <button
          type="button"
          onClick={onAddManager}
          className="flex min-h-[44px] flex-1 items-center gap-2 rounded-md p-2 text-sm transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
          title="Create project"
          aria-label="Add project"
        >
          <SquarePen aria-hidden="true" className="h-4 w-4" />
          <span>New Project</span>
        </button>
        <div className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground">
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              connected ? 'bg-emerald-500' : 'bg-amber-500',
            )}
            title={connected ? 'Connected' : 'Reconnecting'}
          />
          <span className="hidden xl:inline">{connected ? 'Live' : 'Retrying'}</span>
        </div>
        {onMobileClose ? (
          <button
            type="button"
            onClick={onMobileClose}
            className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground md:hidden"
            aria-label="Close sidebar"
          >
            <X className="size-5" />
          </button>
        ) : null}
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 pb-2 [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border [&::-webkit-scrollbar-thumb:hover]:bg-sidebar-border/80"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--sidebar-border) transparent',
        }}
      >
        {/* Pinned Cortex entry */}
        {cortexRow ? (
          <CortexSection
            cortexRow={cortexRow}
              statuses={statuses}
              unreadCounts={unreadCounts}
              selectedAgentId={selectedAgentId}
              isSettingsActive={isSettingsActive}
              isCollapsed={isSearchActive ? false : collapsedProfileIds.has('cortex')}
              collapsedSessionIds={expandedSessionIds}
              visibleSessionLimit={getVisibleSessionLimit('cortex')}
              expandedWorkerListSessionIds={expandedWorkerListSessionIds}
              onToggleCollapsed={toggleProfileCollapsed}
              onToggleSessionCollapsed={toggleSessionCollapsed}
              onShowMoreSessions={showMoreSessions}
              onShowLessSessions={showLessSessions}
              onToggleWorkerListExpanded={toggleWorkerListExpanded}
              onSelect={handleSelectAgent}
              onDeleteAgent={onDeleteAgent}
              onOpenSettings={handleOpenSettings}
              onOpenCortexReview={handleOpenCortexReview}
              outstandingReviewCount={cortexOutstandingReviewCount}
              onCreateSession={onCreateSession ? handleRequestCreateSession : undefined}
              onStopSession={onStopSession}
              onResumeSession={onResumeSession}
              onDeleteSession={handleRequestDelete}
              onRequestRenameSession={handleRequestRename}
              onRequestRenameProfile={onRenameProfile ? handleRequestRenameProfile : undefined}
              onForkSession={onForkSession ? handleForkSetTarget : undefined}
              onMarkUnread={onMarkUnread}
              onMarkAllRead={onMarkAllRead}
              onChangeModel={onUpdateManagerModel ? handleRequestChangeModel : undefined}
              highlightQuery={isSearchActive ? parsedSearch.term : undefined}
              mutedAgents={mutedAgentsState}
              onToggleMute={handleToggleMute}
              onMuteAllSessions={handleMuteAllSessions}
            />
        ) : null}

        {/* Search bar below Cortex, above profile sections */}
        <SidebarSearch
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchInputRef={searchInputRef}
        />

        {isSearchActive ? (
          <div className="px-1 pb-1">
            <h2 className="text-xs font-semibold text-muted-foreground">
              {matchCount} match{matchCount !== 1 ? 'es' : ''}
            </h2>
          </div>
        ) : null}

        {isSearchActive && regularRows.length === 0 && !cortexRow ? (
          <p className="rounded-md px-3 py-4 text-center text-xs text-muted-foreground">
            No matches found.
          </p>
        ) : regularRows.length === 0 && !isSearchActive ? (
          <p className="rounded-md bg-sidebar-accent/50 px-3 py-4 text-center text-xs text-muted-foreground">
            No active agents.
          </p>
        ) : (() => {
          const dndEnabled = !isSearchActive && onReorderProfiles && regularRows.length > 1
          const sortableIds = regularRows.map((row) => row.profile.profileId)
          const activeDragRow = activeDragId ? regularRows.find((row) => row.profile.profileId === activeDragId) : null

          if (dndEnabled) {
            return (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(event) => setActiveDragId(event.active.id as string)}
                onDragCancel={() => setActiveDragId(null)}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  <ul className="mt-2 space-y-1">
                    {regularRows.map((treeRow) => (
                      <SortableProfileGroup key={treeRow.profile.profileId} treeRow={treeRow}>
                        {(dragHandleRef, dragHandleListeners) => profileGroupContent(treeRow, dragHandleRef, dragHandleListeners)}
                      </SortableProfileGroup>
                    ))}
                  </ul>
                </SortableContext>
                <DragOverlay>
                  {activeDragRow ? (
                    <div className="rounded-md border border-sidebar-border bg-sidebar shadow-lg">
                      <div className="flex items-center gap-1.5 px-3 py-2">
                        <span className="text-sm font-semibold">{activeDragRow.profile.displayName}</span>
                      </div>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            )
          }

          return (
            <ul className="mt-2 space-y-1">
              {regularRows.map((treeRow) => (
                <li key={treeRow.profile.profileId}>
                  {profileGroupContent(treeRow)}
                </li>
              ))}
            </ul>
          )
        })()}
      </div>

      <SidebarFooter
        isSettingsActive={isSettingsActive}
        isPlaywrightActive={isPlaywrightActive}
        isStatsActive={isStatsActive}
        showPlaywrightNav={showPlaywrightNav}
        showProviderUsage={showProviderUsage}
        providerUsage={providerUsage}
        providerUsageLoading={providerUsageLoading}
        usagePanelOpen={usagePanelOpen}
        onToggleUsagePanel={handleToggleUsagePanel}
        onCloseUsagePanel={handleCloseUsagePanel}
        onRefetchProviderUsage={refetchProviderUsage}
        onOpenSettings={handleOpenSettings}
        onOpenPlaywright={handleOpenPlaywright}
        onOpenStats={handleOpenStats}
      />
    </aside>
  )

  return (
    <>
      {/* Desktop: render inline */}
      <div className="hidden md:flex md:shrink-0">
        {sidebarContent}
      </div>

      {/* Mobile: render as overlay */}
      <div
        className={cn(
          'fixed inset-0 z-40 md:hidden',
          isMobileOpen ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <div
          className={cn(
            'absolute inset-0 bg-black/50 transition-opacity duration-200',
            isMobileOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={onMobileClose}
          aria-hidden="true"
        />
        <div
          className={cn(
            'relative z-10 h-full w-full transition-transform duration-200 ease-out',
            isMobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {sidebarContent}
        </div>
      </div>

      {/* Create session dialog */}
      {createTarget ? (
        <CreateSessionDialog
          profileId={createTarget.profileId}
          profileLabel={createTarget.profileLabel}
          onConfirm={handleConfirmCreateSession}
          onClose={() => setCreateTarget(null)}
        />
      ) : null}

      {/* Rename session dialog */}
      {renameTarget ? (
        <RenameSessionDialog
          agentId={renameTarget.agentId}
          currentLabel={renameTarget.label}
          onConfirm={handleConfirmRename}
          onClose={() => setRenameTarget(null)}
        />
      ) : null}

      {/* Rename profile dialog */}
      {renameProfileTarget ? (
        <RenameProfileDialog
          profileId={renameProfileTarget.profileId}
          currentName={renameProfileTarget.displayName}
          onConfirm={handleConfirmRenameProfile}
          onClose={() => setRenameProfileTarget(null)}
        />
      ) : null}

      {/* Delete session confirmation dialog */}
      {deleteTarget ? (
        <DeleteSessionDialog
          agentId={deleteTarget.agentId}
          sessionLabel={deleteTarget.label}
          onConfirm={handleConfirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}

      {/* Fork session dialog */}
      {forkTarget && onForkSession ? (
        <ForkSessionDialog
          onConfirm={(name) => {
            onForkSession(forkTarget.sourceAgentId, name)
            setForkTarget(null)
          }}
          onClose={() => setForkTarget(null)}
        />
      ) : null}

      {/* Change model dialog */}
      {changeModelTarget && onUpdateManagerModel ? (
        <ChangeModelDialog
          wsUrl={wsUrl}
          profileId={changeModelTarget.profileId}
          profileLabel={changeModelTarget.profileLabel}
          currentPreset={changeModelTarget.currentPreset}
          currentReasoningLevel={changeModelTarget.currentReasoningLevel}
          onConfirm={handleConfirmChangeModel}
          onClose={() => setChangeModelTarget(null)}
        />
      ) : null}

      {/* Change CWD dialog */}
      {changeCwdTarget && onUpdateManagerCwd && onBrowseDirectory && onValidateDirectory ? (
        <ChangeCwdDialog
          profileId={changeCwdTarget.profileId}
          profileLabel={changeCwdTarget.profileLabel}
          currentCwd={changeCwdTarget.currentCwd}
          onConfirm={handleConfirmChangeCwd}
          onClose={() => setChangeCwdTarget(null)}
          onBrowseDirectory={onBrowseDirectory}
          onValidateDirectory={onValidateDirectory}
        />
      ) : null}

      {/* Project Agent settings sheet */}
      {projectAgentTarget && onSetSessionProjectAgent ? (
        <ProjectAgentSettingsSheet
          agentId={projectAgentTarget.agentId}
          sessionLabel={projectAgentTarget.sessionLabel}
          currentProjectAgent={projectAgentTarget.currentProjectAgent}
          onSave={handleSaveProjectAgent}
          onDemote={handleDemoteProjectAgent}
          onClose={() => setProjectAgentTarget(null)}
          onGetProjectAgentConfig={onGetProjectAgentConfig}
          onListReferences={onListProjectAgentReferences}
          onGetReference={onGetProjectAgentReference}
          onSetReference={onSetProjectAgentReference}
          onDeleteReference={onDeleteProjectAgentReference}
          onRequestRecommendations={onRequestProjectAgentRecommendations}
        />
      ) : null}
    </>
  )
})
