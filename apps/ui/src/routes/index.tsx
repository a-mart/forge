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
import { ArtifactPanel } from '@/components/chat/ArtifactPanel'
import { ArtifactsSidebar } from '@/components/chat/ArtifactsSidebar'
import { CortexDashboardPanel, type DashboardTab as CortexDashboardTab } from '@/components/chat/cortex/CortexDashboardPanel'
import { OnboardingCallout } from '@/components/chat/cortex/OnboardingCallout'
import { ChatHeader, type ChannelView } from '@/components/chat/ChatHeader'
import { CreateManagerDialog } from '@/components/chat/CreateManagerDialog'
import { DeleteManagerDialog } from '@/components/chat/DeleteManagerDialog'
import { ForkSessionDialog } from '@/components/chat/ForkSessionDialog'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList, type MessageListHandle } from '@/components/chat/MessageList'
import { WorkerBackBar } from '@/components/chat/WorkerBackBar'
import { WorkerPillBar } from '@/components/chat/WorkerPillBar'
import { DiffViewerDialog, type DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
import { FileBrowserSidebar } from '@/components/file-browser/FileBrowserSidebar'
import { FileBrowserPanel } from '@/components/file-browser/FileBrowserPanel'
import { PlaywrightDashboardView } from '@/components/playwright/PlaywrightDashboardView'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import type { TerminalSelectionContext } from '@/components/terminal/TerminalViewport'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { StatsPanel } from '@/components/stats/StatsPanel'
import { chooseFallbackAgentId } from '@/lib/agent-hierarchy'
import type { ArtifactReference } from '@/lib/artifacts'
import { collectArtifactsFromMessages } from '@/lib/collect-artifacts'
import { hasProjectManagers } from '@/lib/onboarding-ui'
import { useFeedback } from '@/lib/use-feedback'
import {
  DEFAULT_MANAGER_AGENT_ID,
  useRouteState,
} from '@/hooks/index-page/use-route-state'
import { useWsConnection } from '@/hooks/index-page/use-ws-connection'
import { useManagerActions } from '@/hooks/index-page/use-manager-actions'
import { useVisibleMessages } from '@/hooks/index-page/use-visible-messages'
import { useContextWindow } from '@/hooks/index-page/use-context-window'
import { usePendingResponse } from '@/hooks/index-page/use-pending-response'
import { useFileDrop } from '@/hooks/index-page/use-file-drop'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import { useDynamicFavicon } from '@/hooks/use-dynamic-favicon'
import { useTerminalPanel } from '@/hooks/useTerminalPanel'
import { cn } from '@/lib/utils'
import type {
  AgentDescriptor,
  ChoiceAnswer,
  ConversationAttachment,
  ManagerModelPreset,
  ManagerReasoningLevel,
} from '@forge/protocol'
import { fetchSlashCommands, type SlashCommand } from '@/components/settings/slash-commands-api'
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

  const [activeArtifact, setActiveArtifact] = useState<ArtifactReference | null>(null)
  const [isArtifactsPanelOpen, setIsArtifactsPanelOpen] = useState(false)
  const [cortexDashboardTabRequest, setCortexDashboardTabRequest] = useState<{ tab: CortexDashboardTab; nonce: number } | null>(null)
  const [pendingCortexDashboardOpen, setPendingCortexDashboardOpen] = useState(false)
  const [channelView, setChannelView] = useState<ChannelView>('web')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])
  const slashCommandsFetchKeyRef = useRef(0)
  const [isDiffViewerOpen, setIsDiffViewerOpen] = useState(false)
  const [diffViewerInitialState, setDiffViewerInitialState] = useState<DiffViewerInitialState | null>(null)
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false)
  const [selectedFileBrowserFile, setSelectedFileBrowserFile] = useState<string | null>(null)

  const activeAgentId = useMemo(() => {
    return state.targetAgentId ?? state.subscribedAgentId ?? chooseFallbackAgentId(state.agents)
  }, [state.agents, state.subscribedAgentId, state.targetAgentId])

  const activeAgent = useMemo(() => {
    if (!activeAgentId) {
      return null
    }

    return state.agents.find((agent) => agent.agentId === activeAgentId) ?? null
  }, [activeAgentId, state.agents])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const pinnedCount = useMemo(
    () => state.messages.filter(
      (m) => m.type === 'conversation_message' && m.pinned,
    ).length,
    [state.messages],
  )

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
    setActiveArtifact(null)
    setIsArtifactsPanelOpen(false)
    setIsFileBrowserOpen(false)
    setSelectedFileBrowserFile(null)
    setIsMobileSidebarOpen(false)
  }, [activeAgentId])

  useEffect(() => {
    if (!pendingCortexDashboardOpen || activeAgent?.archetypeId !== 'cortex') {
      return
    }

    setIsArtifactsPanelOpen(true)
    setPendingCortexDashboardOpen(false)
  }, [activeAgent, pendingCortexDashboardOpen])

  // Fetch slash commands on mount (global, not manager-scoped)
  useEffect(() => {
    const fetchKey = ++slashCommandsFetchKeyRef.current
    void (async () => {
      try {
        const cmds = await fetchSlashCommands(wsUrl)
        // Only apply if this is still the latest fetch
        if (fetchKey === slashCommandsFetchKeyRef.current) {
          setSlashCommands(cmds)
        }
      } catch (error) {
        // Slash commands are optional — log error but don't block UI
        console.error('Failed to fetch slash commands:', error)
        if (fetchKey === slashCommandsFetchKeyRef.current) {
          setSlashCommands([])
        }
      }
    })()
  }, [wsUrl, activeView])

  // Keyboard shortcut: ⌘⇧D / Ctrl+Shift+D to toggle diff viewer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        setIsDiffViewerOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

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

  const handleReorderProfiles = useCallback((profileIds: string[]) => {
    clientRef.current?.reorderProfiles(profileIds)
  }, [clientRef])

  const handleSelectAgent = (agentId: string) => {
    navigateToRoute({ view: 'chat', agentId })
    clientRef.current?.subscribeToAgent(agentId)
  }

  const handleOpenCortexReview = useCallback((agentId: string) => {
    navigateToRoute({ view: 'chat', agentId })
    clientRef.current?.subscribeToAgent(agentId)
    setPendingCortexDashboardOpen(true)
    setCortexDashboardTabRequest({ tab: 'review', nonce: Date.now() })
  }, [navigateToRoute])

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

  const handleToggleArtifactsPanel = useCallback(() => {
    setIsArtifactsPanelOpen((previous) => {
      if (!previous) {
        // Opening artifacts → close file browser sidebar
        setIsFileBrowserOpen(false)
        setSelectedFileBrowserFile(null)
      }
      return !previous
    })
  }, [])

  const handleToggleFileBrowser = useCallback(() => {
    setIsFileBrowserOpen((previous) => {
      if (!previous) {
        // Opening file browser → close artifacts sidebar
        setIsArtifactsPanelOpen(false)
      } else {
        // Closing file browser → also close file panel
        setSelectedFileBrowserFile(null)
      }
      return !previous
    })
  }, [])

  // Keyboard shortcut: ⌘⇧E / Ctrl+Shift+E to toggle file browser sidebar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      ) {
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault()
        handleToggleFileBrowser()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleToggleFileBrowser])

  const handleFileBrowserSelectFile = useCallback((path: string) => {
    setSelectedFileBrowserFile(path)
  }, [])

  const handleFileBrowserClosePanel = useCallback(() => {
    setSelectedFileBrowserFile(null)
  }, [])

  const handleFileBrowserNavigateToDirectory = useCallback((_dirPath: string) => {
    setSelectedFileBrowserFile(null)
  }, [])

  const handleOpenArtifact = useCallback((artifact: ArtifactReference) => {
    setActiveArtifact(artifact)
  }, [])

  const handleCloseArtifact = useCallback(() => {
    setActiveArtifact(null)
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
          onRenameProfile={handleRenameProfile}
          onForkSession={handleForkSession}
          onMarkUnread={handleMarkUnread}
          onUpdateManagerModel={handleUpdateManagerModel}
          onRequestSessionWorkers={handleRequestSessionWorkers}
          onReorderProfiles={handleReorderProfiles}

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
              <StatsPanel
                wsUrl={wsUrl}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
              />
            ) : (
              <>
                <ChatHeader
                  connected={state.connected}
                  activeAgentId={activeAgentId}
                  activeAgentLabel={activeAgentLabel}
                  wsUrl={wsUrl}
                  activeAgentProfileName={activeAgentProfileName}
                  activeAgentSessionLabel={activeAgentSessionLabel}
                  totalUnreadCount={totalUnreadCount}
                  activeAgentArchetypeId={activeAgent?.archetypeId}
                  activeAgentStatus={activeAgentStatus}
                  channelView={channelView}
                  onChannelViewChange={setChannelView}
                  contextWindowUsage={contextWindowUsage}
                  showCompact={isActiveManager}
                  compactInProgress={isCompactingManager}
                  onCompact={() => void handleCompactManager()}
                  showSmartCompact={isActiveManager}
                  smartCompactInProgress={isSmartCompactingManager}
                  onSmartCompact={() => void handleSmartCompactManager()}
                  autoCompactionInProgress={autoCompactionInProgress}
                  pinnedCount={pinnedCount}
                  showStopAll={isActiveManager}
                  stopAllInProgress={isStoppingAllAgents}
                  stopAllDisabled={!state.connected || !canStopAllAgents}
                  onStopAll={() => void handleStopAllAgents()}
                  showNewChat={isActiveManager}
                  onNewChat={handleNewChat}
                  isArtifactsPanelOpen={isArtifactsPanelOpen}
                  onToggleArtifactsPanel={handleToggleArtifactsPanel}
                  isTerminalPanelOpen={terminalPanel.isPanelVisible}
                  terminalCount={state.terminals.length}
                  onToggleTerminalPanel={terminalSessionAgentId ? terminalPanel.togglePanel : undefined}
                  onOpenDiffViewer={() => {
                    setDiffViewerInitialState(null)
                    setIsDiffViewerOpen(true)
                  }}
                  isFileBrowserOpen={isFileBrowserOpen}
                  onToggleFileBrowser={handleToggleFileBrowser}
                  onToggleMobileSidebar={() =>
                    setIsMobileSidebarOpen((previous) => !previous)
                  }
                  sessionFeedbackVote={isActiveManager && activeAgentId ? getVote(activeAgentId) : null}
                  sessionFeedbackHasComment={isActiveManager && activeAgentId ? hasComment(activeAgentId) : false}
                  onSessionFeedbackVote={
                    isActiveManager && feedbackProfileId ? submitVote : undefined
                  }
                  onSessionFeedbackComment={
                    isActiveManager && feedbackProfileId ? submitComment : undefined
                  }
                  onSessionFeedbackClearComment={
                    isActiveManager && feedbackProfileId ? clearComment : undefined
                  }
                  isFeedbackSubmitting={isFeedbackSubmitting}
                />

                {state.lastError ? (
                  <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {state.lastError}
                  </div>
                ) : null}

                {state.lastSuccess ? (
                  <div className="border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
                    {state.lastSuccess}
                  </div>
                ) : null}

                {shouldShowWelcomeForm && onboardingState ? (
                  <OnboardingCallout
                    mode="first-launch"
                    state={onboardingState}
                    isBusy={isMutatingOnboardingState}
                    error={onboardingError}
                    onSave={handleSaveOnboarding}
                    onSkipForNow={handleSkipOnboarding}
                  />
                ) : shouldShowCreateManagerState ? (
                  <OnboardingCallout
                    mode="ready"
                    state={onboardingState}
                    isBusy={isMutatingOnboardingState}
                    error={onboardingError}
                    onCreateManager={handleOpenCreateManagerDialog}
                  />
                ) : (
                  <>
                    <div
                      className={cn(
                        'min-h-0 flex flex-1 flex-col overflow-hidden',
                        terminalPanel.panelMode === 'maximized' && !terminalPanel.isMobile && terminalPanel.isPanelVisible && 'hidden',
                      )}
                    >
                      <MessageList
                        ref={messageListRef}
                        messages={visibleMessages}
                        isLoading={isLoading}
                        wsUrl={wsUrl}
                        activeAgentId={activeAgentId}
                        onSuggestionClick={handleSuggestionClick}
                        onArtifactClick={handleOpenArtifact}
                        onForkFromMessage={activeAgentId ? handleForkFromMessage : undefined}
                        onPinMessage={isActiveManager && activeAgentId ? handlePinMessage : undefined}
                        getVote={feedbackProfileId ? getVote : undefined}
                        hasComment={feedbackProfileId ? hasComment : undefined}
                        onFeedbackVote={feedbackProfileId ? submitVote : undefined}
                        onFeedbackComment={feedbackProfileId ? submitComment : undefined}
                        onFeedbackClearComment={feedbackProfileId ? clearComment : undefined}
                        isFeedbackSubmitting={isFeedbackSubmitting}
                        onChoiceSubmit={handleChoiceSubmit}
                        onChoiceCancel={handleChoiceCancel}
                        pendingChoiceIds={state.pendingChoiceIds}
                        streamingStartedAt={activeAgentStatus === 'streaming' ? state.statuses[activeAgentId ?? '']?.streamingStartedAt : undefined}
                      />
                    </div>

                    {isActiveManager ? (
                      <WorkerPillBar
                        workers={sessionWorkers}
                        statuses={state.statuses}
                        activityMessages={state.activityMessages}
                        onNavigateToWorker={handleSelectAgent}
                      />
                    ) : activeAgent?.role === 'worker' && activeAgent.managerId && parentManagerLabel ? (
                      <WorkerBackBar
                        managerLabel={parentManagerLabel}
                        onNavigateBack={() => handleSelectAgent(activeAgent.managerId)}
                      />
                    ) : null}

                    <div className="px-3">
                    <TerminalPanel
                      wsUrl={wsUrl}
                      sessionAgentId={terminalSessionAgentId}
                      terminals={state.terminals}
                      panelMode={terminalPanel.panelMode}
                      activeTerminalId={terminalPanel.activeTerminalId}
                      panelHeight={terminalPanel.panelHeight}
                      isMobile={terminalPanel.isMobile}
                      maxTerminalsPerManager={terminalPanel.maxTerminalsPerManager}
                      editingTerminalId={terminalPanel.editingTerminalId}
                      renameDraft={terminalPanel.renameDraft}
                      initialTickets={terminalPanel.initialTickets}
                      onSelectTerminal={terminalPanel.setActiveTerminalId}
                      onCreateTerminal={() => {
                        void terminalPanel.createTerminal()
                      }}
                      onCloseTerminal={terminalPanel.closeTerminal}
                      onStartRenameTerminal={terminalPanel.startRenameTerminal}
                      onRenameDraftChange={terminalPanel.setRenameDraft}
                      onCommitRenameTerminal={terminalPanel.commitRenameTerminal}
                      onCancelRenameTerminal={terminalPanel.cancelRenameTerminal}
                      onCollapsePanel={terminalPanel.collapsePanel}
                      onRestorePanel={terminalPanel.restorePanel}
                      onMaximizePanel={terminalPanel.maximizePanel}
                      onHidePanel={terminalPanel.hidePanel}
                      onPanelHeightChange={terminalPanel.setPanelHeight}
                      onFocusChatInput={handleFocusChatInput}
                      onAddToChat={handleTerminalAddToChat}
                      issueTicket={terminalPanel.issueTicket}
                    />
                    </div>

                    <MessageInput
                      ref={messageInputRef}
                      onSend={handleSend}
                      onSubmitted={handleMessageInputSubmitted}
                      isLoading={isLoading}
                      disabled={!state.connected || !activeAgentId || hasActivePendingChoice}
                      placeholderOverride={
                        hasActivePendingChoice
                          ? 'Respond to the choice above or click Skip…'
                          : undefined
                      }
                      allowWhileLoading
                      agentLabel={activeAgentLabel}
                      wsUrl={wsUrl}
                      agentId={activeAgentId ?? undefined}
                      slashCommands={slashCommands}
                    />
                  </>
                )}
              </>
            )}
          </div>

          {activeView === 'chat' ? (
            <>
              {activeAgent?.archetypeId === 'cortex' ? (
                <CortexDashboardPanel
                  wsUrl={wsUrl}
                  managerId={activeManagerId}
                  isOpen={isArtifactsPanelOpen}
                  onClose={() => setIsArtifactsPanelOpen(false)}
                  onArtifactClick={handleOpenArtifact}
                  onOpenSession={handleSelectAgent}
                  onOpenDiffViewer={(initialState) => {
                    setDiffViewerInitialState(initialState)
                    setIsDiffViewerOpen(true)
                  }}
                  requestedTab={cortexDashboardTabRequest}
                />
              ) : (
                <ArtifactsSidebar
                  wsUrl={wsUrl}
                  managerId={activeManagerId}
                  artifacts={collectedArtifacts}
                  isOpen={isArtifactsPanelOpen}
                  onClose={() => setIsArtifactsPanelOpen(false)}
                  onArtifactClick={handleOpenArtifact}
                />
              )}
              {isFileBrowserOpen && selectedFileBrowserFile ? (
                <FileBrowserPanel
                  wsUrl={wsUrl}
                  agentId={activeAgentId}
                  filePath={selectedFileBrowserFile}
                  onClose={handleFileBrowserClosePanel}
                  onNavigateToDirectory={handleFileBrowserNavigateToDirectory}
                />
              ) : null}
              <FileBrowserSidebar
                wsUrl={wsUrl}
                agentId={activeAgentId}
                isOpen={isFileBrowserOpen}
                onClose={handleToggleFileBrowser}
                onSelectFile={handleFileBrowserSelectFile}
                selectedFile={selectedFileBrowserFile}
              />
            </>
          ) : null}
        </div>
      </div>

      <ArtifactPanel
        artifact={activeArtifact}
        wsUrl={wsUrl}
        activeAgentId={activeAgentId}
        onClose={handleCloseArtifact}
        onArtifactClick={handleOpenArtifact}
      />

      <CreateManagerDialog
        open={isCreateManagerDialogOpen}
        isCreatingManager={isCreatingManager}
        isValidatingDirectory={isValidatingDirectory}
        isPickingDirectory={isPickingDirectory}
        newManagerName={newManagerName}
        newManagerCwd={newManagerCwd}
        newManagerModel={newManagerModel}
        createManagerError={createManagerError}
        browseError={browseError}
        onOpenChange={handleCreateManagerDialogOpenChange}
        onNameChange={handleNewManagerNameChange}
        onCwdChange={handleNewManagerCwdChange}
        onModelChange={handleNewManagerModelChange}
        onBrowseDirectory={() => {
          void handleBrowseDirectory()
        }}
        onSubmit={(event) => {
          void handleCreateManager(event)
        }}
      />

      <DeleteManagerDialog
        managerToDelete={managerToDelete}
        deleteManagerError={deleteManagerError}
        isDeletingManager={isDeletingManager}
        onClose={handleCloseDeleteManagerDialog}
        onConfirm={() => {
          void handleConfirmDeleteManager()
        }}
      />

      {messageForkTarget ? (
        <ForkSessionDialog
          onConfirm={handleConfirmMessageFork}
          onClose={() => setMessageForkTarget(null)}
          fromMessageTimestamp={messageForkTarget.messageTimestamp
            ? new Date(messageForkTarget.messageTimestamp).toLocaleString()
            : undefined}
        />
      ) : null}

      <DiffViewerDialog
        open={isDiffViewerOpen}
        onOpenChange={setIsDiffViewerOpen}
        wsUrl={wsUrl}
        agentId={activeAgentId}
        isCortex={isDiffViewerCortexSession}
        initialRepoTarget={diffViewerInitialState?.initialRepoTarget}
        initialTab={diffViewerInitialState?.initialTab}
        initialSha={diffViewerInitialState?.initialSha}
        initialFile={diffViewerInitialState?.initialFile}
        initialQuickFilter={diffViewerInitialState?.initialQuickFilter}
      />
    </main>
  )
}

function parseCompactSlashCommand(
  text: string,
): { customInstructions?: string } | null {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i)
  if (!match) {
    return null
  }

  const customInstructions = match[1]?.trim()
  if (!customInstructions) {
    return {}
  }

  return { customInstructions }
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
  search?: { view?: string; agent?: string }
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

function parseWindowRouteSearch(search: string): { view?: string; agent?: string } {
  if (!search) {
    return {}
  }

  const params = new URLSearchParams(search)
  const view = params.get('view')
  const agent = params.get('agent')

  return {
    view: view ?? undefined,
    agent: agent ?? undefined,
  }
}

function chooseMostRecentSessionFallbackForDeletedTarget(
  agents: AgentDescriptor[],
  deletedAgentId: string,
  previousAgentsById: Map<string, AgentDescriptor>,
): string | null {
  const deletedAgent = previousAgentsById.get(deletedAgentId)
  const profileId = deletedAgent
    ? resolveDeletedAgentProfileId(agents, previousAgentsById, deletedAgent)
    : inferProfileIdFromDeletedAgentId(agents, deletedAgentId)
  if (!profileId) {
    return null
  }

  const profileSessions = agents
    .filter((agent) => {
      if (agent.role !== 'manager') {
        return false
      }

      const agentProfileId = agent.profileId?.trim() || agent.agentId
      return agentProfileId === profileId && agent.agentId !== deletedAgentId
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt)
      const rightTime = Date.parse(right.updatedAt)
      const normalizedLeftTime = Number.isFinite(leftTime) ? leftTime : 0
      const normalizedRightTime = Number.isFinite(rightTime) ? rightTime : 0

      if (normalizedLeftTime !== normalizedRightTime) {
        return normalizedRightTime - normalizedLeftTime
      }

      return right.agentId.localeCompare(left.agentId)
    })

  return profileSessions[0]?.agentId ?? null
}

function inferProfileIdFromDeletedAgentId(
  agents: AgentDescriptor[],
  deletedAgentId: string,
): string | null {
  const explicitProfileMatch = agents.find(
    (agent) => agent.role === 'manager' && (agent.profileId?.trim() || agent.agentId) === deletedAgentId,
  )
  if (explicitProfileMatch) {
    return explicitProfileMatch.profileId?.trim() || explicitProfileMatch.agentId
  }

  const sessionMatch = /^(.*)--s\d+$/.exec(deletedAgentId.trim())
  if (!sessionMatch) {
    return null
  }

  const inferredProfileId = sessionMatch[1]?.trim()
  if (!inferredProfileId) {
    return null
  }

  return agents.some((agent) => agent.role === 'manager' && (agent.profileId?.trim() || agent.agentId) === inferredProfileId)
    ? inferredProfileId
    : null
}

function resolveDeletedAgentProfileId(
  agents: AgentDescriptor[],
  previousAgentsById: Map<string, AgentDescriptor>,
  deletedAgent: AgentDescriptor,
): string | null {
  if (deletedAgent.role === 'manager') {
    return deletedAgent.profileId?.trim() || deletedAgent.agentId
  }

  const currentManager = agents.find(
    (agent) => agent.role === 'manager' && agent.agentId === deletedAgent.managerId,
  )
  const previousManager = previousAgentsById.get(deletedAgent.managerId)
  const managerDescriptor =
    currentManager ??
    (previousManager && previousManager.role === 'manager' ? previousManager : null)

  if (!managerDescriptor || managerDescriptor.role !== 'manager') {
    return null
  }

  return managerDescriptor.profileId?.trim() || managerDescriptor.agentId
}

