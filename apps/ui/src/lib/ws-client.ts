import type { ProjectAgentCapability } from '@forge/protocol'
import { handleManagerIdleTransition, removeMutedAgent, removeMutedAgents } from './notification-service'
import {
  assertConnectedSocket,
  assertReconnectableSocket,
  buildChoiceCancelCommand,
  buildChoiceResponseCommand,
  buildClearAllPinsCommand,
  buildCreateManagerCommand,
  buildCreateSessionCommand,
  buildDeleteManagerCommand,
  buildDeleteProjectAgentReferenceCommand,
  buildForkSessionCommand,
  buildGetProjectAgentConfigCommand,
  buildGetProjectAgentExternalDirectoryCommand,
  buildGetProjectAgentReferenceCommand,
  buildGetProjectAgentSharingCommand,
  buildGetSessionWorkersCommand,
  buildHydrateArchiveLastUsedCommand,
  buildKillAgentCommand,
  buildListDirectoriesCommand,
  buildListProjectAgentReferencesCommand,
  buildMarkAllReadCommand,
  buildMarkUnreadCommand,
  buildMergeSessionMemoryCommand,
  buildPickDirectoryCommand,
  buildPinMessageCommand,
  buildProfileArchiveActionCommand,
  buildPinSessionCommand,
  buildRenameProfileCommand,
  buildRenameSessionCommand,
  buildReorderProfilesCommand,
  buildRequestProjectAgentRecommendationsCommand,
  buildSessionActionCommand,
  buildSetProjectAgentReferenceCommand,
  buildSetProjectAgentSharingCommand,
  buildSetSessionProjectAgentCommand,
  buildStopAllAgentsCommand,
  buildSubscribeCommand,
  buildUpdateManagerCwdCommand,
  buildUpdateManagerModelCommand,
  buildUpdateProfileDefaultModelCommand,
  buildUpdateSessionModelCommand,
  buildUserMessageCommand,
  buildValidateDirectoryCommand,
  isSocketOpen,
  RECONNECTING_SOCKET_ERROR,
} from './ws-client/request-definitions'
import { WebSocketTransport } from './ws-client/websocket-transport'
import { BootstrapBuffer } from './ws-client/bootstrap-buffer'
import { SessionWorkerCache } from './ws-client/session-worker-cache'
import {
  INITIAL_CONNECT_DELAY_MS,
  RECONNECT_MS,
} from './ws-client/runtime-types'
import {
  reduceAgentStatus,
  reduceAgentsSnapshot,
  reduceManagerDeleted,
  reduceSessionDeleted,
} from './ws-client/snapshot-reducers'
import type {
  DirectoriesListedResult,
  DirectoryValidationResult,
  Listener,
  ProjectAgentConfigResult,
  ProjectAgentExternalDirectoryResult,
  ProjectAgentReferenceDeletedResult,
  ProjectAgentReferenceResult,
  ProjectAgentReferencesResult,
  ProjectAgentReferenceSavedResult,
  ProjectAgentSharingResult,
  ProjectAgentSharingUpdatedResult,
  ArchiveLastUsedHydrationResult,
  ProfileArchiveResult,
  ProfileRestoreResult,
  SessionActionResult,
  SessionArchiveResult,
  SessionCreatedResult,
  SessionForkedResult,
  SessionProjectAgentResult,
  SessionRestoreResult,
  SessionWorkersResult,
} from './ws-client/types'
import { createSystemConversationMessage, normalizeAgentId, normalizeConversationAttachments, resolveTerminalScopeAgentId } from './ws-client/utils'
import { RequestDispatcher } from './ws-client/request-dispatcher'
import {
  createInitialManagerWsState,
  type ManagerWsState,
} from './ws-state'
import { handleConversationEvent } from './ws-client/event-handlers/conversation-event-handlers'
import { handleTerminalEvent } from './ws-client/event-handlers/terminal-event-handlers'
import { handleAgentEvent } from './ws-client/event-handlers/agent-event-handlers'
import { handleSessionEvent } from './ws-client/event-handlers/session-event-handlers'
import { handleProjectAgentEvent } from './ws-client/event-handlers/project-agent-event-handlers'
import { handleConfigEvent } from './ws-client/event-handlers/config-event-handlers'
import { handleDirectoryEvent } from './ws-client/event-handlers/directory-event-handlers'
import { handleSystemEvent } from './ws-client/event-handlers/system-event-handlers'
import type {
  AgentDescriptor,
  AgentSessionPurpose,
  ChoiceAnswer,
  ClientCommand,
  ConversationAttachment,
  DeliveryMode,
  ManagerExactModelSelection,
  ManagerModelPreset,
  ManagerReasoningLevel,
  ServerEvent,
  SessionMemoryMergeResult,
} from '@forge/protocol'

export type { ManagerWsState } from './ws-state'
export type {
  DirectoriesListedResult,
  DirectoryValidationResult,
  ProjectAgentConfigResult,
  ProjectAgentReferenceDeletedResult,
  ProjectAgentReferenceResult,
  ProjectAgentReferencesResult,
  ProjectAgentReferenceSavedResult,
} from './ws-client/types'

export class ManagerWsClient {
  private readonly transport: WebSocketTransport
  private desiredAgentId: string | null

  /** Convenience accessor — delegates to transport so existing guards work unchanged. */
  private get socket(): WebSocket | null {
    return this.transport.getSocket()
  }

  private hasConnectedOnce = false
  private shouldReloadOnReconnect = false
  private hasExplicitAgentSelection = false
  private explicitAgentSelectionAgentId: string | null = null

  private state: ManagerWsState
  private readonly listeners = new Set<Listener>()

  private readonly requestDispatcher: RequestDispatcher
  private readonly bootstrapBuffer: BootstrapBuffer
  private readonly sessionWorkerCache: SessionWorkerCache

  constructor(url: string, initialAgentId?: string | null) {
    const normalizedInitialAgentId = normalizeAgentId(initialAgentId)
    this.desiredAgentId = normalizedInitialAgentId
    this.state = createInitialManagerWsState(normalizedInitialAgentId)

    this.requestDispatcher = new RequestDispatcher({
      send: (command) => this.send(command),
    })

    this.bootstrapBuffer = new BootstrapBuffer({
      getState: () => this.state,
      updateState: (patch) => this.updateState(patch),
      applyConversationEvent: handleConversationEvent,
    })

    this.sessionWorkerCache = new SessionWorkerCache({
      getState: () => this.state,
      updateState: (patch) => this.updateState(patch),
      requestSessionWorkers: (sessionAgentId) => {
        assertConnectedSocket(this.socket)
        return this.requestDispatcher.enqueueRequest('get_session_workers', (requestId) =>
          buildGetSessionWorkersCommand(sessionAgentId, requestId),
        )
      },
    })

    this.transport = new WebSocketTransport({
      url,
      reconnectDelayMs: RECONNECT_MS,
      onOpen: () => this.handleTransportOpen(),
      onClose: () => this.handleTransportClose(),
      onMessage: (data) => this.handleServerEvent(data),
      onError: () => this.handleTransportError(),
    })
  }

  getState(): ManagerWsState {
    return this.state
  }

  markUnread(agentId: string): void {
    const current = this.state.unreadCounts[agentId] ?? 0
    if (current === 0) {
      this.updateState({
        unreadCounts: { ...this.state.unreadCounts, [agentId]: 1 },
      })
    }
    this.send(buildMarkUnreadCommand(agentId))
  }

  markAllRead(profileId: string): void {
    const nextUnread = { ...this.state.unreadCounts }
    let changed = false
    for (const agent of this.state.agents) {
      if (agent.profileId === profileId && agent.role === 'manager' && nextUnread[agent.agentId]) {
        delete nextUnread[agent.agentId]
        changed = true
      }
    }
    if (changed) {
      this.updateState({ unreadCounts: nextUnread })
    }
    this.send(buildMarkAllReadCommand(profileId))
  }

  hasExplicitSelection(): boolean {
    return this.hasExplicitAgentSelection
  }

  getExplicitSelectionAgentId(): string | null {
    return this.explicitAgentSelectionAgentId
  }

  private resolveTerminalScopeAgentId(
    agentId: string | null | undefined,
    agents: AgentDescriptor[] = this.state.agents,
  ): string | null {
    return resolveTerminalScopeAgentId(agentId, agents)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)

    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (typeof window === 'undefined') return

    this.transport.connect(INITIAL_CONNECT_DELAY_MS)
  }

  destroy(): void {
    this.requestDispatcher.rejectAllPendingRequests('Client destroyed before request completed.')
    this.sessionWorkerCache.destroy()
    this.bootstrapBuffer.clear()

    this.transport.disconnect()
  }

  subscribeToAgent(agentId: string, options?: { explicit?: boolean }): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    const isExplicitSelection = options?.explicit ?? true
    this.hasExplicitAgentSelection = isExplicitSelection
    this.explicitAgentSelectionAgentId = isExplicitSelection ? trimmed : null

    const previousTerminalScopeId = this.resolveTerminalScopeAgentId(this.state.targetAgentId)
    const nextTerminalScopeId = this.resolveTerminalScopeAgentId(trimmed)
    const shouldResetTerminals = previousTerminalScopeId !== nextTerminalScopeId

    this.desiredAgentId = trimmed
    const nextUnread = { ...this.state.unreadCounts }
    delete nextUnread[trimmed]
    this.updateState({
      targetAgentId: trimmed,
      messages: [],
      activityMessages: [],
      modelCacheObservations: [],
      pendingChoiceIds: new Set(),
      taskSnapshotLoadingSessionId: trimmed,
      ...(shouldResetTerminals ? { terminals: [], terminalSessionScopeId: null } : {}),
      lastError: null,
      unreadCounts: nextUnread,
    })

    if (!isSocketOpen(this.socket)) {
      return
    }

    this.bootstrapBuffer.begin(trimmed)
    this.send(buildSubscribeCommand(trimmed))
  }

  sendUserMessage(
    text: string,
    options?: { agentId?: string; delivery?: DeliveryMode; attachments?: ConversationAttachment[] },
  ): void {
    const trimmed = text.trim()
    const attachments = normalizeConversationAttachments(options?.attachments)
    if (!trimmed && attachments.length === 0) return

    if (!isSocketOpen(this.socket)) {
      this.updateState({
        lastError: RECONNECTING_SOCKET_ERROR,
      })
      return
    }

    const agentId =
      options?.agentId ?? this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId

    if (!agentId) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (
      !options?.agentId &&
      !this.state.targetAgentId &&
      !this.state.subscribedAgentId &&
      this.state.agents.length === 0
    ) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (
      this.state.agents.length > 0 &&
      !this.state.agents.some((agent) => agent.agentId === agentId) &&
      !this.state.statuses[agentId]
    ) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    this.send(
      buildUserMessageCommand({
        text: trimmed,
        attachments,
        agentId,
        delivery: options?.delivery,
      }),
    )
  }

  sendChoiceResponse(agentId: string, choiceId: string, answers: ChoiceAnswer[]): void {
    this.send(buildChoiceResponseCommand(agentId, choiceId, answers))
  }

  sendChoiceCancel(agentId: string, choiceId: string): void {
    this.send(buildChoiceCancelCommand(agentId, choiceId))
  }

  pinMessage(agentId: string, messageId: string, pinned: boolean): void {
    this.send(buildPinMessageCommand(agentId, messageId, pinned))
  }

  clearAllPins(agentId: string): void {
    this.send(buildClearAllPinsCommand(agentId))
  }

  deleteAgent(agentId: string): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    if (!isSocketOpen(this.socket)) {
      this.updateState({
        lastError: RECONNECTING_SOCKET_ERROR,
      })
      return
    }

    this.send(buildKillAgentCommand(trimmed))
  }

  async stopAllAgents(
    managerId: string,
  ): Promise<{ managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }> {
    const trimmed = managerId.trim()
    if (!trimmed) {
      throw new Error('Manager id is required.')
    }

    assertReconnectableSocket(this.socket)

    return this.requestDispatcher.enqueueRequest('stop_all_agents', (requestId) =>
      buildStopAllAgentsCommand(trimmed, requestId),
    )
  }

  async createManager(input: {
    name: string
    cwd: string
    model?: ManagerModelPreset
    modelSelection?: ManagerExactModelSelection
    reasoningLevel?: ManagerReasoningLevel
  }): Promise<AgentDescriptor> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('create_manager', (requestId) =>
      buildCreateManagerCommand(input, requestId),
    )
  }

  async deleteManager(managerId: string): Promise<{ managerId: string }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('delete_manager', (requestId) =>
      buildDeleteManagerCommand(managerId, requestId),
    )
  }

  async updateProfileDefaultModel(
    profileId: string,
    model?: ManagerModelPreset,
    reasoningLevel?: ManagerReasoningLevel,
    modelSelection?: ManagerExactModelSelection,
  ): Promise<{ profileId: string }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('update_profile_default_model', (requestId) =>
      buildUpdateProfileDefaultModelCommand(profileId, model, reasoningLevel, requestId, modelSelection),
    )
  }

  async updateManagerModel(
    managerId: string,
    model?: ManagerModelPreset,
    reasoningLevel?: ManagerReasoningLevel,
    modelSelection?: ManagerExactModelSelection,
  ): Promise<{ managerId: string }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('update_manager_model', (requestId) =>
      buildUpdateManagerModelCommand(managerId, model, reasoningLevel, requestId, modelSelection),
    )
  }

  async updateManagerCwd(managerId: string, cwd: string): Promise<{ managerId: string; cwd: string }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('update_manager_cwd', (requestId) =>
      buildUpdateManagerCwdCommand(managerId, cwd, requestId),
    )
  }

  reorderProfiles(profileIds: string[]): boolean {
    if (!isSocketOpen(this.socket)) return false
    return this.send(buildReorderProfilesCommand(profileIds))
  }

  async listDirectories(path?: string): Promise<DirectoriesListedResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('list_directories', (requestId) =>
      buildListDirectoriesCommand(path, requestId),
    )
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('validate_directory', (requestId) =>
      buildValidateDirectoryCommand(path, requestId),
    )
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    const bridge = typeof window !== 'undefined' ? window.electronBridge : undefined
    if (bridge?.showOpenDialog) {
      const result = await bridge.showOpenDialog({
        title: 'Select Directory',
        defaultPath: defaultPath?.trim() || undefined,
        properties: ['openDirectory'],
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }

    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('pick_directory', (requestId) =>
      buildPickDirectoryCommand(defaultPath, requestId),
    )
  }

  async createSession(
    profileId: string,
    name?: string,
    opts?: { sessionPurpose?: AgentSessionPurpose; label?: string },
  ): Promise<SessionCreatedResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('create_session', (requestId) =>
      buildCreateSessionCommand(profileId, name, opts, requestId),
    )
  }

  async updateSessionModel(
    sessionAgentId: string,
    mode: 'inherit' | 'override',
    model?: ManagerModelPreset,
    reasoningLevel?: ManagerReasoningLevel,
    modelSelection?: ManagerExactModelSelection,
  ): Promise<{ sessionAgentId: string; mode: 'inherit' | 'override' }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('update_session_model', (requestId) =>
      buildUpdateSessionModelCommand(sessionAgentId, mode, model, reasoningLevel, requestId, modelSelection),
    )
  }

  async stopSession(agentId: string): Promise<SessionActionResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('stop_session', (requestId) =>
      buildSessionActionCommand('stop_session', agentId, requestId),
    )
  }

  async resumeSession(agentId: string): Promise<SessionActionResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('resume_session', (requestId) =>
      buildSessionActionCommand('resume_session', agentId, requestId),
    )
  }

  async archiveSession(agentId: string): Promise<SessionArchiveResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('archive_session', (requestId) =>
      buildSessionActionCommand('archive_session', agentId, requestId),
    )
  }

  async restoreSession(agentId: string): Promise<SessionRestoreResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('restore_session', (requestId) =>
      buildSessionActionCommand('restore_session', agentId, requestId),
    )
  }

  async deleteSession(agentId: string): Promise<SessionActionResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('delete_session', (requestId) =>
      buildSessionActionCommand('delete_session', agentId, requestId),
    )
  }

  async clearSession(agentId: string): Promise<SessionActionResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('clear_session', (requestId) =>
      buildSessionActionCommand('clear_session', agentId, requestId),
    )
  }

  async renameSession(agentId: string, label: string): Promise<SessionActionResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('rename_session', (requestId) =>
      buildRenameSessionCommand(agentId, label, requestId),
    )
  }

  async pinSession(agentId: string, pinned: boolean): Promise<{ pinnedAt: string | null }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('pin_session', (requestId) =>
      buildPinSessionCommand(agentId, pinned, requestId),
    )
  }

  async renameProfile(profileId: string, displayName: string): Promise<{ profileId: string }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('rename_profile', (requestId) =>
      buildRenameProfileCommand(profileId, displayName, requestId),
    )
  }

  async archiveProfile(profileId: string): Promise<ProfileArchiveResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('archive_profile', (requestId) =>
      buildProfileArchiveActionCommand('archive_profile', profileId, requestId),
    )
  }

  async restoreProfile(profileId: string): Promise<ProfileRestoreResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('restore_profile', (requestId) =>
      buildProfileArchiveActionCommand('restore_profile', profileId, requestId),
    )
  }

  async hydrateArchiveLastUsed(): Promise<ArchiveLastUsedHydrationResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('hydrate_archive_last_used', (requestId) =>
      buildHydrateArchiveLastUsedCommand(requestId),
    )
  }

  async forkSession(
    sourceAgentId: string,
    label?: string,
    fromMessageId?: string,
  ): Promise<SessionForkedResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('fork_session', (requestId) =>
      buildForkSessionCommand(sourceAgentId, label, fromMessageId, requestId),
    )
  }

  async setSessionProjectAgent(
    agentId: string,
    projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string; capabilities?: ProjectAgentCapability[] } | null,
  ): Promise<SessionProjectAgentResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('set_session_project_agent', (requestId) =>
      buildSetSessionProjectAgentCommand(agentId, projectAgent, requestId),
    )
  }

  async getProjectAgentConfig(agentId: string): Promise<ProjectAgentConfigResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('get_project_agent_config', (requestId) =>
      buildGetProjectAgentConfigCommand(agentId, requestId),
    )
  }

  async getProjectAgentSharing(agentId: string): Promise<ProjectAgentSharingResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('get_project_agent_sharing', (requestId) =>
      buildGetProjectAgentSharingCommand(agentId, requestId),
    )
  }

  async setProjectAgentSharing(
    agentId: string,
    targetProfileIds: string[],
  ): Promise<ProjectAgentSharingUpdatedResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('set_project_agent_sharing', (requestId) =>
      buildSetProjectAgentSharingCommand(agentId, targetProfileIds, requestId),
    )
  }

  async getProjectAgentExternalDirectory(): Promise<ProjectAgentExternalDirectoryResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('get_project_agent_external_directory', (requestId) =>
      buildGetProjectAgentExternalDirectoryCommand(requestId),
    )
  }

  async listProjectAgentReferences(agentId: string): Promise<ProjectAgentReferencesResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('list_project_agent_references', (requestId) =>
      buildListProjectAgentReferencesCommand(agentId, requestId),
    )
  }

  async getProjectAgentReference(
    agentId: string,
    fileName: string,
  ): Promise<ProjectAgentReferenceResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('get_project_agent_reference', (requestId) =>
      buildGetProjectAgentReferenceCommand(agentId, fileName, requestId),
    )
  }

  async setProjectAgentReference(
    agentId: string,
    fileName: string,
    content: string,
  ): Promise<ProjectAgentReferenceSavedResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('set_project_agent_reference', (requestId) =>
      buildSetProjectAgentReferenceCommand(agentId, fileName, content, requestId),
    )
  }

  async deleteProjectAgentReference(
    agentId: string,
    fileName: string,
  ): Promise<ProjectAgentReferenceDeletedResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('delete_project_agent_reference', (requestId) =>
      buildDeleteProjectAgentReferenceCommand(agentId, fileName, requestId),
    )
  }

  async requestProjectAgentRecommendations(agentId: string): Promise<{ agentId: string; whenToUse: string; systemPrompt: string }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('request_project_agent_recommendations', (requestId) =>
      buildRequestProjectAgentRecommendationsCommand(agentId, requestId),
    )
  }

  async mergeSessionMemory(agentId: string): Promise<SessionMemoryMergeResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('merge_session_memory', (requestId) =>
      buildMergeSessionMemoryCommand(agentId, requestId),
    )
  }

  getSessionWorkers(sessionAgentId: string): Promise<SessionWorkersResult> {
    return this.sessionWorkerCache.getSessionWorkers(sessionAgentId)
  }

  // -----------------------------------------------------------------------
  // Transport callbacks
  // -----------------------------------------------------------------------

  private handleTransportOpen(): void {
    const shouldReload = this.shouldReloadOnReconnect
    this.hasConnectedOnce = true
    this.shouldReloadOnReconnect = false
    this.hasExplicitAgentSelection = false
    this.explicitAgentSelectionAgentId = null

    this.updateState({
      connected: true,
      hasReceivedAgentsSnapshot: false,
      loadedSessionIds: new Set(),
      lastError: null,
    })

    this.send(buildSubscribeCommand(this.desiredAgentId))

    if (shouldReload && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload()
    }
  }

  private handleTransportClose(): void {
    if (this.hasConnectedOnce) {
      this.shouldReloadOnReconnect = true
    }

    this.hasExplicitAgentSelection = false
    this.explicitAgentSelectionAgentId = null
    this.bootstrapBuffer.clear()

    this.updateState({
      connected: false,
      hasReceivedAgentsSnapshot: false,
      loadedSessionIds: new Set(),
      subscribedAgentId: null,
    })

    this.sessionWorkerCache.clearQueuedRefetches()
    this.requestDispatcher.rejectAllPendingRequests('WebSocket disconnected before request completed.')
  }

  private handleTransportError(): void {
    this.updateState({
      connected: false,
      lastError: 'WebSocket connection error',
    })
  }

  private handleServerEvent(parsed: unknown): void {
    const event = parsed as ServerEvent

    if (this.bootstrapBuffer.active) {
      const consumed = this.bootstrapBuffer.handleEvent(event)
      if (consumed) return
    }

    if (
      handleConversationEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
      })
    ) {
      return
    }

    if (
      handleTerminalEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
      })
    ) {
      return
    }

    if (
      handleAgentEvent(event, {
        applyAgentStatus: (agentEvent) => this.applyAgentStatus(agentEvent),
        applyAgentsSnapshot: (agents) => this.applyAgentsSnapshot(agents),
        applySessionWorkersSnapshot: (sessionAgentId, workers, requestId) =>
          this.applySessionWorkersSnapshot(sessionAgentId, workers, requestId),
        applyManagerCreated: (manager) => this.applyManagerCreated(manager),
        applyManagerDeleted: (managerId) => this.applyManagerDeleted(managerId),
        requestTracker: this.requestDispatcher.tracker,
      })
    ) {
      return
    }

    if (
      handleSessionEvent(event, {
        applySessionDeleted: (agentId, profileId) => this.applySessionDeleted(agentId, profileId),
        requestTracker: this.requestDispatcher.tracker,
      })
    ) {
      return
    }

    if (handleProjectAgentEvent(event, {
      state: this.state,
      updateState: (patch) => this.updateState(patch),
      requestTracker: this.requestDispatcher.tracker,
    })) {
      return
    }

    if (
      handleConfigEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
        requestTracker: this.requestDispatcher.tracker,
      })
    ) {
      return
    }

    if (handleDirectoryEvent(event, { requestTracker: this.requestDispatcher.tracker })) {
      return
    }

    handleSystemEvent(event, {
      updateState: (patch) => this.updateState(patch),
      pushSystemMessage: (text) => this.pushSystemMessage(text),
      rejectPendingFromError: (code, message, requestId) =>
        this.requestDispatcher.rejectPendingFromError(code, message, requestId),
    })
  }

  private applyAgentStatus(
    event: Extract<ServerEvent, { type: 'agent_status' }>,
  ): void {
    const result = reduceAgentStatus({ state: this.state, event })
    this.updateState(result.patch)

    if (result.queueSessionWorkersRefetchId) {
      this.sessionWorkerCache.queueRefetch(result.queueSessionWorkersRefetchId)
    }

    if (result.managerIdleTransitionAgentId) {
      handleManagerIdleTransition(result.managerIdleTransitionAgentId, result.nextState)
    }
  }

  private applyAgentsSnapshot(agents: AgentDescriptor[]): void {
    const result = reduceAgentsSnapshot({
      state: this.state,
      desiredAgentId: this.desiredAgentId,
      explicitAgentSelectionAgentId: this.explicitAgentSelectionAgentId,
      agents,
    })

    for (const sessionAgentId of result.queueSessionWorkersRefetchIds) {
      this.sessionWorkerCache.queueRefetch(sessionAgentId)
    }

    if (result.shouldClearExplicitSelection) {
      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
    }

    this.desiredAgentId = result.nextDesiredAgentId
    this.updateState(result.patch)

    if (result.subscribeToAgentId && isSocketOpen(this.socket)) {
      this.send(buildSubscribeCommand(result.subscribeToAgentId))
    }
  }

  private applySessionWorkersSnapshot(
    sessionAgentId: string,
    workers: AgentDescriptor[],
    requestId?: string,
  ): void {
    this.sessionWorkerCache.applySessionWorkersSnapshot(sessionAgentId, workers)

    if (requestId) {
      this.requestDispatcher.tracker.resolve('get_session_workers', requestId, {
        sessionAgentId,
        workers,
      })
    }
  }

  private applyManagerCreated(manager: AgentDescriptor): void {
    const nextAgents = [
      ...this.state.agents.filter((agent) => agent.agentId !== manager.agentId),
      manager,
    ]
    this.applyAgentsSnapshot(nextAgents)
  }

  private applyManagerDeleted(managerId: string): void {
    const result = reduceManagerDeleted({
      state: this.state,
      managerId,
      socketOpen: isSocketOpen(this.socket),
    })

    this.sessionWorkerCache.clearQueuedRefetch(managerId)
    removeMutedAgents(result.deletedAgentIds)

    if (result.nextDesiredAgentId !== undefined) {
      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
      this.desiredAgentId = result.nextDesiredAgentId
    }

    if (result.subscribeToAgentId) {
      this.send(buildSubscribeCommand(result.subscribeToAgentId))
    }

    this.updateState(result.patch)
  }

  private applySessionDeleted(agentId: string, profileId: string): void {
    const result = reduceSessionDeleted({
      state: this.state,
      agentId,
      profileId,
      socketOpen: isSocketOpen(this.socket),
    })

    this.sessionWorkerCache.clearQueuedRefetch(agentId)
    removeMutedAgent(result.mutedAgentIdToRemove)

    if (result.nextDesiredAgentId !== undefined) {
      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
      this.desiredAgentId = result.nextDesiredAgentId
    }

    if (result.subscribeToAgentId) {
      this.send(buildSubscribeCommand(result.subscribeToAgentId))
    }

    this.updateState(result.patch)
  }

  private pushSystemMessage(text: string): void {
    const message = createSystemConversationMessage(
      this.state.targetAgentId,
      this.state.subscribedAgentId,
      this.desiredAgentId,
      text,
    )
    this.updateState({ messages: [...this.state.messages, message] })
  }

  private send(command: ClientCommand): boolean {
    return this.transport.send(command)
  }

  private updateState(patch: Partial<ManagerWsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

}
