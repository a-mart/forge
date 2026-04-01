import { chooseFallbackAgentId } from './agent-hierarchy'
import { handleManagerIdleTransition, handleUnreadNotification } from './notification-service'
import { WsRequestTracker } from './ws-request-tracker'
import {
  createInitialManagerWsState,
  type AgentActivityEntry,
  type ConversationHistoryEntry,
  type ManagerWsState,
} from './ws-state'
import {
  MANAGER_MODEL_PRESETS,
  MANAGER_REASONING_LEVELS,
  type AgentDescriptor,
  type AgentSessionPurpose,
  type ChoiceAnswer,
  type ClientCommand,
  type ConversationAttachment,
  type ConversationEntry,
  type ConversationMessageEvent,
  type DeliveryMode,
  type ManagerModelPreset,
  type ManagerReasoningLevel,
  type ProjectAgentInfo,
  type ServerEvent,
  type SessionMemoryMergeResult,
} from '@forge/protocol'

export type { ManagerWsState } from './ws-state'

const INITIAL_CONNECT_DELAY_MS = 50
const RECONNECT_MS = 1200
const REQUEST_TIMEOUT_MS = 300_000
const SESSION_WORKERS_REFETCH_DEBOUNCE_MS = 250
// Keep client-side activity retention aligned with backend history retention.
const MAX_CLIENT_CONVERSATION_HISTORY = 2000

export interface DirectoriesListedResult {
  path: string
  directories: string[]
}

export interface DirectoryValidationResult {
  path: string
  valid: boolean
  message: string | null
}

type Listener = (state: ManagerWsState) => void

type SessionCreatedResult = { sessionAgent: AgentDescriptor; profileId: string }
type SessionActionResult = { agentId: string }
type SessionForkedResult = { sourceAgentId: string; newSessionAgent: AgentDescriptor }
type SessionWorkersResult = { sessionAgentId: string; workers: AgentDescriptor[] }

type SessionProjectAgentResult = { agentId: string; profileId: string; projectAgent: ProjectAgentInfo | null }

type ProjectAgentRecommendationsResult = { agentId: string; whenToUse: string; systemPrompt: string }

type WsRequestResultMap = {
  create_manager: AgentDescriptor
  delete_manager: { managerId: string }
  update_manager_model: { managerId: string }
  stop_all_agents: { managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }
  create_session: SessionCreatedResult
  stop_session: SessionActionResult
  resume_session: SessionActionResult
  delete_session: SessionActionResult
  clear_session: SessionActionResult
  rename_session: SessionActionResult
  pin_session: { pinnedAt: string | null }
  rename_profile: { profileId: string }
  fork_session: SessionForkedResult
  merge_session_memory: SessionMemoryMergeResult
  set_session_project_agent: SessionProjectAgentResult
  request_project_agent_recommendations: ProjectAgentRecommendationsResult
  get_session_workers: { sessionAgentId: string; workers: AgentDescriptor[] }
  list_directories: DirectoriesListedResult
  validate_directory: DirectoryValidationResult
  pick_directory: string | null
}

type WsRequestType = Extract<keyof WsRequestResultMap, string>
const WS_REQUEST_TYPES: WsRequestType[] = [
  'create_manager',
  'delete_manager',
  'update_manager_model',
  'stop_all_agents',
  'create_session',
  'stop_session',
  'resume_session',
  'delete_session',
  'clear_session',
  'rename_session',
  'pin_session',
  'rename_profile',
  'fork_session',
  'merge_session_memory',
  'set_session_project_agent',
  'request_project_agent_recommendations',
  'get_session_workers',
  'list_directories',
  'validate_directory',
  'pick_directory',
]

const WS_REQUEST_ERROR_HINTS: Array<{ requestType: WsRequestType; codeFragment: string }> = [
  { requestType: 'create_manager', codeFragment: 'create_manager' },
  { requestType: 'delete_manager', codeFragment: 'delete_manager' },
  { requestType: 'update_manager_model', codeFragment: 'update_manager_model' },
  { requestType: 'stop_all_agents', codeFragment: 'stop_all_agents' },
  { requestType: 'create_session', codeFragment: 'create_session' },
  { requestType: 'stop_session', codeFragment: 'stop_session' },
  { requestType: 'resume_session', codeFragment: 'resume_session' },
  { requestType: 'delete_session', codeFragment: 'delete_session' },
  { requestType: 'clear_session', codeFragment: 'clear_session' },
  { requestType: 'rename_session', codeFragment: 'rename_session' },
  { requestType: 'pin_session', codeFragment: 'pin_session' },
  { requestType: 'rename_profile', codeFragment: 'rename_profile' },
  { requestType: 'fork_session', codeFragment: 'fork_session' },
  { requestType: 'merge_session_memory', codeFragment: 'merge_session_memory' },
  { requestType: 'set_session_project_agent', codeFragment: 'set_session_project_agent' },
  { requestType: 'request_project_agent_recommendations', codeFragment: 'project_agent_recommendations' },
  { requestType: 'get_session_workers', codeFragment: 'get_session_workers' },
  { requestType: 'list_directories', codeFragment: 'list_directories' },
  { requestType: 'validate_directory', codeFragment: 'validate_directory' },
  { requestType: 'pick_directory', codeFragment: 'pick_directory' },
]

export class ManagerWsClient {
  private readonly url: string
  private desiredAgentId: string | null

  private socket: WebSocket | null = null
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private destroyed = false
  private hasConnectedOnce = false
  private shouldReloadOnReconnect = false
  private hasExplicitAgentSelection = false
  private explicitAgentSelectionAgentId: string | null = null
  private hasReceivedAgentsSnapshot = false

  private state: ManagerWsState
  private readonly listeners = new Set<Listener>()

  private requestCounter = 0
  private readonly requestTracker = new WsRequestTracker<WsRequestResultMap>(
    WS_REQUEST_TYPES,
    REQUEST_TIMEOUT_MS,
  )
  private readonly pendingWorkerFetches = new Map<string, Promise<SessionWorkersResult>>()
  private readonly pendingSessionWorkerRefetchTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(url: string, initialAgentId?: string | null) {
    const normalizedInitialAgentId = normalizeAgentId(initialAgentId)
    this.url = url
    this.desiredAgentId = normalizedInitialAgentId
    this.state = createInitialManagerWsState(normalizedInitialAgentId)
  }

  getState(): ManagerWsState {
    return this.state
  }

  /**
   * Manually mark a session as having unread messages.
   * Sets the unread count to at least 1 so the badge appears.
   */
  markUnread(agentId: string): void {
    const current = this.state.unreadCounts[agentId] ?? 0
    if (current === 0) {
      this.updateState({
        unreadCounts: { ...this.state.unreadCounts, [agentId]: 1 },
      })
    }
    // Persist to server
    this.send({ type: 'mark_unread', agentId })
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
    if (!agentId) {
      return null
    }

    const descriptor = agents.find((agent) => agent.agentId === agentId)
    if (!descriptor) {
      return null
    }

    if (descriptor.role === 'manager') {
      return descriptor.profileId ?? descriptor.agentId
    }

    const managerDescriptor = agents.find(
      (agent) => agent.role === 'manager' && agent.agentId === descriptor.managerId,
    )
    if (managerDescriptor) {
      return managerDescriptor.profileId ?? managerDescriptor.agentId
    }

    return descriptor.managerId
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)

    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.started || this.destroyed || typeof window === 'undefined') {
      return
    }

    this.started = true
    this.scheduleConnect(INITIAL_CONNECT_DELAY_MS)
  }

  destroy(): void {
    this.destroyed = true
    this.started = false

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }

    this.rejectAllPendingRequests('Client destroyed before request completed.')
    this.pendingWorkerFetches.clear()
    this.clearQueuedSessionWorkerRefetches()

    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
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
      pendingChoiceIds: new Set(),
      ...(shouldResetTerminals ? { terminals: [], terminalSessionScopeId: null } : {}),
      lastError: null,
      unreadCounts: nextUnread,
    })

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.send({
      type: 'subscribe',
      agentId: trimmed,
    })
  }

  sendUserMessage(
    text: string,
    options?: { agentId?: string; delivery?: DeliveryMode; attachments?: ConversationAttachment[] },
  ): void {
    const trimmed = text.trim()
    const attachments = normalizeConversationAttachments(options?.attachments)
    if (!trimmed && attachments.length === 0) return

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: 'WebSocket is disconnected. Reconnecting...'
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

    this.send({
      type: 'user_message',
      text: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
      agentId,
      delivery: options?.delivery,
    })
  }

  sendChoiceResponse(agentId: string, choiceId: string, answers: ChoiceAnswer[]): void {
    this.send({
      type: 'choice_response',
      agentId,
      choiceId,
      answers,
    })
  }

  sendChoiceCancel(agentId: string, choiceId: string): void {
    this.send({
      type: 'choice_cancel',
      agentId,
      choiceId,
    })
  }

  pinMessage(agentId: string, messageId: string, pinned: boolean): void {
    this.send({
      type: 'pin_message',
      agentId,
      messageId,
      pinned,
    })
  }

  clearAllPins(agentId: string): void {
    this.send({
      type: 'clear_all_pins',
      agentId,
    })
  }

  deleteAgent(agentId: string): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: 'WebSocket is disconnected. Reconnecting...'
      })
      return
    }

    this.send({
      type: 'kill_agent',
      agentId: trimmed,
    })
  }

  async stopAllAgents(
    managerId: string,
  ): Promise<{ managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }> {
    const trimmed = managerId.trim()
    if (!trimmed) {
      throw new Error('Manager id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('stop_all_agents', (requestId) => ({
      type: 'stop_all_agents',
      managerId: trimmed,
      requestId,
    }))
  }

  async createManager(input: { name: string; cwd: string; model: ManagerModelPreset }): Promise<AgentDescriptor> {
    const name = input.name.trim()
    const cwd = input.cwd.trim()
    const model = input.model

    if (!name) {
      throw new Error('Manager name is required.')
    }

    if (!cwd) {
      throw new Error('Manager working directory is required.')
    }

    if (!MANAGER_MODEL_PRESETS.includes(model)) {
      throw new Error('Manager model is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('create_manager', (requestId) => ({
        type: 'create_manager',
        name,
        cwd,
        model,
        requestId,
      }))
  }

  async deleteManager(managerId: string): Promise<{ managerId: string }> {
    const trimmed = managerId.trim()
    if (!trimmed) {
      throw new Error('Manager id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('delete_manager', (requestId) => ({
        type: 'delete_manager',
        managerId: trimmed,
        requestId,
      }))
  }

  async updateManagerModel(managerId: string, model: ManagerModelPreset, reasoningLevel?: ManagerReasoningLevel): Promise<{ managerId: string }> {
    const trimmed = managerId.trim()
    if (!trimmed) {
      throw new Error('Manager id is required.')
    }

    if (!MANAGER_MODEL_PRESETS.includes(model)) {
      throw new Error('Invalid model preset.')
    }

    if (reasoningLevel && !MANAGER_REASONING_LEVELS.includes(reasoningLevel)) {
      throw new Error('Invalid reasoning level.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('update_manager_model', (requestId) => ({
        type: 'update_manager_model',
        managerId: trimmed,
        model,
        reasoningLevel,
        requestId,
      }))
  }

  reorderProfiles(profileIds: string[]): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    return this.send({
      type: 'reorder_profiles',
      profileIds,
    })
  }

  async listDirectories(path?: string): Promise<DirectoriesListedResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('list_directories', (requestId) => ({
        type: 'list_directories',
        path: path?.trim() || undefined,
        requestId,
      }))
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    const trimmed = path.trim()
    if (!trimmed) {
      throw new Error('Directory path is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('validate_directory', (requestId) => ({
        type: 'validate_directory',
        path: trimmed,
        requestId,
      }))
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    // Use native Electron dialog when available
    const bridge = typeof window !== 'undefined' ? window.electronBridge : undefined
    if (bridge?.showOpenDialog) {
      const result = await bridge.showOpenDialog({
        title: 'Select Directory',
        defaultPath: defaultPath?.trim() || undefined,
        properties: ['openDirectory'],
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('pick_directory', (requestId) => ({
        type: 'pick_directory',
        defaultPath: defaultPath?.trim() || undefined,
        requestId,
      }))
  }

  async createSession(profileId: string, name?: string, opts?: { sessionPurpose?: AgentSessionPurpose; label?: string }): Promise<SessionCreatedResult> {
    const trimmed = profileId.trim()
    if (!trimmed) {
      throw new Error('Profile id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('create_session', (requestId) => ({
      type: 'create_session',
      profileId: trimmed,
      name: name?.trim() || undefined,
      label: opts?.label,
      sessionPurpose: opts?.sessionPurpose,
      requestId,
    }))
  }

  async stopSession(agentId: string): Promise<SessionActionResult> {
    const trimmed = agentId.trim()
    if (!trimmed) {
      throw new Error('Agent id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('stop_session', (requestId) => ({
      type: 'stop_session',
      agentId: trimmed,
      requestId,
    }))
  }

  async resumeSession(agentId: string): Promise<SessionActionResult> {
    const trimmed = agentId.trim()
    if (!trimmed) {
      throw new Error('Agent id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('resume_session', (requestId) => ({
      type: 'resume_session',
      agentId: trimmed,
      requestId,
    }))
  }

  async deleteSession(agentId: string): Promise<SessionActionResult> {
    const trimmed = agentId.trim()
    if (!trimmed) {
      throw new Error('Agent id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('delete_session', (requestId) => ({
      type: 'delete_session',
      agentId: trimmed,
      requestId,
    }))
  }

  async clearSession(agentId: string): Promise<SessionActionResult> {
    const trimmed = agentId.trim()
    if (!trimmed) {
      throw new Error('Agent id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('clear_session', (requestId) => ({
      type: 'clear_session',
      agentId: trimmed,
      requestId,
    }))
  }

  async renameSession(agentId: string, label: string): Promise<SessionActionResult> {
    const trimmed = agentId.trim()
    const trimmedLabel = label.trim()
    if (!trimmed) {
      throw new Error('Agent id is required.')
    }

    if (!trimmedLabel) {
      throw new Error('Session label is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('rename_session', (requestId) => ({
      type: 'rename_session',
      agentId: trimmed,
      label: trimmedLabel,
      requestId,
    }))
  }

  async pinSession(agentId: string, pinned: boolean): Promise<{ pinnedAt: string | null }> {
    const trimmed = agentId.trim()
    if (!trimmed) {
      throw new Error('Agent id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('pin_session', (requestId) => ({
      type: 'pin_session',
      agentId: trimmed,
      pinned,
      requestId,
    }))
  }

  async renameProfile(profileId: string, displayName: string): Promise<{ profileId: string }> {
    const trimmedId = profileId.trim()
    const trimmedName = displayName.trim()
    if (!trimmedId) {
      throw new Error('Profile id is required.')
    }

    if (!trimmedName) {
      throw new Error('Profile display name is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('rename_profile', (requestId) => ({
      type: 'rename_profile',
      profileId: trimmedId,
      displayName: trimmedName,
      requestId,
    }))
  }

  async forkSession(sourceAgentId: string, label?: string, fromMessageId?: string): Promise<SessionForkedResult> {
    const trimmed = sourceAgentId.trim()
    if (!trimmed) {
      throw new Error('Source agent id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('fork_session', (requestId) => ({
      type: 'fork_session',
      sourceAgentId: trimmed,
      label: label?.trim() || undefined,
      fromMessageId: fromMessageId?.trim() || undefined,
      requestId,
    }))
  }

  async setSessionProjectAgent(
    agentId: string,
    projectAgent: { whenToUse: string; systemPrompt?: string } | null,
  ): Promise<SessionProjectAgentResult> {
    const trimmed = agentId.trim()
    if (!trimmed) {
      throw new Error('Agent id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('set_session_project_agent', (requestId) => ({
      type: 'set_session_project_agent',
      agentId: trimmed,
      projectAgent,
      requestId,
    }))
  }

  async requestProjectAgentRecommendations(agentId: string): Promise<ProjectAgentRecommendationsResult> {
    const trimmed = agentId.trim()
    if (!trimmed) {
      throw new Error('Agent id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('request_project_agent_recommendations', (requestId) => ({
      type: 'request_project_agent_recommendations',
      agentId: trimmed,
      requestId,
    }))
  }

  async mergeSessionMemory(agentId: string): Promise<SessionMemoryMergeResult> {
    const trimmed = agentId.trim()
    if (!trimmed) {
      throw new Error('Agent id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('merge_session_memory', (requestId) => ({
      type: 'merge_session_memory',
      agentId: trimmed,
      requestId,
    }))
  }

  async getSessionWorkers(sessionAgentId: string): Promise<SessionWorkersResult> {
    const trimmed = sessionAgentId.trim()
    if (!trimmed) {
      throw new Error('Session agent id is required.')
    }

    if (this.state.loadedSessionIds.has(trimmed)) {
      // Validate cache: if the manager's advertised workerCount doesn't match
      // the number of cached workers, the cache is stale — bypass and re-fetch.
      const cachedWorkers = this.state.agents.filter(
        (agent) => agent.role === 'worker' && agent.managerId === trimmed,
      )
      const manager = this.state.agents.find(
        (agent) => agent.role === 'manager' && agent.agentId === trimmed,
      )
      if (manager?.workerCount !== undefined && cachedWorkers.length !== manager.workerCount) {
        const nextLoadedSessionIds = new Set(this.state.loadedSessionIds)
        nextLoadedSessionIds.delete(trimmed)
        this.updateState({ loadedSessionIds: nextLoadedSessionIds })
        // Fall through to fetch fresh data below
      } else {
        return {
          sessionAgentId: trimmed,
          workers: cachedWorkers,
        }
      }
    }

    const existingRequest = this.pendingWorkerFetches.get(trimmed)
    if (existingRequest) {
      return existingRequest
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected.')
    }

    const request = this.enqueueRequest('get_session_workers', (requestId) => ({
      type: 'get_session_workers',
      sessionAgentId: trimmed,
      requestId,
    }))

    this.pendingWorkerFetches.set(trimmed, request)

    try {
      return await request
    } finally {
      this.pendingWorkerFetches.delete(trimmed)
    }
  }

  private connect(): void {
    if (this.destroyed) return

    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.addEventListener('open', () => {
      const shouldReload = this.shouldReloadOnReconnect
      this.hasConnectedOnce = true
      this.shouldReloadOnReconnect = false
      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
      this.hasReceivedAgentsSnapshot = false

      this.updateState({
        connected: true,
        hasReceivedAgentsSnapshot: false,
        loadedSessionIds: new Set(),
        lastError: null,
      })

      this.send({
        type: 'subscribe',
        agentId: this.desiredAgentId ?? undefined,
      })

      if (shouldReload && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
        window.location.reload()
      }
    })

    socket.addEventListener('message', (event) => {
      this.handleServerEvent(event.data)
    })

    socket.addEventListener('close', () => {
      if (!this.destroyed && this.hasConnectedOnce) {
        this.shouldReloadOnReconnect = true
      }

      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
      this.hasReceivedAgentsSnapshot = false

      this.updateState({
        connected: false,
        hasReceivedAgentsSnapshot: false,
        loadedSessionIds: new Set(),
        subscribedAgentId: null,
      })

      this.clearQueuedSessionWorkerRefetches()
      this.rejectAllPendingRequests('WebSocket disconnected before request completed.')
      this.scheduleConnect(RECONNECT_MS)
    })

    socket.addEventListener('error', () => {
      this.updateState({
        connected: false,
        lastError: 'WebSocket connection error',
      })
    })
  }

  private scheduleConnect(delayMs: number): void {
    if (this.destroyed || !this.started || this.connectTimer) {
      return
    }

    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined
      if (!this.destroyed && this.started) {
        this.connect()
      }
    }, delayMs)
  }

  private handleServerEvent(raw: unknown): void {
    let event: ServerEvent
    try {
      event = JSON.parse(String(raw)) as ServerEvent
    } catch {
      this.pushSystemMessage('Received invalid JSON event from backend.')
      return
    }

    switch (event.type) {
      case 'ready':
        this.updateState({
          connected: true,
          targetAgentId: event.subscribedAgentId,
          subscribedAgentId: event.subscribedAgentId,
          lastError: null,
        })
        break

      case 'conversation_message':
      case 'conversation_log': {
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        const messages = [...this.state.messages, event]
        this.updateState({ messages })
        break
      }

      case 'message_pinned': {
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        const pinnedMessages = this.state.messages.map((msg) => {
          if (msg.type === 'conversation_message' && msg.id === event.messageId) {
            return { ...msg, pinned: event.pinned }
          }
          return msg
        })
        this.updateState({ messages: pinnedMessages })
        break
      }

      case 'choice_request': {
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        const existingIdx = this.state.messages.findIndex(
          (message) => message.type === 'choice_request' && message.choiceId === event.choiceId,
        )

        let nextMessages: ConversationHistoryEntry[]
        if (existingIdx >= 0) {
          nextMessages = [...this.state.messages]
          nextMessages[existingIdx] = event
        } else {
          nextMessages = [...this.state.messages, event]
        }

        const nextPendingChoiceIds = new Set(this.state.pendingChoiceIds)
        if (event.status === 'pending') {
          nextPendingChoiceIds.add(event.choiceId)
        } else {
          nextPendingChoiceIds.delete(event.choiceId)
        }

        this.updateState({ messages: nextMessages, pendingChoiceIds: nextPendingChoiceIds })
        break
      }

      case 'unread_notification': {
        // Sound/notification side-effects only.
        // Count is managed by unread_count_update from server.
        handleUnreadNotification(event.agentId, this.state, event.reason, event.sessionAgentId)
        break
      }

      case 'unread_counts_snapshot': {
        const counts = { ...event.counts }
        if (this.state.targetAgentId) {
          delete counts[this.state.targetAgentId]
        }
        this.updateState({
          unreadCounts: counts,
        })
        break
      }

      case 'unread_count_update': {
        // Skip update for the currently-viewed session
        if (event.agentId === this.state.targetAgentId) {
          break
        }
        const nextUnread = { ...this.state.unreadCounts }
        if (event.count > 0) {
          nextUnread[event.agentId] = event.count
        } else {
          delete nextUnread[event.agentId]
        }
        this.updateState({ unreadCounts: nextUnread })
        break
      }

      case 'agent_message':
      case 'agent_tool_call': {
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        const activityMessages = clampConversationHistory([...this.state.activityMessages, event])
        this.updateState({ activityMessages })
        break
      }

      case 'conversation_history':
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        {
          const { messages, activityMessages } = splitConversationHistory(event.messages)
          this.updateState({
            messages,
            activityMessages: clampConversationHistory(activityMessages),
          })
        }
        break

      case 'pending_choices_snapshot':
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        this.updateState({ pendingChoiceIds: new Set(event.choiceIds) })
        break

      case 'conversation_reset':
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        this.updateState({
          messages: [],
          activityMessages: [],
          pendingChoiceIds: new Set(),
          lastError: null,
        })
        break

      case 'terminals_snapshot':
        this.updateState({
          terminals: event.terminals,
          terminalSessionScopeId: event.sessionAgentId,
        })
        break

      case 'terminal_created': {
        if (event.sessionAgentId !== this.state.terminalSessionScopeId) {
          break
        }

        const existingIndex = this.state.terminals.findIndex(
          (terminal) => terminal.terminalId === event.terminal.terminalId,
        )
        const terminals = existingIndex >= 0
          ? this.state.terminals.map((terminal, index) => index === existingIndex ? event.terminal : terminal)
          : [...this.state.terminals, event.terminal]
        this.updateState({ terminals })
        break
      }

      case 'terminal_updated': {
        if (event.sessionAgentId !== this.state.terminalSessionScopeId) {
          break
        }

        const existingIndex = this.state.terminals.findIndex(
          (terminal) => terminal.terminalId === event.terminal.terminalId,
        )
        const terminals = existingIndex >= 0
          ? this.state.terminals.map((terminal, index) => index === existingIndex ? event.terminal : terminal)
          : [...this.state.terminals, event.terminal]
        this.updateState({ terminals })
        break
      }

      case 'terminal_closed': {
        if (event.sessionAgentId !== this.state.terminalSessionScopeId) {
          break
        }

        const terminals = this.state.terminals.filter((terminal) => terminal.terminalId !== event.terminalId)
        this.updateState({ terminals })
        break
      }

      case 'agent_status': {
        const prevEntry = this.state.statuses[event.agentId]
        const prevStatus = prevEntry?.status
        const isKnownAgent = this.state.agents.some((agent) => agent.agentId === event.agentId)

        const statuses = {
          ...this.state.statuses,
          [event.agentId]: {
            status: event.status,
            pendingCount: event.pendingCount,
            contextUsage: event.contextUsage,
            contextRecoveryInProgress: event.contextRecoveryInProgress,
            streamingStartedAt: resolveStreamingStartedAt(prevEntry, event.status, event.streamingStartedAt),
          },
        }

        let nextAgents = this.state.agents
        let nextLoadedSessionIds = this.state.loadedSessionIds
        if (event.managerId) {
          const managerSessionWasLoaded = this.state.loadedSessionIds.has(event.managerId)
          if (!isKnownAgent && managerSessionWasLoaded) {
            nextLoadedSessionIds = new Set(this.state.loadedSessionIds)
            nextLoadedSessionIds.delete(event.managerId)
            this.queueSessionWorkersRefetch(event.managerId)
          }

          nextAgents = this.state.agents.map((agent) => {
            // Update the worker's own status in state.agents
            if (agent.agentId === event.agentId && agent.status !== event.status) {
              return { ...agent, status: event.status, contextUsage: event.contextUsage }
            }

            if (agent.role !== 'manager' || agent.agentId !== event.managerId) {
              return agent
            }

            const delta =
              event.status === 'streaming' && prevStatus !== 'streaming'
                ? 1
                : event.status !== 'streaming' && prevStatus === 'streaming'
                  ? -1
                  : 0

            if (delta === 0) {
              return agent
            }

            return {
              ...agent,
              activeWorkerCount: Math.max(0, (agent.activeWorkerCount ?? 0) + delta),
            }
          })
        }

        const nextState = {
          statuses,
          ...(nextAgents !== this.state.agents ? { agents: nextAgents } : {}),
          ...(nextLoadedSessionIds !== this.state.loadedSessionIds
            ? { loadedSessionIds: nextLoadedSessionIds }
            : {}),
        }
        this.updateState(nextState)

        // Detect manager streaming → idle transition for deferred notification evaluation.
        // When a manager goes idle, check if a pending all-done sound should play now.
        if (prevStatus === 'streaming' && event.status === 'idle') {
          const stateForNotifications = {
            ...this.state,
            ...(nextAgents !== this.state.agents ? { agents: nextAgents } : {}),
            ...(nextLoadedSessionIds !== this.state.loadedSessionIds
              ? { loadedSessionIds: nextLoadedSessionIds }
              : {}),
            statuses,
          }
          const agent = stateForNotifications.agents.find((a) => a.agentId === event.agentId)
          if (agent?.role === 'manager') {
            handleManagerIdleTransition(event.agentId, stateForNotifications)
          }
        }
        break
      }

      case 'agents_snapshot':
        this.applyAgentsSnapshot(event.agents)
        break

      case 'session_workers_snapshot':
        this.applySessionWorkersSnapshot(event.sessionAgentId, event.workers, event.requestId)
        break

      case 'profiles_snapshot':
        this.updateState({ profiles: event.profiles })
        break

      case 'manager_created': {
        this.applyManagerCreated(event.manager)
        this.requestTracker.resolve('create_manager', event.requestId, event.manager)
        break
      }

      case 'manager_deleted': {
        this.applyManagerDeleted(event.managerId)
        this.requestTracker.resolve('delete_manager', event.requestId, {
          managerId: event.managerId,
        })
        break
      }

      case 'manager_model_updated': {
        this.requestTracker.resolve('update_manager_model', event.requestId, {
          managerId: event.managerId,
        })
        break
      }

      case 'session_created': {
        this.requestTracker.resolve('create_session', event.requestId, {
          sessionAgent: event.sessionAgent,
          profileId: event.profile.profileId,
        })
        break
      }

      case 'session_stopped': {
        this.requestTracker.resolve('stop_session', event.requestId, {
          agentId: event.agentId,
        })
        break
      }

      case 'session_resumed': {
        this.requestTracker.resolve('resume_session', event.requestId, {
          agentId: event.agentId,
        })
        break
      }

      case 'session_deleted': {
        this.applySessionDeleted(event.agentId, event.profileId)
        this.requestTracker.resolve('delete_session', event.requestId, {
          agentId: event.agentId,
        })
        break
      }

      case 'session_cleared': {
        this.requestTracker.resolve('clear_session', event.requestId, {
          agentId: event.agentId,
        })
        // conversation_reset event handles clearing the message list
        break
      }

      case 'session_renamed': {
        this.requestTracker.resolve('rename_session', event.requestId, {
          agentId: event.agentId,
        })
        break
      }

      case 'session_pinned': {
        this.requestTracker.resolve('pin_session', event.requestId, {
          pinnedAt: event.pinnedAt,
        })
        break
      }

      case 'session_project_agent_updated': {
        if (event.requestId) {
          this.requestTracker.resolve('set_session_project_agent', event.requestId, {
            agentId: event.agentId,
            profileId: event.profileId,
            projectAgent: event.projectAgent,
          })
        }
        break
      }

      case 'project_agent_recommendations': {
        this.requestTracker.resolve('request_project_agent_recommendations', event.requestId, {
          agentId: event.agentId,
          whenToUse: event.whenToUse,
          systemPrompt: event.systemPrompt,
        })
        break
      }

      case 'project_agent_recommendations_error': {
        if (event.requestId) {
          this.requestTracker.reject(
            'request_project_agent_recommendations',
            event.requestId,
            new Error(event.message || 'Failed to generate project agent recommendations.'),
          )
        }
        break
      }

      case 'profile_renamed': {
        this.requestTracker.resolve('rename_profile', event.requestId, {
          profileId: event.profileId,
        })
        break
      }

      case 'session_forked': {
        this.requestTracker.resolve('fork_session', event.requestId, {
          sourceAgentId: event.sourceAgentId,
          newSessionAgent: event.newSessionAgent,
        })
        break
      }

      case 'session_memory_merge_started': {
        break
      }

      case 'session_memory_merged': {
        this.requestTracker.resolve('merge_session_memory', event.requestId, {
          agentId: event.agentId,
          status: event.status,
          strategy: event.strategy,
          mergedAt: event.mergedAt,
          auditPath: event.auditPath,
        })
        break
      }

      case 'session_memory_merge_failed': {
        if (event.requestId) {
          this.requestTracker.reject(
            'merge_session_memory',
            event.requestId,
            new Error(event.message || 'Session memory merge failed.'),
          )
        }
        break
      }

      case 'stop_all_agents_result': {
        const stoppedWorkerIds = event.stoppedWorkerIds ?? event.terminatedWorkerIds ?? []
        const managerStopped = event.managerStopped ?? event.managerTerminated ?? false

        this.requestTracker.resolve('stop_all_agents', event.requestId, {
          managerId: event.managerId,
          stoppedWorkerIds,
          managerStopped,
        })
        break
      }

      case 'directories_listed': {
        this.requestTracker.resolve('list_directories', event.requestId, {
          path: event.path,
          directories: event.directories,
        })
        break
      }

      case 'directory_validated': {
        this.requestTracker.resolve('validate_directory', event.requestId, {
          path: event.path,
          valid: event.valid,
          message: event.message ?? null,
        })
        break
      }

      case 'directory_picked': {
        this.requestTracker.resolve('pick_directory', event.requestId, event.path ?? null)
        break
      }

      case 'telegram_status':
        this.updateState({ telegramStatus: event })
        break

      case 'playwright_discovery_snapshot':
      case 'playwright_discovery_updated':
        this.updateState({
          playwrightSnapshot: event.snapshot,
          playwrightSettings: event.snapshot.settings,
        })
        break

      case 'playwright_discovery_settings_updated':
        this.updateState({
          playwrightSettings: event.settings,
          playwrightSnapshot: this.state.playwrightSnapshot
            ? { ...this.state.playwrightSnapshot, settings: event.settings }
            : this.state.playwrightSnapshot,
        })
        break

      case 'prompt_changed':
      case 'cortex_prompt_surface_changed':
        this.updateState({ promptChangeKey: this.state.promptChangeKey + 1 })
        break

      case 'specialist_roster_changed':
        this.updateState({ specialistChangeKey: this.state.specialistChangeKey + 1 })
        break

      case 'model_config_changed':
        this.updateState({ modelConfigChangeKey: this.state.modelConfigChangeKey + 1 })
        break

      case 'error':
        this.updateState({ lastError: event.message })
        this.pushSystemMessage(`${event.code}: ${event.message}`)
        this.rejectPendingFromError(event.code, event.message, event.requestId)
        break
    }
  }

  private applyAgentsSnapshot(agents: AgentDescriptor[]): void {
    const incomingAgentIds = new Set(agents.map((agent) => agent.agentId))
    const preservedWorkers = this.state.agents.filter(
      (agent) =>
        agent.role === 'worker' &&
        !incomingAgentIds.has(agent.agentId) &&
        this.isWorkerFromLoadedSession(agent),
    )

    const mergedAgents = [...agents, ...preservedWorkers]
    const mergedAgentIds = new Set(mergedAgents.map((agent) => agent.agentId))
    const nextLoadedSessionIds = new Set(this.state.loadedSessionIds)

    for (const manager of agents) {
      if (manager.role !== 'manager' || manager.workerCount === undefined) {
        continue
      }

      const cachedWorkers = this.state.agents.filter(
        (agent) => agent.role === 'worker' && agent.managerId === manager.agentId,
      )

      if (nextLoadedSessionIds.has(manager.agentId) && cachedWorkers.length !== manager.workerCount) {
        nextLoadedSessionIds.delete(manager.agentId)
        this.queueSessionWorkersRefetch(manager.agentId)
      }
    }

    const previousAgentIds = new Set(this.state.agents.map((agent) => agent.agentId))
    const preservedUnloadedStatuses = Object.fromEntries(
      Object.entries(this.state.statuses).filter(
        ([agentId]) => !mergedAgentIds.has(agentId) && !previousAgentIds.has(agentId),
      ),
    )
    const statuses = {
      ...preservedUnloadedStatuses,
      ...Object.fromEntries(
        mergedAgents.map((agent) => {
          const previous = this.state.statuses[agent.agentId]
          const status = (agent.role === 'worker' && previous) ? previous.status : agent.status
          return [
            agent.agentId,
            {
              status,
              pendingCount: previous && previous.status === status ? previous.pendingCount : 0,
              contextUsage: agent.contextUsage,
              contextRecoveryInProgress: previous?.contextRecoveryInProgress,
              streamingStartedAt: resolveStreamingStartedAt(previous, status, agent.streamingStartedAt),
            },
          ]
        }),
      ),
    }

    const currentTarget = this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId ?? undefined
    const currentTargetStillExists = currentTarget ? mergedAgentIds.has(currentTarget) : false
    const currentTargetIsIntentionalWorkerSubscription = Boolean(
      currentTarget &&
      currentTarget === this.state.subscribedAgentId &&
      !agents.some((agent) => agent.agentId === currentTarget && agent.role === 'manager'),
    )
    const fallbackTarget = currentTargetStillExists
      ? currentTarget
      : currentTargetIsIntentionalWorkerSubscription
        ? currentTarget
        : chooseFallbackAgentId(mergedAgents, currentTarget)
    const targetChanged = fallbackTarget !== this.state.targetAgentId
    const nextSubscribedAgentId =
      this.state.subscribedAgentId && mergedAgentIds.has(this.state.subscribedAgentId)
        ? this.state.subscribedAgentId
        : currentTargetIsIntentionalWorkerSubscription
          ? this.state.subscribedAgentId
          : fallbackTarget ?? null

    if (targetChanged && fallbackTarget !== this.explicitAgentSelectionAgentId) {
      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
    }

    this.hasReceivedAgentsSnapshot = true

    const patch: Partial<ManagerWsState> = {
      agents: mergedAgents,
      statuses,
      loadedSessionIds: nextLoadedSessionIds,
      hasReceivedAgentsSnapshot: this.hasReceivedAgentsSnapshot,
    }

    if (targetChanged) {
      patch.targetAgentId = fallbackTarget
      patch.messages = []
      patch.activityMessages = []
      patch.pendingChoiceIds = new Set()

      const previousTerminalScopeId = this.resolveTerminalScopeAgentId(this.state.targetAgentId, this.state.agents)
      const nextTerminalScopeId = this.resolveTerminalScopeAgentId(fallbackTarget, mergedAgents)
      if (previousTerminalScopeId !== nextTerminalScopeId) {
        patch.terminals = []
        patch.terminalSessionScopeId = null
      }
    }

    if (nextSubscribedAgentId !== this.state.subscribedAgentId) {
      patch.subscribedAgentId = nextSubscribedAgentId
    }

    this.desiredAgentId = fallbackTarget ?? null

    this.updateState(patch)

    if (
      targetChanged &&
      fallbackTarget &&
      this.socket?.readyState === WebSocket.OPEN &&
      !currentTargetIsIntentionalWorkerSubscription
    ) {
      this.send({
        type: 'subscribe',
        agentId: fallbackTarget,
      })
    }
  }

  private applySessionWorkersSnapshot(sessionAgentId: string, workers: AgentDescriptor[], requestId?: string): void {
    const nextLoadedSessionIds = new Set(this.state.loadedSessionIds)
    nextLoadedSessionIds.add(sessionAgentId)

    const incomingWorkerIds = new Set(workers.map((worker) => worker.agentId))
    const preserved = this.state.agents.filter(
      (agent) =>
        !(agent.role === 'worker' && agent.managerId === sessionAgentId && !incomingWorkerIds.has(agent.agentId)),
    )
    const nextAgents = [
      ...preserved.filter((agent) => !(agent.role === 'worker' && agent.managerId === sessionAgentId)),
      ...workers,
    ]

    const nextStatuses = { ...this.state.statuses }
    for (const worker of this.state.agents) {
      if (worker.role === 'worker' && worker.managerId === sessionAgentId && !incomingWorkerIds.has(worker.agentId)) {
        delete nextStatuses[worker.agentId]
      }
    }

    for (const worker of workers) {
      const previous = nextStatuses[worker.agentId]
      nextStatuses[worker.agentId] = {
        status: worker.status,
        pendingCount: previous && previous.status === worker.status ? previous.pendingCount : 0,
        contextUsage: worker.contextUsage,
        contextRecoveryInProgress: previous?.contextRecoveryInProgress,
        streamingStartedAt: resolveStreamingStartedAt(previous, worker.status, worker.streamingStartedAt),
      }
    }

    this.updateState({
      agents: nextAgents,
      statuses: nextStatuses,
      loadedSessionIds: nextLoadedSessionIds,
    })

    if (requestId) {
      this.requestTracker.resolve('get_session_workers', requestId, {
        sessionAgentId,
        workers,
      })
    }

    // Post-load consistency check: if the manager's advertised workerCount
    // doesn't match the loaded count, the snapshot is stale (e.g., workers
    // spawned between the request and response). Invalidate and re-fetch.
    const managerDescriptor = this.state.agents.find(
      (a) => a.role === 'manager' && a.agentId === sessionAgentId,
    )
    if (managerDescriptor?.workerCount !== undefined && workers.length !== managerDescriptor.workerCount) {
      const staleFixupIds = new Set(this.state.loadedSessionIds)
      staleFixupIds.delete(sessionAgentId)
      this.updateState({ loadedSessionIds: staleFixupIds })
      this.queueSessionWorkersRefetch(sessionAgentId)
    }
  }

  private isWorkerFromLoadedSession(worker: AgentDescriptor): boolean {
    return worker.role === 'worker' && this.state.loadedSessionIds.has(worker.managerId)
  }

  private applyManagerCreated(manager: AgentDescriptor): void {
    const nextAgents = [
      ...this.state.agents.filter((agent) => agent.agentId !== manager.agentId),
      manager,
    ]
    this.applyAgentsSnapshot(nextAgents)
  }

  private applyManagerDeleted(managerId: string): void {
    const wasSelected =
      this.state.targetAgentId === managerId || this.state.subscribedAgentId === managerId

    const nextAgents = this.state.agents.filter(
      (agent) => agent.agentId !== managerId && agent.managerId !== managerId,
    )
    const nextStatuses = { ...this.state.statuses }
    delete nextStatuses[managerId]
    // Clean up unread counts for deleted manager and all its sessions/workers
    const nextUnread = { ...this.state.unreadCounts }
    delete nextUnread[managerId]
    for (const agent of this.state.agents) {
      if (agent.managerId === managerId) {
        delete nextStatuses[agent.agentId]
        delete nextUnread[agent.agentId]
      }
    }
    const nextLoadedSessionIds = new Set(this.state.loadedSessionIds)
    nextLoadedSessionIds.delete(managerId)
    this.clearQueuedSessionWorkerRefetch(managerId)

    if (wasSelected) {
      const fallbackId = chooseFallbackAgentId(nextAgents)

      if (fallbackId && this.socket?.readyState === WebSocket.OPEN) {
        this.hasExplicitAgentSelection = false
        this.explicitAgentSelectionAgentId = null
        this.desiredAgentId = fallbackId
        this.send({ type: 'subscribe', agentId: fallbackId })
        this.updateState({
          agents: nextAgents,
          statuses: nextStatuses,
          unreadCounts: nextUnread,
          loadedSessionIds: nextLoadedSessionIds,
          targetAgentId: fallbackId,
          subscribedAgentId: fallbackId,
          messages: [],
          activityMessages: [],
          pendingChoiceIds: new Set(),
          terminals: [],
          terminalSessionScopeId: null,
        })
        return
      }

      this.hasExplicitAgentSelection = false
      this.explicitAgentSelectionAgentId = null
      this.desiredAgentId = null
      this.updateState({
        agents: nextAgents,
        statuses: nextStatuses,
        unreadCounts: nextUnread,
        loadedSessionIds: nextLoadedSessionIds,
        targetAgentId: null,
        subscribedAgentId: null,
        messages: [],
        activityMessages: [],
        pendingChoiceIds: new Set(),
        terminals: [],
        terminalSessionScopeId: null,
      })
      return
    }

    this.updateState({
      agents: nextAgents,
      statuses: nextStatuses,
      unreadCounts: nextUnread,
      loadedSessionIds: nextLoadedSessionIds,
    })
  }

  private applySessionDeleted(agentId: string, profileId: string): void {
    const wasSelected =
      this.state.targetAgentId === agentId || this.state.subscribedAgentId === agentId

    const nextAgents = this.state.agents.filter(
      (agent) => agent.agentId !== agentId && agent.managerId !== agentId,
    )
    const nextStatuses = { ...this.state.statuses }
    delete nextStatuses[agentId]
    // Clean up unread count for the deleted session
    const nextUnread = { ...this.state.unreadCounts }
    delete nextUnread[agentId]
    for (const worker of this.state.agents) {
      if (worker.role === 'worker' && worker.managerId === agentId) {
        delete nextStatuses[worker.agentId]
      }
    }
    const nextLoadedSessionIds = new Set(this.state.loadedSessionIds)
    nextLoadedSessionIds.delete(agentId)
    this.clearQueuedSessionWorkerRefetch(agentId)

    if (wasSelected) {
      const fallbackId =
        chooseMostRecentSessionAgentId(nextAgents, profileId, agentId) ?? chooseFallbackAgentId(nextAgents)

      if (fallbackId && this.socket?.readyState === WebSocket.OPEN) {
        this.hasExplicitAgentSelection = false
        this.explicitAgentSelectionAgentId = null
        this.desiredAgentId = fallbackId
        this.send({ type: 'subscribe', agentId: fallbackId })

        const previousTerminalScopeId = this.resolveTerminalScopeAgentId(agentId, this.state.agents)
        const nextTerminalScopeId = this.resolveTerminalScopeAgentId(fallbackId, nextAgents)

        this.updateState({
          agents: nextAgents,
          statuses: nextStatuses,
          unreadCounts: nextUnread,
          loadedSessionIds: nextLoadedSessionIds,
          targetAgentId: fallbackId,
          subscribedAgentId: fallbackId,
          messages: [],
          activityMessages: [],
          pendingChoiceIds: new Set(),
          ...(previousTerminalScopeId !== nextTerminalScopeId
            ? { terminals: [], terminalSessionScopeId: null }
            : {}),
        })
        return
      }
    }

    this.updateState({
      agents: nextAgents,
      statuses: nextStatuses,
      unreadCounts: nextUnread,
      loadedSessionIds: nextLoadedSessionIds,
    })
  }

  private queueSessionWorkersRefetch(sessionAgentId: string): void {
    const normalizedSessionAgentId = sessionAgentId.trim()
    if (!normalizedSessionAgentId) {
      return
    }

    this.clearQueuedSessionWorkerRefetch(normalizedSessionAgentId)

    const timer = setTimeout(() => {
      this.pendingSessionWorkerRefetchTimers.delete(normalizedSessionAgentId)
      void this.getSessionWorkers(normalizedSessionAgentId).catch(() => {
        // Best-effort refresh to keep worker cache in sync after session invalidation.
      })
    }, SESSION_WORKERS_REFETCH_DEBOUNCE_MS)

    this.pendingSessionWorkerRefetchTimers.set(normalizedSessionAgentId, timer)
  }

  private clearQueuedSessionWorkerRefetch(sessionAgentId: string): void {
    const normalizedSessionAgentId = sessionAgentId.trim()
    if (!normalizedSessionAgentId) {
      return
    }

    const timer = this.pendingSessionWorkerRefetchTimers.get(normalizedSessionAgentId)
    if (!timer) {
      return
    }

    clearTimeout(timer)
    this.pendingSessionWorkerRefetchTimers.delete(normalizedSessionAgentId)
  }

  private clearQueuedSessionWorkerRefetches(): void {
    for (const timer of this.pendingSessionWorkerRefetchTimers.values()) {
      clearTimeout(timer)
    }

    this.pendingSessionWorkerRefetchTimers.clear()
  }

  private pushSystemMessage(text: string): void {
    const message: ConversationMessageEvent = {
      type: 'conversation_message',
      agentId: (this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId) || 'system',
      role: 'system',
      text,
      timestamp: new Date().toISOString(),
      source: 'system',
    }

    const messages = [...this.state.messages, message]
    this.updateState({ messages })
  }

  private send(command: ClientCommand): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(command))
    return true
  }

  private updateState(patch: Partial<ManagerWsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1
    return `${prefix}-${Date.now()}-${this.requestCounter}`
  }

  private enqueueRequest<RequestType extends WsRequestType>(
    requestType: RequestType,
    buildCommand: (requestId: string) => ClientCommand,
  ): Promise<WsRequestResultMap[RequestType]> {
    const requestId = this.nextRequestId(requestType)

    return new Promise<WsRequestResultMap[RequestType]>((resolve, reject) => {
      this.requestTracker.track(requestType, requestId, resolve, reject)

      const sent = this.send(buildCommand(requestId))
      if (!sent) {
        this.requestTracker.reject(
          requestType,
          requestId,
          new Error('WebSocket is disconnected. Reconnecting...'),
        )
      }
    })
  }

  private rejectPendingFromError(code: string, message: string, requestId?: string): void {
    const fullError = new Error(`${code}: ${message}`)

    if (requestId && this.requestTracker.rejectByRequestId(requestId, fullError)) {
      return
    }

    const loweredCode = code.toLowerCase()

    for (const hint of WS_REQUEST_ERROR_HINTS) {
      if (!loweredCode.includes(hint.codeFragment)) {
        continue
      }

      if (this.requestTracker.rejectOldest(hint.requestType, fullError)) {
        return
      }
    }

    this.requestTracker.rejectOnlyPending(fullError)
  }

  private rejectAllPendingRequests(reason: string): void {
    this.requestTracker.rejectAll(new Error(reason))
  }
}

function resolveStreamingStartedAt(
  previous: ManagerWsState['statuses'][string] | undefined,
  nextStatus: AgentDescriptor['status'],
  serverTimestamp?: number,
): number | undefined {
  if (nextStatus !== 'streaming') {
    return previous?.streamingStartedAt
  }

  // Prefer server-provided timestamp (survives reconnect/reload)
  if (serverTimestamp != null) {
    return serverTimestamp
  }

  if (previous?.status === 'streaming' && previous.streamingStartedAt !== undefined) {
    return previous.streamingStartedAt
  }

  return Date.now()
}

function chooseMostRecentSessionAgentId(
  agents: AgentDescriptor[],
  profileId: string,
  excludedAgentId?: string,
): string | null {
  const sessions = agents
    .filter((agent) => {
      if (agent.role !== 'manager') {
        return false
      }

      if (agent.agentId === excludedAgentId) {
        return false
      }

      const agentProfileId = agent.profileId?.trim() || agent.agentId
      return agentProfileId === profileId
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

  return sessions[0]?.agentId ?? null
}

function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined,
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return []
  }

  const normalized: ConversationAttachment[] = []

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      continue
    }

    const maybe = attachment as {
      type?: unknown
      mimeType?: unknown
      data?: unknown
      text?: unknown
      fileName?: unknown
    }

    const attachmentType = typeof maybe.type === 'string' ? maybe.type.trim() : ''
    const mimeType = typeof maybe.mimeType === 'string' ? maybe.mimeType.trim() : ''
    const fileName = typeof maybe.fileName === 'string' ? maybe.fileName.trim() : ''

    if (attachmentType === 'text') {
      const text = typeof maybe.text === 'string' ? maybe.text : ''
      if (!mimeType || text.trim().length === 0) {
        continue
      }

      normalized.push({
        type: 'text',
        mimeType,
        text,
        fileName: fileName || undefined,
      })
      continue
    }

    if (attachmentType === 'binary') {
      const data = typeof maybe.data === 'string' ? maybe.data.trim() : ''
      if (!mimeType || data.length === 0) {
        continue
      }

      normalized.push({
        type: 'binary',
        mimeType,
        data,
        fileName: fileName || undefined,
      })
      continue
    }

    const data = typeof maybe.data === 'string' ? maybe.data.trim() : ''
    if (!mimeType || !mimeType.startsWith('image/') || !data) {
      continue
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined,
    })
  }

  return normalized
}

function splitConversationHistory(
  messages: ConversationEntry[],
): { messages: ConversationHistoryEntry[]; activityMessages: AgentActivityEntry[] } {
  const conversationMessages: ConversationHistoryEntry[] = []
  const activityMessages: AgentActivityEntry[] = []

  for (const entry of messages) {
    if (entry.type === 'agent_message' || entry.type === 'agent_tool_call') {
      activityMessages.push(entry)
      continue
    }

    conversationMessages.push(entry)
  }

  return {
    messages: conversationMessages,
    activityMessages,
  }
}

function clampConversationHistory(messages: AgentActivityEntry[]): AgentActivityEntry[] {
  if (messages.length <= MAX_CLIENT_CONVERSATION_HISTORY) {
    return messages
  }

  return messages.slice(-MAX_CLIENT_CONVERSATION_HISTORY)
}

function normalizeAgentId(agentId: string | null | undefined): string | null {
  const trimmed = agentId?.trim()
  return trimmed ? trimmed : null
}
