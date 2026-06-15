import { randomUUID } from 'node:crypto'

import type {
  ChoiceAnswer,
  CliAgentShowResponse,
  CliAgentsListResponse,
  CliCapabilitiesResponse,
  CliChoiceRouteResult,
  CliChoiceShowResponse,
  CliChoicesListResponse,
  CliHeadlessReadyEvent,
  CliHttpErrorResponse,
  CliMessageDispatchResult,
  CliMessageTarget,
  CliProfileShowResponse,
  CliProfilesListResponse,
  CliProjectAgentShowResponse,
  CliProjectAgentsListResponse,
  CliRequestErrorEvent,
  CliRequestSuccessEvent,
  CliRunCommand,
  CliRunResult,
  CliRunTarget,
  CliSessionCreatedResult,
  CliSessionMutationCommand,
  CliSessionShowResponse,
  CliSessionsListResponse,
  CliStatusResponse,
  CliWsCommand,
  ServerEvent,
} from '@forge/protocol'
import { WebSocket } from 'ws'

import { CliError } from './output.js'
import { CLI_PROTOCOL_VERSION, EXIT_CODES } from './version.js'

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_DEBOUNCE_MS = 750
const MIN_POST_DISPATCH_MS = 1000

export interface ForgeClientOptions {
  url: string
  apiKey: string
  fetchImpl?: typeof fetch
  WebSocketImpl?: typeof WebSocket
}

export interface ChoiceListFilters {
  profileId?: string
  sessionAgentId?: string
}

export type ClientRunTarget =
  | { kind: 'new_session'; profileId: string; label?: string; name?: string }
  | { kind: 'session'; agentId: string }
  | { kind: 'project_agent'; profileId: string; handle: string }

export interface ClientMessageOptions {
  text: string
  delivery?: 'auto' | 'followUp' | 'steer'
}

export interface ClientCreateSessionOptions {
  profileId: string
  label?: string
  name?: string
  invocationCwd?: string
}

export interface ClientRunOptions extends ClientMessageOptions {
  target: ClientRunTarget
  label?: string
  invocationCwd?: string
  timeoutMs?: number
  stopOnTimeout?: boolean
  command: 'run' | 'launch'
}

export interface ClientWaitOptions {
  timeoutMs?: number
  stopOnTimeout?: boolean
}

export interface ForgeClientLike {
  getCapabilities(): Promise<CliCapabilitiesResponse>
  getStatus(): Promise<CliStatusResponse>
  listProfiles(): Promise<CliProfilesListResponse>
  showProfile(profileId: string): Promise<CliProfileShowResponse>
  listSessions(profileId: string): Promise<CliSessionsListResponse>
  showSession(agentId: string): Promise<CliSessionShowResponse>
  listAgents(profileId?: string): Promise<CliAgentsListResponse>
  showAgent(agentId: string): Promise<CliAgentShowResponse>
  listProjectAgents(profileId: string): Promise<CliProjectAgentsListResponse>
  showProjectAgent(profileId: string, handle: string): Promise<CliProjectAgentShowResponse>
  listChoices(filters?: ChoiceListFilters): Promise<CliChoicesListResponse>
  showChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceShowResponse>
  createSession(options: ClientCreateSessionOptions): Promise<CliSessionCreatedResult>
  sendSessionMessage(agentId: string, options: ClientMessageOptions): Promise<CliMessageDispatchResult>
  sendProjectAgentMessage(profileId: string, handle: string, options: ClientMessageOptions): Promise<CliMessageDispatchResult>
  launch(options: ClientRunOptions): Promise<CliMessageDispatchResult>
  run(options: ClientRunOptions): Promise<CliRunResult>
  waitForSession(agentId: string, options?: ClientWaitOptions): Promise<CliRunResult>
  stopSession(agentId: string): Promise<unknown>
  resumeSession(agentId: string): Promise<unknown>
  clearSession(agentId: string): Promise<unknown>
  deleteSession(agentId: string): Promise<unknown>
  renameSession(agentId: string, label: string): Promise<unknown>
  pinSession(agentId: string, pinned: boolean): Promise<unknown>
  forkSession(sourceAgentId: string, options?: { label?: string; fromMessageId?: string }): Promise<unknown>
  answerChoice(choiceId: string, answers: ChoiceAnswer[], sessionAgentId?: string): Promise<CliChoiceRouteResult>
  cancelChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceRouteResult>
}

export class ForgeClient implements ForgeClientLike {
  private readonly baseUrl: URL
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl: typeof WebSocket

  constructor(options: ForgeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.url)
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? fetch
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket
  }

  getCapabilities(): Promise<CliCapabilitiesResponse> {
    return this.get('capabilities')
  }

  getStatus(): Promise<CliStatusResponse> {
    return this.get('status')
  }

  listProfiles(): Promise<CliProfilesListResponse> {
    return this.get('profiles')
  }

  showProfile(profileId: string): Promise<CliProfileShowResponse> {
    return this.get(`profiles/${encodeURIComponent(profileId)}`)
  }

  listSessions(profileId: string): Promise<CliSessionsListResponse> {
    return this.get(`sessions?profileId=${encodeURIComponent(profileId)}`)
  }

  showSession(agentId: string): Promise<CliSessionShowResponse> {
    return this.get(`sessions/${encodeURIComponent(agentId)}`)
  }

  listAgents(profileId?: string): Promise<CliAgentsListResponse> {
    const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''
    return this.get(`agents${query}`)
  }

  showAgent(agentId: string): Promise<CliAgentShowResponse> {
    return this.get(`agents/${encodeURIComponent(agentId)}`)
  }

  listProjectAgents(profileId: string): Promise<CliProjectAgentsListResponse> {
    return this.get(`project-agents?profileId=${encodeURIComponent(profileId)}`)
  }

  showProjectAgent(profileId: string, handle: string): Promise<CliProjectAgentShowResponse> {
    return this.get(`project-agents/${encodeURIComponent(handle)}?profileId=${encodeURIComponent(profileId)}`)
  }

  listChoices(filters: ChoiceListFilters = {}): Promise<CliChoicesListResponse> {
    const params = new URLSearchParams()
    if (filters.sessionAgentId) params.set('sessionAgentId', filters.sessionAgentId)
    if (filters.profileId) params.set('profileId', filters.profileId)
    const query = params.size > 0 ? `?${params.toString()}` : ''
    return this.get(`choices${query}`)
  }

  showChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceShowResponse> {
    const query = sessionAgentId ? `?sessionAgentId=${encodeURIComponent(sessionAgentId)}` : ''
    return this.get(`choices/${encodeURIComponent(choiceId)}${query}`)
  }

  async createSession(options: ClientCreateSessionOptions): Promise<CliSessionCreatedResult> {
    await this.ensureFeatures(['headlessWs', 'cliSessionMetadata'])
    const connection = await this.openWsConnection()
    try {
      return await connection.request<CliSessionCreatedResult>({
        type: 'cli_create_session',
        requestId: randomUUID(),
        profileId: options.profileId,
        ...(options.label ? { label: options.label } : {}),
        ...(options.name ? { name: options.name } : {}),
        cli: buildCliMetadata('sessions create', options.invocationCwd, options.label),
      })
    } finally {
      connection.close()
    }
  }

  async sendSessionMessage(agentId: string, options: ClientMessageOptions): Promise<CliMessageDispatchResult> {
    await this.ensureFeatures(['headlessWs', 'cliSourceContext'])
    const connection = await this.openWsConnection()
    try {
      return await connection.request<CliMessageDispatchResult>({
        type: 'cli_send_message',
        requestId: randomUUID(),
        target: { kind: 'session', agentId },
        text: options.text,
        ...(options.delivery ? { delivery: options.delivery } : {}),
      })
    } finally {
      connection.close()
    }
  }

  async sendProjectAgentMessage(
    profileId: string,
    handle: string,
    options: ClientMessageOptions,
  ): Promise<CliMessageDispatchResult> {
    await this.ensureFeatures(['headlessWs', 'cliSourceContext', 'projectAgentRunTarget'])
    const connection = await this.openWsConnection()
    try {
      return await connection.request<CliMessageDispatchResult>({
        type: 'cli_send_message',
        requestId: randomUUID(),
        target: { kind: 'project_agent', profileId, handle },
        text: options.text,
        ...(options.delivery ? { delivery: options.delivery } : {}),
      })
    } finally {
      connection.close()
    }
  }

  async launch(options: ClientRunOptions): Promise<CliMessageDispatchResult> {
    await this.ensureFeatures(featuresForTarget(options.target))
    const connection = await this.openWsConnection()
    try {
      return await connection.request<CliMessageDispatchResult>(buildRunCommand(options))
    } finally {
      connection.close()
    }
  }

  async run(options: ClientRunOptions): Promise<CliRunResult> {
    await this.ensureFeatures(featuresForTarget(options.target))
    const connection = await this.openWsConnection()
    const startedAt = Date.now()
    let sessionAgentId: string | undefined
    try {
      const prepared = await this.prepareRunTarget(connection, options)
      sessionAgentId = prepared.sessionAgentId
      const tracker = new RunWaitTracker(prepared.ready, {
        startedAt,
        dispatchGateStartedAt: Date.now(),
        timeoutMs: options.timeoutMs,
        requirePostDispatch: true,
        projectAgentHandle: options.target.kind === 'project_agent' ? options.target.handle : null,
      })
      tracker.attach(connection)
      try {
        await connection.request<CliMessageDispatchResult>(prepared.dispatchCommand)
        const result = await tracker.wait()
        if (result.status === 'timeout' && options.stopOnTimeout) {
          await connection.request({ type: 'stop_session', requestId: randomUUID(), agentId: sessionAgentId })
        }
        return result
      } finally {
        tracker.detach()
      }
    } finally {
      connection.close()
    }
  }

  async waitForSession(agentId: string, options: ClientWaitOptions = {}): Promise<CliRunResult> {
    await this.ensureFeatures(['headlessWs', 'activeToolSnapshot', 'choiceOwnerLookup'])
    const connection = await this.openWsConnection()
    const startedAt = Date.now()
    try {
      const ready = await connection.subscribe(agentId)
      const tracker = new RunWaitTracker(ready, {
        startedAt,
        timeoutMs: options.timeoutMs,
        requirePostDispatch: false,
      })
      tracker.attach(connection)
      try {
        const result = await tracker.wait()
        if (result.status === 'timeout' && options.stopOnTimeout) {
          await connection.request({ type: 'stop_session', requestId: randomUUID(), agentId })
        }
        return result
      } finally {
        tracker.detach()
      }
    } finally {
      connection.close()
    }
  }

  stopSession(agentId: string): Promise<unknown> {
    return this.sessionMutation({ type: 'stop_session', requestId: randomUUID(), agentId })
  }

  resumeSession(agentId: string): Promise<unknown> {
    return this.sessionMutation({ type: 'resume_session', requestId: randomUUID(), agentId })
  }

  clearSession(agentId: string): Promise<unknown> {
    return this.sessionMutation({ type: 'clear_session', requestId: randomUUID(), agentId })
  }

  deleteSession(agentId: string): Promise<unknown> {
    return this.sessionMutation({ type: 'delete_session', requestId: randomUUID(), agentId })
  }

  renameSession(agentId: string, label: string): Promise<unknown> {
    return this.sessionMutation({ type: 'rename_session', requestId: randomUUID(), agentId, label })
  }

  pinSession(agentId: string, pinned: boolean): Promise<unknown> {
    return this.sessionMutation({ type: 'pin_session', requestId: randomUUID(), agentId, pinned })
  }

  forkSession(sourceAgentId: string, options: { label?: string; fromMessageId?: string } = {}): Promise<unknown> {
    return this.sessionMutation({
      type: 'fork_session',
      requestId: randomUUID(),
      sourceAgentId,
      ...(options.label ? { label: options.label } : {}),
      ...(options.fromMessageId ? { fromMessageId: options.fromMessageId } : {}),
    })
  }

  async answerChoice(choiceId: string, answers: ChoiceAnswer[], sessionAgentId?: string): Promise<CliChoiceRouteResult> {
    await this.ensureFeatures(['headlessWs', 'choiceOwnerLookup'])
    const ownerSessionAgentId = sessionAgentId ?? (await this.showChoice(choiceId)).choice.sessionAgentId
    const connection = await this.openWsConnection()
    try {
      return await connection.request<CliChoiceRouteResult>({
        type: 'cli_choice_response',
        requestId: randomUUID(),
        choiceId,
        sessionAgentId: ownerSessionAgentId,
        answers,
      })
    } finally {
      connection.close()
    }
  }

  async cancelChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceRouteResult> {
    await this.ensureFeatures(['headlessWs', 'choiceOwnerLookup'])
    const ownerSessionAgentId = sessionAgentId ?? (await this.showChoice(choiceId)).choice.sessionAgentId
    const connection = await this.openWsConnection()
    try {
      return await connection.request<CliChoiceRouteResult>({
        type: 'cli_choice_cancel',
        requestId: randomUUID(),
        choiceId,
        sessionAgentId: ownerSessionAgentId,
      })
    } finally {
      connection.close()
    }
  }

  private async sessionMutation(command: CliSessionMutationCommand): Promise<unknown> {
    await this.ensureFeatures(['headlessWs'])
    const connection = await this.openWsConnection()
    try {
      return await connection.request(command)
    } finally {
      connection.close()
    }
  }

  private async prepareRunTarget(
    connection: CliWsConnection,
    options: ClientRunOptions,
  ): Promise<{ sessionAgentId: string; ready: CliHeadlessReadyEvent; dispatchCommand: CliWsCommand & { requestId: string } }> {
    if (options.target.kind === 'new_session') {
      const cli = buildCliMetadata(options.command, options.invocationCwd, options.label)
      const created = await connection.request<CliSessionCreatedResult>({
        type: 'cli_create_session',
        requestId: randomUUID(),
        profileId: options.target.profileId,
        ...(options.target.label ? { label: options.target.label } : {}),
        ...(options.target.name ? { name: options.target.name } : {}),
        cli,
      })
      const ready = await connection.subscribe(created.session.agentId)
      return {
        sessionAgentId: created.session.agentId,
        ready,
        dispatchCommand: buildSendMessageCommand({ kind: 'session', agentId: created.session.agentId }, options, cli.runId),
      }
    }

    const sessionAgentId = options.target.kind === 'project_agent'
      ? (await this.showProjectAgent(options.target.profileId, options.target.handle)).projectAgent.agentId
      : options.target.agentId
    const ready = await connection.subscribe(sessionAgentId)
    return {
      sessionAgentId,
      ready,
      dispatchCommand: buildRunCommand(options),
    }
  }

  private async ensureFeatures(features: Array<keyof CliStatusResponse['capabilities']['features']>): Promise<void> {
    const status = await this.getStatus()
    assertSupportedCapabilities(status)
    for (const feature of features) {
      if (!status.capabilities.features[feature]) {
        throw new CliError(`Forge server does not support required CLI capability: ${feature}`, {
          exitCode: EXIT_CODES.unsupported,
          code: 'unsupported_capability',
          details: { feature },
        })
      }
    }
  }

  private async openWsConnection(): Promise<CliWsConnection> {
    const connection = new CliWsConnection(buildCliWsUrl(this.baseUrl), this.apiKey, this.WebSocketImpl)
    await connection.open()
    return connection
  }

  private async get<T>(path: string): Promise<T> {
    const url = new URL(`/api/cli/${path}`, this.baseUrl)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
      })
    } catch (error) {
      throw new CliError(`Could not connect to Forge at ${this.baseUrl.origin}: ${redactSecret(errorMessage(error), this.apiKey)}`, {
        exitCode: EXIT_CODES.connection,
        code: 'connection_failed',
      })
    }

    if (!response.ok) {
      const errorPayload = await readErrorPayload(response)
      const message = errorPayload?.error.message ?? `Forge request failed with HTTP ${response.status}`
      const code = errorPayload?.error.code ?? `http_${response.status}`
      throw new CliError(redactSecret(message, this.apiKey), {
        exitCode: mapHttpErrorExitCode(response.status, code),
        code,
        details: { status: response.status },
      })
    }

    try {
      return (await response.json()) as T
    } catch (error) {
      throw new CliError(`Forge returned invalid JSON: ${errorMessage(error)}`, {
        exitCode: EXIT_CODES.connection,
        code: 'invalid_json',
      })
    }
  }
}

export function assertSupportedCapabilities(response: CliCapabilitiesResponse | CliStatusResponse): void {
  const capabilities = response.capabilities
  if (!capabilities.available) {
    throw new CliError('Forge CLI API is not available on this server.', {
      exitCode: EXIT_CODES.unsupported,
      code: 'cli_unavailable',
    })
  }
  if (capabilities.protocolVersion !== CLI_PROTOCOL_VERSION) {
    throw new CliError(`Unsupported Forge CLI protocol version: ${capabilities.protocolVersion}`, {
      exitCode: EXIT_CODES.unsupported,
      code: 'unsupported_protocol',
    })
  }
  if (!capabilities.features.bearerAuth) {
    throw new CliError('Forge server does not advertise CLI bearer authentication.', {
      exitCode: EXIT_CODES.unsupported,
      code: 'missing_bearer_auth',
    })
  }
}

export function normalizeBaseUrl(value: string): URL {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new CliError('Forge URL is required.', { exitCode: EXIT_CODES.usage, code: 'missing_url' })
  }

  const httpUrl = trimmed.startsWith('ws://')
    ? `http://${trimmed.slice('ws://'.length)}`
    : trimmed.startsWith('wss://')
      ? `https://${trimmed.slice('wss://'.length)}`
      : trimmed

  try {
    const url = new URL(httpUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol ${url.protocol}`)
    }
    return url
  } catch (error) {
    throw new CliError(`Invalid Forge URL: ${errorMessage(error)}`, { exitCode: EXIT_CODES.usage, code: 'invalid_url' })
  }
}

class CliWsConnection {
  private socket: WebSocket | null = null
  private manualClosing = false
  private readonly listeners = new Set<(event: ServerEvent) => void>()
  private readonly disconnectListeners = new Set<(error: CliError) => void>()
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()

  constructor(
    private readonly url: URL,
    private readonly apiKey: string,
    private readonly WebSocketImpl: typeof WebSocket,
  ) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.url, { headers: { authorization: `Bearer ${this.apiKey}` } })
      this.socket = socket
      const onError = (error: Error) => {
        reject(new CliError(`Could not open CLI WebSocket: ${redactSecret(error.message, this.apiKey)}`, {
          exitCode: EXIT_CODES.connection,
          code: 'ws_connection_failed',
        }))
      }
      socket.once('open', () => {
        socket.off('error', onError)
        socket.on('message', (raw) => this.handleMessage(raw.toString()))
        socket.on('close', () => this.handleDisconnect('CLI WebSocket closed.'))
        socket.on('error', (error) => this.handleDisconnect(`CLI WebSocket error: ${redactSecret(error.message, this.apiKey)}`))
        resolve()
      })
      socket.once('error', onError)
    })
  }

  close(): void {
    this.manualClosing = true
    this.socket?.close()
    this.socket = null
  }

  request<T = unknown>(command: CliWsCommand & { requestId: string }): Promise<T> {
    const socket = this.requireOpenSocket()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(command.requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      socket.send(JSON.stringify(command), (error) => {
        if (error) {
          this.pending.delete(command.requestId)
          reject(new CliError(`Could not send CLI WebSocket command: ${redactSecret(error.message, this.apiKey)}`, {
            exitCode: EXIT_CODES.connection,
            code: 'ws_send_failed',
          }))
        }
      })
    })
  }

  subscribe(agentId: string): Promise<CliHeadlessReadyEvent> {
    const requestId = randomUUID()
    const readyPromise = this.waitForEvent<CliHeadlessReadyEvent>(
      (event): event is CliHeadlessReadyEvent => event.type === 'headless_ready' && event.requestId === requestId,
      10_000,
    )
    this.requireOpenSocket().send(JSON.stringify({ type: 'subscribe_headless', requestId, agentId }))
    return readyPromise
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onDisconnect(listener: (error: CliError) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  private waitForEvent<T extends ServerEvent>(predicate: (event: ServerEvent) => event is T, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let unsubscribeEvent: (() => void) | null = null
      let unsubscribeDisconnect: (() => void) | null = null
      const cleanup = () => {
        clearTimeout(timeout)
        unsubscribeEvent?.()
        unsubscribeDisconnect?.()
        unsubscribeEvent = null
        unsubscribeDisconnect = null
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new CliError('Timed out waiting for CLI WebSocket subscription.', {
          exitCode: EXIT_CODES.connection,
          code: 'ws_subscription_timeout',
        }))
      }, timeoutMs)
      unsubscribeEvent = this.onEvent((event) => {
        if (predicate(event)) {
          cleanup()
          resolve(event)
        }
      })
      unsubscribeDisconnect = this.onDisconnect((error) => {
        cleanup()
        reject(error)
      })
    })
  }

  private handleMessage(raw: string): void {
    let event: ServerEvent
    try {
      event = JSON.parse(raw) as ServerEvent
    } catch {
      return
    }

    if (event.type === 'cli_request_success') {
      this.resolveRequest(event)
    } else if (event.type === 'cli_request_error') {
      this.rejectRequest(event)
    }

    for (const listener of [...this.listeners]) listener(event)
  }

  private resolveRequest(event: CliRequestSuccessEvent): void {
    const pending = this.pending.get(event.requestId)
    if (!pending) return
    this.pending.delete(event.requestId)
    pending.resolve(event.result)
  }

  private rejectRequest(event: CliRequestErrorEvent): void {
    if (!event.requestId) return
    const pending = this.pending.get(event.requestId)
    if (!pending) return
    this.pending.delete(event.requestId)
    pending.reject(new CliError(event.message, {
      exitCode: mapCliRequestErrorExitCode(event),
      code: event.code,
      details: { status: event.status, fieldErrors: event.fieldErrors },
    }))
  }

  private handleDisconnect(message: string): void {
    const error = new CliError(message, { exitCode: EXIT_CODES.connection, code: 'ws_closed' })
    this.rejectPending(error)
    if (!this.manualClosing) {
      for (const listener of [...this.disconnectListeners]) listener(error)
    }
  }

  private rejectPending(error: CliError): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId)
      pending.reject(error)
    }
  }

  private requireOpenSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new CliError('CLI WebSocket is not open.', { exitCode: EXIT_CODES.connection, code: 'ws_not_open' })
    }
    return this.socket
  }
}

class RunWaitTracker {
  private readonly startedAt: number
  private readonly timeoutMs: number
  private readonly requirePostDispatch: boolean
  private readonly dispatchGateStartedAt: number
  private readonly sessionAgentId: string
  private readonly projectAgentHandle: string | null
  private profileId: string | undefined
  private managerStatus = 'idle'
  private pendingCount = 0
  private workers = new Map<string, { status: string }>()
  private activeTools = 0
  private pendingChoices: NonNullable<CliHeadlessReadyEvent['pendingChoices']> = []
  private finalMessage: string | null = null
  private observedPostDispatchActivity = false
  private quiescentSince: number | null = null
  private disconnectedError: CliError | null = null
  private wakeWaiters = new Set<() => void>()
  private unsubscribe: (() => void) | null = null
  private unsubscribeDisconnect: (() => void) | null = null

  constructor(
    ready: CliHeadlessReadyEvent,
    options: {
      startedAt: number
      dispatchGateStartedAt?: number
      timeoutMs?: number
      requirePostDispatch: boolean
      projectAgentHandle?: string | null
    },
  ) {
    this.startedAt = options.startedAt
    this.dispatchGateStartedAt = options.dispatchGateStartedAt ?? options.startedAt
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    this.requirePostDispatch = options.requirePostDispatch
    this.projectAgentHandle = options.projectAgentHandle ?? null
    this.sessionAgentId = ready.subscribed.agentId ?? ready.targetAgent?.agentId ?? ''
    this.profileId = ready.subscribed.profileId ?? ready.profile?.profileId ?? ready.targetAgent?.profileId
    this.managerStatus = ready.status?.status ?? ready.targetAgent?.status ?? 'idle'
    this.pendingCount = ready.status?.pendingCount ?? 0
    this.activeTools = ready.activeTools?.length ?? 0
    this.pendingChoices = ready.pendingChoices ?? []
    this.workers = new Map((ready.workers ?? []).map((worker) => [worker.agentId, { status: worker.status }]))
  }

  async wait(): Promise<CliRunResult> {
    const start = Date.now()
    while (true) {
      if (this.disconnectedError) throw this.disconnectedError
      const now = Date.now()
      const blocked = this.pendingChoices.filter((choice) => choice.status === 'pending')
      if (blocked.length > 0) {
        return this.result('blocked', now, { reason: 'pending_choice', choices: blocked }, false)
      }
      if (this.managerStatus === 'error') return this.result('agent_failure', now, null, false)
      if (this.managerStatus === 'stopped' || this.managerStatus === 'terminated') return this.result('canceled', now, null, false)
      if (now - start >= this.timeoutMs) return this.result('timeout', now, null, true)

      if (this.isQuiescent(now)) {
        const quiescentSince = this.quiescentSince ?? now
        this.quiescentSince = quiescentSince
        if (now - quiescentSince >= DEFAULT_DEBOUNCE_MS) {
          return this.result('success', now, null, false)
        }
      } else {
        this.quiescentSince = null
      }

      await this.sleepUntilActivity(50)
    }
  }

  attach(connection: CliWsConnection): void {
    this.unsubscribe = connection.onEvent((event) => this.apply(event))
    this.unsubscribeDisconnect = connection.onDisconnect((error) => {
      this.disconnectedError = error
      this.wake()
    })
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribeDisconnect?.()
    this.unsubscribe = null
    this.unsubscribeDisconnect = null
  }

  private apply(event: ServerEvent): void {
    switch (event.type) {
      case 'agent_status':
        if (event.agentId === this.sessionAgentId) {
          this.managerStatus = event.status
          this.pendingCount = event.pendingCount
        } else if (event.managerId === this.sessionAgentId) {
          this.workers.set(event.agentId, { status: event.status })
        }
        this.markActivity()
        return

      case 'session_workers_snapshot':
        if (event.sessionAgentId === this.sessionAgentId) {
          this.workers = new Map(event.workers.map((worker) => [worker.agentId, { status: worker.status }]))
          this.markActivity()
        }
        return

      case 'session_active_tools_snapshot':
        if (event.sessionAgentId === this.sessionAgentId) {
          this.activeTools = event.activeTools.length
          this.markActivity()
        }
        return

      case 'cli_pending_choices_snapshot':
        if (event.sessionAgentId === this.sessionAgentId) {
          this.pendingChoices = event.choices
          this.markActivity()
        }
        return

      case 'conversation_message':
        if (event.agentId === this.sessionAgentId && event.role === 'assistant') {
          this.finalMessage = event.text
        }
        this.markActivity()
        return

      case 'conversation_log':
      case 'agent_tool_call':
      case 'agent_message':
      case 'choice_request':
      case 'work_plan_created':
      case 'model_cache_observation':
        this.markActivity()
    }
  }

  private isQuiescent(now: number): boolean {
    const dispatchGateOpen = !this.requirePostDispatch || this.observedPostDispatchActivity || now - this.dispatchGateStartedAt >= MIN_POST_DISPATCH_MS
    return (
      dispatchGateOpen &&
      this.managerStatus === 'idle' &&
      this.pendingCount === 0 &&
      this.activeTools === 0 &&
      this.pendingChoices.filter((choice) => choice.status === 'pending').length === 0 &&
      [...this.workers.values()].every((worker) => worker.status !== 'streaming')
    )
  }

  private markActivity(): void {
    this.observedPostDispatchActivity = true
    this.quiescentSince = null
    this.wake()
  }

  private sleepUntilActivity(ms: number): Promise<void> {
    if (this.disconnectedError) return Promise.resolve()
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timeout)
        this.wakeWaiters.delete(wake)
        resolve()
      }
      const timeout = setTimeout(wake, ms)
      this.wakeWaiters.add(wake)
    })
  }

  private wake(): void {
    const waiters = [...this.wakeWaiters]
    this.wakeWaiters.clear()
    for (const waiter of waiters) waiter()
  }

  private result(
    status: CliRunResult['status'],
    now: number,
    blocked: CliRunResult['blocked'],
    timedOut: boolean,
  ): CliRunResult {
    return {
      status,
      sessionAgentId: this.sessionAgentId,
      profileId: this.profileId,
      projectAgentHandle: this.projectAgentHandle,
      finalMessage: this.finalMessage,
      blocked,
      timedOut,
      durationMs: now - this.startedAt,
    }
  }
}

async function readErrorPayload(response: Response): Promise<CliHttpErrorResponse | null> {
  try {
    return (await response.json()) as CliHttpErrorResponse
  } catch {
    return null
  }
}

function buildCliWsUrl(baseUrl: URL): URL {
  const wsUrl = new URL('/api/cli/ws', baseUrl)
  wsUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return wsUrl
}

function buildRunCommand(options: ClientRunOptions): CliRunCommand {
  return {
    type: 'cli_run',
    requestId: randomUUID(),
    target: toCliRunTarget(options.target),
    text: options.text,
    ...(options.delivery ? { delivery: options.delivery } : {}),
    cli: buildCliMetadata(options.command, options.invocationCwd, options.label),
  }
}

function buildSendMessageCommand(
  target: CliMessageTarget,
  options: ClientMessageOptions,
  requestId = randomUUID(),
): CliWsCommand & { requestId: string } {
  return {
    type: 'cli_send_message',
    requestId,
    target,
    text: options.text,
    ...(options.delivery ? { delivery: options.delivery } : {}),
  }
}

function toCliRunTarget(target: ClientRunTarget): CliRunTarget {
  if (target.kind === 'new_session') {
    return {
      kind: 'new_session',
      profileId: target.profileId,
      ...(target.label ? { label: target.label } : {}),
      ...(target.name ? { name: target.name } : {}),
    }
  }
  if (target.kind === 'project_agent') {
    return { kind: 'project_agent', profileId: target.profileId, handle: target.handle }
  }
  return { kind: 'session', agentId: target.agentId }
}

function buildCliMetadata(command: 'run' | 'launch' | 'sessions create', invocationCwd?: string, label?: string) {
  return {
    createdBy: 'forge-cli' as const,
    runId: randomUUID(),
    command,
    startedAt: new Date().toISOString(),
    ...(invocationCwd ? { invocationCwd } : {}),
    ...(label ? { label } : {}),
  }
}

function featuresForTarget(target: ClientRunTarget): Array<keyof CliStatusResponse['capabilities']['features']> {
  const features: Array<keyof CliStatusResponse['capabilities']['features']> = [
    'headlessWs',
    'cliSourceContext',
    'cliSessionMetadata',
    'activeToolSnapshot',
    'choiceOwnerLookup',
  ]
  if (target.kind === 'project_agent') features.push('projectAgentRunTarget')
  return features
}

function mapHttpErrorExitCode(status: number, code: string) {
  if (status === 401 || isAuthErrorCode(code)) return EXIT_CODES.auth
  if (status >= 400 && status < 500) return EXIT_CODES.usage
  return EXIT_CODES.connection
}

function mapCliRequestErrorExitCode(event: CliRequestErrorEvent) {
  if (event.status === 401 || isAuthErrorCode(event.code)) return EXIT_CODES.auth
  if (event.code === 'unsupported_command' || event.code === 'unsupported_target') return EXIT_CODES.unsupported
  if (event.status && event.status >= 400 && event.status < 500) return EXIT_CODES.usage
  return EXIT_CODES.connection
}

function isAuthErrorCode(code: string): boolean {
  return code === 'missing_authorization' || code === 'malformed_authorization' || code === 'invalid_token' || code === 'revoked_token'
}

function redactSecret(message: string, secret: string): string {
  if (!secret) return message
  return message.split(secret).join('<redacted>')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
