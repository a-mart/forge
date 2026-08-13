import { BROWSER_HOST_REGISTER_PROTOCOL_INCOMPATIBLE_ERROR } from '@forge/protocol'
import type { CodexElicitationDecision, CodexElicitationPersistScope, ManagerPosture, ProjectAgentCapability, SessionGoalControlAction } from '@forge/protocol'
import type { ConversationSnapshotCache } from './ws-client/conversation-snapshot-cache'
import {
  conversationBootstrapMetrics,
  type ConversationSubscriptionReason,
} from './ws-client/conversation-bootstrap-metrics'
import { handleManagerIdleTransition, removeMutedAgent, removeMutedAgents } from './notification-service'
import {
  assertConnectedSocket,
  assertReconnectableSocket,
  buildBrowserHostFocusCommand,
  buildBrowserHostHydrateCommand,
  buildBrowserHostLifecycleResponseCommand,
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
  buildDismissSessionAttentionCommand,
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
  buildUpdateProjectDelegationDefaultsCommand,
  buildUpdateSessionDelegationCommand,
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

const BROWSER_HANDSHAKE_REQUEST_TIMEOUT_MS = 2_000
const BROWSER_HANDSHAKE_RETRY_INITIAL_MS = 1_000
const BROWSER_HANDSHAKE_RETRY_MAX_MS = 30_000
export const CONVERSATION_BOOTSTRAP_WATCHDOG_MS = 30_000
const GENERATION_TERMINAL_SETTLE_MS = 5_000
const MAX_DEFERRED_WORKER_THROUGHPUT_EVENTS = 64

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
import {
  clearGenerationThroughputForAgents,
  clearGenerationThroughputState,
  pendingGenerationThroughputWorkerMetadataSessionId,
  removeGenerationThroughputTombstone,
  type GenerationThroughputReduction,
} from './ws-client/generation-throughput-state'
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
import {
  applySecureSessionSnapshot as reduceSecureSessionSnapshot,
  handleConversationEvent,
} from './ws-client/event-handlers/conversation-event-handlers'
import { handleTerminalEvent } from './ws-client/event-handlers/terminal-event-handlers'
import { handleAgentEvent } from './ws-client/event-handlers/agent-event-handlers'
import { handleGenerationThroughputEvent } from './ws-client/event-handlers/generation-throughput-event-handlers'
import { handleSessionEvent } from './ws-client/event-handlers/session-event-handlers'
import { handleSessionAttentionEvent } from './ws-client/event-handlers/session-attention-event-handlers'
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
  BrowserHostLifecycleRequest,
  BrowserHostLifecycleResponse,
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
  SecureSessionSnapshot,
  SessionAttentionUpdateEvent,
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

export interface ManagerWsClientOptions {
  originId?: string
  conversationSnapshotCache?: ConversationSnapshotCache
  conversationBootstrapWatchdogMs?: number
}

export class ManagerWsClient {
  private readonly transport: WebSocketTransport
  private desiredAgentId: string | null
  private conversationView: BuilderTimelineChannelView = 'web'
  private readonly originId: string
  private readonly conversationSnapshotCache?: ConversationSnapshotCache
  private readonly conversationBootstrapWatchdogMs: number
  private conversationBootstrapTimer: ReturnType<typeof setTimeout> | null = null
  private stalePresentationAttachedAt: number | null = null
  private readonly subscriptionIdPrefix = generateClientRequestId()
  private nextSubscriptionId = 1
  /** Bounded metric guard: only the current/most-recent subscription can terminal twice. */
  private terminalSubscriptionId: string | null = null
  /** Destructive requests suppress recapture until fresh history replaces authority. */
  private readonly nonCapturableConversationAgentIds = new Set<string>()

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
  private readonly generationTerminalCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Worker telemetry that arrived before this connection received its roster. */
  private deferredWorkerThroughputEvents: Array<Extract<ServerEvent, {
    type: 'generation_throughput' | 'generation_throughput_snapshot'
  }>> = []

  private state: ManagerWsState
  private readonly listeners = new Set<Listener>()

  private readonly requestDispatcher: RequestDispatcher
  private readonly bootstrapBuffer: BootstrapBuffer
  private readonly sessionWorkerCache: SessionWorkerCache
  private browserHostRegistration: BrowserHostRegistration | null = null
  private browserHandshakeTimer: ReturnType<typeof setTimeout> | null = null
  /** Invalidates timers and completions from an older socket or host registration. */
  private browserHandshakeEpoch = 0
  private browserHandshakeInFlight = false
  private browserHandshakeFailures = 0
  /** A negotiated v2 mismatch is actionable but must not retry forever. */
  private browserHandshakeProtocolError: string | null = null
  private readonly browserHydrationChunks = new Map<string, { chunkCount: number; chunks: Array<Uint8Array | undefined> }>()
  private browserAutomationRequestHandler: ((request: BrowserAutomationRequest) => Promise<BrowserAutomationResponse>) | null = null
  private browserLifecycleRequestHandler: ((request: BrowserHostLifecycleRequest) => Promise<BrowserHostLifecycleResponse>) | null = null
  private readonly repositoryProjectProgressListeners = new Map<
    string,
    (event: Extract<import('@forge/protocol').ServerEvent, { type: 'repository_project_creation_progress' }>) => void
  >()

  constructor(url: string, initialAgentId?: string | null, options: ManagerWsClientOptions = {}) {
    const normalizedInitialAgentId = normalizeAgentId(initialAgentId)
    this.desiredAgentId = normalizedInitialAgentId
    this.originId = options.originId ?? 'local'
    this.conversationSnapshotCache = options.conversationSnapshotCache
    this.conversationBootstrapWatchdogMs = options.conversationBootstrapWatchdogMs ?? CONVERSATION_BOOTSTRAP_WATCHDOG_MS
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
      onWorkersRemoved: (agentIds) => this.clearGenerationThroughputForAgents(agentIds),
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

  applySecureSessionSnapshot(snapshot: SecureSessionSnapshot): void {
    reduceSecureSessionSnapshot(snapshot, {
      state: this.state,
      updateState: (patch) => this.updateState(patch),
    })
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

  dismissSessionAttention(attentionIds: string[]): Promise<SessionAttentionUpdateEvent> {
    if (!this.state.sessionAttentionAvailable) {
      return Promise.reject(new Error('Session attention is not supported by this origin.'))
    }
    assertConnectedSocket(this.socket)
    return this.requestDispatcher.enqueueRequest(
      'dismiss_session_attention',
      (requestId) => buildDismissSessionAttentionCommand(attentionIds, requestId),
    )
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
    handleLifecycle?: (request: BrowserHostLifecycleRequest) => Promise<BrowserHostLifecycleResponse>,
  ): () => void {
    this.clearBrowserHandshakeProtocolError()
    this.browserHostRegistration = registration
    this.browserAutomationRequestHandler = handleRequest
    this.browserLifecycleRequestHandler = handleLifecycle ?? null
    this.restartBrowserHandshake()
    return () => {
      if (this.browserHostRegistration?.hostId === registration.hostId) {
        this.browserHostRegistration = null
        this.browserAutomationRequestHandler = null
        this.browserLifecycleRequestHandler = null
        this.stopBrowserHandshake()
      }
    }
  }

  private restartBrowserHandshake(): void {
    this.stopBrowserHandshake()
    if (!this.browserHostRegistration || !isSocketOpen(this.socket) || this.browserHandshakeProtocolError) return
    this.scheduleBrowserHandshake(this.browserHandshakeEpoch, 0)
  }

  private stopBrowserHandshake(): void {
    this.browserHandshakeEpoch += 1
    if (this.browserHandshakeTimer) clearTimeout(this.browserHandshakeTimer)
    this.browserHandshakeTimer = null
    this.browserHandshakeInFlight = false
    this.browserHandshakeFailures = 0
    this.browserHydrationChunks.clear()
  }

  private scheduleBrowserHandshake(epoch: number, delayMs: number): void {
    if (epoch !== this.browserHandshakeEpoch || this.browserHandshakeTimer || this.browserHandshakeProtocolError) return
    this.browserHandshakeTimer = setTimeout(() => {
      this.browserHandshakeTimer = null
      void this.runBrowserHandshake(epoch)
    }, delayMs)
  }

  private async runBrowserHandshake(epoch: number): Promise<void> {
    const registration = this.browserHostRegistration
    if (epoch !== this.browserHandshakeEpoch || !registration || !isSocketOpen(this.socket)
      || this.browserHandshakeInFlight || this.browserHandshakeProtocolError) return
    this.browserHandshakeInFlight = true
    let completed = false
    try {
      let host = this.state.browserHost
      if (host.hostId !== registration.hostId || host.hostGeneration === null) {
        host = await this.requestDispatcher.enqueueRequest(
          'browser_host_register',
          (requestId) => buildBrowserHostRegisterCommand(requestId, { ...registration, registeredAt: new Date().toISOString() }),
          { timeoutMs: BROWSER_HANDSHAKE_REQUEST_TIMEOUT_MS },
        )
      }
      if (epoch !== this.browserHandshakeEpoch || this.browserHostRegistration !== registration || host.hostId !== registration.hostId || host.hostGeneration === null) return
      this.browserHydrationChunks.clear()
      await this.requestDispatcher.enqueueRequest(
        'browser_host_hydrate',
        (requestId) => buildBrowserHostHydrateCommand(requestId, registration.hostId, host.hostGeneration!),
        { timeoutMs: BROWSER_HANDSHAKE_REQUEST_TIMEOUT_MS },
      )
      completed = true
    } catch {
      // A transient registration or hydration failure is retried with capped
      // exponential backoff. The epoch and in-flight gate make the retry both
      // connection-scoped and single-flight.
    } finally {
      if (epoch !== this.browserHandshakeEpoch) return
      this.browserHandshakeInFlight = false
      if (completed) {
        this.browserHandshakeFailures = 0
        return
      }
      if (!this.state.browserHostHydrated && this.browserHostRegistration === registration
        && isSocketOpen(this.socket) && !this.browserHandshakeProtocolError) {
        const delay = Math.min(
          BROWSER_HANDSHAKE_RETRY_INITIAL_MS * 2 ** this.browserHandshakeFailures,
          BROWSER_HANDSHAKE_RETRY_MAX_MS,
        )
        this.browserHandshakeFailures += 1
        this.scheduleBrowserHandshake(epoch, delay)
      }
    }
  }

  private handleBrowserRegistrationError(error: { code: string; message: string }): void {
    if (error.code !== BROWSER_HOST_REGISTER_PROTOCOL_INCOMPATIBLE_ERROR) return
    this.browserHandshakeProtocolError = error.message
    // Keep the one actionable incompatibility visible in the banner without
    // appending it to whatever conversation happens to be selected.
    this.updateState({ lastError: error.message })
  }

  private clearBrowserHandshakeProtocolError(): void {
    const previous = this.browserHandshakeProtocolError
    this.browserHandshakeProtocolError = null
    if (previous && this.state.lastError === previous) this.updateState({ lastError: null })
  }

  private acceptBrowserHydrationChunk(
    event: Extract<ServerEvent, { type: 'browser_host_hydration_chunk' }>,
  ): BrowserSessionSnapshot[] | null {
    if (event.chunkCount < 1 || event.chunkIndex < 0 || event.chunkIndex >= event.chunkCount) return null
    let bytes: Uint8Array
    try {
      const binary = atob(event.payloadBase64)
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    } catch {
      return null
    }
    const existing = this.browserHydrationChunks.get(event.requestId)
    const hydration = existing?.chunkCount === event.chunkCount
      ? existing
      : { chunkCount: event.chunkCount, chunks: new Array<Uint8Array | undefined>(event.chunkCount) }
    hydration.chunks[event.chunkIndex] = bytes
    this.browserHydrationChunks.set(event.requestId, hydration)
    if (hydration.chunks.some((chunk) => chunk === undefined)) return null
    this.browserHydrationChunks.delete(event.requestId)
    try {
      const total = hydration.chunks.reduce((sum, chunk) => sum + chunk!.byteLength, 0)
      const joined = new Uint8Array(total)
      let offset = 0
      for (const chunk of hydration.chunks) {
        joined.set(chunk!, offset)
        offset += chunk!.byteLength
      }
      const parsed = JSON.parse(new TextDecoder().decode(joined)) as unknown
      return Array.isArray(parsed) ? parsed as BrowserSessionSnapshot[] : null
    } catch {
      return null
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
    this.cancelConversationBootstrapWatchdog()
    for (const timer of this.optimisticSendExpiryTimers) {
      clearTimeout(timer)
    }
    this.optimisticSendExpiryTimers.clear()
    this.clearGenerationTerminalCleanupTimers()
    this.stopBrowserHandshake()

    this.transport.disconnect()
  }

  subscribeToAgent(agentId: string, options?: { explicit?: boolean; reason?: ConversationSubscriptionReason }): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    const isExplicitSelection = options?.explicit ?? true
    this.hasExplicitAgentSelection = isExplicitSelection
    this.explicitAgentSelectionAgentId = isExplicitSelection ? trimmed : null
    this.explicitAgentSelectionPending = isExplicitSelection
    this.rejectedExplicitAgentSelectionId = null

    const previousTerminalScopeId = this.resolveTerminalScopeAgentId(this.state.targetAgentId)
    const nextTerminalScopeId = this.resolveTerminalScopeAgentId(trimmed)
    const nextUnread = { ...this.state.unreadCounts }
    delete nextUnread[trimmed]
    this.desiredAgentId = trimmed
    this.beginConversationSubscription({
      agentId: trimmed,
      requestedView: this.conversationView,
      reason: options?.reason ?? 'selection',
      patch: {
        planSnapshotLoadingSessionId: trimmed,
        goalSnapshotLoadingSessionId: trimmed,
        secureSessionSnapshotLoadingSessionId: trimmed,
        ...(previousTerminalScopeId !== nextTerminalScopeId
          ? { terminals: [], terminalSessionScopeId: null }
          : {}),
        unreadCounts: nextUnread,
      },
    })
  }

  retryConversationBootstrap(): boolean {
    const agentId = this.state.conversationBootstrap.agentId ?? this.state.targetAgentId
    if (!agentId) return false
    this.beginConversationSubscription({
      agentId,
      requestedView: this.state.conversationBootstrap.requestedView,
      reason: 'retry',
    })
    return true
  }

  setConversationView(view: BuilderTimelineChannelView): boolean {
    if (this.conversationView === view) return false
    this.conversationView = view
    const agentId = this.state.targetAgentId
    if (!agentId) return false
    this.beginConversationSubscription({ agentId, requestedView: view, reason: 'view_change' })
    return isSocketOpen(this.socket)
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
    this.invalidateConversationSnapshotAgent(managerId)
    for (const agent of this.state.agents) {
      if (agent.managerId === managerId) this.invalidateConversationSnapshotAgent(agent.agentId)
    }
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

  async updateProjectDelegationDefaults(
    profileId: string,
    updates: {
      managerPosture?: ManagerPosture | null
      delegationRosterId?: string | null
    },
  ): Promise<{ profileId: string }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest(
      'update_project_delegation_defaults',
      (requestId) =>
        buildUpdateProjectDelegationDefaultsCommand(profileId, updates, requestId),
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

  async updateSessionDelegation(
    sessionAgentId: string,
    updates: {
      managerPosture?: { mode: 'inherit' } | {
        mode: 'override'
        value: ManagerPosture
      }
      delegationRoster?: { mode: 'inherit' } | {
        mode: 'override'
        rosterId: string
      }
    },
  ): Promise<{ sessionAgentId: string }> {
    assertReconnectableSocket(this.socket)
    return this.requestDispatcher.enqueueRequest(
      'update_session_delegation',
      (requestId) =>
        buildUpdateSessionDelegationCommand(sessionAgentId, updates, requestId),
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
    this.invalidateConversationSnapshotAgent(agentId)
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
    this.invalidateConversationSnapshotAgent(agentId)
    return this.requestDispatcher.enqueueRequest('delete_session', (requestId) =>
      buildSessionActionCommand('delete_session', agentId, requestId),
    )
  }

  async clearSession(agentId: string): Promise<SessionActionResult> {
    assertReconnectableSocket(this.socket)
    this.invalidateConversationSnapshotAgent(agentId)
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
    this.conversationSnapshotCache?.evictProfile(this.originId, profileId)
    for (const agent of this.state.agents) {
      if (agent.profileId === profileId) this.nonCapturableConversationAgentIds.add(agent.agentId)
    }
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
    if (this.state.conversationBootstrap.phase !== 'ready') return null
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
    if (!agentId) return false
    this.beginConversationSubscription({
      agentId,
      requestedView: this.conversationView,
      reason: 'refresh',
    })
    return isSocketOpen(this.socket)
  }

  private beginConversationSubscription(input: {
    agentId: string | null
    requestedView: BuilderTimelineChannelView
    reason: ConversationSubscriptionReason
    patch?: Partial<ManagerWsState>
    /** Destructive fallback reducers have already revoked the outgoing authority. */
    captureOutgoingSnapshot?: boolean
  }): void {
    const previous = this.state.conversationBootstrap
    if (previous.phase === 'pending' && previous.subscriptionId) {
      this.recordConversationBootstrapTerminal(previous.subscriptionId, 'superseded')
    }
    this.cancelConversationBootstrapWatchdog()
    if (input.captureOutgoingSnapshot !== false) this.captureCurrentConversationSnapshot()
    this.bootstrapBuffer.clear()
    this.clearGenerationTerminalCleanupTimers()

    const subscriptionId = `${this.subscriptionIdPrefix}-${this.nextSubscriptionId++}`.slice(0, 128)
    const startedAt = Date.now()
    this.stalePresentationAttachedAt = null
    this.updateState({
      ...input.patch,
      targetAgentId: input.agentId,
      subscribedAgentId: null,
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
      managerToolActivity: null,
      ...clearGenerationThroughputState(),
      secureSessionSnapshotLoadingSessionId: input.agentId,
      conversationPresentation: null,
      conversationBootstrap: {
        phase: 'pending',
        agentId: input.agentId,
        subscriptionId,
        requestedView: input.requestedView,
        servedView: null,
        reason: input.reason,
        protocolMode: previous.protocolMode,
        startedAt,
      },
      lastError: null,
    })
    conversationBootstrapMetrics.started(input.reason)

    if (!isSocketOpen(this.socket)) return
    if (input.agentId) this.bootstrapBuffer.begin(input.agentId)
    this.startConversationBootstrapWatchdog(subscriptionId)
    this.emitActiveSubscriptionCommand()
  }

  /** The sole subscribe command emitter. Pending state is installed before this runs. */
  private emitActiveSubscriptionCommand(): void {
    const bootstrap = this.state.conversationBootstrap
    if (bootstrap.phase !== 'pending' || !bootstrap.subscriptionId) return
    this.send(buildSubscribeCommand(
      bootstrap.agentId,
      bootstrap.requestedView,
      bootstrap.subscriptionId,
    ))
  }

  private startConversationBootstrapWatchdog(subscriptionId: string): void {
    this.cancelConversationBootstrapWatchdog()
    this.conversationBootstrapTimer = setTimeout(() => {
      this.conversationBootstrapTimer = null
      const current = this.state.conversationBootstrap
      if (current.phase !== 'pending' || current.subscriptionId !== subscriptionId) return
      this.recordConversationBootstrapTerminal(subscriptionId, 'timed_out')
      this.updateState({
        conversationBootstrap: {
          ...current,
          phase: 'error',
          errorCode: 'BOOTSTRAP_TIMEOUT',
          errorMessage: 'Conversation loading timed out.',
        },
      })
    }, this.conversationBootstrapWatchdogMs)
  }

  private cancelConversationBootstrapWatchdog(): void {
    if (this.conversationBootstrapTimer) clearTimeout(this.conversationBootstrapTimer)
    this.conversationBootstrapTimer = null
  }

  private recordConversationBootstrapTerminal(
    subscriptionId: string,
    terminal: 'completed' | 'failed' | 'timed_out' | 'superseded' | 'disconnected',
  ): void {
    if (this.terminalSubscriptionId === subscriptionId) return
    this.terminalSubscriptionId = subscriptionId
    conversationBootstrapMetrics.terminal(terminal)
  }

  private invalidateConversationSnapshotAgent(agentId: string): void {
    this.nonCapturableConversationAgentIds.add(agentId)
    this.conversationSnapshotCache?.evictAgent(this.originId, agentId)
  }

  private captureCurrentConversationSnapshot(): void {
    const bootstrap = this.state.conversationBootstrap
    if (
      !this.conversationSnapshotCache ||
      bootstrap.phase !== 'ready' ||
      bootstrap.protocolMode !== 'correlated' ||
      !bootstrap.agentId ||
      !bootstrap.servedView ||
      this.nonCapturableConversationAgentIds.has(bootstrap.agentId)
    ) return
    const profileId = this.state.agents.find((agent) => agent.agentId === bootstrap.agentId)?.profileId ?? null
    this.conversationSnapshotCache.capture({
      originId: this.originId,
      agentId: bootstrap.agentId,
      servedView: bootstrap.servedView,
      profileId,
      messages: this.state.messages,
      activityMessages: this.state.activityMessages,
      conversationPage: this.state.conversationPage,
    })
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
      secureSecretCatalogRevision: null,
      secureSessionSnapshots: {},
      secureSessionSnapshotLoadingSessionId: this.desiredAgentId,
      sessionAttentionAvailable: false,
      sessionAttentionRevision: -1,
      sessionAttentions: {},
      hasReceivedAgentsSnapshot: false,
      hasReceivedProfilesSnapshot: false,
      workerMetadataSessionIds: new Set(),
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
      managerToolActivity: null,
      conversationBootstrap: {
        ...this.state.conversationBootstrap,
        protocolMode: 'unknown',
      },
      conversationPresentation: null,
      ...clearGenerationThroughputState(),
      lastError: this.browserHandshakeProtocolError,
    })

    // Fetch failures accumulated against the old socket don't predict anything
    // on the new one — reset the retry budget and requeue sessions whose
    // worker fetch was lost to the disconnect.
    this.sessionWorkerCache.retryFailedFetchesAfterReconnect()

    this.beginConversationSubscription({
      agentId: this.desiredAgentId,
      requestedView: this.conversationView,
      reason: 'reconnect',
    })
    this.restartBrowserHandshake()
  }

  private handleTransportClose(event?: CloseEvent): void {
    this.hasExplicitAgentSelection = false
    this.explicitAgentSelectionAgentId = null
    this.explicitAgentSelectionPending = false
    this.rejectedExplicitAgentSelectionId = null
    this.bootstrapBuffer.clear()
    this.cancelConversationBootstrapWatchdog()
    this.deferredWorkerThroughputEvents = []
    const pendingBootstrap = this.state.conversationBootstrap
    if (pendingBootstrap.phase === 'pending' && pendingBootstrap.subscriptionId) {
      this.recordConversationBootstrapTerminal(pendingBootstrap.subscriptionId, 'disconnected')
    }
    this.stopBrowserHandshake()
    this.clearGenerationTerminalCleanupTimers()

    // Keep `loadedSessionIds` — see handleTransportOpen.
    this.updateState({
      connected: false,
      hasReceivedAgentsSnapshot: false,
      hasReceivedProfilesSnapshot: false,
      workerMetadataSessionIds: new Set(),
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
      managerToolActivity: null,
      ...clearGenerationThroughputState(),
      ...(pendingBootstrap.phase === 'pending'
        ? {
            conversationBootstrap: {
              ...pendingBootstrap,
              phase: 'error' as const,
              errorCode: 'DISCONNECTED',
              errorMessage: 'Disconnected while loading conversation.',
            },
          }
        : {}),
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

    if (event.type === 'conversation_reset') {
      this.invalidateConversationSnapshotAgent(event.agentId)
    } else if (event.type === 'conversation_page' && event.page.completeness === 'source_changed') {
      this.invalidateConversationSnapshotAgent(event.agentId)
    } else if (event.type === 'session_archived' || event.type === 'session_cleared') {
      this.invalidateConversationSnapshotAgent(event.agentId)
    } else if (event.type === 'profile_archived') {
      this.conversationSnapshotCache?.evictProfile(this.originId, event.profileId)
      for (const agent of this.state.agents) {
        if (agent.profileId === event.profileId) this.nonCapturableConversationAgentIds.add(agent.agentId)
      }
    }

    if (
      event.type === 'error' &&
      event.code === 'UNKNOWN_AGENT' &&
      this.explicitAgentSelectionAgentId === this.desiredAgentId
    ) {
      this.rejectedExplicitAgentSelectionId = this.explicitAgentSelectionAgentId
      this.explicitAgentSelectionPending = false
      this.bootstrapBuffer.clear()
    }

    if (this.handleConversationBootstrapFrame(event)) return

    if (
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

    if (
      this.bootstrapBuffer.active
      && event.type === 'session_attention_update'
      && event.requestId
    ) {
      this.requestDispatcher.tracker.resolve('dismiss_session_attention', event.requestId, event)
    }

    if (this.bootstrapBuffer.active) {
      const consumed = this.bootstrapBuffer.handleEvent(event)
      if (consumed) return
    }

    if (handleSessionAttentionEvent(event, {
      state: this.state,
      updateState: (patch) => this.updateState(patch),
      requestTracker: this.requestDispatcher.tracker,
    })) {
      return
    }

    if (handleBrowserEvent(event, {
      state: this.state,
      updateState: (patch) => this.updateState(patch),
      requestTracker: this.requestDispatcher.tracker,
      acceptHydrationChunk: (chunk) => this.acceptBrowserHydrationChunk(chunk),
      registration: this.browserHostRegistration,
      handleAutomationRequest: this.browserAutomationRequestHandler,
      handleLifecycleRequest: this.browserLifecycleRequestHandler,
      sendHostResponse: (response) => this.send(buildBrowserHostResponseCommand(response)),
      sendLifecycleResponse: (response) => this.send(buildBrowserHostLifecycleResponseCommand(response)),
      handleRegistrationError: (error) => this.handleBrowserRegistrationError(error),
    })) {
      return
    }

    if (event.type === 'generation_throughput' || event.type === 'generation_throughput_snapshot') {
      const pendingWorkerMetadataSessionId =
        pendingGenerationThroughputWorkerMetadataSessionId(this.state, event)
      if (pendingWorkerMetadataSessionId) {
        this.deferWorkerThroughputEvent(event)
        return
      }
    }

    if (handleGenerationThroughputEvent(event, {
      state: this.state,
      applyGenerationThroughputReduction: (reduction) => this.applyGenerationThroughputReduction(reduction),
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

    // Gate terminal snapshots at the facade so handlers stay pure: reject late
    // prior-scope frames after A→B when the selected target's resolved scope differs.
    if (event.type === 'terminals_snapshot') {
      const expectedTerminalScopeId = this.resolveTerminalScopeAgentId(this.state.targetAgentId)
      if (event.sessionAgentId !== expectedTerminalScopeId) {
        return
      }
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

  private handleConversationBootstrapFrame(event: ServerEvent): boolean {
    if (
      event.type !== 'ready' &&
      event.type !== 'conversation_history' &&
      event.type !== 'pending_choices_snapshot' &&
      event.type !== 'bootstrap_failed'
    ) return false

    const frame = event.type
    const current = this.state.conversationBootstrap
    const eventSubscriptionId = 'subscriptionId' in event ? event.subscriptionId : undefined

    // Uncorrelated ready may be a ping. It can refresh connection health only.
    if (frame === 'ready' && !eventSubscriptionId && current.phase === 'pending') {
      if (!this.state.connected) this.updateState({ connected: true })
      return true
    }

    // A matching uncorrelated history is the sole legacy-peer detector.
    if (frame === 'conversation_history' && !eventSubscriptionId && current.phase === 'pending') {
      const expectedAgentId = current.agentId ?? event.agentId
      if (event.agentId !== expectedAgentId) return true
      this.conversationSnapshotCache?.evictOrigin(this.originId)
      this.bootstrapBuffer.flush()
      let patch: Partial<ManagerWsState> = {}
      handleConversationEvent(event, {
        state: this.state,
        updateState: (next) => { patch = { ...patch, ...next } },
      })
      this.cancelConversationBootstrapWatchdog()
      if (current.subscriptionId) this.recordConversationBootstrapTerminal(current.subscriptionId, 'completed')
      if (event.agentId === this.explicitAgentSelectionAgentId) {
        this.hasExplicitAgentSelection = false
        this.explicitAgentSelectionAgentId = null
        this.explicitAgentSelectionPending = false
        this.rejectedExplicitAgentSelectionId = null
      }
      this.updateState({
        ...patch,
        targetAgentId: event.agentId,
        subscribedAgentId: event.agentId,
        conversationPresentation: null,
        conversationBootstrap: {
          ...current,
          phase: 'ready',
          agentId: event.agentId,
          servedView: current.requestedView,
          protocolMode: 'legacy',
          errorCode: undefined,
          errorMessage: undefined,
        },
      })
      return true
    }

    // Legacy choices may arrive before legacy history. Apply only to the
    // selected target, but do not let them prove capability or completion.
    if (!eventSubscriptionId) {
      if (
        frame === 'pending_choices_snapshot' &&
        (current.agentId === null || event.agentId === current.agentId)
      ) {
        handleConversationEvent(event, {
          state: this.state,
          updateState: (patch) => this.updateState(patch),
        })
        return true
      }
      return false
    }

    if (
      current.phase === 'ready' &&
      frame === 'pending_choices_snapshot' &&
      current.subscriptionId === eventSubscriptionId &&
      current.agentId === event.agentId &&
      current.servedView === event.servedConversationView
    ) {
      handleConversationEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
      })
      return true
    }

    const mismatchDimension = (() => {
      if (current.phase !== 'pending') return 'phase' as const
      if (current.subscriptionId !== eventSubscriptionId) return 'id' as const
      const eventAgentId = frame === 'ready' ? event.subscribedAgentId : event.agentId
      if (current.agentId !== null && eventAgentId !== current.agentId) return 'agent' as const
      if (event.servedConversationView !== current.requestedView) return 'view' as const
      return null
    })()
    if (mismatchDimension) {
      conversationBootstrapMetrics.mismatch({ frame, dimension: mismatchDimension })
      return true
    }

    const eventAgentId = frame === 'ready' ? event.subscribedAgentId : event.agentId
    if (frame === 'ready') {
      const presentation = this.conversationSnapshotCache?.get({
        originId: this.originId,
        agentId: eventAgentId,
        servedView: event.servedConversationView!,
      }) ?? null
      this.stalePresentationAttachedAt = presentation ? Date.now() : null
      this.rejectedExplicitAgentSelectionId = null
      this.explicitAgentSelectionPending = false
      this.updateState({
        connected: true,
        targetAgentId: eventAgentId,
        subscribedAgentId: eventAgentId,
        sessionAttentionAvailable: event.sessionAttention === true,
        conversationPresentation: presentation,
        conversationBootstrap: {
          ...current,
          agentId: eventAgentId,
          servedView: event.servedConversationView!,
          protocolMode: 'correlated',
        },
      })
      return true
    }

    if (frame === 'bootstrap_failed') {
      this.cancelConversationBootstrapWatchdog()
      this.recordConversationBootstrapTerminal(eventSubscriptionId, 'failed')
      if (event.code === 'UNKNOWN_AGENT' || event.code === 'TARGET_REMOVED') {
        this.conversationSnapshotCache?.evictAgent(this.originId, eventAgentId)
      }
      this.updateState({
        conversationBootstrap: {
          ...current,
          phase: 'error',
          agentId: eventAgentId,
          servedView: event.servedConversationView,
          protocolMode: 'correlated',
          errorCode: event.code,
          errorMessage: event.message,
        },
      })
      return true
    }

    if (frame === 'pending_choices_snapshot') {
      handleConversationEvent(event, {
        state: this.state,
        updateState: (patch) => this.updateState(patch),
      })
      return true
    }

    // Correlated history is the success point. Reduce fresh authority and
    // release stale presentation in the same state notification.
    this.bootstrapBuffer.flush()
    let patch: Partial<ManagerWsState> = {}
    handleConversationEvent(event, {
      state: this.state,
      updateState: (next) => { patch = { ...patch, ...next } },
    })
    this.cancelConversationBootstrapWatchdog()
    this.recordConversationBootstrapTerminal(eventSubscriptionId, 'completed')
    // The correlated history is fresh authority, so a reset/clear suppression
    // can be released before capturing the replacement snapshot below.
    this.nonCapturableConversationAgentIds.delete(eventAgentId)
    if (this.stalePresentationAttachedAt !== null) {
      conversationBootstrapMetrics.staleDwell(Date.now() - this.stalePresentationAttachedAt)
      this.stalePresentationAttachedAt = null
    }
    this.updateState({
      ...patch,
      conversationPresentation: null,
      conversationBootstrap: {
        ...current,
        phase: 'ready',
        agentId: eventAgentId,
        servedView: event.servedConversationView!,
        protocolMode: 'correlated',
        errorCode: undefined,
        errorMessage: undefined,
      },
    })
    this.captureCurrentConversationSnapshot()
    return true
  }

  private deferWorkerThroughputEvent(
    event: Extract<ServerEvent, { type: 'generation_throughput' | 'generation_throughput_snapshot' }>,
  ): void {
    this.deferredWorkerThroughputEvents.push(event)
    if (this.deferredWorkerThroughputEvents.length > MAX_DEFERRED_WORKER_THROUGHPUT_EVENTS) {
      this.deferredWorkerThroughputEvents.shift()
    }
  }

  private flushDeferredWorkerThroughputEvents(sessionAgentId: string): void {
    const deferred = this.deferredWorkerThroughputEvents
    this.deferredWorkerThroughputEvents = []
    for (const event of deferred) {
      const eventSessionAgentId = event.type === 'generation_throughput'
        ? event.measurement.sessionId
        : event.sessionAgentId
      if (eventSessionAgentId !== sessionAgentId) {
        this.deferredWorkerThroughputEvents.push(event)
        continue
      }
      handleGenerationThroughputEvent(event, {
        state: this.state,
        applyGenerationThroughputReduction: (reduction) => this.applyGenerationThroughputReduction(reduction),
      })
    }
  }

  private applyGenerationThroughputReduction(reduction: GenerationThroughputReduction): void {
    if (!reduction.accepted) return
    this.updateState(reduction.patch)
    if (!reduction.terminal) return

    const timerKey = reduction.terminal.measurementId
    const existingTimer = this.generationTerminalCleanupTimers.get(timerKey)
    if (existingTimer) clearTimeout(existingTimer)
    const timer = setTimeout(() => {
      this.generationTerminalCleanupTimers.delete(timerKey)
      this.updateState(removeGenerationThroughputTombstone(this.state, reduction.terminal!))
    }, GENERATION_TERMINAL_SETTLE_MS)
    this.generationTerminalCleanupTimers.set(timerKey, timer)
  }

  private clearGenerationTerminalCleanupTimers(): void {
    for (const timer of this.generationTerminalCleanupTimers.values()) clearTimeout(timer)
    this.generationTerminalCleanupTimers.clear()
  }

  private clearGenerationThroughputForAgents(agentIds: Iterable<string>): void {
    this.updateState(clearGenerationThroughputForAgents(this.state, agentIds))
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
    // A full agents snapshot is authoritative for managers. Workers may be
    // intentionally omitted and preserved by the worker cache, but a missing
    // manager (and every worker owned by it) is definitively removed.
    const incomingManagerIds = new Set(
      agents.filter((agent) => agent.role === 'manager').map((agent) => agent.agentId),
    )
    const removedManagerIds = new Set(
      this.state.agents
        .filter((agent) => agent.role === 'manager' && !incomingManagerIds.has(agent.agentId))
        .map((agent) => agent.agentId),
    )
    for (const agent of this.state.agents) {
      if (
        (agent.role === 'manager' && removedManagerIds.has(agent.agentId)) ||
        (agent.role === 'worker' && removedManagerIds.has(agent.managerId))
      ) this.invalidateConversationSnapshotAgent(agent.agentId)
    }

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
    const nextAgentIds = new Set((result.patch.agents ?? this.state.agents).map((agent) => agent.agentId))
    const removedAgentIds = this.state.agents
      .filter((agent) => !nextAgentIds.has(agent.agentId))
      .map((agent) => agent.agentId)
    const throughputCleanup = clearGenerationThroughputForAgents(
      { ...this.state, ...result.patch },
      removedAgentIds,
    )
    const patch = { ...result.patch, ...throughputCleanup }

    if (result.subscribeToAgentId) {
      this.beginConversationSubscription({
        agentId: result.subscribeToAgentId,
        requestedView: this.conversationView,
        reason: 'fallback',
        patch,
        captureOutgoingSnapshot: false,
      })
    } else {
      this.updateState(patch)
    }
  }

  private applySessionWorkersSnapshot(
    sessionAgentId: string,
    workers: AgentDescriptor[],
    requestId?: string,
  ): void {
    this.sessionWorkerCache.applySessionWorkersSnapshot(sessionAgentId, workers)
    this.flushDeferredWorkerThroughputEvents(sessionAgentId)

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
    for (const deletedAgentId of result.deletedAgentIds) {
      this.invalidateConversationSnapshotAgent(deletedAgentId)
    }
    removeMutedAgents(result.deletedAgentIds)

    if (result.nextDesiredAgentId !== undefined) {
      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
      this.explicitAgentSelectionPending = false
      this.desiredAgentId = result.nextDesiredAgentId
    }

    const throughputCleanup = clearGenerationThroughputForAgents(this.state, result.deletedAgentIds)
    const patch = { ...result.patch, ...throughputCleanup }

    if (result.subscribeToAgentId) {
      this.beginConversationSubscription({
        agentId: result.subscribeToAgentId,
        requestedView: this.conversationView,
        reason: 'fallback',
        patch,
        captureOutgoingSnapshot: false,
      })
    } else {
      this.updateState(patch)
    }
  }

  private applySessionDeleted(agentId: string, profileId: string): void {
    const result = reduceSessionDeleted({
      state: this.state,
      agentId,
      profileId,
      socketOpen: isSocketOpen(this.socket),
    })

    this.sessionWorkerCache.clearQueuedRefetch(agentId)
    this.invalidateConversationSnapshotAgent(agentId)
    removeMutedAgent(result.mutedAgentIdToRemove)

    if (result.nextDesiredAgentId !== undefined) {
      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
      this.explicitAgentSelectionPending = false
      this.desiredAgentId = result.nextDesiredAgentId
    }

    const removedAgentIds = this.state.agents
      .filter((agent) => agent.agentId === agentId || agent.managerId === agentId)
      .map((agent) => agent.agentId)
    const throughputCleanup = clearGenerationThroughputForAgents(this.state, removedAgentIds)
    const sessionAttentions = { ...this.state.sessionAttentions }
    delete sessionAttentions[agentId]
    const patch = { ...result.patch, ...throughputCleanup, sessionAttentions }

    if (result.subscribeToAgentId) {
      this.beginConversationSubscription({
        agentId: result.subscribeToAgentId,
        requestedView: this.conversationView,
        reason: 'fallback',
        patch,
        captureOutgoingSnapshot: false,
      })
    } else {
      this.updateState(patch)
    }
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
