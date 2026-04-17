/* eslint-disable react-refresh/only-export-components -- TanStack route file exports Route + page utilities */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  createFileRoute,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { AgentSidebar } from '@/components/chat/AgentSidebar'
import { type ChannelView } from '@/components/chat/ChatHeader'
import { type MessageInputHandle } from '@/components/chat/MessageInput'
import { type MessageListHandle } from '@/components/chat/MessageList'
import { useChatSearch } from '@/components/chat/useChatSearch'
import { useSearchHighlight } from '@/components/chat/useSearchHighlight'
import { ChatSidePanels } from '@/components/index-page/ChatSidePanels'
import { ChatWorkspace } from '@/components/index-page/ChatWorkspace'
import { GlobalDialogs } from '@/components/index-page/GlobalDialogs'
import { StatsPage } from '@/components/index-page/StatsPage'
import { PlaywrightDashboardView } from '@/components/playwright/PlaywrightDashboardView'
import type { TerminalSelectionContext } from '@/components/terminal/TerminalViewport'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { chooseFallbackAgentId } from '@/lib/agent-hierarchy'
import { collectArtifactsFromMessages } from '@/lib/collect-artifacts'
import { hasProjectManagers } from '@/lib/onboarding-ui'
import { useFeedback } from '@/lib/use-feedback'
import { getSidebarPerfRegistry } from '@/lib/perf/sidebar-perf-debug'
import {
  DEFAULT_MANAGER_AGENT_ID,
  useRouteState,
  type StatsTab,
} from '@/hooks/index-page/use-route-state'
import {
  chooseMostRecentSessionFallbackForDeletedTarget,
} from '@/hooks/index-page/deleted-agent-fallback'
import { useWsConnection } from '@/hooks/index-page/use-ws-connection'
import { useManagerActions } from '@/hooks/index-page/use-manager-actions'
import { useVisibleMessages } from '@/hooks/index-page/use-visible-messages'
import { useContextWindow } from '@/hooks/index-page/use-context-window'
import { usePendingResponse } from '@/hooks/index-page/use-pending-response'
import { useFileDrop } from '@/hooks/index-page/use-file-drop'
import {
  getProjectAgentSuggestions,
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
  ManagerModelPreset,
  ManagerReasoningLevel,
} from '@forge/protocol'
import { resolveBackendWsUrl } from '@/lib/backend-url'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

const DEFAULT_MANAGER_MODEL: ManagerModelPreset = 'pi-codex'

export function isCortexDiffViewerSession(agent: AgentDescriptor | null | undefined): boolean {
  return Boolean(
    agent &&
      (agent.profileId === 'cortex' ||
        agent.archetypeId === 'cortex' ||
        agent.sessionPurpose === 'cortex_review'),
  )
}

export { getProjectAgentSuggestions } from '@/hooks/index-page/project-agent-suggestions'

export function IndexPage() {
  const wsUrl = resolveBackendWsUrl()
  const messageInputRef = useRef<MessageInputHandle | null>(null)
  const messageListRef = useRef<MessageListHandle | null>(null)
  const previousAgentsByIdRef = useRef<Map<string, AgentDescriptor>>(new Map())
  const navigate = useOptionalNavigate()
  const location = useOptionalLocation()

  const { clientRef, state, setState } = useWsConnection(wsUrl)
  const { routeState, activeView, navigateToRoute } = useRouteState({
    pathname: location.pathname,
    search: location.search,
    navigate,
  })
  const {
    onboardingState,
    isMutating: isMutatingOnboardingState,
    error: onboardingError,
    savePreferences: saveOnboardingPreferences,
    skip: skipOnboarding,
  } = useOnboardingState(wsUrl)

  const [channelView, setChannelView] = useState<ChannelView>('web')

  const activeAgentId = useMemo(() => {
    return state.targetAgentId ?? state.subscribedAgentId ?? chooseFallbackAgentId(state.agents)
  }, [state.agents, state.subscribedAgentId, state.targetAgentId])

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

  const terminalSessionAgentId = useMemo(() => {
    if (!activeAgent) {
      return null
    }

    if (activeAgent.role === 'manager') {
      return activeAgent.profileId ?? activeAgent.agentId
    }

    return activeManagerAgent?.profileId ?? activeManagerAgent?.agentId ?? activeAgent.managerId ?? null
  }, [activeAgent, activeManagerAgent])

  // Project agents for @mention autocomplete — only when the active agent is a manager session
  const projectAgentSuggestions = useMemo(
    () => getProjectAgentSuggestions(activeAgent, state.agents),
    [activeAgent, state.agents],
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

  // Proactively load workers when viewing a manager session or when workerCount changes
  useEffect(() => {
    if (!isActiveManager || !activeManagerId || !clientRef.current) return
    void clientRef.current.getSessionWorkers(activeManagerId).catch(() => {})
  }, [isActiveManager, activeManagerId, clientRef, activeManagerWorkerCount])

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
    channelView,
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
    newManagerModel,
    createManagerError,
    browseError,
    isCreatingManager,
    isValidatingDirectory,
    isPickingDirectory,
    handleNewManagerNameChange,
    handleNewManagerCwdChange,
    handleNewManagerModelChange,
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
    defaultManagerModel: DEFAULT_MANAGER_MODEL,
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
      const explicitTargetExists = state.agents.some(
        (agent) => agent.agentId === explicitSelectionAgentId,
      )

      if (explicitTargetExists) {
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
        ) ?? chooseFallbackAgentId(state.agents)

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

    if (state.agents.some((agent) => agent.agentId === routeState.agentId)) {
      clientRef.current?.subscribeToAgent(routeState.agentId)
      return
    }

    if (state.agents.length === 0) {
      return
    }

    const fallbackAgentId = chooseFallbackAgentId(state.agents)
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

  const handleUpdateManagerModel = useCallback(async (managerId: string, model: ManagerModelPreset, reasoningLevel?: ManagerReasoningLevel) => {
    const client = clientRef.current
    if (!client) return

    try {
      await client.updateManagerModel(managerId, model, reasoningLevel)
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to update model: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
    // Start the session-switch interaction token before any navigation /
    // subscribe so the conversation_history stop has a matching active token.
    // Always-on; cost is two performance.now() calls when nothing is recording.
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
      const fallbackAgentId = chooseFallbackAgentId(remainingAgents)
      if (fallbackAgentId) {
        navigateToRoute({ view: 'chat', agentId: fallbackAgentId })
        clientRef.current?.subscribeToAgent(fallbackAgentId)
      }
    }

    clientRef.current?.deleteAgent(agentId)
  }

  const handleOpenSettingsPanel = () => {
    navigateToRoute({ view: 'settings' })
  }

  const handleOpenPlaywright = () => {
    navigateToRoute({ view: 'playwright' })
  }

  const handleOpenStats = () => {
    navigateToRoute({ view: 'stats' })
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

  const handlePlaywrightViewStateChange = useCallback(
    (sessionId: string | null, mode: import('@/hooks/index-page/use-route-state').PlaywrightViewMode) => {
      navigateToRoute({
        view: 'playwright',
        playwrightSession: sessionId ?? undefined,
        playwrightMode: mode,
      })
    },
    [navigateToRoute],
  )

  const handlePlaywrightSnapshotUpdate = useCallback(
    (snapshot: import('@forge/protocol').PlaywrightDiscoverySnapshot) => {
      setState((prev) => ({
        ...prev,
        playwrightSnapshot: snapshot,
        playwrightSettings: snapshot.settings,
      }))
    },
    [setState],
  )

  const handlePlaywrightSettingsLoaded = useCallback(
    (settings: import('@forge/protocol').PlaywrightDiscoverySettings) => {
      setState((prev) => ({
        ...prev,
        playwrightSettings: settings,
      }))
    },
    [setState],
  )

  const showPlaywrightNav = state.playwrightSettings?.effectiveEnabled === true

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
    <main className="h-dvh bg-background text-foreground">
      <div className="flex h-dvh w-full min-w-0 overflow-hidden bg-background">
        <AgentSidebar
          connected={state.connected}
          wsUrl={wsUrl}
          agents={state.agents}
          profiles={state.profiles}
          statuses={state.statuses}
          unreadCounts={state.unreadCounts}
          terminalScopeId={state.terminalSessionScopeId}
          terminalCount={state.terminals.length}
          selectedAgentId={activeAgentId}
          isSettingsActive={activeView === 'settings'}
          isPlaywrightActive={activeView === 'playwright'}
          isStatsActive={activeView === 'stats'}
          showPlaywrightNav={showPlaywrightNav}
          isMobileOpen={isMobileSidebarOpen}
          onMobileClose={() => setIsMobileSidebarOpen(false)}
          onAddManager={handleOpenCreateManagerDialog}
          onSelectAgent={handleSelectAgent}
          onDeleteAgent={handleDeleteAgent}
          onDeleteManager={handleRequestDeleteManager}
          onOpenSettings={handleOpenSettingsPanel}
          onOpenCortexReview={handleOpenCortexReview}
          onOpenPlaywright={handleOpenPlaywright}
          onOpenStats={handleOpenStats}
          onCreateSession={handleCreateSession}
          onStopSession={handleStopSession}
          onResumeSession={handleResumeSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onPinSession={handlePinSession}
          onRenameProfile={handleRenameProfile}
          onForkSession={handleForkSession}
          onMarkUnread={handleMarkUnread}
          onMarkAllRead={handleMarkAllRead}
          onUpdateManagerModel={handleUpdateManagerModel}
          onUpdateManagerCwd={handleUpdateManagerCwd}
          onBrowseDirectory={handleBrowseDirectoryForCwd}
          onValidateDirectory={handleValidateDirectoryForCwd}
          onRequestSessionWorkers={handleRequestSessionWorkers}
          onReorderProfiles={handleReorderProfiles}
          onSetSessionProjectAgent={handleSetSessionProjectAgent}
          onGetProjectAgentConfig={handleGetProjectAgentConfig}
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
                onPlaywrightSnapshotUpdate={handlePlaywrightSnapshotUpdate}
                onPlaywrightSettingsLoaded={handlePlaywrightSettingsLoaded}
              />
            ) : activeView === 'playwright' ? (
              <PlaywrightDashboardView
                wsUrl={wsUrl}
                snapshot={state.playwrightSnapshot}
                onSnapshotUpdate={handlePlaywrightSnapshotUpdate}
                onOpenSettings={handleOpenSettingsPanel}
                selectedSessionId={routeState.view === 'playwright' ? routeState.playwrightSession ?? null : null}
                viewMode={routeState.view === 'playwright' ? routeState.playwrightMode ?? 'tiles' : 'tiles'}
                onViewStateChange={handlePlaywrightViewStateChange}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
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
                  activeAgentCreatedAt: activeAgent?.createdAt ?? null,
                  activeAgentUpdatedAt: activeAgent?.updatedAt ?? null,
                  channelView,
                  onChannelViewChange: setChannelView,
                  contextWindowUsage,
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
                  isLoading,
                  wsUrl,
                  activeAgentId,
                  projectAgent: activeAgent?.projectAgent,
                  onSuggestionClick: handleSuggestionClick,
                  onArtifactClick: handleOpenArtifact,
                  onForkFromMessage: activeAgentId ? handleForkFromMessage : undefined,
                  onPinMessage: isActiveManager && activeAgentId ? handlePinMessage : undefined,
                  getVote: feedbackProfileId ? getVote : undefined,
                  hasComment: feedbackProfileId ? hasComment : undefined,
                  onFeedbackVote: feedbackProfileId ? submitVote : undefined,
                  onFeedbackComment: feedbackProfileId ? submitComment : undefined,
                  onFeedbackClearComment: feedbackProfileId ? clearComment : undefined,
                  isFeedbackSubmitting,
                  onChoiceSubmit: handleChoiceSubmit,
                  onChoiceCancel: handleChoiceCancel,
                  pendingChoiceIds: state.pendingChoiceIds,
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
              }}
            />
          ) : null}
        </div>
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
          newManagerModel,
          createManagerError,
          browseError,
          onOpenChange: handleCreateManagerDialogOpenChange,
          onNameChange: handleNewManagerNameChange,
          onCwdChange: handleNewManagerCwdChange,
          onModelChange: handleNewManagerModelChange,
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
    </main>
  )
}

function useOptionalLocation(): { pathname: string; search: unknown } {
  try {
    const location = useLocation()
    return {
      pathname: location.pathname,
      search: location.search,
    }
  } catch {
    if (typeof window === 'undefined') {
      return { pathname: '/', search: {} }
    }

    return {
      pathname: window.location.pathname || '/',
      search: parseWindowRouteSearch(window.location.search),
    }
  }
}

type NavigateFn = (options: {
  to: string
  search?: { view?: string; agent?: string; statsTab?: string }
  replace?: boolean
  resetScroll?: boolean
}) => void | Promise<void>

function useOptionalNavigate(): NavigateFn {
  const fallbackNavigate: NavigateFn = ({ to, search, replace }) => {
    if (typeof window === 'undefined') {
      return
    }

    const params = new URLSearchParams()
    if (search?.view) {
      params.set('view', search.view)
    }
    if (search?.agent) {
      params.set('agent', search.agent)
    }
    if (search?.statsTab) {
      params.set('statsTab', search.statsTab)
    }

    const query = params.toString()
    const nextUrl = query ? `${to}?${query}` : to

    if (replace) {
      window.history.replaceState(null, '', nextUrl)
    } else {
      window.history.pushState(null, '', nextUrl)
    }
  }

  try {
    const routerNavigate = useNavigate() as unknown as NavigateFn
    return (options) => {
      try {
        return routerNavigate(options)
      } catch {
        return fallbackNavigate(options)
      }
    }
  } catch {
    return fallbackNavigate
  }
}

function parseWindowRouteSearch(search: string): { view?: string; agent?: string; statsTab?: string } {
  if (!search) {
    return {}
  }

  const params = new URLSearchParams(search)
  const view = params.get('view')
  const agent = params.get('agent')
  const statsTab = params.get('statsTab')

  return {
    view: view ?? undefined,
    agent: agent ?? undefined,
    statsTab: statsTab ?? undefined,
  }
}


