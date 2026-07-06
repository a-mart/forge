import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { reportBuilderConnected } from '@/lib/connection-health-store'
import { AgentSidebarConnected } from '@/components/chat/AgentSidebarConnected'
import { ArtifactsSidebar } from '@/components/chat/ArtifactsSidebar'
import { ActivityRail } from '@/components/index-page/ActivityRail'
import { ArchiveView } from '@/components/index-page/ArchiveView'
import { type MessageSourceView } from '@/components/chat/ChatHeader'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { type MessageInputHandle } from '@/components/chat/MessageInput'
import { type MessageListHandle } from '@/components/chat/MessageList'
import { ChatSidePanels } from '@/components/index-page/ChatSidePanels'
import { ChatWorkspace } from '@/components/index-page/ChatWorkspace'
import { FileBrowserPanel } from '@/components/file-browser/FileBrowserPanel'
import { FileBrowserSidebar } from '@/components/file-browser/FileBrowserSidebar'
import { FileDirtyConfirmDialog } from '@/components/file-browser/FileDirtyConfirmDialog'
import { FILE_BROWSER_INLINE_EDITING_ENABLED } from '@/components/file-browser/file-editor-feature-gates'
import type { useFileEditorCoordinator } from '@/components/file-browser/use-file-editor-coordinator'
import { DiffViewerContent } from '@/components/diff-viewer/DiffViewerDialog'
import { GlobalDialogs } from '@/components/index-page/GlobalDialogs'
import { StatsPage } from '@/components/index-page/StatsPage'
import { shouldEnableCodexMention } from '@/components/index-page/codex-mention-utils'
import { resolveWorkerFetchManagerId } from '@/lib/agent-hierarchy'
import { hasProjectManagers } from '@/lib/onboarding-ui'
import {
  DEFAULT_MANAGER_AGENT_ID,
  type ActiveSurface,
  type ActiveView,
  type AppRouteState,
  type StatsTab,
} from '@/hooks/index-page/use-route-state'
import { fetchModelCacheVisualizationEnabled } from '@/components/settings/model-cache-visualization-api'
import { buildModelCacheHeaderSummary } from '@/components/chat/model-cache'
import { deriveMissingPendingChoiceIds } from '@/lib/ws-client/utils'
import { useWsConnection } from '@/hooks/index-page/use-ws-connection'
import { useManagerActions } from '@/hooks/index-page/use-manager-actions'
import { useActiveAgent } from '@/hooks/index-page/use-active-agent'
import { useWorkspacePanels } from '@/hooks/index-page/use-workspace-panels'
import { useTranscriptController } from '@/hooks/index-page/use-transcript-controller'
import { useSessionActions } from '@/hooks/index-page/use-session-actions'
import { useFileDrop } from '@/hooks/index-page/use-file-drop'
import {
  getProjectAgentSuggestions,
  shouldLoadExternalProjectAgentDirectory,
} from '@/hooks/index-page/project-agent-suggestions'
import { useSlashCommands } from '@/hooks/index-page/use-slash-commands'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import { useDynamicFavicon } from '@/hooks/use-dynamic-favicon'
import { useTerminalPanel } from '@/hooks/useTerminalPanel'
import type {
  AgentDescriptor,
  ProjectAgentExternalDirectoryEntry,
} from '@forge/protocol'

type FileEditorCoordinator = ReturnType<typeof useFileEditorCoordinator>

function isCortexDiffViewerSession(agent: AgentDescriptor | null | undefined): boolean {
  return Boolean(
    agent &&
      (agent.profileId === 'cortex' ||
        agent.archetypeId === 'cortex' ||
        agent.sessionPurpose === 'cortex_review'),
  )
}

type BuilderNavigationState =
  | { view: 'chat'; agentId: string }
  | { view: 'settings'; surface: ActiveSurface }
  | { view: 'stats'; statsTab?: StatsTab }
  | { view: 'archive'; surface: ActiveSurface }

interface BuilderSurfaceProps {
  wsUrl: string
  routeState: AppRouteState
  activeView: ActiveView
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
  collaborationModeSwitch?: {
    activeSurface: ActiveSurface
    onSelectSurface: (surface: ActiveSurface) => void
  }
}

export function BuilderSurface({
  wsUrl,
  routeState,
  activeView,
  navigateToRoute: navigateToOuterRoute,
  collaborationModeSwitch,
}: BuilderSurfaceProps) {
  const navigateToRoute = useCallback((nextRouteState: BuilderNavigationState, replace = false) => {
    if (nextRouteState.view === 'chat') {
      navigateToOuterRoute({
        ...nextRouteState,
        surface: 'builder',
      }, replace)
      return
    }

    navigateToOuterRoute(nextRouteState, replace)
  }, [navigateToOuterRoute])

  // Shell-level refs shared across the extracted controllers.  Keeping these at
  // the shell (not inside a hook) is what breaks the apparent ordering cycle
  // between active-agent derivation and the workspace panels: the route-sync
  // effect reads `fileEditorCoordinatorRef.current` lazily, and the shell keeps
  // the ref current during render once the panels hook has created the
  // coordinator — so every effect (regardless of which hook registered it) sees
  // the live coordinator.
  const messageInputRef = useRef<MessageInputHandle | null>(null)
  const messageListRef = useRef<MessageListHandle | null>(null)
  const previousAgentsByIdRef = useRef<Map<string, AgentDescriptor>>(new Map())
  const fileEditorCoordinatorRef = useRef<FileEditorCoordinator | null>(null)
  const archiveHydrationRequestedRef = useRef(false)

  const { clientRef, httpClientRef, state, setState } = useWsConnection(wsUrl)

  // Sync builder WS health to the module-level store so ModeSwitch can
  // display the builder connection dot even from the collab surface.
  useEffect(() => {
    reportBuilderConnected(state.connected)
  }, [state.connected])

  useEffect(() => {
    let cancelled = false
    // Route through the origin's target-aware HTTP client (requirement 9)
    // rather than a raw wsUrl, so remote origins carry their credentials.
    void fetchModelCacheVisualizationEnabled(httpClientRef.current ?? wsUrl)
      .then((enabled) => {
        if (!cancelled) {
          clientRef.current?.applyLoadedModelCacheVisualizationSetting(enabled)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [clientRef, httpClientRef, wsUrl])

  useEffect(() => {
    if (activeView !== 'archive') {
      archiveHydrationRequestedRef.current = false
      return
    }
    if (!state.connected || archiveHydrationRequestedRef.current) return
    archiveHydrationRequestedRef.current = true
    clientRef.current?.hydrateArchiveLastUsed().catch((error) => {
      console.warn('Failed to hydrate archive last-used metadata', error)
      archiveHydrationRequestedRef.current = false
    })
  }, [activeView, clientRef, state.connected])

  const {
    onboardingState,
    isMutating: isMutatingOnboardingState,
    error: onboardingError,
    savePreferences: saveOnboardingPreferences,
    skip: skipOnboarding,
  } = useOnboardingState(wsUrl)

  const [messageSourceView, setMessageSourceView] = useState<MessageSourceView>('web')
  const [detailedAllView, setDetailedAllView] = useState(false)
  const [activeWorkExpanded, setActiveWorkExpanded] = useState(false)
  const [externalProjectAgentEntries, setExternalProjectAgentEntries] = useState<ProjectAgentExternalDirectoryEntry[]>([])

  // ── Active-agent derivation + route→subscription sync ──
  const {
    activeAgentId,
    activeAgent,
    activeManagerId,
    activeManagerAgent,
    isActiveManager,
    terminalSessionAgentId,
    activeAgentStatus,
    activeAgentProfileName,
    activeAgentSessionLabel,
    activeAgentLabel,
  } = useActiveAgent({
    state,
    routeState,
    navigateToRoute,
    clientRef,
    fileEditorCoordinatorRef,
    previousAgentsByIdRef,
  })

  const totalUnreadCount = useMemo(() => {
    if (!state.unreadCounts) return 0
    return Object.entries(state.unreadCounts).reduce((sum, [agentId, count]) => {
      if (agentId === activeAgentId) return sum
      return sum + count
    }, 0)
  }, [state.unreadCounts, activeAgentId])

  // Reset Detailed All when leaving All view
  useEffect(() => {
    if (messageSourceView !== 'all') setDetailedAllView(false)
  }, [messageSourceView])

  // Reset local chat chrome when switching active agent/session
  useEffect(() => {
    setDetailedAllView(false)
    setActiveWorkExpanded(false)
  }, [activeAgentId])

  // Derive effective detailed state for hook consumption
  const effectiveDetailedAllView = isActiveManager && messageSourceView === 'all' && detailedAllView

  const activeWorkSnapshot = null

  const modelCacheHeaderSummary =
    state.modelCacheVisualizationEnabled && isActiveManager
      ? buildModelCacheHeaderSummary({
          enabled: true,
          observations: state.modelCacheObservations,
        })
      : null

  const activeAgentRole = activeAgent?.role ?? null
  const activeAgentProfileId = activeAgent?.profileId ?? null
  const activeAgentProfileType = useMemo(
    () => state.profiles.find((profile) => profile.profileId === activeAgentProfileId)?.profileType ?? null,
    [activeAgentProfileId, state.profiles],
  )

  useEffect(() => {
    if (!state.connected || !shouldLoadExternalProjectAgentDirectory({
      activeAgentRole,
      activeProfileId: activeAgentProfileId,
      activeProfileType: activeAgentProfileType,
    })) {
      setExternalProjectAgentEntries([])
      return
    }

    const client = clientRef.current
    if (!client) {
      setExternalProjectAgentEntries([])
      return
    }

    let cancelled = false
    void client.getProjectAgentExternalDirectory()
      .then((result) => {
        if (!cancelled) {
          setExternalProjectAgentEntries(result.entries)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExternalProjectAgentEntries([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    activeAgentProfileId,
    activeAgentProfileType,
    activeAgentRole,
    clientRef,
    state.connected,
    state.promptChangeKey,
  ])

  // Project agents for @mention autocomplete — only when the active agent is a manager session
  const projectAgentSuggestions = useMemo(
    () => getProjectAgentSuggestions(activeAgent, state.agents, externalProjectAgentEntries),
    [activeAgent, externalProjectAgentEntries, state.agents],
  )

  const diffViewerSessionAgent = useMemo(() => {
    if (!activeAgent) {
      return null
    }

    return activeAgent.role === 'manager' ? activeAgent : activeManagerAgent ?? activeAgent
  }, [activeAgent, activeManagerAgent])

  const isDiffViewerCortexSession = isCortexDiffViewerSession(diffViewerSessionAgent)

  const terminalPanel = useTerminalPanel({
    wsUrl,
    sessionAgentId: terminalSessionAgentId,
    sessionCwd: activeManagerAgent?.cwd ?? activeAgent?.cwd ?? null,
    terminals: state.terminals,
    enabled: activeView === 'chat',
    onError: (message) => {
      setState((previous) => ({
        ...previous,
        lastError: message,
      }))
    },
  })

  const isCortexSession = activeAgent?.archetypeId === 'cortex'

  // ── Workspace panels (file browser / diff viewer / artifacts / activity rail) ──
  const panels = useWorkspacePanels({
    wsUrl,
    activeAgentId,
    activeAgent,
    activeManagerAgent,
    terminalSessionAgentId,
    terminalPanel,
    terminalCount: state.terminals.length,
    isCortexSession,
    clientRef,
    messageInputRef,
    navigateToRoute,
  })

  // Keep the shell-level coordinator ref current for the active-agent route-sync
  // effect.  Assigned during render (after panels creates the coordinator) so it
  // is visible to every effect on the next commit, matching the original
  // in-component ordering where the ref always held the live coordinator.
  // eslint-disable-next-line -- deliberate render-time assignment (see comment above); matches original in-component ordering
  fileEditorCoordinatorRef.current = panels.fileEditorCoordinator

  // Workers belonging to the active manager session (for pill bar)
  const sessionWorkers = useMemo(() => {
    if (!activeManagerId) return []
    return state.agents.filter(
      (a) => a.role === 'worker' && a.managerId === activeManagerId,
    )
  }, [activeManagerId, state.agents])

  // Track the active manager's workerCount so the effect re-fires when workers spawn/despawn
  const activeManagerWorkerCount = useMemo(() => {
    if (!activeManagerId) return 0
    const manager = state.agents.find(
      (a) => a.role === 'manager' && a.agentId === activeManagerId,
    )
    return manager?.workerCount ?? 0
  }, [activeManagerId, state.agents])

  // Resolve worker-fetch target from actual active agent context only.
  const workerFetchManagerId = useMemo(
    () => resolveWorkerFetchManagerId(activeAgent),
    [activeAgent],
  )

  useEffect(() => {
    if (!workerFetchManagerId || !clientRef.current) return
    void clientRef.current.getSessionWorkers(workerFetchManagerId).catch(() => {})
  }, [workerFetchManagerId, clientRef, activeManagerWorkerCount])

  // Resolve parent manager label for the worker back-bar
  const parentManagerLabel = useMemo(() => {
    if (activeAgent?.role !== 'worker' || !activeAgent.managerId) return null
    const manager = state.agents.find((a) => a.agentId === activeAgent.managerId)
    if (!manager) return activeAgent.managerId
    if (manager.profileId && manager.sessionLabel) {
      const profile = state.profiles.find((p) => p.profileId === manager.profileId)
      const profileName = profile?.displayName ?? manager.profileId
      return `${profileName} › ${manager.sessionLabel}`
    }
    return manager.displayName ?? manager.agentId
  }, [activeAgent, state.agents, state.profiles])

  // For settings, only show profile-level managers (default sessions or legacy managers without profileId)
  const settingsManagers = useMemo(() => {
    const defaultSessionIds = new Set(state.profiles.map((p) => p.defaultSessionAgentId))
    return state.agents.filter((agent) => {
      if (agent.role !== 'manager') return false
      if (state.profiles.length > 0) {
        return defaultSessionIds.has(agent.agentId) || !agent.profileId
      }
      return true
    })
  }, [state.agents, state.profiles])

  useDynamicFavicon({
    agents: state.agents,
    statuses: state.statuses,
  })

  // ── Transcript / search / feedback / pins / context window / pending response ──
  const transcript = useTranscriptController({
    state,
    activeView,
    activeAgent,
    activeAgentId,
    activeAgentStatus,
    messageSourceView,
    effectiveDetailedAllView,
    messageListRef,
  })
  const { feedback } = transcript
  const isLoading = transcript.isLoading

  const missingPendingChoiceIds = useMemo(
    () => deriveMissingPendingChoiceIds(state.pendingChoiceIds, state.messages, activeAgentId),
    [activeAgentId, state.messages, state.pendingChoiceIds],
  )
  const hasActivePendingChoice = state.pendingChoiceIds.size > 0
  const canStopAllAgents =
    isActiveManager &&
    (activeAgentStatus === 'idle' || activeAgentStatus === 'streaming')

  const autoCompactionInProgress = useMemo(() => {
    if (!activeAgentId) return false
    return state.statuses[activeAgentId]?.contextRecoveryInProgress === true
  }, [activeAgentId, state.statuses])

  const hasCreatedProjectManager = useMemo(() => hasProjectManagers(state.agents), [state.agents])

  const shouldShowWelcomeForm =
    routeState.view === 'chat' &&
    !hasCreatedProjectManager &&
    onboardingState?.status === 'pending'
  const shouldShowCreateManagerState =
    routeState.view === 'chat' &&
    !hasCreatedProjectManager &&
    Boolean(onboardingState && onboardingState.status !== 'pending')

  const { slashCommands } = useSlashCommands({ wsUrl, activeView })

  const {
    isCreateManagerDialogOpen,
    newManagerName,
    newManagerCwd,
    newManagerModelSelection,
    newManagerReasoningLevel,
    scaffoldForgeResources,
    createManagerError,
    browseError,
    isCreatingManager,
    isValidatingDirectory,
    isPickingDirectory,
    handleNewManagerNameChange,
    handleNewManagerCwdChange,
    handleNewManagerModelSelectionChange,
    handleNewManagerReasoningLevelChange,
    handleScaffoldForgeResourcesChange,
    handleOpenCreateManagerDialog,
    handleCreateManagerDialogOpenChange,
    handleBrowseDirectory,
    handleCreateManager,
    managerToDelete,
    deleteManagerError,
    isDeletingManager,
    handleRequestDeleteManager,
    handleConfirmDeleteManager,
    handleCloseDeleteManagerDialog,
    isCompactingManager,
    handleCompactManager,
    isSmartCompactingManager,
    handleSmartCompactManager,
    isStoppingAllAgents,
    handleStopAllAgents,
  } = useManagerActions({
    wsUrl,
    clientRef,
    agents: state.agents,
    activeAgent,
    activeAgentId,
    isActiveManager,
    navigateToRoute,
    setState,
    clearPendingResponseForAgent: transcript.clearPendingResponseForAgent,
  })

  // ── Session / sidebar action handlers ──
  const session = useSessionActions({
    clientRef,
    fileEditorCoordinator: panels.fileEditorCoordinator,
    state,
    activeAgent,
    activeAgentId,
    isActiveManager,
    isLoading,
    navigateToRoute,
    setState,
    visibleMessages: transcript.visibleMessages,
    markPendingResponse: transcript.markPendingResponse,
    handleCompactManager,
    messageInputRef,
    messageListRef,
  })
  const { replyTarget, setReplyTarget, messageForkTarget, setMessageForkTarget } = session

  const {
    isDraggingFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useFileDrop({
    activeView,
    messageInputRef,
  })

  useEffect(() => {
    if (!state.lastSuccess) return
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, lastSuccess: null }))
    }, 4000)
    return () => clearTimeout(timer)
  }, [state.lastSuccess, setState])

  const handleSaveOnboarding = useCallback((input: import('@/lib/onboarding-api').SaveOnboardingPreferencesInput) => {
    void (async () => {
      const nextState = await saveOnboardingPreferences(input)
      if (!nextState) {
        return
      }
      navigateToRoute({ view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID }, true)
    })()
  }, [navigateToRoute, saveOnboardingPreferences])

  const handleSkipOnboarding = useCallback(() => {
    void (async () => {
      const nextState = await skipOnboarding()
      if (!nextState) {
        return
      }
      navigateToRoute({ view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID }, true)
    })()
  }, [navigateToRoute, skipOnboarding])

  const previewSession = useMemo(() => {
    if (!activeAgentId) return null
    const activeDescriptor = state.agents.find((agent) => agent.agentId === activeAgentId)
    if (!activeDescriptor) return null

    const sessionAgentId = activeDescriptor.role === 'manager' ? activeDescriptor.agentId : activeDescriptor.managerId
    const sessionDescriptor = state.agents.find((agent) => agent.agentId === sessionAgentId && agent.role === 'manager')
    if (!sessionDescriptor?.profileId) return null

    return {
      agentId: sessionDescriptor.agentId,
      profileId: sessionDescriptor.profileId,
    }
  }, [activeAgentId, state.agents])

  const showActivityRail = activeView === 'chat'

  const feedbackProfileId = transcript.feedbackProfileId

  return (
    <>
      <FileDirtyConfirmDialog state={panels.fileEditorCoordinator.dialogState} />

      <AgentSidebarConnected
        wsUrl={wsUrl}
        collaborationModeSwitch={collaborationModeSwitch}
        selectedAgentId={activeAgentId}
        isSettingsActive={activeView === 'settings'}
        isStatsActive={activeView === 'stats'}
        isArchiveActive={activeView === 'archive'}
        isMobileOpen={panels.isMobileSidebarOpen}
        onMobileClose={() => panels.setIsMobileSidebarOpen(false)}
        onAddManager={handleOpenCreateManagerDialog}
        onSelectAgent={panels.handleSelectAgent}
        onDeleteAgent={session.handleDeleteAgent}
        onDeleteManager={handleRequestDeleteManager}
        onOpenSettings={() => panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'settings' }, () => {
          navigateToRoute({ view: 'settings', surface: 'builder' })
        })}
        onOpenStats={() => panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'stats' }, () => {
          navigateToRoute({ view: 'stats' })
        })}
        onOpenArchive={() => panels.fileEditorCoordinator.requestFileEditorTransition({ type: 'navigate-route', nextView: 'archive' }, () => {
          navigateToRoute({ view: 'archive', surface: 'builder' })
        })}
        onCreateSession={session.handleCreateSession}
        onStopSession={session.handleStopSession}
        onResumeSession={session.handleResumeSession}
        onDeleteSession={session.handleDeleteSession}
        onArchiveSession={session.handleArchiveSession}
        onArchiveProfile={session.handleArchiveProfile}
        onRenameSession={session.handleRenameSession}
        onPinSession={session.handlePinSession}
        onRenameProfile={session.handleRenameProfile}
        onForkSession={session.handleForkSession}
        onMarkUnread={session.handleMarkUnread}
        onMarkAllRead={session.handleMarkAllRead}
        onUpdateManagerModel={session.handleUpdateManagerModel}
        onUpdateSessionModel={session.handleUpdateSessionModel}
        onUpdateManagerCwd={session.handleUpdateManagerCwd}
        onBrowseDirectory={session.handleBrowseDirectoryForCwd}
        onValidateDirectory={session.handleValidateDirectoryForCwd}
        onRequestSessionWorkers={session.handleRequestSessionWorkers}
        onReorderProfiles={session.handleReorderProfiles}
        onSetSessionProjectAgent={session.handleSetSessionProjectAgent}
        onGetProjectAgentConfig={session.handleGetProjectAgentConfig}
        onGetProjectAgentSharing={session.handleGetProjectAgentSharing}
        onSetProjectAgentSharing={session.handleSetProjectAgentSharing}
        onListProjectAgentReferences={session.handleListProjectAgentReferences}
        onGetProjectAgentReference={session.handleGetProjectAgentReference}
        onSetProjectAgentReference={session.handleSetProjectAgentReference}
        onDeleteProjectAgentReference={session.handleDeleteProjectAgentReference}
        onRequestProjectAgentRecommendations={session.handleRequestProjectAgentRecommendations}
        onCreateAgentCreator={session.handleCreateAgentCreator}
      />

      {showActivityRail ? (
        <ActivityRail items={panels.activityRailItems} />
      ) : null}

      <div
          className="relative flex min-w-0 flex-1"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {activeView === 'chat' && isDraggingFiles ? (
            <div className="pointer-events-none absolute inset-2 z-50 rounded-lg border-2 border-dashed border-primary bg-primary/10" />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && panels.isArtifactsPanelOpen ? (
            <ArtifactsSidebar
              wsUrl={wsUrl}
              managerId={activeManagerId}
              artifacts={transcript.collectedArtifacts}
              isOpen={panels.isArtifactsPanelOpen}
              onClose={panels.handleGuardedArtifactsClose}
              onArtifactClick={panels.handleOpenArtifact}
              activeTab={panels.artifactsPanelTab}
              onActiveTabChange={panels.setArtifactsPanelTab}
              panelMode="rail-selected"
              desktopPlacement="left"
              desktopOnly
            />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && !panels.isArtifactsPanelOpen ? (
            <FileBrowserSidebar
              wsUrl={wsUrl}
              agentId={activeAgentId}
              isOpen={panels.isFileBrowserOpen}
              onClose={panels.handleGuardedToggleFileBrowser}
              onSelectFile={panels.handleGuardedFileBrowserSelectFile}
              onOpenStickyFile={panels.handleFileBrowserOpenStickyFile}
              selectedFile={panels.selectedFileBrowserFile}
              treeSnapshot={panels.fileBrowserTreeSnapshot}
              onTreeSnapshotChange={panels.updateFileBrowserTreeSnapshot}
              worktreeContext={panels.fileBrowserWorktreeContext}
              onClearWorktreeContext={panels.handleGuardedClearFileBrowserWorktreeContext}
              projectResourceProfileId={activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? null}
              projectResourceSessionAgentId={activeManagerAgent?.agentId ?? null}
              desktopPlacement="left"
              desktopOnly
              refreshNonce={panels.fileBrowserRefreshNonce}
              onDeleteEntry={panels.handleFileBrowserDeleteEntry}
            />
          ) : null}

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen && panels.isFileBrowserOpen && panels.selectedFileBrowserFile ? (
            <FileBrowserPanel
              wsUrl={wsUrl}
              agentId={activeAgentId}
              filePath={panels.selectedFileBrowserFile}
              onClose={panels.handleGuardedFileBrowserClosePanel}
              onNavigateToDirectory={panels.handleGuardedFileBrowserNavigateToDirectory}
              tabs={panels.fileBrowserTabs}
              activeTabId={panels.activeFileBrowserTabId}
              previewTabId={panels.previewFileBrowserTabId}
              dirtyTabIds={panels.dirtyFileBrowserTabIds}
              contentScrollSnapshot={panels.activeFileBrowserContentScrollSnapshot}
              onContentScrollSnapshotChange={panels.updateActiveFileBrowserContentScrollSnapshot}
              onActivateTab={panels.activateFileBrowserTab}
              onCloseTab={(tab) => panels.handleRequestCloseFileBrowserTab(tab.id)}
              onStickifyTab={panels.stickifyFileBrowserTab}
              worktreeId={panels.fileBrowserWorktreeContext?.worktreeId ?? null}
              desktopOnly
              resizeHandlePlacement="right"
              inlineEditingEnabled={FILE_BROWSER_INLINE_EDITING_ENABLED}
              editSession={panels.fileEditSession}
              editorSessionKey={panels.activeFileEditorKey}
              refreshNonce={panels.fileBrowserRefreshNonce}
              onContentLoaded={panels.handleFileEditorContentLoaded}
            />
          ) : null}

          <div className="flex min-w-0 flex-1 flex-col">
            {panels.isInlineDiffViewerOpen ? (
              <div className="diff-viewer flex min-h-0 flex-1 flex-col overflow-hidden bg-background" aria-label="Source Control workspace">
                <DiffViewerContent
                  active={panels.isInlineDiffViewerOpen}
                  wsUrl={wsUrl}
                  agentId={activeAgentId}
                  isCortex={isDiffViewerCortexSession}
                  onClose={panels.handleCloseDiffViewer}
                  onBrowseWorktreeFiles={panels.handleBrowseWorktreeFromSourceControl}
                  onRequestSourceControlMutation={panels.handleRequestSourceControlMutation}
                  onSourceControlMutationComplete={panels.handleSourceControlMutationComplete}
                  externalRefreshNonce={panels.sourceControlRefreshNonce}
                  initialRepoTarget={panels.diffViewerInitialState?.initialRepoTarget}
                  initialTab={panels.diffViewerInitialState?.initialTab}
                  initialSha={panels.diffViewerInitialState?.initialSha}
                  initialFile={panels.diffViewerInitialState?.initialFile}
                  initialQuickFilter={panels.diffViewerInitialState?.initialQuickFilter}
                />
              </div>
            ) : activeView === 'settings' ? (
              <SettingsPanel
                wsUrl={wsUrl}
                managers={settingsManagers}
                profiles={state.profiles}
                telegramStatus={state.telegramStatus}
                promptChangeKey={state.promptChangeKey}
                specialistChangeKey={state.specialistChangeKey}
                modelConfigChangeKey={state.modelConfigChangeKey}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
                previewSession={previewSession}
                initialTab={routeState.view === 'settings' ? routeState.settingsTab : undefined}
                initialCollabApiBaseUrl={routeState.view === 'settings' ? routeState.collabApiBaseUrl : undefined}
                initialSkillImportUrl={routeState.view === 'settings' ? routeState.skillImportUrl : undefined}
                onSkillImportUrlConsumed={() => {
                  if (routeState.view === 'settings' && routeState.skillImportUrl) {
                    navigateToOuterRoute({ ...routeState, skillImportUrl: undefined }, true)
                  }
                }}
              />
            ) : activeView === 'stats' ? (
              <StatsPage
                wsUrl={wsUrl}
                routeState={routeState as { view: 'stats'; statsTab?: StatsTab }}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
                onTabChange={(tab) =>
                  navigateToRoute({ view: 'stats', statsTab: tab })
                }
              />
            ) : activeView === 'archive' ? (
              <ArchiveView
                agents={state.agents}
                profiles={state.profiles}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
                onRestoreProfile={session.handleRestoreProfile}
                onRestoreSession={session.handleRestoreSession}
              />
            ) : (
              <ChatWorkspace
                headerProps={{
                  connected: state.connected,
                  activeAgentId,
                  activeAgentLabel,
                  wsUrl,
                  activeAgentProfileName,
                  activeAgentSessionLabel,
                  totalUnreadCount,
                  activeAgentArchetypeId: activeAgent?.archetypeId,
                  activeAgentSessionPurpose: activeAgent?.sessionPurpose,
                  activeAgentStatus,
                  activeAgentRole: activeAgent?.role ?? null,
                  activeAgentCreatedAt: activeAgent?.createdAt ?? null,
                  activeAgentUpdatedAt: activeAgent?.updatedAt ?? null,
                  channelView: messageSourceView,
                  onChannelViewChange: setMessageSourceView,
                  detailedAllView: effectiveDetailedAllView,
                  onDetailedAllViewChange: undefined,
                  contextWindowUsage: transcript.contextWindowUsage,
                  modelCacheHeaderSummary,
                  activeWorkSnapshot,
                  activeWorkAgents: state.agents,
                  activeWorkStatuses: state.statuses,
                  onNavigateToActiveWorkWorker: isActiveManager ? panels.handleSelectAgent : undefined,
                  compactionCount: activeAgent?.compactionCount,
                  showCompact: isActiveManager,
                  compactInProgress: isCompactingManager,
                  onCompact: () => void handleCompactManager(),
                  showSmartCompact: isActiveManager,
                  smartCompactInProgress: isSmartCompactingManager,
                  onSmartCompact: () => void handleSmartCompactManager(),
                  autoCompactionInProgress,
                  pinnedCount: transcript.pinnedCount,
                  pinnedMessageIds: transcript.pinnedMessageIds,
                  onScrollToMessage: transcript.handleScrollToMessage,
                  onClearAllPins: session.handleClearAllPins,
                  showStopAll: isActiveManager,
                  stopAllInProgress: isStoppingAllAgents,
                  stopAllDisabled: !state.connected || !canStopAllAgents,
                  onStopAll: () => void handleStopAllAgents(),
                  showNewChat: isActiveManager,
                  onNewChat: session.handleNewChat,
                  isArtifactsPanelOpen: panels.isArtifactsPanelOpen,
                  onToggleArtifactsPanel: panels.handleGuardedToggleArtifactsPanel,
                  isTerminalPanelOpen: terminalPanel.isPanelVisible,
                  terminalCount: state.terminals.length,
                  onToggleTerminalPanel: terminalSessionAgentId ? terminalPanel.togglePanel : undefined,
                  onOpenDiffViewer: panels.handleOpenDiffViewerModal,
                  isFileBrowserOpen: panels.isFileBrowserOpen,
                  onToggleFileBrowser: panels.handleGuardedToggleFileBrowser,
                  onToggleMobileSidebar: () =>
                    panels.setIsMobileSidebarOpen((previous) => !previous),
                  showDesktopWorkspaceActions: !showActivityRail,
                  sessionFeedbackVote: isActiveManager && activeAgentId ? feedback.getVote(activeAgentId) : null,
                  sessionFeedbackHasComment: isActiveManager && activeAgentId ? feedback.hasComment(activeAgentId) : false,
                  onSessionFeedbackVote:
                    isActiveManager && feedbackProfileId ? feedback.submitVote : undefined,
                  onSessionFeedbackComment:
                    isActiveManager && feedbackProfileId ? feedback.submitComment : undefined,
                  onSessionFeedbackClearComment:
                    isActiveManager && feedbackProfileId ? feedback.clearComment : undefined,
                  isFeedbackSubmitting: feedback.isSubmitting,
                }}
                lastError={state.lastError}
                lastSuccess={state.lastSuccess}
                restartRecovery={state.restartRecovery}
                onResumeRestartRecovery={() => clientRef.current?.resumeRestartRecovery()}
                onDismissRestartRecovery={() => clientRef.current?.dismissRestartRecovery()}
                chatSearchBarProps={{ search: transcript.chatSearch }}
                showWelcomeForm={shouldShowWelcomeForm}
                showCreateManagerState={shouldShowCreateManagerState}
                welcomeCalloutProps={{
                  mode: 'first-launch',
                  state: onboardingState,
                  isBusy: isMutatingOnboardingState,
                  error: onboardingError,
                  onSave: handleSaveOnboarding,
                  onSkipForNow: handleSkipOnboarding,
                }}
                readyCalloutProps={{
                  mode: 'ready',
                  state: onboardingState,
                  isBusy: isMutatingOnboardingState,
                  error: onboardingError,
                  onCreateManager: handleOpenCreateManagerDialog,
                }}
                isMessageListHidden={
                  terminalPanel.panelMode === 'maximized' &&
                  !terminalPanel.isMobile &&
                  terminalPanel.isPanelVisible
                }
                messageListRef={messageListRef}
                messageListProps={{
                  messages: transcript.visibleMessages,
                  agents: state.agents,
                  isLoading,
                  wsUrl,
                  activeAgentId,
                  projectAgent: activeAgent?.projectAgent,
                  onSuggestionClick: session.handleSuggestionClick,
                  onArtifactClick: panels.handleOpenArtifact,
                  onForkFromMessage: activeAgentId ? session.handleForkFromMessage : undefined,
                  onPinMessage: isActiveManager && activeAgentId ? session.handlePinMessage : undefined,
                  onStopExternalThread: session.handleStopSession,
                  onReplyToMessage: session.handleReplyToMessage,
                  getVote: feedbackProfileId ? feedback.getVote : undefined,
                  hasComment: feedbackProfileId ? feedback.hasComment : undefined,
                  onFeedbackVote: feedbackProfileId ? feedback.submitVote : undefined,
                  onFeedbackComment: feedbackProfileId ? feedback.submitComment : undefined,
                  onFeedbackClearComment: feedbackProfileId ? feedback.clearComment : undefined,
                  isFeedbackSubmitting: feedback.isSubmitting,
                  onChoiceSubmit: session.handleChoiceSubmit,
                  onChoiceCancel: session.handleChoiceCancel,
                  pendingChoiceIds: state.pendingChoiceIds,
                  missingPendingChoiceIds,
                  activeWorkSnapshot,
                  activeWorkExpanded,
                  onActiveWorkExpandedChange: setActiveWorkExpanded,
                  statuses: state.statuses,
                  onNavigateToWorker: isActiveManager ? panels.handleSelectAgent : undefined,
                  streamingStartedAt:
                    activeAgentStatus === 'streaming'
                      ? state.statuses[activeAgentId ?? '']?.streamingStartedAt
                      : undefined,
                }}
                workerPillBarProps={
                  isActiveManager
                    ? {
                        workers: sessionWorkers,
                        statuses: state.statuses,
                        activityMessages: state.activityMessages,
                        onNavigateToWorker: panels.handleSelectAgent,
                      }
                    : undefined
                }
                workerBackBarProps={
                  activeAgent?.role === 'worker' && activeAgent.managerId && parentManagerLabel
                    ? {
                        managerLabel: parentManagerLabel,
                        onNavigateBack: () => panels.handleSelectAgent(activeAgent.managerId),
                      }
                    : undefined
                }
                terminalPanelProps={{
                  wsUrl,
                  sessionAgentId: terminalSessionAgentId,
                  terminals: state.terminals,
                  panelMode: terminalPanel.panelMode,
                  activeTerminalId: terminalPanel.activeTerminalId,
                  panelHeight: terminalPanel.panelHeight,
                  isMobile: terminalPanel.isMobile,
                  maxTerminalsPerManager: terminalPanel.maxTerminalsPerManager,
                  editingTerminalId: terminalPanel.editingTerminalId,
                  renameDraft: terminalPanel.renameDraft,
                  initialTickets: terminalPanel.initialTickets,
                  onSelectTerminal: terminalPanel.setActiveTerminalId,
                  onCreateTerminal: () => {
                    void terminalPanel.createTerminal()
                  },
                  onCloseTerminal: terminalPanel.closeTerminal,
                  onStartRenameTerminal: terminalPanel.startRenameTerminal,
                  onRenameDraftChange: terminalPanel.setRenameDraft,
                  onCommitRenameTerminal: terminalPanel.commitRenameTerminal,
                  onCancelRenameTerminal: terminalPanel.cancelRenameTerminal,
                  onCollapsePanel: terminalPanel.collapsePanel,
                  onRestorePanel: terminalPanel.restorePanel,
                  onMaximizePanel: terminalPanel.maximizePanel,
                  onHidePanel: terminalPanel.hidePanel,
                  onPanelHeightChange: terminalPanel.setPanelHeight,
                  onFocusChatInput: session.handleFocusChatInput,
                  onAddToChat: session.handleTerminalAddToChat,
                  issueTicket: terminalPanel.issueTicket,
                }}
                messageInputRef={messageInputRef}
                messageInputProps={{
                  onSend: session.handleSend,
                  onSubmitted: session.handleMessageInputSubmitted,
                  isLoading,
                  disabled: !state.connected || !activeAgentId || hasActivePendingChoice,
                  placeholderOverride: hasActivePendingChoice
                    ? 'Respond to the choice above or click Skip…'
                    : undefined,
                  allowWhileLoading: true,
                  agentLabel: activeAgentLabel,
                  wsUrl,
                  agentId: activeAgentId ?? undefined,
                  slashCommands,
                  projectAgents: projectAgentSuggestions,
                  enableCodexMention: shouldEnableCodexMention(activeAgent),
                  managerAgentId: activeAgentId ?? undefined,
                  replyTarget,
                  onClearReplyTarget: () => setReplyTarget(null),
                }}
              />
            )}
          </div>

          {activeView === 'chat' && !panels.isInlineDiffViewerOpen ? (
            <ChatSidePanels
              isCortexSession={activeAgent?.archetypeId === 'cortex'}
              cortexDashboardProps={{
                wsUrl,
                managerId: activeManagerId,
                isOpen: panels.isArtifactsPanelOpen,
                onClose: panels.handleGuardedArtifactsClose,
                onArtifactClick: panels.handleOpenArtifact,
                onOpenSession: panels.handleSelectAgent,
                onOpenDiffViewer: panels.handleOpenDiffViewerModal,
                requestedTab: panels.cortexDashboardTabRequest,
                onActiveTabChange: panels.handleCortexDashboardTabChange,
              }}
              artifactsSidebarProps={{
                wsUrl,
                managerId: activeManagerId,
                artifacts: transcript.collectedArtifacts,
                isOpen: panels.isArtifactsPanelOpen,
                onClose: panels.handleGuardedArtifactsClose,
                onArtifactClick: panels.handleOpenArtifact,
                activeTab: panels.artifactsPanelTab,
                onActiveTabChange: panels.setArtifactsPanelTab,
                panelMode: 'rail-selected',
                mobileOnly: true,
              }}
              fileBrowserPanelProps={
                panels.isFileBrowserOpen && panels.selectedFileBrowserFile
                  ? {
                      wsUrl,
                      agentId: activeAgentId,
                      filePath: panels.selectedFileBrowserFile,
                      onClose: panels.handleGuardedFileBrowserClosePanel,
                      onNavigateToDirectory: panels.handleGuardedFileBrowserNavigateToDirectory,
                      tabs: panels.fileBrowserTabs,
                      activeTabId: panels.activeFileBrowserTabId,
                      previewTabId: panels.previewFileBrowserTabId,
                      dirtyTabIds: panels.dirtyFileBrowserTabIds,
                      contentScrollSnapshot: panels.activeFileBrowserContentScrollSnapshot,
                      onContentScrollSnapshotChange: panels.updateActiveFileBrowserContentScrollSnapshot,
                      onActivateTab: panels.activateFileBrowserTab,
                      onCloseTab: (tab) => panels.handleRequestCloseFileBrowserTab(tab.id),
                      onStickifyTab: panels.stickifyFileBrowserTab,
                      worktreeId: panels.fileBrowserWorktreeContext?.worktreeId ?? null,
                      mobileOnly: true,
                    }
                  : null
              }
              fileBrowserSidebarProps={{
                wsUrl,
                agentId: activeAgentId,
                isOpen: panels.isFileBrowserOpen,
                onClose: panels.handleGuardedToggleFileBrowser,
                onSelectFile: panels.handleGuardedFileBrowserSelectFile,
                onOpenStickyFile: panels.handleFileBrowserOpenStickyFile,
                selectedFile: panels.selectedFileBrowserFile,
                treeSnapshot: panels.fileBrowserTreeSnapshot,
                onTreeSnapshotChange: panels.updateFileBrowserTreeSnapshot,
                worktreeContext: panels.fileBrowserWorktreeContext,
                onClearWorktreeContext: panels.handleGuardedClearFileBrowserWorktreeContext,
                projectResourceProfileId: activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? null,
                projectResourceSessionAgentId: activeManagerAgent?.agentId ?? null,
                mobileOnly: true,
                refreshNonce: panels.fileBrowserRefreshNonce,
                onDeleteEntry: panels.handleFileBrowserDeleteEntry,
              }}
            />
          ) : null}
      </div>

      <GlobalDialogs
        artifactPanelProps={{
          artifact: panels.activeArtifact,
          wsUrl,
          activeAgentId,
          onClose: panels.handleGuardedArtifactDialogClose,
          onArtifactClick: panels.handleOpenArtifact,
        }}
        createManagerDialogProps={{
          open: isCreateManagerDialogOpen,
          wsUrl,
          isCreatingManager,
          isValidatingDirectory,
          isPickingDirectory,
          newManagerName,
          newManagerCwd,
          newManagerModelSelection,
          newManagerReasoningLevel,
          scaffoldForgeResources,
          createManagerError,
          browseError,
          onOpenChange: handleCreateManagerDialogOpenChange,
          onNameChange: handleNewManagerNameChange,
          onCwdChange: handleNewManagerCwdChange,
          onModelSelectionChange: handleNewManagerModelSelectionChange,
          onReasoningLevelChange: handleNewManagerReasoningLevelChange,
          onScaffoldForgeResourcesChange: handleScaffoldForgeResourcesChange,
          onBrowseDirectory: () => {
            void handleBrowseDirectory()
          },
          onSubmit: (event) => {
            void handleCreateManager(event)
          },
        }}
        deleteManagerDialogProps={{
          managerToDelete,
          deleteManagerError,
          isDeletingManager,
          onClose: handleCloseDeleteManagerDialog,
          onConfirm: () => {
            void handleConfirmDeleteManager()
          },
        }}
        forkSessionDialogProps={
          messageForkTarget
            ? {
                onConfirm: session.handleConfirmMessageFork,
                onClose: () => setMessageForkTarget(null),
                fromMessageTimestamp: messageForkTarget.messageTimestamp
                  ? new Date(messageForkTarget.messageTimestamp).toLocaleString()
                  : undefined,
              }
            : null
        }
        diffViewerDialogProps={{
          open: panels.isDiffViewerOpen && panels.diffViewerPresentation === 'modal',
          onOpenChange: panels.handleGuardedDiffViewerOpenChange,
          wsUrl,
          agentId: activeAgentId,
          isCortex: isDiffViewerCortexSession,
          onBrowseWorktreeFiles: panels.handleBrowseWorktreeFromSourceControl,
          onRequestSourceControlMutation: panels.handleRequestSourceControlMutation,
          onSourceControlMutationComplete: panels.handleSourceControlMutationComplete,
          externalRefreshNonce: panels.sourceControlRefreshNonce,
          initialRepoTarget: panels.diffViewerInitialState?.initialRepoTarget,
          initialTab: panels.diffViewerInitialState?.initialTab,
          initialSha: panels.diffViewerInitialState?.initialSha,
          initialFile: panels.diffViewerInitialState?.initialFile,
          initialQuickFilter: panels.diffViewerInitialState?.initialQuickFilter,
        }}
      />
    </>
  )
}
