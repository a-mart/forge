import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { reportBuilderConnected } from '@/lib/connection-health-store'
import { AgentSidebar } from '@/components/chat/AgentSidebar'
import { ArchiveView } from '@/components/index-page/ArchiveView'
import { isUsableActiveTarget } from '@/components/index-page/archive-target-guards'
import { type MessageSourceView } from '@/components/chat/ChatHeader'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { type MessageInputHandle } from '@/components/chat/MessageInput'
import { type MessageListHandle } from '@/components/chat/MessageList'
import { useChatSearch } from '@/components/chat/useChatSearch'
import { useSearchHighlight } from '@/components/chat/useSearchHighlight'
import { ChatSidePanels } from '@/components/index-page/ChatSidePanels'
import { ChatWorkspace } from '@/components/index-page/ChatWorkspace'
import { GlobalDialogs } from '@/components/index-page/GlobalDialogs'
import { StatsPage } from '@/components/index-page/StatsPage'
import { shouldEnableCodexMention } from '@/components/index-page/codex-mention-utils'
import type { TerminalSelectionContext } from '@/components/terminal/TerminalViewport'
import { chooseFallbackAgentId, filterAgentsAfterProfileArchive, filterAgentsAfterSessionArchive, isAgentEffectivelyArchived, resolveWorkerFetchManagerId } from '@/lib/agent-hierarchy'
import { collectArtifactsFromMessages } from '@/lib/collect-artifacts'
import { hasProjectManagers } from '@/lib/onboarding-ui'
import { useFeedback } from '@/lib/use-feedback'
import { getSidebarPerfRegistry } from '@/lib/perf/sidebar-perf-debug'
import {
  DEFAULT_MANAGER_AGENT_ID,
  type ActiveSurface,
  type ActiveView,
  type AppRouteState,
  type StatsTab,
} from '@/hooks/index-page/use-route-state'
import {
  chooseMostRecentSessionFallbackForDeletedTarget,
} from '@/hooks/index-page/deleted-agent-fallback'
import { fetchWorkPlansEnabled } from '@/components/settings/work-plans-api'
import { useWsConnection } from '@/hooks/index-page/use-ws-connection'
import { useManagerActions } from '@/hooks/index-page/use-manager-actions'
import { useVisibleMessages } from '@/hooks/index-page/use-visible-messages'
import { useContextWindow } from '@/hooks/index-page/use-context-window'
import { usePendingResponse } from '@/hooks/index-page/use-pending-response'
import { useFileDrop } from '@/hooks/index-page/use-file-drop'
import {
  getProjectAgentSuggestions,
  shouldLoadExternalProjectAgentDirectory,
} from '@/hooks/index-page/project-agent-suggestions'
import { usePanelState } from '@/hooks/index-page/use-panel-state'
import {
  parseCompactSlashCommand,
  useSlashCommands,
} from '@/hooks/index-page/use-slash-commands'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import { useDynamicFavicon } from '@/hooks/use-dynamic-favicon'
import { useTerminalPanel } from '@/hooks/useTerminalPanel'
import type {
  AgentDescriptor,
  ChoiceAnswer,
  ConversationAttachment,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  ProjectAgentExternalDirectoryEntry,
} from '@forge/protocol'

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
  const messageInputRef = useRef<MessageInputHandle | null>(null)
  const messageListRef = useRef<MessageListHandle | null>(null)
  const previousAgentsByIdRef = useRef<Map<string, AgentDescriptor>>(new Map())
  const archiveHydrationRequestedRef = useRef(false)

  const { clientRef, state, setState } = useWsConnection(wsUrl)

  // Sync builder WS health to the module-level store so ModeSwitch can
  // display the builder connection dot even from the collab surface.
  // The route-level health poll keeps the dot accurate when this surface
  // unmounts, so no cleanup callback is needed here.
  useEffect(() => {
    reportBuilderConnected(state.connected)
  }, [state.connected])

  useEffect(() => {
    if (!state.connected) return
    let cancelled = false
    void fetchWorkPlansEnabled(wsUrl)
      .then((enabled) => {
        if (!cancelled) {
          setState((prev) => ({ ...prev, workPlansEnabled: enabled }))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [setState, state.connected, wsUrl])

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

  const activeAgentId = useMemo(() => {
    const preferredId = state.targetAgentId ?? state.subscribedAgentId ?? null
    const preferredAgent = preferredId ? state.agents.find((agent) => agent.agentId === preferredId) : null
    const preferredManager = preferredAgent?.role === 'worker'
      ? state.agents.find((agent) => agent.role === 'manager' && agent.agentId === preferredAgent.managerId)
      : preferredAgent
    if (preferredManager?.role === 'manager' && isAgentEffectivelyArchived(preferredManager, state.profiles)) {
      return chooseFallbackAgentId(state.agents, undefined, state.profiles)
    }
    return preferredId ?? chooseFallbackAgentId(state.agents, undefined, state.profiles)
  }, [state.agents, state.profiles, state.subscribedAgentId, state.targetAgentId])

  const activeAgent = useMemo(() => {
    if (!activeAgentId) {
      return null
    }

    return state.agents.find((agent) => agent.agentId === activeAgentId) ?? null
  }, [activeAgentId, state.agents])

  const {
    activeArtifact,
    openArtifact: handleOpenArtifact,
    closeArtifact: handleCloseArtifact,
    isArtifactsPanelOpen,
    setIsArtifactsPanelOpen,
    toggleArtifactsPanel: handleToggleArtifactsPanel,
    cortexDashboardTabRequest,
    requestCortexDashboardTab,
    isMobileSidebarOpen,
    setIsMobileSidebarOpen,
    isDiffViewerOpen,
    setIsDiffViewerOpen,
    diffViewerInitialState,
    openDiffViewer,
    isFileBrowserOpen,
    toggleFileBrowser: handleToggleFileBrowser,
    selectedFileBrowserFile,
    selectFileBrowserFile: handleFileBrowserSelectFile,
    closeFileBrowserPanel: handleFileBrowserClosePanel,
    navigateFileBrowserToDirectory: handleFileBrowserNavigateToDirectory,
  } = usePanelState({
    activeAgentId,
    activeAgentArchetypeId: activeAgent?.archetypeId,
  })

  const { slashCommands } = useSlashCommands({ wsUrl, activeView })

  const hasCreatedProjectManager = useMemo(() => hasProjectManagers(state.agents), [state.agents])

  const shouldShowWelcomeForm =
    routeState.view === 'chat' &&
    !hasCreatedProjectManager &&
    onboardingState?.status === 'pending'
  const shouldShowCreateManagerState =
    routeState.view === 'chat' &&
    !hasCreatedProjectManager &&
    Boolean(onboardingState && onboardingState.status !== 'pending')

  const activeAgentProfileName = useMemo(() => {
    if (!activeAgent?.profileId || !activeAgent.sessionLabel) return undefined
    const profile = state.profiles.find((p) => p.profileId === activeAgent.profileId)
    return profile?.displayName ?? activeAgent.profileId
  }, [activeAgent, state.profiles])

  const activeAgentSessionLabel = useMemo(() => {
    if (!activeAgent?.profileId || !activeAgent.sessionLabel) return undefined
    return activeAgent.sessionLabel
  }, [activeAgent])

  const activeAgentLabel = useMemo(() => {
    if (!activeAgent) return activeAgentId ?? 'No active agent'
    // For session agents, show profile name + session label
    if (activeAgentProfileName && activeAgentSessionLabel) {
      return `${activeAgentProfileName} › ${activeAgentSessionLabel}`
    }
    return activeAgent.displayName ?? activeAgentId ?? 'No active agent'
  }, [activeAgent, activeAgentId, activeAgentProfileName, activeAgentSessionLabel])

  const totalUnreadCount = useMemo(() => {
    if (!state.unreadCounts) return 0
    return Object.entries(state.unreadCounts).reduce((sum, [agentId, count]) => {
      if (agentId === activeAgentId) return sum
      return sum + count
    }, 0)
  }, [state.unreadCounts, activeAgentId])

  const isActiveManager = activeAgent?.role === 'manager'

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

  const activeManagerId = useMemo(() => {
    if (activeAgent?.role === 'manager') {
      return activeAgent.agentId
    }

    if (activeAgent?.managerId) {
      return activeAgent.managerId
    }

    return (
      state.agents.find((agent) => agent.role === 'manager')?.agentId ??
      DEFAULT_MANAGER_AGENT_ID
    )
  }, [activeAgent, state.agents])

  const activeManagerAgent = useMemo(() => {
    if (!activeManagerId) {
      return null
    }

    return state.agents.find(
      (agent) => agent.role === 'manager' && agent.agentId === activeManagerId,
    ) ?? null
  }, [activeManagerId, state.agents])

  const activeWorkSnapshot =
    state.workPlansEnabled &&
    activeAgent?.role === 'manager' &&
    activeManagerId &&
    state.taskSnapshotLoadingSessionId !== activeManagerId
      ? state.taskSnapshots[activeManagerId] ?? null
      : null

  const terminalSessionAgentId = useMemo(() => {
    if (!activeAgent) {
      return null
    }

    if (activeAgent.role === 'manager') {
      return activeAgent.agentId
    }

    return activeManagerAgent?.agentId ?? activeAgent.managerId ?? null
  }, [activeAgent, activeManagerAgent])

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

  // Resolve worker-fetch target from actual active agent context only — no fallback to
  // first-manager or DEFAULT_MANAGER_AGENT_ID to avoid fetching the wrong manager's workers
  // during cold boot, reconnect, or when a worker descriptor hasn't loaded yet.
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
    // Prefer "Profile › Session" format matching activeAgentLabel logic
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
      // If profiles exist, only show default sessions
      if (state.profiles.length > 0) {
        return defaultSessionIds.has(agent.agentId) || !agent.profileId
      }
      // No profiles yet (legacy) — show all managers
      return true
    })
  }, [state.agents, state.profiles])

  const activeAgentStatus = useMemo(() => {
    if (!activeAgentId) {
      return null
    }

    const fromStatuses = state.statuses[activeAgentId]?.status
    if (fromStatuses) {
      return fromStatuses
    }

    return state.agents.find((agent) => agent.agentId === activeAgentId)?.status ?? null
  }, [activeAgentId, state.agents, state.statuses])

  useDynamicFavicon({
    agents: state.agents,
    statuses: state.statuses,
  })

  const { contextWindowUsage } = useContextWindow({
    activeAgent,
    activeAgentId,
    messages: state.messages,
    statuses: state.statuses,
  })

  const {
    markPendingResponse,
    clearPendingResponseForAgent,
    isAwaitingResponseStart,
  } = usePendingResponse({
    activeAgentId,
    activeAgentStatus,
    messages: state.messages,
  })

  const isLoading = activeAgentStatus === 'streaming' || isAwaitingResponseStart
  const hasActivePendingChoice = state.pendingChoiceIds.size > 0
  const canStopAllAgents =
    isActiveManager &&
    (activeAgentStatus === 'idle' || activeAgentStatus === 'streaming')

  const autoCompactionInProgress = useMemo(() => {
    if (!activeAgentId) return false
    return state.statuses[activeAgentId]?.contextRecoveryInProgress === true
  }, [activeAgentId, state.statuses])

  const { allMessages, visibleMessages } = useVisibleMessages({
    messages: state.messages,
    activityMessages: state.activityMessages,
    agents: state.agents,
    activeAgent,
    channelView: messageSourceView,
    detailedAllView: effectiveDetailedAllView,
  })

  const pinnedMessageIds = useMemo(() => {
    const ids: string[] = []
    for (const m of visibleMessages) {
      if (m.type === 'conversation_message' && m.pinned) {
        const id = m.id?.trim() || m.timestamp
        ids.push(id)
      }
    }
    return ids
  }, [visibleMessages])

  const pinnedCount = pinnedMessageIds.length

  // ── Find-in-chat search ──
  const chatSearch = useChatSearch(visibleMessages)

  const searchContainerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    searchContainerRef.current = messageListRef.current?.getScrollContainer() ?? null
  })

  useSearchHighlight(
    searchContainerRef,
    chatSearch.matches,
    chatSearch.currentMatchIndex,
    chatSearch.isOpen,
  )

  // Scroll to the message containing the current match
  useEffect(() => {
    if (!chatSearch.isOpen || chatSearch.matches.length === 0) return
    const match = chatSearch.matches[chatSearch.currentMatchIndex]
    if (match) {
      messageListRef.current?.scrollToMessage(match.messageId)
    }
  }, [chatSearch.isOpen, chatSearch.matches, chatSearch.currentMatchIndex])

  // Close search on session switch
  useEffect(() => {
    chatSearch.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId])

  // Keyboard shortcut: Ctrl+F / Cmd+F to toggle find-in-chat
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        if (activeView !== 'chat') return
        e.preventDefault()
        if (chatSearch.isOpen) {
          chatSearch.close()
        } else {
          chatSearch.open()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeView, chatSearch])

  const handleScrollToMessage = useCallback((messageId: string) => {
    messageListRef.current?.scrollToMessage(messageId)
  }, [])

  const collectedArtifacts = useMemo(
    () => collectArtifactsFromMessages(allMessages),
    [allMessages],
  )

  const feedbackSessionId = useMemo(() => {
    if (!activeAgent) {
      return null
    }

    return activeAgent.role === 'worker' ? activeAgent.managerId : activeAgent.agentId
  }, [activeAgent])

  const feedbackSessionAgent = useMemo(() => {
    if (!feedbackSessionId) {
      return null
    }

    return (
      state.agents.find(
        (agent) => agent.agentId === feedbackSessionId && agent.role === 'manager',
      ) ?? null
    )
  }, [feedbackSessionId, state.agents])

  const feedbackProfileId = feedbackSessionAgent?.profileId ?? null
  const { getVote, hasComment, submitVote, submitComment, clearComment, isSubmitting: isFeedbackSubmitting } = useFeedback(
    feedbackProfileId,
    feedbackSessionId,
  )

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
    clearPendingResponseForAgent,
  })

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

  useEffect(() => {
    if (routeState.view !== 'chat') {
      return
    }

    const currentAgentId = state.targetAgentId ?? state.subscribedAgentId
    const hasExplicitRouteSelection = routeState.agentId !== DEFAULT_MANAGER_AGENT_ID
    const explicitSelectionAgentId =
      clientRef.current?.getExplicitSelectionAgentId() ??
      (hasExplicitRouteSelection ? routeState.agentId : null)
    const hasExplicitSelection =
      hasExplicitRouteSelection || clientRef.current?.hasExplicitSelection() === true

    if (
      hasExplicitSelection &&
      explicitSelectionAgentId &&
      explicitSelectionAgentId !== DEFAULT_MANAGER_AGENT_ID
    ) {
      const explicitTargetUsable = isUsableActiveTarget(
        explicitSelectionAgentId,
        state.agents,
        state.profiles,
      )

      if (explicitTargetUsable) {
        if (currentAgentId !== explicitSelectionAgentId) {
          clientRef.current?.subscribeToAgent(explicitSelectionAgentId)
        }
        return
      }

      if (!state.hasReceivedAgentsSnapshot) {
        return
      }

      const fallbackAgentId =
        chooseMostRecentSessionFallbackForDeletedTarget(
          state.agents,
          explicitSelectionAgentId,
          previousAgentsByIdRef.current,
        ) ?? chooseFallbackAgentId(state.agents, undefined, state.profiles)

      if (!fallbackAgentId) {
        navigateToRoute({ view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID }, true)
        return
      }

      if (currentAgentId !== fallbackAgentId) {
        clientRef.current?.subscribeToAgent(fallbackAgentId, { explicit: false })
      }

      navigateToRoute({ view: 'chat', agentId: fallbackAgentId }, true)
      return
    }

    if (currentAgentId === routeState.agentId) {
      return
    }

    if (isUsableActiveTarget(routeState.agentId, state.agents, state.profiles)) {
      clientRef.current?.subscribeToAgent(routeState.agentId)
      return
    }

    if (state.agents.length === 0) {
      return
    }

    const fallbackAgentId = chooseFallbackAgentId(state.agents, undefined, state.profiles)
    if (!fallbackAgentId || fallbackAgentId === currentAgentId) {
      return
    }

    clientRef.current?.subscribeToAgent(fallbackAgentId, { explicit: false })
  }, [
    clientRef,
    navigateToRoute,
    routeState,
    state.agents,
    state.hasReceivedAgentsSnapshot,
    state.profiles,
    state.subscribedAgentId,
    state.targetAgentId,
  ])

  useEffect(() => {
    previousAgentsByIdRef.current = new Map(
      state.agents.map((agent) => [agent.agentId, agent]),
    )
  }, [state.agents])

  const handleSend = (text: string, attachments?: ConversationAttachment[]) => {
    if (!activeAgentId) {
      return
    }

    const compactCommand =
      isActiveManager && (!attachments || attachments.length === 0)
        ? parseCompactSlashCommand(text)
        : null

    if (compactCommand) {
      void handleCompactManager(compactCommand.customInstructions)
      return
    }

    markPendingResponse(activeAgentId, state.messages.length)

    clientRef.current?.sendUserMessage(text, {
      agentId: activeAgentId,
      delivery: isActiveManager ? 'steer' : isLoading ? 'steer' : 'auto',
      attachments,
    })
  }

  const handleMessageInputSubmitted = useCallback(() => {
    messageListRef.current?.scrollToBottom('smooth')
  }, [])

  const handleChoiceSubmit = useCallback((agentId: string, choiceId: string, answers: ChoiceAnswer[]) => {
    clientRef.current?.sendChoiceResponse(agentId, choiceId, answers)
  }, [clientRef])

  const handleChoiceCancel = useCallback((agentId: string, choiceId: string) => {
    clientRef.current?.sendChoiceCancel(agentId, choiceId)
  }, [clientRef])

  const handlePinMessage = useCallback((messageId: string, pinned: boolean) => {
    if (!activeAgentId || !isActiveManager) return
    clientRef.current?.pinMessage(activeAgentId, messageId, pinned)
  }, [activeAgentId, clientRef, isActiveManager])

  const handleClearAllPins = useCallback(() => {
    if (!activeAgentId || !isActiveManager) return
    clientRef.current?.clearAllPins(activeAgentId)
  }, [activeAgentId, clientRef, isActiveManager])

  const handleNewChat = () => {
    if (!isActiveManager || !activeAgentId || !activeAgent) {
      return
    }

    // Multi-session: clear current session conversation
    const profileId = activeAgent.profileId
    if (profileId && clientRef.current) {
      void (async () => {
        try {
          await clientRef.current!.clearSession(activeAgentId)
        } catch (error) {
          setState((prev) => ({
            ...prev,
            lastError: `Failed to clear conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }))
        }
      })()
      return
    }

    // Legacy fallback: destructive /new
    clientRef.current?.sendUserMessage('/new', {
      agentId: activeAgentId,
      delivery: 'steer',
    })
  }

  const handleCreateSession = useCallback((profileId: string, name?: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        const result = await client.createSession(profileId, name)
        navigateToRoute({ view: 'chat', agentId: result.sessionAgent.agentId })
        client.subscribeToAgent(result.sessionAgent.agentId)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to create session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, navigateToRoute, setState])

  const handleCreateAgentCreator = useCallback((profileId: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        const result = await client.createSession(profileId, undefined, {
          sessionPurpose: 'agent_creator',
          label: 'Agent Creator',
        })
        navigateToRoute({ view: 'chat', agentId: result.sessionAgent.agentId })
        client.subscribeToAgent(result.sessionAgent.agentId)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to create agent creator: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, navigateToRoute, setState])

  const handleStopSession = useCallback((agentId: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        await client.stopSession(agentId)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to stop session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, setState])

  const handleResumeSession = useCallback((agentId: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        await client.resumeSession(agentId)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to resume session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, setState])

  const handleDeleteSession = useCallback((agentId: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        await client.deleteSession(agentId)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to delete session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, setState])

  const handleArchiveSession = useCallback((agentId: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        await client.archiveSession(agentId)
        const fallbackAgentId = chooseFallbackAgentId(
          filterAgentsAfterSessionArchive(state.agents, agentId),
          undefined,
          state.profiles,
        )
        if (agentId === activeAgentId && fallbackAgentId) {
          navigateToRoute({ view: 'chat', agentId: fallbackAgentId })
        }
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to archive session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [activeAgentId, clientRef, navigateToRoute, setState, state.agents, state.profiles])

  const handleArchiveProfile = useCallback((profileId: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        await client.archiveProfile(profileId)
        const fallbackAgentId = chooseFallbackAgentId(
          filterAgentsAfterProfileArchive(state.agents, profileId),
          undefined,
          state.profiles.filter((profile) => profile.profileId !== profileId),
        )
        if (activeAgent?.role === 'manager' && (activeAgent.profileId ?? activeAgent.agentId) === profileId && fallbackAgentId) {
          navigateToRoute({ view: 'chat', agentId: fallbackAgentId })
        }
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to archive project: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [activeAgent, clientRef, navigateToRoute, setState, state.agents, state.profiles])

  const handleRestoreSession = useCallback((agentId: string, open = false) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        const result = await client.restoreSession(agentId)
        if (open) navigateToRoute({ view: 'chat', agentId: result.openAgentId ?? result.agentId })
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to restore session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, navigateToRoute, setState])

  const handleRestoreProfile = useCallback((profileId: string, open = false) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        const result = await client.restoreProfile(profileId)
        if (open && result.openAgentId) navigateToRoute({ view: 'chat', agentId: result.openAgentId })
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to restore project: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, navigateToRoute, setState])

  const handleRenameSession = useCallback((agentId: string, label: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        await client.renameSession(agentId, label)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to rename session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, setState])

  const handlePinSession = useCallback((agentId: string, pinned: boolean) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        await client.pinSession(agentId, pinned)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to ${pinned ? 'pin' : 'unpin'} session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, setState])

  const handleRenameProfile = useCallback((profileId: string, displayName: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        await client.renameProfile(profileId, displayName)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to rename profile: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, setState])

  const handleForkSession = useCallback((sourceAgentId: string, name?: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        const result = await client.forkSession(sourceAgentId, name)
        navigateToRoute({ view: 'chat', agentId: result.newSessionAgent.agentId })
        client.subscribeToAgent(result.newSessionAgent.agentId)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to fork session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, navigateToRoute, setState])

  const [messageForkTarget, setMessageForkTarget] = useState<{ messageId: string; messageTimestamp?: string } | null>(null)

  const handleForkFromMessage = useCallback((messageId: string) => {
    if (!activeAgentId) return
    // Find the message timestamp for display in the dialog
    const msg = visibleMessages.find(
      (m) => m.type === 'conversation_message' && ((m.id?.trim() || m.timestamp) === messageId),
    )
    const timestamp = msg?.timestamp
    setMessageForkTarget({ messageId, messageTimestamp: timestamp })
  }, [activeAgentId, visibleMessages])

  const handleConfirmMessageFork = useCallback((name?: string) => {
    const client = clientRef.current
    if (!client || !activeAgentId || !messageForkTarget) return

    const { messageId } = messageForkTarget
    setMessageForkTarget(null)

    void (async () => {
      try {
        const result = await client.forkSession(activeAgentId, name, messageId)
        navigateToRoute({ view: 'chat', agentId: result.newSessionAgent.agentId })
        client.subscribeToAgent(result.newSessionAgent.agentId)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to fork session from message: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, activeAgentId, messageForkTarget, navigateToRoute, setState])


  const handleRequestSessionWorkers = useCallback((sessionAgentId: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        await client.getSessionWorkers(sessionAgentId)
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to load session workers: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    })()
  }, [clientRef, setState])

  const handleMarkUnread = useCallback((agentId: string) => {
    clientRef.current?.markUnread(agentId)
  }, [clientRef])

  const handleMarkAllRead = useCallback((profileId: string) => {
    clientRef.current?.markAllRead(profileId)
  }, [clientRef])


  const handleUpdateManagerModel = useCallback(async (profileId: string, modelSelection: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => {
    const client = clientRef.current
    if (!client) return

    try {
      await client.updateProfileDefaultModel(profileId, undefined, reasoningLevel, modelSelection)
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to update default model: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }))
    }
  }, [clientRef, setState])

  const handleUpdateSessionModel = useCallback(async (
    sessionAgentId: string,
    mode: 'inherit' | 'override',
    modelSelection?: ManagerExactModelSelection,
    reasoningLevel?: ManagerReasoningLevel,
  ) => {
    const client = clientRef.current
    if (!client) return

    try {
      await client.updateSessionModel(sessionAgentId, mode, undefined, reasoningLevel, modelSelection)
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to update session model: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }))
    }
  }, [clientRef, setState])

  const handleUpdateManagerCwd = useCallback(async (managerId: string, cwd: string) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')

    await client.updateManagerCwd(managerId, cwd)
  }, [clientRef])

  const handleBrowseDirectoryForCwd = useCallback(async (defaultPath: string) => {
    const client = clientRef.current
    if (!client) return null
    return client.pickDirectory(defaultPath)
  }, [clientRef])

  const handleValidateDirectoryForCwd = useCallback(async (path: string) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')
    return client.validateDirectory(path)
  }, [clientRef])

  const handleReorderProfiles = useCallback((profileIds: string[]) => {
    clientRef.current?.reorderProfiles(profileIds)
  }, [clientRef])

  const handleSetSessionProjectAgent = useCallback(async (agentId: string, projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string; capabilities?: import('@forge/protocol').ProjectAgentCapability[] } | null) => {
    await clientRef.current?.setSessionProjectAgent(agentId, projectAgent)
  }, [clientRef])

  const handleGetProjectAgentConfig = useCallback(async (agentId: string) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')
    return client.getProjectAgentConfig(agentId)
  }, [clientRef])

  const handleGetProjectAgentSharing = useCallback(async (agentId: string) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')
    return client.getProjectAgentSharing(agentId)
  }, [clientRef])

  const handleSetProjectAgentSharing = useCallback(async (agentId: string, targetProfileIds: string[]) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')
    return client.setProjectAgentSharing(agentId, targetProfileIds)
  }, [clientRef])

  const handleListProjectAgentReferences = useCallback(async (agentId: string) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')
    return client.listProjectAgentReferences(agentId)
  }, [clientRef])

  const handleGetProjectAgentReference = useCallback(async (agentId: string, fileName: string) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')
    return client.getProjectAgentReference(agentId, fileName)
  }, [clientRef])

  const handleSetProjectAgentReference = useCallback(async (agentId: string, fileName: string, content: string) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')
    return client.setProjectAgentReference(agentId, fileName, content)
  }, [clientRef])

  const handleDeleteProjectAgentReference = useCallback(async (agentId: string, fileName: string) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')
    return client.deleteProjectAgentReference(agentId, fileName)
  }, [clientRef])

  const handleRequestProjectAgentRecommendations = useCallback(async (agentId: string) => {
    const client = clientRef.current
    if (!client) throw new Error('WebSocket is not connected.')
    return client.requestProjectAgentRecommendations(agentId)
  }, [clientRef])

  const handleSelectAgent = (agentId: string) => {
    getSidebarPerfRegistry().startSessionSwitch(agentId)
    navigateToRoute({ view: 'chat', agentId })
    clientRef.current?.subscribeToAgent(agentId)
  }

  const handleOpenCortexReview = useCallback((agentId: string) => {
    navigateToRoute({ view: 'chat', agentId })
    clientRef.current?.subscribeToAgent(agentId)
    requestCortexDashboardTab('review')
  }, [navigateToRoute, requestCortexDashboardTab, clientRef])

  const handleDeleteAgent = (agentId: string) => {
    const agent = state.agents.find((entry) => entry.agentId === agentId)
    if (!agent || agent.role !== 'worker') {
      return
    }

    if (activeAgentId === agentId) {
      const remainingAgents = state.agents.filter((entry) => entry.agentId !== agentId)
      const fallbackAgentId = chooseFallbackAgentId(remainingAgents, undefined, state.profiles)
      if (fallbackAgentId) {
        navigateToRoute({ view: 'chat', agentId: fallbackAgentId })
        clientRef.current?.subscribeToAgent(fallbackAgentId)
      }
    }

    clientRef.current?.deleteAgent(agentId)
  }

  const handleOpenSettingsPanel = () => {
    navigateToRoute({ view: 'settings', surface: 'builder' })
  }

  const handleOpenStats = () => {
    navigateToRoute({ view: 'stats' })
  }

  const handleOpenArchive = () => {
    navigateToRoute({ view: 'archive', surface: 'builder' })
  }

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

  const handleSuggestionClick = (prompt: string) => {
    messageInputRef.current?.setInput(prompt)
  }

  const handleFocusChatInput = useCallback(() => {
    messageInputRef.current?.focus()
  }, [])

  const handleTerminalAddToChat = useCallback((context: TerminalSelectionContext) => {
    messageInputRef.current?.addTerminalContext(context)
  }, [])

  return (
    <>
      <AgentSidebar
        connected={state.connected}
        wsUrl={wsUrl}
        agents={state.agents}
        profiles={state.profiles}
        statuses={state.statuses}
        unreadCounts={state.unreadCounts}
        collaborationModeSwitch={collaborationModeSwitch}
        terminalScopeId={state.terminalSessionScopeId}
        terminalCount={state.terminals.length}
        selectedAgentId={activeAgentId}
        isSettingsActive={activeView === 'settings'}
        isStatsActive={activeView === 'stats'}
        isArchiveActive={activeView === 'archive'}
        isMobileOpen={isMobileSidebarOpen}
        onMobileClose={() => setIsMobileSidebarOpen(false)}
        onAddManager={handleOpenCreateManagerDialog}
        onSelectAgent={handleSelectAgent}
        onDeleteAgent={handleDeleteAgent}
        onDeleteManager={handleRequestDeleteManager}
        onOpenSettings={handleOpenSettingsPanel}
        onOpenCortexReview={handleOpenCortexReview}
        onOpenStats={handleOpenStats}
        onOpenArchive={handleOpenArchive}
        onCreateSession={handleCreateSession}
        onStopSession={handleStopSession}
        onResumeSession={handleResumeSession}
        onDeleteSession={handleDeleteSession}
        onArchiveSession={handleArchiveSession}
        onArchiveProfile={handleArchiveProfile}
        onRenameSession={handleRenameSession}
        onPinSession={handlePinSession}
        onRenameProfile={handleRenameProfile}
        onForkSession={handleForkSession}
        onMarkUnread={handleMarkUnread}
        onMarkAllRead={handleMarkAllRead}
        onUpdateManagerModel={handleUpdateManagerModel}
        onUpdateSessionModel={handleUpdateSessionModel}
        onUpdateManagerCwd={handleUpdateManagerCwd}
        onBrowseDirectory={handleBrowseDirectoryForCwd}
        onValidateDirectory={handleValidateDirectoryForCwd}
        onRequestSessionWorkers={handleRequestSessionWorkers}
        onReorderProfiles={handleReorderProfiles}
        onSetSessionProjectAgent={handleSetSessionProjectAgent}
        onGetProjectAgentConfig={handleGetProjectAgentConfig}
        onGetProjectAgentSharing={handleGetProjectAgentSharing}
        onSetProjectAgentSharing={handleSetProjectAgentSharing}
        onListProjectAgentReferences={handleListProjectAgentReferences}
        onGetProjectAgentReference={handleGetProjectAgentReference}
        onSetProjectAgentReference={handleSetProjectAgentReference}
        onDeleteProjectAgentReference={handleDeleteProjectAgentReference}
        onRequestProjectAgentRecommendations={handleRequestProjectAgentRecommendations}
        onCreateAgentCreator={handleCreateAgentCreator}
      />

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

          <div className="flex min-w-0 flex-1 flex-col">
            {activeView === 'settings' ? (
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
                onRestoreProfile={handleRestoreProfile}
                onRestoreSession={handleRestoreSession}
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
                  onDetailedAllViewChange: isActiveManager ? setDetailedAllView : undefined,
                  contextWindowUsage,
                  activeWorkSnapshot,
                  activeWorkAgents: state.agents,
                  activeWorkStatuses: state.statuses,
                  onNavigateToActiveWorkWorker: isActiveManager ? handleSelectAgent : undefined,
                  compactionCount: activeAgent?.compactionCount,
                  showCompact: isActiveManager,
                  compactInProgress: isCompactingManager,
                  onCompact: () => void handleCompactManager(),
                  showSmartCompact: isActiveManager,
                  smartCompactInProgress: isSmartCompactingManager,
                  onSmartCompact: () => void handleSmartCompactManager(),
                  autoCompactionInProgress,
                  pinnedCount,
                  pinnedMessageIds,
                  onScrollToMessage: handleScrollToMessage,
                  onClearAllPins: handleClearAllPins,
                  showStopAll: isActiveManager,
                  stopAllInProgress: isStoppingAllAgents,
                  stopAllDisabled: !state.connected || !canStopAllAgents,
                  onStopAll: () => void handleStopAllAgents(),
                  showNewChat: isActiveManager,
                  onNewChat: handleNewChat,
                  isArtifactsPanelOpen,
                  onToggleArtifactsPanel: handleToggleArtifactsPanel,
                  isTerminalPanelOpen: terminalPanel.isPanelVisible,
                  terminalCount: state.terminals.length,
                  onToggleTerminalPanel: terminalSessionAgentId ? terminalPanel.togglePanel : undefined,
                  onOpenDiffViewer: () => openDiffViewer(),
                  isFileBrowserOpen,
                  onToggleFileBrowser: handleToggleFileBrowser,
                  onToggleMobileSidebar: () =>
                    setIsMobileSidebarOpen((previous) => !previous),
                  sessionFeedbackVote: isActiveManager && activeAgentId ? getVote(activeAgentId) : null,
                  sessionFeedbackHasComment: isActiveManager && activeAgentId ? hasComment(activeAgentId) : false,
                  onSessionFeedbackVote:
                    isActiveManager && feedbackProfileId ? submitVote : undefined,
                  onSessionFeedbackComment:
                    isActiveManager && feedbackProfileId ? submitComment : undefined,
                  onSessionFeedbackClearComment:
                    isActiveManager && feedbackProfileId ? clearComment : undefined,
                  isFeedbackSubmitting,
                }}
                lastError={state.lastError}
                lastSuccess={state.lastSuccess}
                chatSearchBarProps={{ search: chatSearch }}
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
                  messages: visibleMessages,
                  agents: state.agents,
                  isLoading,
                  wsUrl,
                  activeAgentId,
                  projectAgent: activeAgent?.projectAgent,
                  onSuggestionClick: handleSuggestionClick,
                  onArtifactClick: handleOpenArtifact,
                  onForkFromMessage: activeAgentId ? handleForkFromMessage : undefined,
                  onPinMessage: isActiveManager && activeAgentId ? handlePinMessage : undefined,
                  onStopExternalThread: handleStopSession,
                  getVote: feedbackProfileId ? getVote : undefined,
                  hasComment: feedbackProfileId ? hasComment : undefined,
                  onFeedbackVote: feedbackProfileId ? submitVote : undefined,
                  onFeedbackComment: feedbackProfileId ? submitComment : undefined,
                  onFeedbackClearComment: feedbackProfileId ? clearComment : undefined,
                  isFeedbackSubmitting,
                  onChoiceSubmit: handleChoiceSubmit,
                  onChoiceCancel: handleChoiceCancel,
                  pendingChoiceIds: state.pendingChoiceIds,
                  activeWorkSnapshot,
                  activeWorkExpanded,
                  onActiveWorkExpandedChange: setActiveWorkExpanded,
                  statuses: state.statuses,
                  onNavigateToWorker: isActiveManager ? handleSelectAgent : undefined,
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
                        onNavigateToWorker: handleSelectAgent,
                      }
                    : undefined
                }
                workerBackBarProps={
                  activeAgent?.role === 'worker' && activeAgent.managerId && parentManagerLabel
                    ? {
                        managerLabel: parentManagerLabel,
                        onNavigateBack: () => handleSelectAgent(activeAgent.managerId),
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
                  onFocusChatInput: handleFocusChatInput,
                  onAddToChat: handleTerminalAddToChat,
                  issueTicket: terminalPanel.issueTicket,
                }}
                messageInputRef={messageInputRef}
                messageInputProps={{
                  onSend: handleSend,
                  onSubmitted: handleMessageInputSubmitted,
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
                }}
              />
            )}
          </div>

          {activeView === 'chat' ? (
            <ChatSidePanels
              isCortexSession={activeAgent?.archetypeId === 'cortex'}
              cortexDashboardProps={{
                wsUrl,
                managerId: activeManagerId,
                isOpen: isArtifactsPanelOpen,
                onClose: () => setIsArtifactsPanelOpen(false),
                onArtifactClick: handleOpenArtifact,
                onOpenSession: handleSelectAgent,
                onOpenDiffViewer: openDiffViewer,
                requestedTab: cortexDashboardTabRequest,
              }}
              artifactsSidebarProps={{
                wsUrl,
                managerId: activeManagerId,
                artifacts: collectedArtifacts,
                isOpen: isArtifactsPanelOpen,
                onClose: () => setIsArtifactsPanelOpen(false),
                onArtifactClick: handleOpenArtifact,
              }}
              fileBrowserPanelProps={
                isFileBrowserOpen && selectedFileBrowserFile
                  ? {
                      wsUrl,
                      agentId: activeAgentId,
                      filePath: selectedFileBrowserFile,
                      onClose: handleFileBrowserClosePanel,
                      onNavigateToDirectory: handleFileBrowserNavigateToDirectory,
                    }
                  : null
              }
              fileBrowserSidebarProps={{
                wsUrl,
                agentId: activeAgentId,
                isOpen: isFileBrowserOpen,
                onClose: handleToggleFileBrowser,
                onSelectFile: handleFileBrowserSelectFile,
                selectedFile: selectedFileBrowserFile,
                projectResourceProfileId: activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? null,
                projectResourceSessionAgentId: activeManagerAgent?.agentId ?? null,
              }}
            />
          ) : null}
      </div>

      <GlobalDialogs
        artifactPanelProps={{
          artifact: activeArtifact,
          wsUrl,
          activeAgentId,
          onClose: handleCloseArtifact,
          onArtifactClick: handleOpenArtifact,
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
                onConfirm: handleConfirmMessageFork,
                onClose: () => setMessageForkTarget(null),
                fromMessageTimestamp: messageForkTarget.messageTimestamp
                  ? new Date(messageForkTarget.messageTimestamp).toLocaleString()
                  : undefined,
              }
            : null
        }
        diffViewerDialogProps={{
          open: isDiffViewerOpen,
          onOpenChange: setIsDiffViewerOpen,
          wsUrl,
          agentId: activeAgentId,
          isCortex: isDiffViewerCortexSession,
          initialRepoTarget: diffViewerInitialState?.initialRepoTarget,
          initialTab: diffViewerInitialState?.initialTab,
          initialSha: diffViewerInitialState?.initialSha,
          initialFile: diffViewerInitialState?.initialFile,
          initialQuickFilter: diffViewerInitialState?.initialQuickFilter,
        }}
      />
    </>
  )
}



