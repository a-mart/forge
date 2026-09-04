/**
 * Session / sidebar actions controller (WP-U3 BuilderSurface split).
 *
 * Owns the sibling session/sidebar command handlers that used to live inline in
 * BuilderSurface: send/reply, choice responses, pin/clear-pins, new chat,
 * session + profile lifecycle (create/stop/resume/delete/archive/restore/
 * rename/pin/fork), message fork, worker requests, read markers, model/cwd
 * updates, project-agent config/sharing/reference handlers, delete-agent, and
 * the small input helpers.
 *
 * Companion to (not a wrapper around) `useManagerActions` — the manager
 * create/delete/compact/stop-all dialog handlers stay in that existing hook and
 * are threaded in here where a session handler needs them (e.g. `/compact`
 * detection in `handleSend`).  Threaded-state controller (WP-U3 plan review):
 * receives `state`, active-agent info, the file-editor coordinator (owned by
 * `useWorkspacePanels`, which runs first), and `handleSelectAgent` rather than
 * re-deriving them.  Plain (non-`useCallback`) handlers that read fresh render
 * state at call time — `handleSend`, `handleNewChat`, `handleDeleteAgent`,
 * `handleSuggestionClick` — are kept plain deliberately (see plan review B7).
 */

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type {
  AgentDescriptor,
  ChoiceAnswer,
  ConversationAttachment,
  ConversationEntry,
  ConversationReplyTargetInput,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  WorkModeId,
  SessionProjectAgentInput,
} from '@forge/protocol'
import type { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type { MessageInputHandle } from '@/components/chat/MessageInput'
import type { MessageListHandle } from '@/components/chat/MessageList'
import {
  chooseFallbackAgentId,
  filterAgentsAfterProfileArchive,
  filterAgentsAfterSessionArchive,
} from '@/lib/agent-hierarchy'
import { requestGuardedAgentTransition } from '@/components/index-page/builder-file-editor-guard-actions'
import { isReplyTargetLoadedInMessages } from '@/components/index-page/reply-target-utils'
import { parseCompactSlashCommand } from '@/hooks/index-page/use-slash-commands'
import { useFileEditorCoordinator } from '@/components/file-browser/use-file-editor-coordinator'
import type { TerminalSelectionContext } from '@/components/terminal/TerminalViewport'

type FileEditorCoordinator = ReturnType<typeof useFileEditorCoordinator>

interface BuilderNavigationState {
  view: 'chat'
  agentId: string
}

export interface UseSessionActionsOptions {
  clientRef: MutableRefObject<ManagerWsClient | null>
  fileEditorCoordinator: FileEditorCoordinator
  state: ManagerWsState
  activeAgent: AgentDescriptor | null
  activeAgentId: string | null
  isActiveManager: boolean
  isLoading: boolean
  navigateToRoute: (nextRouteState: BuilderNavigationState, replace?: boolean) => void
  setState: Dispatch<SetStateAction<ManagerWsState>>
  visibleMessages: ConversationEntry[]
  markPendingResponse: (agentId: string, messageCount: number) => void
  handleCompactManager: (customInstructions?: string) => Promise<void>
  messageInputRef: MutableRefObject<MessageInputHandle | null>
  messageListRef: MutableRefObject<MessageListHandle | null>
}

export function useSessionActions({
  clientRef,
  fileEditorCoordinator,
  state,
  activeAgent,
  activeAgentId,
  isActiveManager,
  isLoading,
  navigateToRoute,
  setState,
  visibleMessages,
  markPendingResponse,
  handleCompactManager,
  messageInputRef,
  messageListRef,
}: UseSessionActionsOptions) {
  const [replyTarget, setReplyTarget] = useState<ConversationReplyTargetInput | null>(null)
  const [messageForkTarget, setMessageForkTarget] = useState<{ messageId: string; messageTimestamp?: string } | null>(null)

  useEffect(() => {
    setReplyTarget(null)
  }, [activeAgentId])

  useEffect(() => {
    const targetId = replyTarget?.messageId.trim()
    if (!targetId) {
      return
    }

    if (!isReplyTargetLoadedInMessages(replyTarget, state.messages)) {
      setReplyTarget(null)
    }
  }, [replyTarget, state.messages])

  const handleSend = (
    text: string,
    attachments?: ConversationAttachment[],
    options?: { replyTo?: ConversationReplyTargetInput },
  ) => {
    if (!activeAgentId) {
      return false
    }

    const compactCommand =
      isActiveManager && (!attachments || attachments.length === 0)
        ? parseCompactSlashCommand(text)
        : null

    if (compactCommand) {
      void handleCompactManager(compactCommand.customInstructions)
      return true
    }

    markPendingResponse(activeAgentId, state.messages.length)

    clientRef.current?.sendUserMessage(text, {
      agentId: activeAgentId,
      delivery: isActiveManager ? 'steer' : isLoading ? 'steer' : 'auto',
      attachments,
      replyTo: options?.replyTo,
    })
    return true
  }

  const handleReplyToMessage = useCallback((target: ConversationReplyTargetInput) => {
    setReplyTarget(target)
    requestAnimationFrame(() => messageInputRef.current?.focus())
  }, [messageInputRef])

  const handleMessageInputSubmitted = useCallback(() => {
    messageListRef.current?.scrollToBottom('smooth')
  }, [messageListRef])

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

    setReplyTarget(null)

    // Multi-session: clear current session conversation
    const profileId = activeAgent.profileId
    if (profileId && clientRef.current) {
      void (async () => {
        try {
          setReplyTarget(null)
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
    setReplyTarget(null)
    clientRef.current?.sendUserMessage('/new', {
      agentId: activeAgentId,
      delivery: 'steer',
    })
  }

  const handleCreateSession = useCallback((profileId: string, name?: string) => {
    const client = clientRef.current
    if (!client) return

    requestGuardedAgentTransition(fileEditorCoordinator, profileId, () => {
      void (async () => {
        try {
          const result = await client.createSession(profileId, name)
          navigateToRoute({ view: 'chat', agentId: result.sessionAgent.agentId })
          client.subscribeToAgent(result.sessionAgent.agentId, { reason: 'create' })
        } catch (error) {
          setState((prev) => ({
            ...prev,
            lastError: `Failed to create session: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }))
        }
      })()
    })
  }, [clientRef, fileEditorCoordinator, navigateToRoute, setState])

  const handleCreateAgentCreator = useCallback((profileId: string) => {
    const client = clientRef.current
    if (!client) return

    requestGuardedAgentTransition(fileEditorCoordinator, profileId, () => {
      void (async () => {
        try {
          const result = await client.createSession(profileId, undefined, {
            sessionPurpose: 'agent_creator',
            label: 'Agent Creator',
          })
          navigateToRoute({ view: 'chat', agentId: result.sessionAgent.agentId })
          client.subscribeToAgent(result.sessionAgent.agentId, { reason: 'create' })
        } catch (error) {
          setState((prev) => ({
            ...prev,
            lastError: `Failed to create agent creator: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }))
        }
      })()
    })
  }, [clientRef, fileEditorCoordinator, navigateToRoute, setState])

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

    const runDelete = () => {
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
    }

    if (agentId === activeAgentId) {
      requestGuardedAgentTransition(fileEditorCoordinator, agentId, runDelete)
      return
    }

    runDelete()
  }, [activeAgentId, clientRef, fileEditorCoordinator, setState])

  const handleArchiveSession = useCallback((agentId: string) => {
    const client = clientRef.current
    if (!client) return

    const runArchive = () => {
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
    }

    if (agentId === activeAgentId) {
      requestGuardedAgentTransition(fileEditorCoordinator, agentId, runArchive)
      return
    }

    runArchive()
  }, [activeAgentId, clientRef, fileEditorCoordinator, navigateToRoute, setState, state.agents, state.profiles])

  const handleArchiveProfile = useCallback((profileId: string) => {
    const client = clientRef.current
    if (!client) return

    const archivesActiveProfile = activeAgent?.role === 'manager' && (activeAgent.profileId ?? activeAgent.agentId) === profileId
    const runArchive = () => {
      void (async () => {
        try {
          await client.archiveProfile(profileId)
          const fallbackAgentId = chooseFallbackAgentId(
            filterAgentsAfterProfileArchive(state.agents, profileId),
            undefined,
            state.profiles.filter((profile) => profile.profileId !== profileId),
          )
          if (archivesActiveProfile && fallbackAgentId) {
            navigateToRoute({ view: 'chat', agentId: fallbackAgentId })
          }
        } catch (error) {
          setState((prev) => ({
            ...prev,
            lastError: `Failed to archive project: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }))
        }
      })()
    }

    if (archivesActiveProfile) {
      requestGuardedAgentTransition(fileEditorCoordinator, profileId, runArchive)
      return
    }

    runArchive()
  }, [activeAgent, clientRef, fileEditorCoordinator, navigateToRoute, setState, state.agents, state.profiles])

  const handleRestoreSession = useCallback((agentId: string, open = false) => {
    const client = clientRef.current
    if (!client) return

    const runRestore = () => {
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
    }

    if (open) {
      requestGuardedAgentTransition(fileEditorCoordinator, agentId, runRestore)
      return
    }

    runRestore()
  }, [clientRef, fileEditorCoordinator, navigateToRoute, setState])

  const handleRestoreProfile = useCallback((profileId: string, open = false) => {
    const client = clientRef.current
    if (!client) return

    const runRestore = () => {
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
    }

    if (open) {
      requestGuardedAgentTransition(fileEditorCoordinator, profileId, runRestore)
      return
    }

    runRestore()
  }, [clientRef, fileEditorCoordinator, navigateToRoute, setState])

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

    requestGuardedAgentTransition(fileEditorCoordinator, sourceAgentId, () => {
      void (async () => {
        try {
          const result = await client.forkSession(sourceAgentId, name)
          navigateToRoute({ view: 'chat', agentId: result.newSessionAgent.agentId })
          client.subscribeToAgent(result.newSessionAgent.agentId, { reason: 'fork' })
        } catch (error) {
          setState((prev) => ({
            ...prev,
            lastError: `Failed to fork session: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }))
        }
      })()
    })
  }, [clientRef, fileEditorCoordinator, navigateToRoute, setState])

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

    requestGuardedAgentTransition(fileEditorCoordinator, activeAgentId, () => {
      void (async () => {
        try {
          const result = await client.forkSession(activeAgentId, name, messageId)
          navigateToRoute({ view: 'chat', agentId: result.newSessionAgent.agentId })
          client.subscribeToAgent(result.newSessionAgent.agentId, { reason: 'fork' })
        } catch (error) {
          setState((prev) => ({
            ...prev,
            lastError: `Failed to fork session from message: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }))
        }
      })()
    })
  }, [clientRef, activeAgentId, fileEditorCoordinator, messageForkTarget, navigateToRoute, setState])

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

  const handleUpdateProjectDelegationDefaults = useCallback(async (
    profileId: string,
    updates: {
      managerPosture?: WorkModeId | null
      delegationRosterId?: string | null
    },
  ) => {
    const client = clientRef.current
    if (!client) return
    try {
      await client.updateProjectDelegationDefaults(profileId, updates)
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to update project delegation defaults: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      }))
      throw error
    }
  }, [clientRef, setState])

  const handleUpdateSessionDelegation = useCallback(async (
    sessionAgentId: string,
    updates: Parameters<ManagerWsClient['updateSessionDelegation']>[1],
  ) => {
    const client = clientRef.current
    if (!client) return
    try {
      await client.updateSessionDelegation(sessionAgentId, updates)
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to update session delegation: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      }))
      throw error
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

  const handleSetSessionProjectAgent = useCallback(async (agentId: string, projectAgent: SessionProjectAgentInput | null) => {
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

  const handleDeleteAgent = (agentId: string) => {
    const agent = state.agents.find((entry) => entry.agentId === agentId)
    if (!agent || agent.role !== 'worker') {
      return
    }

    const runDelete = () => {
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

    if (activeAgentId === agentId) {
      requestGuardedAgentTransition(fileEditorCoordinator, agentId, runDelete)
      return
    }

    runDelete()
  }

  const handleSuggestionClick = (prompt: string) => {
    messageInputRef.current?.setInput(prompt)
  }

  const handleFocusChatInput = useCallback(() => {
    messageInputRef.current?.focus()
  }, [messageInputRef])

  const handleTerminalAddToChat = useCallback((context: TerminalSelectionContext) => {
    messageInputRef.current?.addTerminalContext(context)
  }, [messageInputRef])

  return {
    replyTarget,
    setReplyTarget,
    messageForkTarget,
    setMessageForkTarget,
    handleSend,
    handleReplyToMessage,
    handleMessageInputSubmitted,
    handleChoiceSubmit,
    handleChoiceCancel,
    handlePinMessage,
    handleClearAllPins,
    handleNewChat,
    handleCreateSession,
    handleCreateAgentCreator,
    handleStopSession,
    handleResumeSession,
    handleDeleteSession,
    handleArchiveSession,
    handleArchiveProfile,
    handleRestoreSession,
    handleRestoreProfile,
    handleRenameSession,
    handlePinSession,
    handleRenameProfile,
    handleForkSession,
    handleForkFromMessage,
    handleConfirmMessageFork,
    handleRequestSessionWorkers,
    handleMarkUnread,
    handleMarkAllRead,
    handleUpdateManagerModel,
    handleUpdateSessionModel,
    handleUpdateProjectDelegationDefaults,
    handleUpdateSessionDelegation,
    handleUpdateManagerCwd,
    handleBrowseDirectoryForCwd,
    handleValidateDirectoryForCwd,
    handleReorderProfiles,
    handleSetSessionProjectAgent,
    handleGetProjectAgentConfig,
    handleGetProjectAgentSharing,
    handleSetProjectAgentSharing,
    handleListProjectAgentReferences,
    handleGetProjectAgentReference,
    handleSetProjectAgentReference,
    handleDeleteProjectAgentReference,
    handleRequestProjectAgentRecommendations,
    handleDeleteAgent,
    handleSuggestionClick,
    handleFocusChatInput,
    handleTerminalAddToChat,
  }
}
