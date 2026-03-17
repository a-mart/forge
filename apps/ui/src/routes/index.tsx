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
import { ChatHeader, type ChannelView } from '@/components/chat/ChatHeader'
import { CreateManagerDialog } from '@/components/chat/CreateManagerDialog'
import { DeleteManagerDialog } from '@/components/chat/DeleteManagerDialog'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList, type MessageListHandle } from '@/components/chat/MessageList'
import { PlaywrightDashboardView } from '@/components/playwright/PlaywrightDashboardView'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { chooseFallbackAgentId } from '@/lib/agent-hierarchy'
import type { ArtifactReference } from '@/lib/artifacts'
import { collectArtifactsFromMessages } from '@/lib/collect-artifacts'
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
import { useDynamicFavicon } from '@/hooks/use-dynamic-favicon'
import type {
  AgentDescriptor,
  ConversationAttachment,
  ManagerModelPreset,
  ManagerReasoningLevel,
} from '@forge/protocol'
import { fetchSlashCommands, type SlashCommand } from '@/components/settings/slash-commands-api'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

const DEFAULT_MANAGER_MODEL: ManagerModelPreset = 'pi-codex'
const DEFAULT_DEV_WS_URL = 'ws://127.0.0.1:47187'

function resolveDefaultWsUrl(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_DEV_WS_URL
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = window.location.hostname
  const uiPort =
    Number(window.location.port) ||
    (window.location.protocol === 'https:' ? 443 : 80)
  // Dev UI runs on 47188 -> backend 47187, prod UI runs on 47189 -> backend 47287.
  const wsPort = uiPort <= 47188 ? 47187 : 47287

  return `${protocol}//${hostname}:${wsPort}`
}

export function IndexPage() {
  const wsUrl = import.meta.env.VITE_FORGE_WS_URL ?? import.meta.env.VITE_MIDDLEMAN_WS_URL ?? resolveDefaultWsUrl()
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

  const [activeArtifact, setActiveArtifact] = useState<ArtifactReference | null>(null)
  const [isArtifactsPanelOpen, setIsArtifactsPanelOpen] = useState(false)
  const [cortexDashboardTabRequest, setCortexDashboardTabRequest] = useState<{ tab: CortexDashboardTab; nonce: number } | null>(null)
  const [pendingCortexDashboardOpen, setPendingCortexDashboardOpen] = useState(false)
  const [channelView, setChannelView] = useState<ChannelView>('web')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])
  const slashCommandsFetchKeyRef = useRef(0)

  const activeAgentId = useMemo(() => {
    return state.targetAgentId ?? state.subscribedAgentId ?? chooseFallbackAgentId(state.agents)
  }, [state.agents, state.subscribedAgentId, state.targetAgentId])

  const activeAgent = useMemo(() => {
    if (!activeAgentId) {
      return null
    }

    return state.agents.find((agent) => agent.agentId === activeAgentId) ?? null
  }, [activeAgentId, state.agents])

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

  const handleMergeSessionMemory = useCallback((agentId: string) => {
    const client = clientRef.current
    if (!client) return

    void (async () => {
      try {
        const result = await client.mergeSessionMemory(agentId)
        setState((prev) => ({
          ...prev,
          lastSuccess:
            result.status === 'applied'
              ? 'Session memory promoted into profile summary successfully.'
              : `Session memory merge skipped (${result.strategy.replace(/_/g, ' ')}).`,
          lastError: null,
        }))
      } catch (error) {
        setState((prev) => ({
          ...prev,
          lastError: `Failed to merge session memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
          lastSuccess: null,
        }))
      }
    })()
  }, [clientRef, setState])

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

  const handleToggleArtifactsPanel = useCallback(() => {
    setIsArtifactsPanelOpen((previous) => !previous)
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
          agents={state.agents}
          profiles={state.profiles}
          statuses={state.statuses}
          unreadCounts={state.unreadCounts}
          selectedAgentId={activeAgentId}
          isSettingsActive={activeView === 'settings'}
          isPlaywrightActive={activeView === 'playwright'}
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
          onCreateSession={handleCreateSession}
          onStopSession={handleStopSession}
          onResumeSession={handleResumeSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onForkSession={handleForkSession}
          onMergeSessionMemory={handleMergeSessionMemory}
          onMarkUnread={handleMarkUnread}
          onUpdateManagerModel={handleUpdateManagerModel}
          onRequestSessionWorkers={handleRequestSessionWorkers}
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
                slackStatus={state.slackStatus}
                telegramStatus={state.telegramStatus}
                promptChangeKey={state.promptChangeKey}
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
            ) : (
              <>
                <ChatHeader
                  connected={state.connected}
                  activeAgentId={activeAgentId}
                  activeAgentLabel={activeAgentLabel}
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
                  showStopAll={isActiveManager}
                  stopAllInProgress={isStoppingAllAgents}
                  stopAllDisabled={!state.connected || !canStopAllAgents}
                  onStopAll={() => void handleStopAllAgents()}
                  showNewChat={isActiveManager}
                  onNewChat={handleNewChat}
                  isArtifactsPanelOpen={isArtifactsPanelOpen}
                  onToggleArtifactsPanel={handleToggleArtifactsPanel}
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

                <MessageList
                  ref={messageListRef}
                  messages={visibleMessages}
                  isLoading={isLoading}
                  wsUrl={wsUrl}
                  activeAgentId={activeAgentId}
                  onSuggestionClick={handleSuggestionClick}
                  onArtifactClick={handleOpenArtifact}
                  getVote={feedbackProfileId ? getVote : undefined}
                  hasComment={feedbackProfileId ? hasComment : undefined}
                  onFeedbackVote={feedbackProfileId ? submitVote : undefined}
                  onFeedbackComment={feedbackProfileId ? submitComment : undefined}
                  onFeedbackClearComment={feedbackProfileId ? clearComment : undefined}
                  isFeedbackSubmitting={isFeedbackSubmitting}
                />

                <MessageInput
                  ref={messageInputRef}
                  onSend={handleSend}
                  onSubmitted={handleMessageInputSubmitted}
                  isLoading={isLoading}
                  disabled={!state.connected || !activeAgentId}
                  allowWhileLoading
                  agentLabel={activeAgentLabel}
                  wsUrl={wsUrl}
                  agentId={activeAgentId ?? undefined}
                  slashCommands={slashCommands}
                />
              </>
            )}
          </div>

          {activeView === 'chat' ? (
            activeAgent?.archetypeId === 'cortex' ? (
              <CortexDashboardPanel
                wsUrl={wsUrl}
                managerId={activeManagerId}
                isOpen={isArtifactsPanelOpen}
                onClose={() => setIsArtifactsPanelOpen(false)}
                onArtifactClick={handleOpenArtifact}
                onOpenSession={handleSelectAgent}
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
            )
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

