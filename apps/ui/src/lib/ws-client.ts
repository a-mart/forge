import type { CodexElicitationDecision, CodexElicitationPersistScope, ProjectAgentCapability, SessionGoalControlAction } from '@forge/protocol'
import { handleManagerIdleTransition, removeMutedAgent, removeMutedAgents } from './notification-service'
import {
  assertConnectedSocket,
  assertReconnectableSocket,
  buildBrowserHostFocusCommand,
  buildBrowserHostRegisterCommand,
  buildBrowserHostResponseCommand,
  buildBrowserHostStateReportCommand,
  buildBrowserPanelRevealAcknowledgeCommand,
  buildBrowserRecordingStartCommand,
  buildBrowserRecordingStopCommand,
  buildBrowserTabActivateCommand,
  buildBrowserTabCloseCommand,
  buildBrowserTabOpenCommand,
  buildBrowserTabResizeCommand,
  buildChoiceCancelCommand,
  buildChoiceResponseCommand,
  buildCodexElicitationResponseCommand,
  buildClearAllPinsCommand,
  buildCreateManagerCommand,
  buildCreateDirectoryCommand,
  buildCreateRepositoryProjectCommand,
  buildCancelRepositoryProjectCreationCommand,
  buildCreateSessionCommand,
  buildDeleteManagerCommand,
  buildDeleteProjectAgentReferenceCommand,
  buildForkSessionCommand,
  buildGetProjectAgentConfigCommand,
  buildGetProjectAgentExternalDirectoryCommand,
  buildGetProjectAgentReferenceCommand,
  buildGetProjectAgentSharingCommand,
  buildGetConversationPageCommand,
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
  buildRestartRecoveryActionCommand,
  buildRequestProjectAgentRecommendationsCommand,
  buildSessionActionCommand,
  buildSessionGoalControlCommand,
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
import { applyLoadedModelCacheVisualizationSetting as reduceLoadedModelCacheVisualizationSetting } from './ws-client/model-cache-visualization-state'
import {
  CREATE_REPOSITORY_PROJECT_TIMEOUT_MS,
  INITIAL_CONNECT_DELAY_MS,
  RECONNECT_MS,
  SESSION_WORKERS_REQUEST_TIMEOUT_MS,
  CONVERSATION_PAGE_REQUEST_TIMEOUT_MS,
} from './ws-client/runtime-types'

/** Server close code for a permanently invalidated collaboration session. */
const SESSION_INVALIDATED_CLOSE_CODE = 4001

/** How long an optimistic send may wait for its server echo before expiring. */
const OPTIMISTIC_SEND_EXPIRY_MS = 20_000

function generateClientRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
import {
  reduceAgentStatus,
  reduceAgentsSnapshot,
  reduceManagerDeleted,
  reduceSessionDeleted,
} from './ws-client/snapshot-reducers'
import type {
  DirectoriesListedResult,
  DirectoryCreatedResult,
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
  ConversationPageResult,
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
import { handleBrowserEvent } from './ws-client/event-handlers/browser-event-handlers'
import type {
  AgentDescriptor,
  AgentSessionPurpose,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostRegistration,
  BrowserHostSessionStateReport,
  BrowserHostStateReportResult,
  BrowserSessionSnapshot,
  BrowserViewportSetting,
  BuilderTimelineChannelView,
  ChoiceAnswer,
  ClientCommand,
  ConversationAttachment,
  ConversationReplyTargetInput,
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
  DirectoryCreatedResult,
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
  private conversationView: BuilderTimelineChannelView = 'web'

  /** Convenience accessor — delegates to transport so existing guards work unchanged. */
  private get socket(): WebSocket | null {
    return this.transport.getSocket()
  }

  private hasExplicitAgentSelection = false
  private explicitAgentSelectionAgentId: string | null = null
  private explicitAgentSelectionPending = false
  private rejectedExplicitAgentSelectionId: string | null = null
  private sessionInvalidatedObserver: (() => void) | null = null
  private readonly optimisticSendExpiryTimers = new Set<ReturnType<typeof setTimeout>>()

  private state: ManagerWsState
  private readonly listeners = new Set<Listener>()

  private readonly requestDispatcher: RequestDispatcher
  private readonly bootstrapBuffer: BootstrapBuffer
  private readonly sessionWorkerCache: SessionWorkerCache
  private browserHostRegistration: BrowserHostRegistration | null = null
  private browserAutomationRequestHandler: ((request: BrowserAutomationRequest) => Promise<BrowserAutomationResponse>) | null = null
  private readonly repositoryProjectProgressListeners = new Map<
    string,
    (event: Extract<import('@forge/protocol').ServerEvent, { type: 'repository_project_creation_progress' }>) => void
  >()

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
        // Short timeout: a lost response must not hold the cache's in-flight
        // dedupe for the full default request timeout — the cache retries with
        // backoff on failure.
        return this.requestDispatcher.enqueueRequest(
          'get_session_workers',
          (requestId) => buildGetSessionWorkersCommand(sessionAgentId, requestId),
          { timeoutMs: SESSION_WORKERS_REQUEST_TIMEOUT_MS },
        )
      },
    })

    this.transport = new WebSocketTransport({
      url,
      reconnectDelayMs: RECONNECT_MS,
      onOpen: () => this.handleTransportOpen(),
      onClose: (event) => this.handleTransportClose(event),
      onMessage: (data) => this.handleServerEvent(data),
      onError: () => this.handleTransportError(),
    })
  }

  /**
   * Observe permanent session invalidation (server close code 4001 on remote
   * collaboration origins — role change, disable, sign-out). The client stops
   * reconnecting when it fires; the origin manager flips the origin to
   * `unauthorized`. Local builder sockets never receive 4001.
   */
  setSessionInvalidatedObserver(observer: (() => void) | null): void {
    this.sessionInvalidatedObserver = observer
  }

  getState(): ManagerWsState {
    return this.state
  }

  applyLoadedModelCacheVisualizationSetting(enabled: boolean): void {
    this.bootstrapBuffer.flush()
    this.updateState(
      reduceLoadedModelCacheVisualizationSetting({
        enabled,
        currentObservations: this.state.modelCacheObservations,
        pendingObservations: this.state.pendingModelCacheObservations,
      }),
    )
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

  resumeRestartRecovery(): void {
    this.send(buildRestartRecoveryActionCommand('resume_restart_recovery'))
  }

  dismissRestartRecovery(): void {
    this.send(buildRestartRecoveryActionCommand('dismiss_restart_recovery'))
  }

  registerBrowserAutomationHost(
    registration: BrowserHostRegistration,
    handleRequest: (request: BrowserAutomationRequest) => Promise<BrowserAutomationResponse>,
  ): () => void {
    this.browserHostRegistration = registration
    this.browserAutomationRequestHandler = handleRequest
    if (isSocketOpen(this.socket)) this.send(buildBrowserHostRegisterCommand(registration))
    return () => {
      if (this.browserHostRegistration?.hostId === registration.hostId) {
        this.browserHostRegistration = null
        this.browserAutomationRequestHandler = null
      }
    }
  }

  reportBrowserHostState(sessions: BrowserHostSessionStateReport[]): Promise<BrowserHostStateReportResult> {
    const registration = this.browserHostRegistration
    const generation = this.state.browserHost.hostGeneration
    if (!registration || generation === null || !isSocketOpen(this.socket)) {
      return Promise.reject(new Error(RECONNECTING_SOCKET_ERROR))
    }
    return this.requestDispatcher.enqueueRequest(
      'browser_host_state_report',
      (requestId) => buildBrowserHostStateReportCommand(requestId, registration.hostId, generation, sessions),
      { timeoutMs: 15_000 },
    )
  }

  setBrowserHostFocused(focused: boolean): void {
    const registration = this.browserHostRegistration
    const generation = this.state.browserHost.hostGeneration
    if (!registration || generation === null || !isSocketOpen(this.socket)) return
    this.send(buildBrowserHostFocusCommand(registration.hostId, generation, focused))
  }

  acknowledgeBrowserPanelReveal(options: {
    sessionAgentId: string
    profileId: string
    tabId: string
    sequence: number
  }): Promise<BrowserSessionSnapshot> {
    const registration = this.browserHostRegistration
    const hostGeneration = this.state.browserHost.hostGeneration
    if (!registration || hostGeneration === null || !isSocketOpen(this.socket)) {
      return Promise.reject(new Error(RECONNECTING_SOCKET_ERROR))
    }
    return this.requestDispatcher.enqueueRequest(
      'browser_panel_reveal_acknowledge',
      (requestId) => buildBrowserPanelRevealAcknowledgeCommand({
        requestId,
        hostId: registration.hostId,
        hostGeneration,
        ...options,
      }),
      { timeoutMs: 15_000 },
    )
  }

  openBrowserTab(sessionAgentId: string, profileId: string, options?: { url?: string; activate?: boolean }): Promise<BrowserSessionSnapshot> {
    assertConnectedSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('browser_tab_open', (requestId) =>
      buildBrowserTabOpenCommand(sessionAgentId, profileId, requestId, options))
  }

  activateBrowserTab(sessionAgentId: string, tabId: string): Promise<BrowserSessionSnapshot> {
    assertConnectedSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('browser_tab_activate', (requestId) =>
      buildBrowserTabActivateCommand(sessionAgentId, tabId, requestId))
  }

  closeBrowserTab(sessionAgentId: string, tabId: string): Promise<BrowserSessionSnapshot> {
    assertConnectedSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('browser_tab_close', (requestId) =>
      buildBrowserTabCloseCommand(sessionAgentId, tabId, requestId))
  }

  resizeBrowserTab(sessionAgentId: string, tabId: string, viewport: BrowserViewportSetting): Promise<BrowserSessionSnapshot> {
    assertConnectedSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('browser_tab_resize', (requestId) =>
      buildBrowserTabResizeCommand(sessionAgentId, tabId, viewport, requestId))
  }

  startBrowserRecording(sessionAgentId: string, tabId: string) {
    assertConnectedSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('browser_recording_start', (requestId) =>
      buildBrowserRecordingStartCommand(sessionAgentId, tabId, requestId))
  }

  stopBrowserRecording(sessionAgentId: string, tabId: string, recordingId: string) {
    assertConnectedSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('browser_recording_stop', (requestId) =>
      buildBrowserRecordingStopCommand(sessionAgentId, tabId, recordingId, requestId))
  }

  hasExplicitSelection(): boolean {
    return this.hasExplicitAgentSelection
  }

  getExplicitSelectionAgentId(): string | null {
    return this.explicitAgentSelectionAgentId
  }

  getRejectedExplicitSelectionAgentId(): string | null {
    return this.rejectedExplicitAgentSelectionId
  }

  isExplicitSelectionPending(): boolean {
    return this.explicitAgentSelectionPending
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
    for (const timer of this.optimisticSendExpiryTimers) {
      clearTimeout(timer)
    }
    this.optimisticSendExpiryTimers.clear()

    this.transport.disconnect()
  }

  subscribeToAgent(agentId: string, options?: { explicit?: boolean }): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    const isExplicitSelection = options?.explicit ?? true
    this.hasExplicitAgentSelection = isExplicitSelection
    this.explicitAgentSelectionAgentId = isExplicitSelection ? trimmed : null
    this.explicitAgentSelectionPending = isExplicitSelection
    this.rejectedExplicitAgentSelectionId = null

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
      conversationPage: null,
      conversationPageLoading: false,
      conversationPageRequestId: null,
      conversationHistoryMutation: null,
      modelCacheObservations: [],
      pendingModelCacheObservations: [],
      pendingChoiceIds: new Set(),
      codexElicitations: [],
      planSnapshotLoadingSessionId: trimmed,
      goalSnapshotLoadingSessionId: trimmed,
      ...(shouldResetTerminals ? { terminals: [], terminalSessionScopeId: null } : {}),
      lastError: null,
      unreadCounts: nextUnread,
    })

    if (!isSocketOpen(this.socket)) {
      return
    }

    this.bootstrapBuffer.begin(trimmed)
    this.send(buildSubscribeCommand(trimmed, this.conversationView))
  }

  setConversationView(view: BuilderTimelineChannelView): boolean {
    if (this.conversationView === view) return false
    this.conversationView = view
    return this.refreshConversationHistory()
  }

  sendUserMessage(
    text: string,
    options?: { agentId?: string; delivery?: DeliveryMode; attachments?: ConversationAttachment[]; replyTo?: ConversationReplyTargetInput },
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

    // Optimistic multi-writer send (SPEC §4.6): append the message locally
    // keyed by a clientRequestId; the server echoes the id on the broadcast
    // and the shared reducer replaces this entry instead of duplicating it.
    const clientRequestId = generateClientRequestId()
    if (agentId === this.state.targetAgentId) {
      const optimisticEntry = {
        type: 'conversation_message' as const,
        agentId,
        role: 'user' as const,
        text: trimmed,
        timestamp: new Date().toISOString(),
        source: 'user_input' as const,
        clientRequestId,
      }
      this.updateState({ messages: [...this.state.messages, optimisticEntry] })
      this.scheduleOptimisticSendExpiry(clientRequestId)
    }

    this.send(
      buildUserMessageCommand({
        text: trimmed,
        attachments,
        replyTo: options?.replyTo,
        agentId,
        delivery: options?.delivery,
        clientRequestId,
      }),
    )
  }

  /**
   * Drop an optimistic entry the server never confirmed (send lost, denied,
   * or the socket died) so it cannot persist as a ghost message.
   */
  private scheduleOptimisticSendExpiry(clientRequestId: string): void {
    const timer = setTimeout(() => {
      this.optimisticSendExpiryTimers.delete(timer)
      const index = this.state.messages.findIndex(
        (message) =>
          message.type === 'conversation_message' &&
          !message.id &&
          message.clientRequestId === clientRequestId,
      )
      if (index < 0) return
      const nextMessages = [...this.state.messages]
      nextMessages.splice(index, 1)
      this.updateState({
        messages: nextMessages,
        lastError: 'Message delivery was not confirmed. Please try again.',
      })
    }, OPTIMISTIC_SEND_EXPIRY_MS)
    this.optimisticSendExpiryTimers.add(timer)
  }

  sendChoiceResponse(agentId: string, choiceId: string, answers: ChoiceAnswer[]): void {
    this.send(buildChoiceResponseCommand(agentId, choiceId, answers))
  }

  sendChoiceCancel(agentId: string, choiceId: string): void {
    this.send(buildChoiceCancelCommand(agentId, choiceId))
  }

  sendCodexElicitationResponse(
    agentId: string,
    elicitationId: string,
    decision: CodexElicitationDecision,
    values?: Record<string, unknown>,
    persistScope?: CodexElicitationPersistScope,
  ): void {
    this.send(buildCodexElicitationResponseCommand(agentId, elicitationId, decision, values, persistScope))
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

  /**
   * Clone a repository then create a manager. Returns an operation handle so
   * callers can cancel and subscribe to progress without touching RequestTracker.
   */
  createRepositoryProject(
    input: {
      name: string
      repositoryUrl: string
      repositoryBasePath: string
      repositoryFolder: string
      modelSelection: ManagerExactModelSelection
      reasoningLevel?: ManagerReasoningLevel
    },
    options?: {
      onProgress?: (
        event: Extract<import('@forge/protocol').ServerEvent, { type: 'repository_project_creation_progress' }>,
      ) => void
    },
  ): {
    requestId: string
    promise: Promise<{ manager: AgentDescriptor; repositoryPath: string }>
    cancel: () => Promise<{ accepted: boolean; tooLate: boolean; operationRequestId: string }>
  } {
    assertReconnectableSocket(this.socket)
    const requestId = this.requestDispatcher.nextRequestId('create_repository_project')

    if (options?.onProgress) {
      this.repositoryProjectProgressListeners.set(requestId, options.onProgress)
    }

    const promise = new Promise<{ manager: AgentDescriptor; repositoryPath: string }>((resolve, reject) => {
      this.requestDispatcher.tracker.track(
        'create_repository_project',
        requestId,
        resolve,
        reject,
        CREATE_REPOSITORY_PROJECT_TIMEOUT_MS,
      )

      const sent = this.send(buildCreateRepositoryProjectCommand(input, requestId))
      if (!sent) {
        this.requestDispatcher.tracker.reject(
          'create_repository_project',
          requestId,
          new Error(RECONNECTING_SOCKET_ERROR),
        )
      }
    }).finally(() => {
      this.repositoryProjectProgressListeners.delete(requestId)
    })

    return {
      requestId,
      promise,
      cancel: () => this.cancelRepositoryProjectCreation(requestId),
    }
  }

  async cancelRepositoryProjectCreation(
    operationRequestId: string,
  ): Promise<{ accepted: boolean; tooLate: boolean; operationRequestId: string }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('cancel_repository_project_creation', (requestId) =>
      buildCancelRepositoryProjectCreationCommand(operationRequestId, requestId),
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

  async createDirectory(parentPath: string, name: string): Promise<DirectoryCreatedResult> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest('create_directory', (requestId) =>
      buildCreateDirectoryCommand(parentPath, name, requestId),
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

  controlSessionGoal(agentId: string, action: SessionGoalControlAction): void {
    if (!isSocketOpen(this.socket)) {
      this.updateState({ lastError: RECONNECTING_SOCKET_ERROR })
      return
    }
    this.send(buildSessionGoalControlCommand(agentId, action))
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

  async loadOlderConversation(limit?: number): Promise<ConversationPageResult | null> {
    const agentId = this.state.targetAgentId
    const cursor = this.state.conversationPage?.nextCursor
    if (!agentId || !cursor || !this.state.conversationPage?.hasOlder || this.state.conversationPageLoading) {
      return null
    }

    assertReconnectableSocket(this.socket)
    this.updateState({ conversationPageLoading: true, lastError: null })
    let pageRequestId: string | null = null
    try {
      return await this.requestDispatcher.enqueueRequest(
        'get_conversation_page',
        (requestId) => {
          pageRequestId = requestId
          this.updateState({ conversationPageRequestId: requestId })
          return buildGetConversationPageCommand(
            agentId,
            cursor,
            requestId,
            limit,
            this.conversationView,
          )
        },
        { timeoutMs: CONVERSATION_PAGE_REQUEST_TIMEOUT_MS },
      )
    } catch (error) {
      if (
        this.state.targetAgentId === agentId &&
        this.state.conversationPageRequestId === pageRequestId
      ) {
        this.updateState({
          conversationPageLoading: false,
          conversationPageRequestId: null,
          lastError: error instanceof Error ? error.message : String(error),
        })
      }
      throw error
    }
  }

  refreshConversationHistory(): boolean {
    const agentId = this.state.targetAgentId
    if (!agentId || !isSocketOpen(this.socket)) return false

    this.updateState({
      messages: [],
      activityMessages: [],
      conversationPage: null,
      conversationPageLoading: false,
      conversationPageRequestId: null,
      conversationHistoryMutation: null,
      modelCacheObservations: [],
      pendingModelCacheObservations: [],
      codexElicitations: [],
      lastError: null,
    })
    this.bootstrapBuffer.begin(agentId)
    this.send(buildSubscribeCommand(agentId, this.conversationView))
    return true
  }

  // -----------------------------------------------------------------------
  // Transport callbacks
  // -----------------------------------------------------------------------

  private handleTransportOpen(): void {
    this.hasExplicitAgentSelection = false
    this.explicitAgentSelectionAgentId = null
    this.explicitAgentSelectionPending = false
    this.rejectedExplicitAgentSelectionId = null

    // A reconnect (including after a backend restart) re-hydrates state IN
    // PLACE — never a full page reload. Resetting the bootstrap-tracking flags
    // below and re-issuing `subscribe` re-triggers the backend bootstrap and
    // refreshes WS state without discarding the SPA. Do NOT re-add a
    // `window.location.reload()` here: it re-runs the entire bootstrap from
    // scratch and, under a large session on a backpressured socket, fuels a
    // reconnect→reload loop (see UI-RELOAD-LOOP-INVESTIGATION.md).
    //
    // `loadedSessionIds` must survive the reconnect: the re-bootstrap
    // agents_snapshot is managers-only, and reduceAgentsSnapshot both preserves
    // cached workers and queues drift refetches ONLY for sessions in
    // `loadedSessionIds`. Clearing it here silently dropped every worker row
    // (sidebar + pill bar) after any reconnect, with no refetch, until a full
    // page reload. Stale entries are safe — a workerCount mismatch in the
    // fresh snapshot invalidates and refetches per session.
    this.updateState({
      connected: true,
      connectionEpoch: this.state.connectionEpoch + 1,
      // Invalidation revisions are scoped to one backend connection epoch. A
      // restarted backend may legitimately reload local preference authority
      // at R0, so an old R5 watermark must not suppress its new R1..R5 events.
      builderSidebarOrderRevision: null,
      hasReceivedAgentsSnapshot: false,
      hasReceivedProfilesSnapshot: false,
      remoteUpdateAwarenessSnapshot: null,
      codexElicitations: [],
      browserHost: {
        connected: false,
        hostId: null,
        hostGeneration: null,
        focused: false,
        capabilities: null,
        connectedAt: null,
      },
      browserSessions: {},
      browserHostHydrated: false,
      browserPanelRevealRequest: null,
      browserMetadataStale: false,
      lastError: null,
    })

    // Fetch failures accumulated against the old socket don't predict anything
    // on the new one — reset the retry budget and requeue sessions whose
    // worker fetch was lost to the disconnect.
    this.sessionWorkerCache.retryFailedFetchesAfterReconnect()

    this.send(buildSubscribeCommand(this.desiredAgentId, this.conversationView))
    if (this.browserHostRegistration) {
      this.send(buildBrowserHostRegisterCommand({
        ...this.browserHostRegistration,
        registeredAt: new Date().toISOString(),
      }))
    }
  }

  private handleTransportClose(event?: CloseEvent): void {
    this.hasExplicitAgentSelection = false
    this.explicitAgentSelectionAgentId = null
    this.explicitAgentSelectionPending = false
    this.rejectedExplicitAgentSelectionId = null
    this.bootstrapBuffer.clear()

    // Keep `loadedSessionIds` — see handleTransportOpen.
    this.updateState({
      connected: false,
      hasReceivedAgentsSnapshot: false,
      hasReceivedProfilesSnapshot: false,
      subscribedAgentId: null,
      remoteUpdateAwarenessSnapshot: null,
      codexElicitations: [],
      browserHost: {
        connected: false,
        hostId: null,
        hostGeneration: null,
        focused: false,
        capabilities: null,
        connectedAt: null,
      },
      browserHostHydrated: false,
      browserPanelRevealRequest: null,
      browserMetadataStale: Object.keys(this.state.browserSessions).length > 0,
    })

    this.sessionWorkerCache.clearQueuedRefetches()
    this.requestDispatcher.rejectAllPendingRequests('WebSocket disconnected before request completed.')

    // Remote collaboration origins: 4001 means the session is permanently
    // invalid — reconnecting would 401 forever. Stop the transport and let
    // the origin manager surface the sign-in state.
    if (event?.code === SESSION_INVALIDATED_CLOSE_CODE) {
      this.transport.disconnect()
      this.updateState({
        lastError: 'Your session has been invalidated. Please sign in again.',
      })
      this.sessionInvalidatedObserver?.()
    }
  }

  private handleTransportError(): void {
    this.updateState({
      connected: false,
      lastError: 'WebSocket connection error',
    })
  }

  private handleServerEvent(parsed: unknown): void {
    const event = parsed as ServerEvent

    if (
      event.type === 'error' &&
      event.code === 'UNKNOWN_AGENT' &&
      this.explicitAgentSelectionAgentId === this.desiredAgentId
    ) {
      this.rejectedExplicitAgentSelectionId = this.explicitAgentSelectionAgentId
      this.explicitAgentSelectionPending = false
      this.bootstrapBuffer.clear()
    } else if (
      event.type === 'ready' &&
      event.subscribedAgentId === this.explicitAgentSelectionAgentId
    ) {
      this.rejectedExplicitAgentSelectionId = null
      this.explicitAgentSelectionPending = false
    }

    if (event.type === 'conversation_page') {
      this.requestDispatcher.tracker.resolve('get_conversation_page', event.requestId, {
        agentId: event.agentId,
        messages: event.messages,
        page: event.page,
      })
    }

    if (this.bootstrapBuffer.active) {
      const consumed = this.bootstrapBuffer.handleEvent(event)
      if (consumed) return
    }

    if (handleBrowserEvent(event, {
      state: this.state,
      updateState: (patch) => this.updateState(patch),
      requestTracker: this.requestDispatcher.tracker,
      registration: this.browserHostRegistration,
      handleAutomationRequest: this.browserAutomationRequestHandler,
      sendHostResponse: (response) => this.send(buildBrowserHostResponseCommand(response)),
    })) {
      return
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
        onRepositoryProjectCreationProgress: (progressEvent) => {
          this.repositoryProjectProgressListeners.get(progressEvent.requestId)?.(progressEvent)
        },
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

    if (event.type === 'builder_sidebar_order_updated') {
      if (
        this.state.builderSidebarOrderRevision === null
        || event.revision > this.state.builderSidebarOrderRevision
      ) {
        this.updateState({ builderSidebarOrderRevision: event.revision })
      }
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
      isPendingDirectoryRequest: (requestId) =>
        this.requestDispatcher.isPendingDirectoryRequest(requestId),
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
      this.explicitAgentSelectionPending = false
    }

    this.desiredAgentId = result.nextDesiredAgentId
    this.updateState(result.patch)

    if (result.subscribeToAgentId && isSocketOpen(this.socket)) {
      this.send(buildSubscribeCommand(result.subscribeToAgentId, this.conversationView))
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
      this.explicitAgentSelectionPending = false
      this.desiredAgentId = result.nextDesiredAgentId
    }

    if (result.subscribeToAgentId) {
      this.send(buildSubscribeCommand(result.subscribeToAgentId, this.conversationView))
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
      this.explicitAgentSelectionPending = false
      this.desiredAgentId = result.nextDesiredAgentId
    }

    if (result.subscribeToAgentId) {
      this.send(buildSubscribeCommand(result.subscribeToAgentId, this.conversationView))
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
