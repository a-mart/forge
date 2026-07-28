import {
  BROWSER_AUTOMATION_OPERATIONS,
  type BrowserAutomationFailure,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserHostCapabilities,
  type BrowserHostLifecycleRequest,
  type BrowserHostLifecycleResponse,
  type BrowserSessionSnapshot,
  type BrowserTabSnapshot,
  type BrowserTargetAffinity,
} from '@forge/protocol'
import type {
  AutomaticBrowserFallbackReason,
  AutomaticExternalBrowserAdapter,
  BrowserMutationState,
  BrowserTargetAdapter,
  BrowserTargetExecution,
  BrowserTargetFailureMetadata,
  BrowserTargetSession,
  ExternalBrowserTargetAuthority,
  ExternalBrowserRevealResult,
} from './browser-target-adapter.js'
import { isAutomaticExternalBrowserAdapter } from './browser-target-adapter.js'

const MANAGED_ONLY_OPERATIONS = new Set<BrowserAutomationOperation>([
  'resize',
  'recordingStart',
  'recordingStop',
])

export interface AutomaticBrowserHostCapabilities extends BrowserHostCapabilities {
  targets: Readonly<Record<BrowserTargetAffinity, {
    available: boolean
    supportedOperations: readonly BrowserAutomationOperation[]
    physicalViewport: boolean
    recording: boolean
    reveal: boolean
  }>>
}

export interface AutomaticBrowserHostOptions {
  managedAdapter: BrowserTargetAdapter & { targetAffinity: 'managed-electron' }
  externalAdapter?: BrowserTargetAdapter
  /** Main-process allocation hook. It is intentionally private from renderer and wire callers. */
  ensureManagedTarget?: (
    request: BrowserAutomationRequest,
    options: { reuseExisting: boolean; preferredTabId: string | null },
  ) => Promise<string | null>
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  authorityBurst?: {
    initialIdleMs?: number
    incrementMs?: number
    maximumIdleMs?: number
  }
}

export type AutomaticBrowserRevealResult =
  | ({ targetAffinity: 'external-chrome' } & ExternalBrowserRevealResult)
  | { targetAffinity: 'managed-electron'; revealed: false; tabId: string; reason: 'embedded-target' }

interface SessionPolicyState {
  selectedTabId: string | null
  defaultTabId: string | null
}

interface AuthorityBurst {
  session: BrowserTargetSession
  authority: ExternalBrowserTargetAuthority
  operations: number
  timer: ReturnType<typeof setTimeout> | null
  pendingReleaseReason: 'idle' | 'operation-failed' | 'turn-ended' | Extract<BrowserHostLifecycleRequest, { kind: 'release-session' }>['reason'] | null
}

/**
 * The one Desktop browser host. Target affinity, Chrome acquisition, fallback,
 * no-replay, burst authority, reveal, and lifecycle policy do not escape this seam.
 */
export class AutomaticBrowserHost {
  private readonly managed: AutomaticBrowserHostOptions['managedAdapter']
  private readonly external?: BrowserTargetAdapter
  private readonly ensureManagedTarget?: AutomaticBrowserHostOptions['ensureManagedTarget']
  private readonly now: () => number
  private readonly setTimer: NonNullable<AutomaticBrowserHostOptions['setTimer']>
  private readonly clearTimer: NonNullable<AutomaticBrowserHostOptions['clearTimer']>
  private readonly initialIdleMs: number
  private readonly incrementMs: number
  private readonly maximumIdleMs: number
  private readonly targetAffinities = new Map<string, BrowserTargetAffinity>()
  private readonly targetOwners = new Map<string, { sessionKey: string; affinity: BrowserTargetAffinity }>()
  private readonly sessions = new Map<string, SessionPolicyState>()
  private readonly sessionQueues = new Map<string, Promise<void>>()
  private readonly bursts = new Map<string, AuthorityBurst>()
  private ownerEpoch = 0
  private destroyed = false

  constructor(options: AutomaticBrowserHostOptions) {
    this.managed = options.managedAdapter
    this.external = options.externalAdapter
    this.ensureManagedTarget = options.ensureManagedTarget
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.initialIdleMs = boundedDelay(options.authorityBurst?.initialIdleMs, 250)
    this.incrementMs = boundedDelay(options.authorityBurst?.incrementMs, 150)
    this.maximumIdleMs = Math.max(this.initialIdleMs, boundedDelay(options.authorityBurst?.maximumIdleMs, 1_000))
  }

  get capabilities(): AutomaticBrowserHostCapabilities {
    const managed = this.managed.capabilities
    const external = this.external?.capabilities
    return {
      protocolVersions: { minimum: 2, maximum: 2 },
      supportedOperations: [...BROWSER_AUTOMATION_OPERATIONS],
      maxResponseBytes: 5 * 1_024 * 1_024,
      features: {
        resize: managed.physicalViewport,
        recording: managed.recording,
        capturePage: true,
        downloadEvents: false,
        downloadArtifacts: false,
        downloadOpen: false,
      },
      targets: {
        'managed-electron': targetCapability(true, managed),
        'external-chrome': targetCapability(Boolean(external), external),
      },
    }
  }

  /** Records a locally materialized target before canonical state reconciliation catches up. */
  adoptTarget(tab: BrowserTabSnapshot): void {
    this.rememberTab(tab)
    const key = sessionKey(tab)
    const state = this.sessions.get(key) ?? { selectedTabId: null, defaultTabId: null }
    state.selectedTabId ??= tab.tabId
    state.defaultTabId ??= tab.tabId
    this.sessions.set(key, state)
  }

  /** Rehydrates private routing affinity from canonical protocol-v2 session state. */
  synchronizeSessions(snapshots: readonly BrowserSessionSnapshot[]): void {
    for (const snapshot of snapshots) {
      const key = sessionKey(snapshot)
      this.sessions.set(key, { selectedTabId: snapshot.activeTabId, defaultTabId: snapshot.defaultTabId })
      for (const tabId of [...this.targetAffinities.keys()]) {
        if (!tabId.startsWith(`${key}\u0000`)) continue
        this.targetAffinities.delete(tabId)
        const logicalTabId = tabId.slice(key.length + 1)
        if (this.targetOwners.get(logicalTabId)?.sessionKey === key) this.targetOwners.delete(logicalTabId)
      }
      for (const tab of snapshot.tabs) this.rememberTab(tab)
    }
  }

  perform(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    return this.serialize(sessionKey(request), async () => correlateCallerTab(request, await this.performSerialized(request)))
  }

  execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    return this.perform(request)
  }

  async handleLifecycle(request: BrowserHostLifecycleRequest): Promise<BrowserHostLifecycleResponse> {
    const session = { sessionAgentId: request.sessionAgentId, profileId: request.profileId }
    return this.serialize(sessionKey(session), async () => {
      try {
        if (request.kind === 'turn-ended') {
          await this.endTurn(session, request.turnId)
          return { ...request, ok: true }
        }
        await this.releaseSession(session, request.reason)
        return { ...request, ok: true }
      } catch (error) {
        return {
          requestId: request.requestId,
          sessionAgentId: request.sessionAgentId,
          profileId: request.profileId,
          hostId: request.hostId,
          hostGeneration: request.hostGeneration,
          kind: request.kind,
          ok: false,
          error: failureFromUnknown(error, 'Browser lifecycle cleanup failed.', 'cleanup'),
        }
      }
    })
  }

  async endTurn(session: BrowserTargetSession, turnId: string): Promise<void> {
    await this.releaseBurst(session, 'turn-ended')
    await Promise.all([
      this.managed.endTurn?.(session, turnId),
      this.external?.endTurn?.(session, turnId),
    ])
  }

  async releaseSession(session: BrowserTargetSession, reason: Extract<BrowserHostLifecycleRequest, { kind: 'release-session' }>['reason']): Promise<void> {
    await this.releaseBurst(session, reason)
    await Promise.all([
      this.managed.releaseSession?.(session, reason),
      this.external?.releaseSession?.(session, reason),
    ])
    const key = sessionKey(session)
    this.sessions.delete(key)
    for (const tabKey of [...this.targetAffinities.keys()]) {
      if (!tabKey.startsWith(`${key}\u0000`)) continue
      this.targetAffinities.delete(tabKey)
      const logicalTabId = tabKey.slice(key.length + 1)
      if (this.targetOwners.get(logicalTabId)?.sessionKey === key) this.targetOwners.delete(logicalTabId)
    }
  }

  revealTarget(session: BrowserTargetSession, tabId: string): Promise<AutomaticBrowserRevealResult> {
    return this.serialize(sessionKey(session), async () => {
      const affinity = this.targetAffinities.get(targetKey(session, tabId))
      if (affinity !== 'external-chrome') {
        return { targetAffinity: 'managed-electron', revealed: false, tabId, reason: 'embedded-target' }
      }
      const external = this.external
      if (!isAutomaticExternalBrowserAdapter(external)) {
        throw failureError('unsupported-operation', 'This Chrome target cannot be revealed.', false, {
          phase: 'execution', mutationState: 'not-started', fallbackReason: 'operation-unsupported',
        })
      }
      // Reveal never borrows operation authority. Close any active burst first;
      // the External adapter then reacquires this exact tab with bounded authority.
      await this.releaseBurst(session, 'idle')
      return { targetAffinity: 'external-chrome', ...await external.revealTarget(session, tabId) }
    })
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    const releases = [...this.bursts.entries()].map(([key, burst]) => this.releaseAndForgetBurst(key, burst, 'desktop-quit'))
    await Promise.allSettled(releases)
    await Promise.allSettled([
      this.managed.destroy?.(),
      this.external?.destroy?.(),
    ])
  }

  private async performSerialized(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    if (this.destroyed) return failureResponse(request, 'host-disconnected', 'Browser host is shutting down.', true)
    if (Date.parse(request.deadlineAt) <= this.now()) return failureResponse(request, 'timeout', 'Browser request deadline has elapsed.', true)

    const session = { sessionAgentId: request.sessionAgentId, profileId: request.profileId }
    const explicit = request.tabId !== null
    const explicitAffinity = request.tabId ? this.targetAffinities.get(targetKey(session, request.tabId)) : undefined
    if (explicit && !explicitAffinity) {
      const owner = request.tabId ? this.targetOwners.get(request.tabId) : undefined
      if (owner && owner.sessionKey !== sessionKey(session)) {
        return failureResponse(request, 'tab-session-mismatch', 'The browser tab belongs to another session.', false)
      }
      return failureResponse(request, 'tab-not-found', 'The browser target affinity is unavailable.', true, policyDetails({
        phase: 'discovery', mutationState: 'not-started', fallbackReason: 'no-eligible-target',
      }, false))
    }
    if (explicitAffinity) return this.performAtAffinity(request, explicitAffinity, true)

    const managedOnly = MANAGED_ONLY_OPERATIONS.has(request.operation)
    const state = this.sessions.get(sessionKey(session))
    const selectedTabId = request.operation === 'open' && !request.input.reuseExistingTab
      ? null
      : state?.selectedTabId ?? state?.defaultTabId ?? null
    const selectedAffinity = selectedTabId
      ? this.targetAffinities.get(targetKey(session, selectedTabId))
      : undefined

    if (managedOnly) return this.performManaged(request, selectedAffinity === 'managed-electron' ? selectedTabId : null)
    if (request.operation === 'status' && !selectedAffinity) return this.performManaged(request, null)
    if (request.operation === 'open' && request.input.reuseExistingTab && selectedAffinity === 'external-chrome') {
      const external = this.external
      if (isAutomaticExternalBrowserAdapter(external) && supports(external, request.operation)) {
        // A tabless open is an explicit re-selection boundary. Release any
        // completed burst before probing the uniquely focused eligible tab;
        // non-open operations continue to use exact sticky affinity.
        return this.performExternal(request, external, false, null, true, false, true)
      }
    }
    if (selectedAffinity) {
      const selectedRequest = { ...request, tabId: selectedTabId } as BrowserAutomationRequest
      return this.performAtAffinity(selectedRequest, selectedAffinity, false)
    }

    const external = this.external
    if (isAutomaticExternalBrowserAdapter(external) && supports(external, request.operation)) {
      return this.performExternal(request, external, false, null, request.operation === 'open' ? request.input.reuseExistingTab : true)
    }
    return this.performManaged(request, null)
  }

  private performAtAffinity(
    request: BrowserAutomationRequest,
    affinity: BrowserTargetAffinity,
    explicit: boolean,
  ): Promise<BrowserAutomationResponse> {
    if (affinity === 'managed-electron') return this.performManaged(request, request.tabId)
    const external = this.external
    if (!external || !supports(external, request.operation)) {
      return Promise.resolve(failureResponse(request, 'unsupported-operation', `Chrome targets do not support ${request.operation}.`, false, policyDetails({
        phase: 'discovery', mutationState: 'not-started', fallbackReason: 'operation-unsupported',
      }, false)))
    }
    if (!isAutomaticExternalBrowserAdapter(external)) return external.execute(request).then((response) => this.acceptResponse(request, response, 'external-chrome'))
    return this.performExternal(request, external, explicit, request.tabId, true)
  }

  private async performExternal(
    request: BrowserAutomationRequest,
    external: AutomaticExternalBrowserAdapter,
    explicit: boolean,
    preferredTabId: string | null,
    reuseExisting: boolean,
    dedicatedAttempt = false,
    forceReacquire = false,
  ): Promise<BrowserAutomationResponse> {
    const session = { sessionAgentId: request.sessionAgentId, profileId: request.profileId }
    const burstKey = sessionKey(session)
    let burst = this.bursts.get(burstKey)
    const canReuseBurst = !forceReacquire && Boolean(burst
      && burst.pendingReleaseReason === null
      && reuseExisting
      && (!preferredTabId || preferredTabId === burst.authority.tabId))
    if (burst && !canReuseBurst) {
      try {
        await this.releaseAndForgetBurst(burstKey, burst, burst.pendingReleaseReason ?? 'idle')
      } catch (error) {
        return failureResponse(request, 'host-disconnected', error instanceof Error ? error.message : 'Pending Chrome authority release failed.', true,
          policyDetails({ phase: 'cleanup', mutationState: 'not-started', fallbackReason: 'transport-disconnected' }, false))
      }
      burst = undefined
    }

    if (!burst) {
      const acquired = await external.acquireTarget({
        ...session,
        operation: request.operation,
        preferredTabId,
        reuseExisting,
        createIfNeeded: true,
        deadlineAt: Date.parse(request.deadlineAt),
        ownerEpoch: ++this.ownerEpoch,
      })
      if (!acquired.ok) {
        if (!explicit && acquired.metadata.mutationState === 'not-started') {
          if (!dedicatedAttempt && reuseExisting) {
            return this.performExternal(request, external, false, null, false, true)
          }
          return this.performManaged(request, null, acquired.metadata.fallbackReason)
        }
        return failureResponse(request, acquired.error.code, acquired.error.message, acquired.error.retryable, {
          ...acquired.error.details,
          ...policyDetails(acquired.metadata, false),
        })
      }
      burst = { session, authority: acquired.authority, operations: 0, timer: null, pendingReleaseReason: null }
      this.bursts.set(burstKey, burst)
    } else if (burst.timer) {
      this.clearTimer(burst.timer)
      burst.timer = null
    }

    const targeted = { ...request, tabId: burst.authority.tabId } as BrowserAutomationRequest
    let execution: BrowserTargetExecution
    try {
      execution = await external.executeWithAuthority({ authority: burst.authority, request: targeted })
    } catch (error) {
      execution = {
        response: failureResponse(targeted, 'host-disconnected', error instanceof Error ? error.message : 'Chrome transport disconnected.', true),
        failure: { phase: 'execution', mutationState: mutationDefault(request.operation), fallbackReason: 'transport-disconnected' },
      }
    }
    const response = this.acceptResponse(targeted, execution.response, 'external-chrome')
    if (response.ok) {
      burst.operations += 1
      this.scheduleBurstRelease(burst)
      return response
    }

    // Cleanup cannot replace the original no-replay operation result. If the
    // acknowledgement is lost, retain this exact authority and retry before any
    // later acquisition or lifecycle acknowledgement.
    await this.releaseAndForgetBurst(burstKey, burst, 'operation-failed').catch(() => undefined)
    const metadata = execution.failure ?? {
      phase: 'execution' as const,
      mutationState: mutationDefault(request.operation),
    }
    const terminal = withPolicyFailure(response, metadata, metadata.mutationState !== 'not-started')
    if (explicit || metadata.mutationState !== 'not-started') return terminal
    if (!dedicatedAttempt && reuseExisting) return this.performExternal(request, external, false, null, false, true)
    return this.performManaged(request, null, metadata.fallbackReason)
  }

  private async performManaged(
    request: BrowserAutomationRequest,
    preferredTabId: string | null,
    fallbackReason?: AutomaticBrowserFallbackReason,
  ): Promise<BrowserAutomationResponse> {
    if (!supports(this.managed, request.operation)) {
      return failureResponse(request, 'unsupported-operation', `Managed Browser does not support ${request.operation}.`, false)
    }
    let tabId = preferredTabId ?? request.tabId
    if (!tabId && request.operation !== 'status') {
      tabId = await this.ensureManagedTarget?.(request, {
        preferredTabId,
        reuseExisting: request.operation === 'open' ? request.input.reuseExistingTab : true,
      }) ?? null
    }
    const targeted = { ...request, tabId } as BrowserAutomationRequest
    const response = this.acceptResponse(targeted, await this.managed.execute(targeted), 'managed-electron')
    if (!response.ok && fallbackReason) {
      return withPolicyFailure(response, {
        phase: 'acquisition', mutationState: 'not-started', fallbackReason,
      }, false)
    }
    return response
  }

  private acceptResponse(
    request: BrowserAutomationRequest,
    response: BrowserAutomationResponse,
    affinity: BrowserTargetAffinity,
  ): BrowserAutomationResponse {
    if (response.requestId !== request.requestId
      || response.sessionAgentId !== request.sessionAgentId
      || response.profileId !== request.profileId
      || response.operation !== request.operation) {
      return failureResponse(request, 'malformed-response', 'Browser adapter response correlation failed.', false)
    }
    const tab = response.updatedTab ?? resultTab(response)
    if (tab) {
      if (tab.sessionAgentId !== request.sessionAgentId || tab.profileId !== request.profileId || tab.targetAffinity !== affinity) {
        return failureResponse(request, 'malformed-response', 'Browser adapter returned a mismatched target identity.', false)
      }
      this.rememberTab(tab)
      const state = this.sessions.get(sessionKey(request)) ?? { selectedTabId: null, defaultTabId: null }
      state.selectedTabId = tab.tabId
      state.defaultTabId ??= tab.tabId
      this.sessions.set(sessionKey(request), state)
    }
    return response
  }

  private rememberTab(tab: BrowserTabSnapshot): void {
    const key = sessionKey(tab)
    this.targetAffinities.set(targetKey(tab, tab.tabId), tab.targetAffinity)
    this.targetOwners.set(tab.tabId, { sessionKey: key, affinity: tab.targetAffinity })
  }

  private scheduleBurstRelease(burst: AuthorityBurst): void {
    if (burst.timer) this.clearTimer(burst.timer)
    const delay = Math.min(this.maximumIdleMs, this.initialIdleMs + Math.max(0, burst.operations - 1) * this.incrementMs)
    burst.timer = this.setTimer(() => {
      const key = sessionKey(burst.session)
      if (this.bursts.get(key) !== burst) return
      void this.releaseAndForgetBurst(key, burst, 'idle').catch(() => undefined)
    }, delay)
  }

  private async releaseBurst(
    session: BrowserTargetSession,
    reason: 'idle' | 'turn-ended' | Extract<BrowserHostLifecycleRequest, { kind: 'release-session' }>['reason'],
  ): Promise<void> {
    const key = sessionKey(session)
    const burst = this.bursts.get(key)
    if (!burst) return
    await this.releaseAndForgetBurst(key, burst, reason)
  }

  private async releaseAndForgetBurst(
    key: string,
    burst: AuthorityBurst,
    reason: 'idle' | 'operation-failed' | 'turn-ended' | Extract<BrowserHostLifecycleRequest, { kind: 'release-session' }>['reason'],
  ): Promise<void> {
    if (burst.timer) {
      this.clearTimer(burst.timer)
      burst.timer = null
    }
    burst.pendingReleaseReason ??= reason
    if (isAutomaticExternalBrowserAdapter(this.external)) {
      await this.external.releaseAuthority(burst.session, burst.authority, burst.pendingReleaseReason)
    }
    if (this.bursts.get(key) === burst) this.bursts.delete(key)
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.sessionQueues.set(key, settled)
    void settled.finally(() => {
      if (this.sessionQueues.get(key) === settled) this.sessionQueues.delete(key)
    })
    return result
  }
}

function targetCapability(available: boolean, capability?: BrowserTargetAdapter['capabilities']) {
  return {
    available,
    supportedOperations: capability?.supportedOperations ?? [],
    physicalViewport: capability?.physicalViewport ?? false,
    recording: capability?.recording ?? false,
    reveal: capability?.reveal ?? false,
  }
}

function supports(adapter: BrowserTargetAdapter, operation: BrowserAutomationOperation): boolean {
  return adapter.capabilities.supportedOperations.includes(operation)
}

function sessionKey(session: BrowserTargetSession): string {
  return `${session.profileId}\u0000${session.sessionAgentId}`
}

function targetKey(session: BrowserTargetSession, tabId: string): string {
  return `${sessionKey(session)}\u0000${tabId}`
}

function correlateCallerTab(
  request: BrowserAutomationRequest,
  response: BrowserAutomationResponse,
): BrowserAutomationResponse {
  return response.tabId === request.tabId ? response : { ...response, tabId: request.tabId } as BrowserAutomationResponse
}

function resultTab(response: BrowserAutomationResponse): BrowserTabSnapshot | undefined {
  if (!response.ok || (response.operation !== 'open' && response.operation !== 'navigate')) return undefined
  return response.result.tab
}

function boundedDelay(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! >= 0 && value! <= 60_000 ? value! : fallback
}

function mutationDefault(operation: BrowserAutomationOperation): BrowserMutationState {
  return operation === 'status' || operation === 'snapshot' || operation === 'waitFor' ? 'not-started' : 'possible'
}

function policyDetails(metadata: BrowserTargetFailureMetadata, noReplay: boolean): NonNullable<BrowserAutomationFailure['details']> {
  return {
    automaticPolicyPhase: metadata.phase,
    mutationState: metadata.mutationState,
    noReplay,
    ...(metadata.fallbackReason ? { fallbackReason: metadata.fallbackReason } : {}),
  }
}

function withPolicyFailure(
  response: Extract<BrowserAutomationResponse, { ok: false }>,
  metadata: BrowserTargetFailureMetadata,
  noReplay: boolean,
): BrowserAutomationResponse {
  return {
    ...response,
    error: {
      ...response.error,
      details: { ...response.error.details, ...policyDetails(metadata, noReplay) },
    },
  }
}

function failureResponse(
  request: BrowserAutomationRequest,
  code: BrowserAutomationFailure['code'],
  message: string,
  retryable: boolean,
  details?: BrowserAutomationFailure['details'],
): BrowserAutomationResponse {
  return {
    requestId: request.requestId,
    sessionAgentId: request.sessionAgentId,
    profileId: request.profileId,
    tabId: request.tabId,
    hostId: request.hostId,
    hostGeneration: request.hostGeneration,
    operation: request.operation,
    ok: false,
    error: { code, message, retryable, ...(details ? { details } : {}) },
    elapsedMs: 0,
  }
}

function failureFromUnknown(error: unknown, fallback: string, phase: BrowserTargetFailureMetadata['phase']): BrowserAutomationFailure {
  if (error && typeof error === 'object' && 'code' in error && 'retryable' in error) {
    const typed = error as BrowserAutomationFailure
    return typed
  }
  return {
    code: 'execution-failed',
    message: error instanceof Error ? error.message : fallback,
    retryable: true,
    details: policyDetails({ phase, mutationState: 'not-started' }, false),
  }
}

function failureError(
  code: BrowserAutomationFailure['code'],
  message: string,
  retryable: boolean,
  metadata: BrowserTargetFailureMetadata,
): Error & BrowserAutomationFailure {
  return Object.assign(new Error(message), { code, retryable, details: policyDetails(metadata, false) })
}
