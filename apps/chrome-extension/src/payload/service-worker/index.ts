import {
  EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
  EXTERNAL_CHROME_MAX_NEGOTIATED_MESSAGE_BYTES,
  EXTERNAL_CHROME_REOBSERVE_REQUIRED_DETAILS,
  externalChromeControlCollisionDetails,
  isExternalChromeControlCollisionDetails,
  parseExternalChromeJsonRpcFrame,
  type BrowserAutomationResultByOperation,
  type BrowserTabSnapshot,
  type ExternalChromeExecuteParams,
  type ExternalChromeJsonRpcMessage,
  type ExternalChromeRequest,
} from '@forge/protocol'
import {
  DebuggerAttachConflictError,
  DebuggerAttachmentLimitError,
  DebuggerController,
  DebuggerIdentityLossError,
} from '../../runtime/debugger-controller.js'
import {
  ControlSessionManager,
  type ControlSessionScheduler,
  type PhysicalDebuggerDetachReason,
} from '../../runtime/control-session-manager.js'
import { installedChrome, type ChromeApi, type ChromeRuntimePort, type ChromeRuntimeSender, type ChromeTab } from '../../runtime/chrome-api.js'
import { PAYLOAD_VERSION } from '../../runtime/identity.js'
import type { SyntheticTrustedEventSignature } from '../../runtime/human-control.js'
import { LeaseError, LeaseManager, type TabAuthorityRecord } from '../../runtime/lease-manager.js'
import { NativeRpcClient } from '../../runtime/native-rpc-client.js'
import { ExternalChromeOperationExecutor } from '../../runtime/operation-executor.js'
import { compactSnapshotForJsonRpc } from '../../runtime/snapshot-compaction.js'
import { restrictedTargetReason } from '../../runtime/restricted-target.js'
import type { ServiceWorkerPayload, ShellEventName, VerifiedPayloadIdentity } from '../../shell/service-worker-bootstrap.js'
import { loadVerifiedPayloadSelector } from '../../shell/selector.js'

const INSTANCE_KEY = 'forge.externalChrome.instanceId.v1'
const HEARTBEAT_ALARM = 'forge.externalChrome.heartbeat.v2'
const TRANSPORT_GRACE_ALARM = 'forge.externalChrome.transportGrace.v2'
const CLEANUP_RETRY_ALARM = 'forge.externalChrome.cleanupRetry.v1'
const TRANSPORT_GRACE_DELAY_MINUTES = 0.5
const MAX_CONTENT_BRIDGES = 512
const MAX_CONTENT_BRIDGES_PER_TAB = 64
const MAX_PENDING_CLOSED_TAB_RECEIPTS = 128

type ContentPort = ChromeRuntimePort & { sender?: ChromeRuntimeSender }

interface ContentBridgeRecord {
  key: string
  tabId: number
  frameId: number
  documentId: string
  port: ContentPort
  ready: boolean
}

export interface RuntimeOptions {
  chrome?: ChromeApi
  now?: () => number
  scheduler?: ControlSessionScheduler
  debuggerIdleTimeoutMs?: number
  debuggerMaximumLifetimeMs?: number
  maximumDebuggerAttachments?: number
}

export interface RuntimeDiagnostics {
  authorities: Array<{ tabId: number; state: TabAuthorityRecord['state']; ownerId: string; ownerEpoch: number }>
  debuggerSessions: ReturnType<ControlSessionManager['all']>
  debuggerMetrics: ReturnType<ControlSessionManager['metrics']>
  bridges: {
    active: number
    maximumObserved: number
    connected: number
    disconnected: number
    duplicatesRejected: number
    boundRejections: number
  }
  cleanup: {
    attempts: number
    failures: number
    retries: number
    completed: number
    pendingClosedTabReceipts: number
  }
}

interface Deferred<Value> {
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
}

interface InitialNavigationTransition {
  dispatchStarted: boolean
  commitStarted: boolean
  documentId: string | null
  authorityCurrent(): boolean
  completeAuthority(): Promise<void>
  committed: Deferred<ChromeTab>
  domContentLoaded: Deferred<ChromeTab>
  completed: Deferred<ChromeTab>
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

function chromeVersion(): string { return /Chrom(?:e|ium)\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? 'unknown' }
function acquiredTab(tab: ChromeTab): Record<string, unknown> {
  return { tabId: tab.id ?? 0, title: tab.title ?? '', url: tab.url ?? tab.pendingUrl ?? '', active: tab.active === true }
}

export class Runtime implements ServiceWorkerPayload {
  private readonly chrome: ChromeApi
  private readonly now: () => number
  private readonly authorities: LeaseManager
  private readonly debuggers: DebuggerController
  private readonly controlSessions: ControlSessionManager
  private readonly operations: ExternalChromeOperationExecutor
  private readonly contentBridges = new Map<string, ContentBridgeRecord>()
  private readonly bridgeKeysByTab = new Map<number, Set<string>>()
  private readonly syntheticAcknowledgements = new Map<string, {
    pending: Set<ContentPort>
    controlEpoch: number
    resolve: () => void
    reject: (error: Error) => void
  }>()
  private readonly activeOperations = new Map<number, Promise<void>>()
  private readonly initialNavigations = new Map<number, InitialNavigationTransition>()
  private readonly pendingClosedTabReceipts = new Set<number>()
  private readonly humanInterruptedOperations = new Map<number, number>()
  private native: NativeRpcClient | null = null
  private directory = ''
  private extensionInstanceId = ''
  private acceptingOperations = true
  private maximumObservedBridges = 0
  private bridgesConnected = 0
  private bridgesDisconnected = 0
  private bridgeDuplicatesRejected = 0
  private bridgeBoundRejections = 0
  private cleanupAttempts = 0
  private cleanupFailures = 0
  private cleanupRetries = 0
  private cleanupCompleted = 0
  private terminalCleanupTail: Promise<void> = Promise.resolve()
  private authorityRequestTail: Promise<void> = Promise.resolve()

  constructor(options: RuntimeOptions = {}) {
    this.chrome = options.chrome ?? installedChrome()
    this.now = options.now ?? Date.now
    this.authorities = new LeaseManager(this.chrome, PAYLOAD_VERSION, this.now)
    this.debuggers = new DebuggerController(this.chrome.debugger, options.maximumDebuggerAttachments, this.now)
    this.operations = new ExternalChromeOperationExecutor(this.debuggers, (tabId) => this.chrome.tabs.get(tabId), this.now)
    this.controlSessions = new ControlSessionManager(this.debuggers, {
      now: this.now,
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.debuggerIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.debuggerIdleTimeoutMs }),
      ...(options.debuggerMaximumLifetimeMs === undefined ? {} : { maximumLifetimeMs: options.debuggerMaximumLifetimeMs }),
      onExpiry: async (tabId, reason) => { await this.expirePhysicalSession(tabId, reason) },
    })
  }

  diagnostics(): RuntimeDiagnostics {
    return {
      authorities: this.authorities.all().map(({ tabId, state, ownerId, ownerEpoch }) => ({ tabId, state, ownerId, ownerEpoch })),
      debuggerSessions: this.controlSessions.all(),
      debuggerMetrics: this.controlSessions.metrics(),
      bridges: {
        active: this.contentBridges.size,
        maximumObserved: this.maximumObservedBridges,
        connected: this.bridgesConnected,
        disconnected: this.bridgesDisconnected,
        duplicatesRejected: this.bridgeDuplicatesRejected,
        boundRejections: this.bridgeBoundRejections,
      },
      cleanup: {
        attempts: this.cleanupAttempts,
        failures: this.cleanupFailures,
        retries: this.cleanupRetries,
        completed: this.cleanupCompleted,
        pendingClosedTabReceipts: this.pendingClosedTabReceipts.size,
      },
    }
  }

  async initialize(identity: VerifiedPayloadIdentity): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(identity.sha256) || identity.directory !== `${PAYLOAD_VERSION}-${identity.sha256}`) throw new Error('invalid immutable payload identity')
    this.directory = identity.directory
    const stored = await this.chrome.storage.local.get(INSTANCE_KEY)
    this.extensionInstanceId = typeof stored[INSTANCE_KEY] === 'string' ? String(stored[INSTANCE_KEY]) : crypto.randomUUID()
    if (stored[INSTANCE_KEY] !== this.extensionInstanceId) await this.chrome.storage.local.set({ [INSTANCE_KEY]: this.extensionInstanceId })
    const recovered = await this.authorities.recover()
    // Recovery restores only CAS ownership. Prove and release any debugger control that
    // survived a service-worker crash; never adopt a foreign debugger.
    const recoveredTerminalOwners = new Map<string, TabAuthorityRecord>()
    for (const authority of recovered) {
      const physical = await this.debuggers.reconcileForRelease(authority.tabId, this.chrome.runtime.id)
      if (physical === 'owned') await this.debuggers.reset(authority.tabId)
      if (physical === 'foreign') await this.authorities.markLost(authority.tabId)
      if ((authority.state === 'lost' || physical === 'foreign') && this.debuggers.state(authority.tabId) === 'UNATTACHED') {
        recoveredTerminalOwners.set(`${authority.ownerId}\0${authority.ownerEpoch}`, authority)
      }
    }
    for (const authority of recoveredTerminalOwners.values()) {
      await this.terminateOwner(authority.ownerId, authority.ownerEpoch, 'identity-loss')
    }
    this.chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 })
    this.native = new NativeRpcClient({
      connect: (host) => this.chrome.runtime.connectNative(host),
      extensionInstanceId: this.extensionInstanceId,
      chromeVersion: chromeVersion(),
      payloadSha256: identity.sha256,
      onDisconnected: () => {
        this.chrome.alarms.create(TRANSPORT_GRACE_ALARM, { delayInMinutes: TRANSPORT_GRACE_DELAY_MINUTES })
        // Transport uncertainty revokes synthetic authority and physically detaches immediately;
        // the alarm remains only a durable retry edge if MV3 suspends this worker.
        void this.serializeAuthorityWork(() => this.terminateAll('transport-uncertain')).catch(() => undefined)
        this.native?.reconnectNow()
      },
      onConnected: () => {
        void this.chrome.alarms.clear(TRANSPORT_GRACE_ALARM)
        // A complete snapshot is ordered after any disconnect cleanup and before a newly
        // reconnected Desktop can reconcile an interrupted pre-acquisition journal.
        void this.serializeAuthorityWork(async () => { this.reportAuthoritySnapshot() }).catch(() => undefined)
        if (this.pendingClosedTabReceipts.size > 0) void this.retryClosedTabReceipts().catch(() => undefined)
      },
      onRequest: (message) => this.handleDesktopRequest(message),
    })
    this.native.start()
  }

  onShellEvent(name: ShellEventName, args: unknown[]): unknown {
    switch (name) {
      case 'runtime.connect': this.handleConnect(args[0]); return undefined
      case 'debugger.event': void this.handleDebuggerEvent(args).catch(() => undefined); return undefined
      case 'debugger.detach': void this.handleDebuggerDetach(args).catch(() => undefined); return undefined
      case 'tab.removed': void this.handleTabRemoved(args[0]).catch(() => undefined); return undefined
      case 'navigation.committed': void this.handleNavigationCommitted(args[0]).catch(() => undefined); return undefined
      case 'navigation.domContentLoaded': void this.handleNavigationMilestone(args[0], 'domContentLoaded').catch(() => undefined); return undefined
      case 'navigation.completed': void this.handleNavigationMilestone(args[0], 'completed').catch(() => undefined); return undefined
      case 'alarm': {
        const alarm = args[0] as { name?: string } | undefined
        if (alarm?.name === HEARTBEAT_ALARM) void this.expireAuthorities().catch(() => undefined)
        if (alarm?.name === CLEANUP_RETRY_ALARM) void this.retryClosedTabReceipts().catch(() => undefined)
        if (alarm?.name === TRANSPORT_GRACE_ALARM && this.native?.isConnected() !== true) {
          // A suspended MV3 worker can lose NativeRpcClient's in-memory retry timer.
          // The durable alarm is the recovery edge after Desktop closes an old epoch.
          this.native?.stop()
          this.native?.start()
          void this.serializeAuthorityWork(() => this.terminateAll('transport-uncertain')).catch(() => undefined)
        }
        return undefined
      }
      case 'runtime.message': {
        const respond = args[2] as ((value: unknown) => void) | undefined
        respond?.({ ok: false, error: { code: 'invalid-params', message: 'External Chrome attaches automatically.' } })
        return true
      }
      default: return undefined
    }
  }

  async shutdown(): Promise<void> {
    this.acceptingOperations = false
    this.native?.stop()
    await this.serializeAuthorityWork(() => this.terminateAll('runtime-shutdown'))
  }

  /** Disposable fixture seam: exercises the same compactor and shared parser as NativeRpcClient. */
  async handleIsolatedFixtureRequest(message: ExternalChromeJsonRpcMessage): Promise<{
    rawEnvelope: Record<string, unknown>
    envelope: Record<string, unknown>
    parsed: ExternalChromeJsonRpcMessage
  }> {
    if (!('method' in message) || !('id' in message)) throw new Error('fixture message is not a request')
    const rawResult = await this.handleDesktopRequest(message)
    const rawEnvelope = { jsonrpc: '2.0', id: message.id, result: rawResult }
    const result = compactSnapshotForJsonRpc(rawResult, message.id, EXTERNAL_CHROME_MAX_NEGOTIATED_MESSAGE_BYTES)
    const envelope = { jsonrpc: '2.0', id: message.id, result }
    const parsed = parseExternalChromeJsonRpcFrame(JSON.stringify(envelope), {
      expectedResponseMethod: message.method, protocolVersion: 1,
    })
    return { rawEnvelope, envelope, parsed }
  }

  private handleDesktopRequest(message: ExternalChromeJsonRpcMessage): Promise<unknown> {
    if (!('method' in message) || !('id' in message)) return Promise.reject(new Error('Desktop message is not a request'))
    const request = message as ExternalChromeRequest
    if (request.method === 'forge.runtime.prepareUpdate') this.acceptingOperations = false
    if (['forge.browser.acquire', 'forge.browser.release', 'forge.browser.acknowledgeRelease', 'forge.runtime.prepareUpdate'].includes(request.method)) {
      return this.serializeAuthorityWork(async () => {
        try {
          return await this.handleDesktopRequestUnlocked(request)
        } finally {
          // Every acquire attempt publishes one complete post-attempt authority view. If its
          // response races disconnect, Desktop either checkpoints exact scope or retains intent.
          if (request.method === 'forge.browser.acquire') this.reportAuthoritySnapshot()
        }
      })
    }
    return this.handleDesktopRequestUnlocked(request)
  }

  private async handleDesktopRequestUnlocked(request: ExternalChromeRequest): Promise<unknown> {
    if (!this.acceptingOperations && !['forge.runtime.ping', 'forge.runtime.prepareUpdate', 'forge.runtime.reload', 'forge.browser.release', 'forge.browser.acknowledgeRelease'].includes(request.method)) {
      throw new LeaseError('lease-lost', 'runtime is quiesced')
    }
    switch (request.method) {
      case 'forge.runtime.ping': return { protocolVersion: 1, nonce: request.params.nonce, receivedAt: new Date().toISOString() }
      case 'forge.browser.inventory': {
        const inventory = await this.authorities.eligibleTabs(request.params.sessionAgentId)
        return { protocolVersion: 1, ...inventory }
      }
      case 'forge.browser.acquire': {
        let tab: ChromeTab
        let createdByForge = false
        if (request.params.tabId !== undefined) {
          const acquired = await this.authorities.acquire({
            tabId: request.params.tabId,
            ownerId: request.params.leaseId,
            ownerEpoch: request.params.leaseEpoch,
            sessionAgentId: request.params.sessionAgentId,
            expectedOwnerEpoch: 0,
          })
          tab = acquired.tab
        } else {
          if (!request.params.createIfNeeded) throw new LeaseError('target-not-found', 'no existing tab was selected and creation was not requested')
          await this.authorities.ensureAcquireAdmission({
            ownerId: request.params.leaseId,
            ownerEpoch: request.params.leaseEpoch,
            sessionAgentId: request.params.sessionAgentId,
          })
          const allocated = await this.authorities.createNeutralTab()
          tab = allocated.tab
          createdByForge = allocated.createdByForge
          if (tab.id === undefined) throw new LeaseError('target-not-found', 'Chrome did not return a tab ID')
          try {
            await this.authorities.acquire({
              tabId: tab.id,
              ownerId: request.params.leaseId,
              ownerEpoch: request.params.leaseEpoch,
              sessionAgentId: request.params.sessionAgentId,
              expectedOwnerEpoch: 0,
              createdByForge,
            })
          } catch (error) {
            if (createdByForge) await this.chrome.tabs.remove(tab.id).catch(() => undefined)
            throw error
          }
        }
        this.humanInterruptedOperations.delete(tab.id!)
        this.notifyLeaseChanged(request.params.leaseId, request.params.leaseEpoch, 'acquired', [tab.id!])
        return {
          protocolVersion: 1,
          leaseId: request.params.leaseId,
          leaseEpoch: request.params.leaseEpoch,
          sessionAgentId: request.params.sessionAgentId,
          extensionInstanceId: this.extensionInstanceId,
          tab: acquiredTab(tab),
          created: createdByForge,
        }
      }
      case 'forge.browser.release': {
        const releasedTabIds = await this.terminateOwner(
          request.params.leaseId,
          request.params.leaseEpoch,
          `release:${request.params.reason.slice(0, 128)}`,
        )
        return { protocolVersion: 1, leaseId: request.params.leaseId, leaseEpoch: request.params.leaseEpoch, releasedTabIds }
      }
      case 'forge.browser.acknowledgeRelease': {
        const releasedTabIds = await this.authorities.acknowledgeRelease(
          request.params.leaseId,
          request.params.leaseEpoch,
          request.params.releasedTabIds,
        )
        return {
          protocolVersion: 1,
          leaseId: request.params.leaseId,
          leaseEpoch: request.params.leaseEpoch,
          releasedTabIds,
          acknowledged: true,
        }
      }
      case 'forge.browser.reveal': {
        this.authorities.assertScope(request.params.leaseId, request.params.leaseEpoch, request.params.tabId)
        const tab = await this.chrome.tabs.get(request.params.tabId)
        const windows = this.chrome.windows as unknown as { update(windowId: number, properties: { focused: boolean }): Promise<unknown> }
        await this.chrome.tabs.update(request.params.tabId, { active: true })
        if (tab.windowId !== undefined) await windows.update(tab.windowId, { focused: true })
        return { protocolVersion: 1, leaseId: request.params.leaseId, leaseEpoch: request.params.leaseEpoch, tabId: request.params.tabId, revealed: true }
      }
      case 'forge.browser.execute': return this.execute(request.params)
      case 'forge.runtime.prepareUpdate': {
        this.acceptingOperations = false
        const deadline = Date.parse(request.params.deadlineAt)
        await this.terminateAll('runtime-update')
        await Promise.allSettled([...this.activeOperations.values()])
        if (!Number.isFinite(deadline) || this.now() >= deadline) throw new Error('prepareUpdate deadline elapsed')
        return { protocolVersion: 1, payloadVersion: request.params.payloadVersion, quiesced: true }
      }
      case 'forge.runtime.reload': {
        const selector = await loadVerifiedPayloadSelector((path) => this.chrome.runtime.getURL(path), 'service-worker.js')
        if (selector.payloadVersion !== request.params.payloadVersion || selector.payloadSha256 !== request.params.sha256) throw new Error('reload selector mismatch')
        setTimeout(() => this.chrome.runtime.reload(), 0)
        return { protocolVersion: 1, payloadVersion: request.params.payloadVersion, accepted: true }
      }
      case 'forge.runtime.hello': throw new Error('hello is extension-initiated')
    }
  }

  private async execute(params: ExternalChromeExecuteParams): Promise<unknown> {
    let authority: TabAuthorityRecord
    try {
      authority = this.authorities.assertScope(params.leaseId, params.leaseEpoch, params.tabId)
    } catch (error) {
      return this.executeFailure(params, error instanceof LeaseError ? error.code : 'lease-lost', error instanceof Error ? error.message : 'Tab authority is stale.', true)
    }
    const requestedControlEpoch = authority.controlEpoch
    if (params.operation === 'status') {
      try {
        const tab = await this.chrome.tabs.get(params.tabId)
        authority = this.authorities.assertScope(params.leaseId, params.leaseEpoch, params.tabId)
        return this.executeResponse(params, true, {
          available: true,
          host: { connected: true, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null },
          panelVisible: false,
          panelRevealRequested: false,
          physicalTabVisible: false,
          selectedTab: this.browserTab(tab, authority),
          eligibleTabs: [],
          eligibleTabsTruncated: false,
        })
      } catch (error) {
        if (error instanceof LeaseError) return this.executeFailure(params, error.code, error.message, true)
        await this.terminateTab(params.tabId, 'identity-loss').catch(() => undefined)
        return this.executeFailure(params, 'target-not-found', 'The leased Chrome tab no longer exists.', false)
      }
    }
    if (!['navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor'].includes(params.operation)) {
      return this.executeFailure(params, 'unsupported-operation', `External Chrome does not support ${params.operation}.`, false)
    }
    if (authority.requiresObservation && params.operation !== 'snapshot') {
      const attached = this.hasCollaborativeAttachedIdle(params)
      return this.executeFailure(
        params,
        'request-cancelled',
        'Trusted collaborative input changed the page; take a fresh snapshot before continuing.',
        true,
        attached ? EXTERNAL_CHROME_REOBSERVE_REQUIRED_DETAILS : undefined,
      )
    }
    return this.operations.runExclusive(params.tabId, async () => {
      let resolveTracked!: () => void
      const tracked = new Promise<void>((resolve) => { resolveTracked = resolve })
      this.activeOperations.set(params.tabId, tracked)
      let controlEpoch: number | null = null
      let syntheticOperationId: string | null = null
      let physicalOperation = false
      let mutationState: 'not-started' | 'possible' = 'not-started'
      try {
        if (!this.acceptingOperations || Date.parse(params.deadlineAt) <= this.now()) {
          return this.executeFailure(params, 'timeout', 'Operation deadline elapsed.', true)
        }
        let operationAuthority = this.authorities.assertScope(params.leaseId, params.leaseEpoch, params.tabId)
        if (operationAuthority.controlEpoch !== requestedControlEpoch) {
          return this.executeFailure(params, 'request-cancelled', 'Queued operation authority changed before execution.', true)
        }
        let currentTab: ChromeTab
        try { currentTab = await this.chrome.tabs.get(params.tabId) }
        catch {
          await this.terminateTab(params.tabId, 'identity-loss')
          return this.executeFailure(params, 'target-not-found', 'The leased Chrome tab no longer exists.', false)
        }
        const neutralInitialTarget = operationAuthority.createdByForge && operationAuthority.initialNavigationPending
          && await this.authorities.hasAuthorizedNeutralInitialTarget(currentTab)
        const currentRestriction = restrictedTargetReason(currentTab.url)
        if (currentRestriction !== null && !neutralInitialTarget) {
          await this.terminateTab(params.tabId, 'restricted-target')
          return this.executeFailure(params, 'restricted-target', `Current target is restricted (${currentRestriction}).`, false)
        }
        if (operationAuthority.initialNavigationPending && currentRestriction === null) {
          operationAuthority = await this.authorities.completeInitialNavigation(params.leaseId, params.leaseEpoch, params.tabId)
        }
        const navigateInput = params.operation === 'navigate'
          ? params.input as { url?: string; readiness: 'load' | 'domContentLoaded' | 'none'; timeoutMs: number }
          : null
        if (navigateInput !== null && (!navigateInput.url || restrictedTargetReason(navigateInput.url) !== null)) {
          return this.executeFailure(params, 'restricted-target', 'Navigation target is missing or restricted.', false)
        }
        if (neutralInitialTarget && navigateInput === null) {
          return this.executeFailure(params, 'restricted-target', 'The neutral target requires an initial navigation.', false)
        }

        const expectedEpoch = requestedControlEpoch
        if (neutralInitialTarget && navigateInput !== null) {
          controlEpoch = await this.authorities.beginAgentControl(params.leaseId, params.leaseEpoch, params.tabId, expectedEpoch)
          this.broadcastState([params.tabId], 'agent')
          const isCurrent = () => this.authorities.isOperationCurrent(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch as number)
          const authorityCurrent = () => this.authorities.isAuthorityCurrent(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch as number)
          const deadline = Math.min(Date.parse(params.deadlineAt), this.now() + navigateInput.timeoutMs)
          try {
            const tab = await this.navigateInitialTarget(
              params,
              navigateInput.url as string,
              navigateInput.readiness,
              deadline,
              isCurrent,
              authorityCurrent,
              () => { mutationState = 'possible' },
            )
            if (!isCurrent()) return this.executeFailure(params, 'control-interrupted', 'Human input interrupted navigation.', true)
            const result: BrowserAutomationResultByOperation['navigate'] = {
              tab: this.browserTab(tab, operationAuthority),
              readiness: navigateInput.readiness,
            }
            return this.executeResponse(params, true, result)
          } catch {
            const remainedCurrent = isCurrent()
            const interrupted = this.wasHumanInterrupted(params.tabId, controlEpoch)
            if (!interrupted) await this.authorities.markLost(params.tabId)
            return this.executeFailure(
              params,
              remainedCurrent ? 'timeout' : interrupted ? 'control-interrupted' : 'request-cancelled',
              remainedCurrent ? 'Navigation timed out.' : interrupted ? 'Human input interrupted navigation.' : 'Navigation authority changed.',
              true,
            )
          }
        }

        try {
          await this.controlSessions.ensure(params.tabId, params.leaseId, params.leaseEpoch)
        } catch (error) {
          if (error instanceof DebuggerAttachConflictError) {
            return this.executeFailure(params, 'debugger-unavailable', error.message, true, EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS)
          }
          if (error instanceof DebuggerAttachmentLimitError) {
            return this.executeFailure(params, 'debugger-unavailable', error.message, true, {
              limitation: 'simultaneous-debugger-attachment-bound',
              maximumAttachments: error.maximum,
            })
          }
          if (error instanceof DebuggerIdentityLossError || /identity|attachment was lost/u.test(error instanceof Error ? error.message : String(error))) {
            await this.terminateTab(params.tabId, 'identity-loss')
            return this.executeFailure(params, 'lease-lost', 'Chrome could not prove the leased root identity.', true)
          }
          if (this.debuggers.state(params.tabId) === 'LOST') {
            await this.terminateTab(params.tabId, 'operation-failed')
            return this.executeFailure(params, 'debugger-unavailable', error instanceof Error ? error.message : 'Partial debugger setup failed.', true)
          }
          throw error
        }
        physicalOperation = true
        // Terminal cleanup may have started while chrome.debugger.attach was pending. Re-check the
        // logical CAS before admitting this newly created physical session to an operation.
        this.authorities.assertScope(params.leaseId, params.leaseEpoch, params.tabId)
        this.controlSessions.beginOperation(params.tabId, params.leaseId, params.leaseEpoch)
        // Repeated injection is a recovery probe. The document-owned singleton bridge guarantees
        // that this never multiplies Ports or trusted-input listeners in one live document.
        await this.chrome.scripting.executeScript({
          target: { tabId: params.tabId, allFrames: true },
          files: [`payloads/${this.directory}/content-script.js`],
          world: 'ISOLATED',
        })
        controlEpoch = await this.authorities.beginAgentControl(params.leaseId, params.leaseEpoch, params.tabId, expectedEpoch)
        this.broadcastState([params.tabId], 'agent')
        const isCurrent = () => this.authorities.isOperationCurrent(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch as number)
        if (navigateInput !== null) {
          const deadline = Math.min(Date.parse(params.deadlineAt), this.now() + navigateInput.timeoutMs)
          try {
            await this.debuggers.navigateAndWait(
              params.tabId,
              navigateInput.url as string,
              navigateInput.readiness,
              deadline,
              isCurrent,
              () => { mutationState = 'possible' },
            )
            await this.debuggers.revalidateRoot(params.tabId)
          } catch (error) {
            const remainedCurrent = isCurrent()
            if (error instanceof DebuggerIdentityLossError) {
              await this.terminateTab(params.tabId, 'identity-loss')
              return this.executeFailure(params, 'lease-lost', error.message, true)
            }
            const interrupted = this.wasHumanInterrupted(params.tabId, controlEpoch)
            if (interrupted) await this.settleCollaborativeOperation(params)
            else await this.cancelPhysicalOperation(params, controlEpoch, 'operation-cancelled')
            return this.executeFailure(
              params,
              remainedCurrent ? 'timeout' : interrupted ? 'control-interrupted' : 'request-cancelled',
              remainedCurrent ? 'Navigation timed out.' : interrupted ? 'Human input interrupted navigation.' : 'Navigation authority changed.',
              true,
              interrupted && this.hasCollaborativeAttachedIdle(params)
                ? externalChromeControlCollisionDetails(mutationState)
                : undefined,
            )
          }
          if (!isCurrent()) {
            const interrupted = this.wasHumanInterrupted(params.tabId, controlEpoch)
            if (interrupted) await this.settleCollaborativeOperation(params)
            return this.executeFailure(
              params,
              interrupted ? 'control-interrupted' : 'request-cancelled',
              interrupted ? 'Human input interrupted navigation.' : 'Navigation authority changed.',
              true,
              interrupted && this.hasCollaborativeAttachedIdle(params)
                ? externalChromeControlCollisionDetails(mutationState)
                : undefined,
            )
          }
          const tab = await this.chrome.tabs.get(params.tabId)
          const restriction = restrictedTargetReason(tab.url)
          if (restriction !== null) {
            await this.terminateTab(params.tabId, 'restricted-target')
            return this.executeFailure(params, 'restricted-target', `Navigation entered a restricted target (${restriction}).`, false)
          }
          if (!isCurrent()) {
            const interrupted = this.wasHumanInterrupted(params.tabId, controlEpoch)
            if (interrupted) await this.settleCollaborativeOperation(params)
            return this.executeFailure(
              params,
              interrupted ? 'control-interrupted' : 'request-cancelled',
              interrupted ? 'Human input interrupted navigation.' : 'Navigation authority changed.',
              true,
              interrupted && this.hasCollaborativeAttachedIdle(params)
                ? externalChromeControlCollisionDetails(mutationState)
                : undefined,
            )
          }
          const result: BrowserAutomationResultByOperation['navigate'] = {
            tab: this.browserTab(tab, operationAuthority),
            readiness: navigateInput.readiness,
          }
          return this.executeResponse(params, true, result)
        }
        const outcome = await this.operations.executeNow(params, {
          navigationGeneration: this.debuggers.navigationGeneration(params.tabId),
          isCurrent,
          wasHumanInterrupted: () => this.wasHumanInterrupted(params.tabId, controlEpoch as number),
          mutationState: () => mutationState,
          markMutationDispatched: () => { mutationState = 'possible' },
          canPreserveAttachedIdle: () => this.hasCollaborativeAttachedIdle(params),
          cancelOutstanding: async () => {
            if (this.wasHumanInterrupted(params.tabId, controlEpoch as number)) await this.settleCollaborativeOperation(params)
            else await this.cancelPhysicalOperation(params, controlEpoch as number, 'operation-cancelled')
          },
          beginSyntheticInput: async (expectedEvents) => {
            if (syntheticOperationId !== null) return
            syntheticOperationId = crypto.randomUUID()
            await this.signalSyntheticStart(params.tabId, syntheticOperationId, controlEpoch as number, expectedEvents)
          },
          endSyntheticInput: () => {
            if (syntheticOperationId === null) return
            this.signalSyntheticEnd(params.tabId, syntheticOperationId, controlEpoch as number)
            syntheticOperationId = null
          },
        })
        if (outcome.ok && params.operation === 'snapshot') {
          const observed = await this.authorities.completeObservation(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch)
          if (!observed) {
            return this.executeFailure(
              params,
              'control-interrupted',
              'Trusted collaborative input interrupted the snapshot; take a fresh snapshot before continuing.',
              true,
              this.hasCollaborativeAttachedIdle(params)
                ? externalChromeControlCollisionDetails('not-started')
                : undefined,
            )
          }
        }
        const preservedCollision = !outcome.ok && outcome.error.code === 'control-interrupted' &&
          isExternalChromeControlCollisionDetails(outcome.error.details)
        if (!outcome.ok && !preservedCollision &&
          this.controlSessions.isAttachedFor(params.tabId, params.leaseId, params.leaseEpoch)) {
          const interrupted = ['timeout', 'request-cancelled', 'lease-lost'].includes(outcome.error.code)
          const ambiguousFailure = outcome.error.code === 'execution-failed' || outcome.error.code === 'evaluation-failed'
          if (interrupted || ambiguousFailure) {
            await this.cancelPhysicalOperation(params, controlEpoch, interrupted ? 'operation-cancelled' : 'operation-failed')
          }
        }
        return outcome.ok
          ? this.executeResponse(params, true, outcome.result)
          : this.executeFailure(params, outcome.error.code, outcome.error.message, outcome.error.retryable, outcome.error.details)
      } catch (error) {
        if (physicalOperation) {
          try {
            if (controlEpoch !== null) await this.cancelPhysicalOperation(params, controlEpoch, 'operation-failed')
            else await this.controlSessions.detach(params.tabId, 'operation-failed')
          } catch {
            await this.authorities.markLost(params.tabId).catch(() => undefined)
          }
        }
        const code = error instanceof LeaseError
          ? error.code
          : params.operation === 'evaluate' ? 'evaluation-failed' : 'execution-failed'
        return this.executeFailure(params, code, error instanceof Error ? error.message : 'Chrome operation failed', true)
      } finally {
        try {
          if (syntheticOperationId !== null && controlEpoch !== null) this.signalSyntheticEnd(params.tabId, syntheticOperationId, controlEpoch)
          if (controlEpoch !== null) await this.authorities.finishAgentControl(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch)
          if (physicalOperation && this.controlSessions.isAttachedFor(params.tabId, params.leaseId, params.leaseEpoch)) {
            this.controlSessions.finishOperation(params.tabId, params.leaseId, params.leaseEpoch)
            this.broadcastState([params.tabId], 'attached-idle')
          } else if (this.authorities.forTab(params.tabId)?.state === 'idle') {
            this.broadcastState([params.tabId], 'human')
          }
        } finally {
          resolveTracked()
          if (this.activeOperations.get(params.tabId) === tracked) this.activeOperations.delete(params.tabId)
          if (controlEpoch !== null && this.wasHumanInterrupted(params.tabId, controlEpoch)) this.humanInterruptedOperations.delete(params.tabId)
        }
      }
    })
  }

  private executeResponse(params: ExternalChromeExecuteParams, ok: true, result: unknown): Record<string, unknown> { return { protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, tabId: params.tabId, operation: params.operation, ok, result } }
  private executeFailure(params: ExternalChromeExecuteParams, code: string, message: string, retryable: boolean, details?: Record<string, string | number | boolean | null>): Record<string, unknown> { return { protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, tabId: params.tabId, operation: params.operation, ok: false, error: { code, message: message.slice(0, 1_024), retryable, ...(details ? { details } : {}) } } }

  private browserTab(tab: ChromeTab, authority: TabAuthorityRecord): BrowserTabSnapshot {
    const now = new Date(this.now()).toISOString()
    const physicalSession = this.controlSessions.forTab(authority.tabId)
    const controller = authority.state === 'agent'
      ? 'agent'
      : physicalSession?.leaseId === authority.ownerId && physicalSession.leaseEpoch === authority.ownerEpoch
        ? 'agent-idle'
        : 'human'
    return { targetAffinity: 'external-chrome', tabId: String(tab.id), sessionAgentId: authority.sessionAgentId, profileId: this.extensionInstanceId, url: tab.url ?? tab.pendingUrl ?? '', title: tab.title ?? '', lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller, agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now }
  }

  private handleConnect(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const port = value as ContentPort
    const tabId = port.sender?.tab?.id
    const frameId = port.sender?.frameId
    const documentId = port.sender?.documentId
    const authority = tabId === undefined ? null : this.authorities.forTab(tabId)
    if (!Number.isSafeInteger(tabId) || !Number.isSafeInteger(frameId) || (frameId as number) < 0 ||
      typeof documentId !== 'string' || documentId.length < 1 || documentId.length > 128 ||
      !/^forge-leased-frame:[0-9a-f-]{36}$/u.test(port.name) || authority === null || authority.state === 'lost') {
      port.disconnect()
      return
    }
    const key = this.bridgeKey(tabId as number, frameId as number, documentId)
    if (this.contentBridges.has(key)) {
      this.bridgeDuplicatesRejected += 1
      port.disconnect()
      return
    }
    const tabKeys = this.bridgeKeysByTab.get(tabId as number) ?? new Set<string>()
    for (const staleKey of [...tabKeys]) {
      const stale = this.contentBridges.get(staleKey)
      if (stale !== undefined && stale.frameId === frameId && stale.documentId !== documentId) {
        this.removeBridge(stale)
        stale.port.disconnect()
      }
    }
    if (this.contentBridges.size >= MAX_CONTENT_BRIDGES || tabKeys.size >= MAX_CONTENT_BRIDGES_PER_TAB) {
      this.bridgeBoundRejections += 1
      port.disconnect()
      return
    }
    const bridge: ContentBridgeRecord = { key, tabId: tabId as number, frameId: frameId as number, documentId, port, ready: false }
    this.contentBridges.set(key, bridge)
    tabKeys.add(key)
    this.bridgeKeysByTab.set(bridge.tabId, tabKeys)
    this.bridgesConnected += 1
    this.maximumObservedBridges = Math.max(this.maximumObservedBridges, this.contentBridges.size)
    port.onMessage.addListener((message) => {
      if (this.contentBridges.get(key) !== bridge || typeof message !== 'object' || message === null) return
      const record = message as Record<string, unknown>
      if (record.nonce !== port.name.slice('forge-leased-frame:'.length)) return
      if (record.type === 'content-ready') {
        bridge.ready = true
        const current = this.authorities.forTab(bridge.tabId)
        const state = current?.state === 'agent'
          ? 'agent'
          : current && this.controlSessions.isAttachedFor(bridge.tabId, current.ownerId, current.ownerEpoch)
            ? 'attached-idle'
            : current ? 'human' : 'detached'
        try { port.postMessage({ type: 'status', nonce: record.nonce, state, ...(current === null ? {} : { controlEpoch: current.controlEpoch }) }) }
        catch { this.removeBridge(bridge) }
        return
      }
      if (record.type === 'synthetic-ack' && typeof record.operationId === 'string' && Number.isSafeInteger(record.controlEpoch)) {
        const acknowledgement = this.syntheticAcknowledgements.get(this.syntheticKey(bridge.tabId, record.operationId))
        if (acknowledgement === undefined || acknowledgement.controlEpoch !== record.controlEpoch) return
        acknowledgement.pending.delete(port)
        if (acknowledgement.pending.size === 0) acknowledgement.resolve()
        return
      }
      if (record.type === 'trusted-human-input' && Number.isSafeInteger(record.controlEpoch)) {
        const current = this.authorities.forTab(bridge.tabId)
        if (current?.controlEpoch === record.controlEpoch) void this.interrupt(bridge.tabId, record.event)
      }
    })
    port.onDisconnect.addListener(() => this.removeBridge(bridge))
  }

  private broadcastState(tabIds: number[], state: 'human' | 'agent' | 'attached-idle' | 'detached'): void {
    for (const tabId of tabIds) for (const bridge of this.bridgesForTab(tabId)) {
      const nonce = bridge.port.name.slice('forge-leased-frame:'.length)
      const authority = this.authorities.forTab(tabId)
      try { bridge.port.postMessage({ type: 'status', nonce, state, ...(authority === null ? {} : { controlEpoch: authority.controlEpoch }) }) }
      catch { this.removeBridge(bridge) }
    }
  }

  private async signalSyntheticStart(
    tabId: number,
    operationId: string,
    controlEpoch: number,
    expectedEvents: readonly SyntheticTrustedEventSignature[],
  ): Promise<void> {
    const deadline = this.now() + 1_000
    while (this.readyBridges(tabId).length === 0 && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const ports = new Set(this.readyBridges(tabId).map((bridge) => bridge.port))
    if (ports.size === 0) throw new LeaseError('lease-lost', 'trusted-input guard did not become ready')
    const key = this.syntheticKey(tabId, operationId)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.syntheticAcknowledgements.delete(key)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(new Error('synthetic input acknowledgement timed out')), 1_000)
      this.syntheticAcknowledgements.set(key, {
        pending: ports,
        controlEpoch,
        resolve: () => finish(),
        reject: (error) => finish(error),
      })
      try {
        for (const port of ports) {
          const nonce = port.name.slice('forge-leased-frame:'.length)
          port.postMessage({
            type: 'synthetic-start', nonce, operationId, controlEpoch,
            expectedEvents: expectedEvents.map((event) => structuredClone(event)),
          })
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error('trusted-input guard send failed'))
      }
    })
  }

  private signalSyntheticEnd(tabId: number, operationId: string, controlEpoch: number): void {
    for (const bridge of this.readyBridges(tabId)) {
      const nonce = bridge.port.name.slice('forge-leased-frame:'.length)
      try { bridge.port.postMessage({ type: 'synthetic-end', nonce, operationId, controlEpoch }) }
      catch { this.removeBridge(bridge) }
    }
  }

  private syntheticKey(tabId: number, operationId: string): string { return `${tabId}\0${operationId}` }

  private async interrupt(tabId: number, event: unknown): Promise<void> {
    const before = this.authorities.forTab(tabId)
    if (before === null) return
    if (before.state === 'agent') this.humanInterruptedOperations.set(tabId, before.controlEpoch)
    let authority: TabAuthorityRecord
    try {
      authority = await this.authorities.trustedHumanInput(tabId) ?? before
    } catch {
      // In-memory operation authority is already revoked even if storage.session is temporarily unavailable.
      authority = this.authorities.forTab(tabId) ?? { ...before, state: 'idle', controlEpoch: before.controlEpoch + 1 }
    }
    try {
      this.native?.sendNotification('browser.userControl', {
        protocolVersion: 1,
        leaseId: authority.ownerId,
        leaseEpoch: authority.ownerEpoch,
        tabId,
        controlEpoch: authority.controlEpoch,
        event: ['pointer', 'key', 'wheel', 'touch'].includes(String(event)) ? event as 'pointer' | 'key' | 'wheel' | 'touch' : 'pointer',
        at: new Date(this.now()).toISOString(),
      })
    } catch { /* Desktop still owns the exact lease checkpoint */ }
    // Collaborative input invalidates only the operation epoch. The exact debugger attachment
    // remains available while the operation queue settles every already-dispatched CDP command.
    const attached = this.controlSessions.isAttachedFor(tabId, authority.ownerId, authority.ownerEpoch)
    this.broadcastState([tabId], attached ? 'attached-idle' : 'human')
  }

  private async interruptExternalNavigation(tabId: number): Promise<void> {
    const before = this.authorities.forTab(tabId)
    if (before === null) return
    try { await this.authorities.trustedHumanInput(tabId) }
    catch { /* In-memory epoch revocation remains authoritative for this worker. */ }
    try {
      await this.controlSessions.detach(tabId, 'external-navigation')
      this.operations.clear(tabId)
      this.broadcastState([tabId], 'human')
    } catch {
      await this.authorities.markLost(tabId).catch(() => undefined)
    }
  }

  private async navigateInitialTarget(
    params: ExternalChromeExecuteParams,
    url: string,
    readiness: 'load' | 'domContentLoaded' | 'none',
    deadline: number,
    isCurrent: () => boolean,
    authorityCurrent: () => boolean,
    onDispatch: () => void,
  ): Promise<ChromeTab> {
    if (this.initialNavigations.has(params.tabId)) throw new Error('initial navigation is already active')
    const transition: InitialNavigationTransition = {
      dispatchStarted: false,
      commitStarted: false,
      documentId: null,
      authorityCurrent,
      completeAuthority: async () => { await this.authorities.completeInitialNavigation(params.leaseId, params.leaseEpoch, params.tabId) },
      committed: deferred<ChromeTab>(),
      domContentLoaded: deferred<ChromeTab>(),
      completed: deferred<ChromeTab>(),
    }
    this.initialNavigations.set(params.tabId, transition)
    let keepUntilCommit = false
    try {
      // The thunk makes deadline and operation authority a synchronous
      // preflight immediately before the one target mutation.
      const updated = await this.awaitInitialNavigationStep(() => {
        transition.dispatchStarted = true
        onDispatch()
        return this.chrome.tabs.update(params.tabId, { url })
      }, deadline, isCurrent)
      if (readiness === 'none') {
        keepUntilCommit = true
        this.monitorInitialNavigation(params.tabId, transition, deadline)
        return updated
      }
      await this.awaitInitialNavigationStep(() => transition.committed.promise, deadline, isCurrent)
      const milestone = readiness === 'domContentLoaded' ? transition.domContentLoaded : transition.completed
      return await this.awaitInitialNavigationStep(() => milestone.promise, deadline, isCurrent)
    } finally {
      if (!keepUntilCommit && this.initialNavigations.get(params.tabId) === transition) {
        this.rejectInitialNavigation(transition, new Error('initial navigation waiter closed'))
        this.initialNavigations.delete(params.tabId)
      }
    }
  }

  private monitorInitialNavigation(tabId: number, transition: InitialNavigationTransition, deadline: number): void {
    void this.awaitInitialNavigationStep(() => transition.committed.promise, deadline, transition.authorityCurrent)
      .catch((error: unknown) => this.rejectInitialNavigation(transition, error))
      .finally(() => {
        if (this.initialNavigations.get(tabId) === transition) this.initialNavigations.delete(tabId)
      })
  }

  private rejectInitialNavigation(transition: InitialNavigationTransition, error: unknown): void {
    transition.committed.reject(error)
    transition.domContentLoaded.reject(error)
    transition.completed.reject(error)
  }

  private async awaitInitialNavigationStep<Value>(operation: () => Promise<Value>, deadline: number, isCurrent: () => boolean): Promise<Value> {
    if (!isCurrent()) throw new Error('initial navigation authority was interrupted')
    const remaining = deadline - this.now()
    if (remaining <= 0) throw new Error('initial navigation deadline elapsed')
    const promise = operation()
    return new Promise<Value>((resolve, reject) => {
      let settled = false
      const finish = (outcome: { value: Value } | { error: unknown }): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearInterval(authorityCheck)
        if ('error' in outcome) reject(outcome.error)
        else resolve(outcome.value)
      }
      const timeout = setTimeout(() => finish({ error: new Error('initial navigation deadline elapsed') }), remaining)
      const authorityCheck = setInterval(() => {
        if (!isCurrent()) finish({ error: new Error('initial navigation authority was interrupted') })
      }, 10)
      promise.then((value) => {
        if (!isCurrent()) finish({ error: new Error('initial navigation authority was interrupted') })
        else if (this.now() >= deadline) finish({ error: new Error('initial navigation deadline elapsed') })
        else finish({ value })
      }, (error) => finish({ error }))
    })
  }

  private async handleNavigationCommitted(value: unknown): Promise<void> {
    const details = value as { tabId?: unknown; frameId?: unknown; documentId?: unknown; url?: unknown }
    if (!Number.isSafeInteger(details.tabId) || !Number.isSafeInteger(details.frameId)) return
    const tabId = details.tabId as number
    const transition = this.initialNavigations.get(tabId)
    if (details.frameId === 0 && typeof details.url === 'string' && restrictedTargetReason(details.url) !== null) {
      if (transition !== undefined) this.rejectInitialNavigation(transition, new Error('navigation committed to a restricted target'))
      await this.terminateTab(tabId, 'restricted-target')
      return
    }
    if (transition !== undefined) {
      if (!transition.dispatchStarted || details.frameId !== 0 || transition.commitStarted) return
      transition.commitStarted = true
      if (typeof details.documentId !== 'string' || details.documentId.length === 0 || details.documentId.length > 128 ||
        typeof details.url !== 'string' || restrictedTargetReason(details.url) !== null || !transition.authorityCurrent()) {
        this.rejectInitialNavigation(transition, new Error('initial navigation committed without eligible exact authority'))
        return
      }
      transition.documentId = details.documentId
      try {
        if (!await this.injectContentScript(details, transition)) throw new Error('initial destination injection was not authorized')
        const tab = await this.chrome.tabs.get(tabId)
        if (restrictedTargetReason(tab.url) !== null || !transition.authorityCurrent()) throw new Error('initial destination remained unauthorized')
        await transition.completeAuthority()
        transition.committed.resolve(tab)
      } catch (error) {
        this.rejectInitialNavigation(transition, error)
      }
      return
    }
    await this.injectContentScript(details).catch(() => false)
  }

  private async handleNavigationMilestone(value: unknown, milestone: 'domContentLoaded' | 'completed'): Promise<void> {
    const details = value as { tabId?: unknown; frameId?: unknown; documentId?: unknown; url?: unknown }
    if (!Number.isSafeInteger(details.tabId) || details.frameId !== 0 || typeof details.documentId !== 'string' || typeof details.url !== 'string') return
    const transition = this.initialNavigations.get(details.tabId as number)
    if (transition === undefined || transition.documentId !== details.documentId) return
    if (restrictedTargetReason(details.url) !== null || !transition.authorityCurrent()) {
      this.rejectInitialNavigation(transition, new Error(`initial navigation ${milestone} lost exact authority`))
      return
    }
    try {
      const tab = await this.chrome.tabs.get(details.tabId as number)
      if (restrictedTargetReason(tab.url) !== null || !transition.authorityCurrent()) throw new Error(`initial navigation ${milestone} was not eligible`)
      transition[milestone].resolve(tab)
    } catch (error) {
      this.rejectInitialNavigation(transition, error)
    }
  }

  private async handleDebuggerEvent(args: unknown[]): Promise<void> {
    const source = args[0] as { tabId?: number; sessionId?: string }
    if (source.tabId === undefined || this.controlSessions.forTab(source.tabId) === null) return
    const method = typeof args[1] === 'string' ? args[1] : ''
    const rawParams = args[2]
    if (method === 'Page.frameNavigated' && source.sessionId === undefined) {
      const payload = asRecord(rawParams)
      const frame = asRecord(payload?.frame)
      if (typeof frame?.parentId !== 'string' && typeof frame?.url === 'string') {
        if (restrictedTargetReason(frame.url) !== null) {
          await this.terminateTab(source.tabId, 'restricted-target')
          return
        }
        const session = this.controlSessions.forTab(source.tabId)
        if (session !== null && !session.operationActive) {
          // Address-bar, reload, renderer, and page-initiated navigation outside an admitted
          // operation all invalidate the idle operation epoch before physical detach.
          await this.interruptExternalNavigation(source.tabId)
          return
        }
      }
    }
    const accepted = await this.debuggers.onEvent(source, method, rawParams)
    if (accepted.rootIdentityLost) {
      await this.terminateTab(source.tabId, 'identity-loss')
      return
    }
    if (!accepted.accepted) return
    const sessionId = accepted.sessionId ?? source.sessionId
    const targetId = accepted.targetId ?? this.debuggers.targetId(source.tabId, sessionId)
    if (targetId !== undefined) {
      this.operations.onCdpEvent(source.tabId, { targetId, ...(sessionId ? { sessionId } : {}) }, method, rawParams)
    }
  }

  private async handleDebuggerDetach(args: unknown[]): Promise<void> {
    const source = args[0] as { tabId?: number }
    const notice = source.tabId === undefined ? null : this.debuggers.onDetach(source, String(args[1] ?? 'unknown'))
    if (notice === null || notice.expected) return
    const authority = this.authorities.forTab(notice.tabId)
    this.controlSessions.acknowledgeExternalDetach(
      notice.tabId,
      notice.devtoolsContention ? 'devtools-preemption' : 'debugger-detached',
      notice.devtoolsContention,
    )
    this.operations.clear(notice.tabId)
    if (authority === null) return
    try {
      this.native?.sendNotification('browser.detached', {
        protocolVersion: 1,
        leaseId: authority.ownerId,
        leaseEpoch: authority.ownerEpoch,
        tabId: notice.tabId,
        reason: notice.reason.slice(0, 1_024),
      })
    } catch { /* exact release remains durable */ }
    await this.terminateOwner(
      authority.ownerId,
      authority.ownerEpoch,
      notice.devtoolsContention ? 'devtools-preemption' : 'debugger-detached',
      new Set([notice.tabId]),
    )
  }

  private async handleTabRemoved(value: unknown): Promise<void> {
    if (!Number.isSafeInteger(value)) return
    const tabId = value as number
    const transition = this.initialNavigations.get(tabId)
    if (transition !== undefined) {
      this.rejectInitialNavigation(transition, new Error('initial navigation target was removed'))
      this.initialNavigations.delete(tabId)
    }
    this.controlSessions.acknowledgeTargetClosed(tabId)
    this.disconnectBridges(tabId)
    const authority = this.authorities.forTab(tabId)
    if (authority !== null) {
      this.cleanupAttempts += 1
      try {
        await this.authorities.recordClosedTab(authority.ownerId, authority.ownerEpoch, tabId)
        this.cleanupCompleted += 1
        this.notifyLeaseChanged(authority.ownerId, authority.ownerEpoch, 'released', [tabId])
      } catch {
        this.cleanupFailures += 1
        if (this.pendingClosedTabReceipts.size < MAX_PENDING_CLOSED_TAB_RECEIPTS) this.pendingClosedTabReceipts.add(tabId)
        this.chrome.alarms.create(CLEANUP_RETRY_ALARM, { delayInMinutes: 0.5 })
      }
    }
    await this.authorities.forgetNeutralTarget(tabId).catch(() => undefined)
    this.operations.clear(tabId)
  }

  private async injectContentScript(value: unknown, transition?: InitialNavigationTransition): Promise<boolean> {
    const details = value as { tabId?: unknown; frameId?: unknown; documentId?: unknown; url?: unknown }
    if (!Number.isSafeInteger(details.tabId) || !Number.isSafeInteger(details.frameId) ||
      typeof details.documentId !== 'string' || details.documentId.length < 1 || details.documentId.length > 128 ||
      typeof details.url !== 'string' || restrictedTargetReason(details.url) !== null) return false
    const tabId = details.tabId as number
    const transitionAuthorized = transition !== undefined && this.initialNavigations.get(tabId) === transition && transition.authorityCurrent()
    const authority = this.authorities.forTab(tabId)
    const physicalAuthorized = authority !== null && authority.state !== 'lost' &&
      this.controlSessions.isAttachedFor(tabId, authority.ownerId, authority.ownerEpoch)
    if (!transitionAuthorized && !physicalAuthorized) return false
    const tab = await this.chrome.tabs.get(tabId)
    if (restrictedTargetReason(tab.url) !== null || transition !== undefined && !transition.authorityCurrent()) return false
    await this.chrome.scripting.executeScript({ target: { tabId, frameIds: [details.frameId as number] }, files: [`payloads/${this.directory}/content-script.js`], world: 'ISOLATED' })
    return true
  }

  private wasHumanInterrupted(tabId: number, controlEpoch: number): boolean {
    return this.humanInterruptedOperations.get(tabId) === controlEpoch
  }

  private async settleCollaborativeOperation(
    params: Pick<ExternalChromeExecuteParams, 'leaseId' | 'leaseEpoch' | 'tabId' | 'deadlineAt'>,
  ): Promise<void> {
    try {
      await this.debuggers.settlePending(params.tabId, Date.parse(params.deadlineAt))
    } catch (error) {
      // A command whose callback cannot settle by the caller deadline cannot support the exact
      // attached-idle proof. Detach physically; Desktop will terminally release logical authority.
      try {
        await this.controlSessions.detach(params.tabId, 'operation-cancelled')
      } catch {
        await this.authorities.markLost(params.tabId).catch(() => undefined)
      }
      throw error
    }
    const authority = this.authorities.forTab(params.tabId)
    if (authority?.ownerId !== params.leaseId || authority.ownerEpoch !== params.leaseEpoch || authority.state !== 'idle' ||
      !this.controlSessions.isAttachedFor(params.tabId, params.leaseId, params.leaseEpoch)) {
      throw new LeaseError('lease-lost', 'collaborative input could not preserve exact attached-idle authority')
    }
  }

  private hasCollaborativeAttachedIdle(
    params: Pick<ExternalChromeExecuteParams, 'leaseId' | 'leaseEpoch' | 'tabId'>,
  ): boolean {
    const authority = this.authorities.forTab(params.tabId)
    return authority?.ownerId === params.leaseId && authority.ownerEpoch === params.leaseEpoch && authority.state === 'idle' &&
      this.controlSessions.isAttachedFor(params.tabId, params.leaseId, params.leaseEpoch)
  }

  private async cancelPhysicalOperation(
    params: Pick<ExternalChromeExecuteParams, 'leaseId' | 'leaseEpoch' | 'tabId'>,
    controlEpoch: number,
    reason: 'operation-cancelled' | 'operation-failed',
  ): Promise<void> {
    let revocationFailure: unknown = null
    try {
      await this.authorities.cancelAgentControl(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch)
    } catch (error) {
      revocationFailure = error
    }
    // Epoch revocation happens before physical detach; reset waits for every tracked command to
    // settle, so later work can never overtake an ambiguous command from this operation.
    await this.controlSessions.detach(params.tabId, reason)
    if (revocationFailure !== null) throw errorFromUnknown(revocationFailure, 'operation authority revocation failed')
    const authority = this.authorities.forTab(params.tabId)
    if (authority?.state === 'idle') this.broadcastState([params.tabId], 'human')
  }

  private async expirePhysicalSession(tabId: number, reason: 'idle-timeout' | 'maximum-lifetime'): Promise<void> {
    const authority = this.authorities.forTab(tabId)
    if (authority === null) {
      await this.controlSessions.detach(tabId, reason).catch(() => undefined)
      return
    }
    try {
      let revocationFailure: unknown = null
      if (authority.state === 'agent') {
        try { await this.authorities.cancelAgentControl(authority.ownerId, authority.ownerEpoch, tabId, authority.controlEpoch) }
        catch (error) { revocationFailure = error }
      }
      await this.controlSessions.detach(tabId, reason)
      if (revocationFailure !== null) throw errorFromUnknown(revocationFailure, 'expired operation authority revocation failed')
      if (this.authorities.forTab(tabId)?.state === 'idle') this.broadcastState([tabId], 'human')
    } catch {
      // Failed detach cannot be represented as idle physical state. Retain exact lost authority so
      // Desktop release/reconnect must retry instead of admitting another operation.
      await this.authorities.markLost(tabId).catch(() => undefined)
    }
  }

  private async expireAuthorities(): Promise<void> {
    const owners = new Map(this.authorities.expired().map((record) => [`${record.ownerId}\0${record.ownerEpoch}`, record] as const))
    for (const record of owners.values()) await this.terminateOwner(record.ownerId, record.ownerEpoch, 'lease-expired').catch(() => undefined)
    if (this.native !== null && !this.native.isConnected()) { this.native.stop(); this.native.start() }
  }

  private terminateTab(tabId: number, reason: PhysicalDebuggerDetachReason): Promise<number[]> {
    const authority = this.authorities.forTab(tabId)
    return authority === null ? Promise.resolve([]) : this.terminateOwner(authority.ownerId, authority.ownerEpoch, reason)
  }

  private terminateAll(reason: PhysicalDebuggerDetachReason): Promise<void> {
    const owners = new Map(this.authorities.all().map((record) => [`${record.ownerId}\0${record.ownerEpoch}`, record] as const))
    return Promise.allSettled([...owners.values()].map((record) => this.terminateOwner(record.ownerId, record.ownerEpoch, reason))).then((results) => {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) throw errorFromUnknown(failure.reason, 'terminal debugger cleanup failed')
    })
  }

  private terminateOwner(
    ownerId: string,
    ownerEpoch: number,
    reason: PhysicalDebuggerDetachReason,
    acknowledgedDetached = new Set<number>(),
  ): Promise<number[]> {
    return this.serializeTerminalCleanup(async () => {
      this.cleanupAttempts += 1
      try {
        const tabIds = this.authorities.activeReleaseScope(ownerId, ownerEpoch)
        let revocationFailure: unknown = null
        for (const tabId of tabIds) {
          if (this.authorities.forTab(tabId)?.state === 'lost') continue
          try { await this.authorities.markLost(tabId) } catch (error) { revocationFailure ??= error }
        }
        for (const tabId of tabIds) {
          if (acknowledgedDetached.has(tabId)) continue
          const session = this.controlSessions.forTab(tabId)
          if (session !== null) await this.controlSessions.detach(tabId, reason)
          else if (this.debuggers.state(tabId) === 'ATTACHING' || this.debuggers.state(tabId) === 'ATTACHED' || this.debuggers.state(tabId) === 'DETACHING' || this.debuggers.state(tabId) === 'LOST') {
            await this.debuggers.reset(tabId)
          }
        }
        if (revocationFailure !== null) throw errorFromUnknown(revocationFailure, 'terminal authority revocation failed')
        this.broadcastState(tabIds, 'detached')
        for (const tabId of tabIds) this.disconnectBridges(tabId, false)
        const released = await this.authorities.releaseOwner(ownerId, ownerEpoch)
        for (const tabId of released) {
          this.operations.clear(tabId)
          this.humanInterruptedOperations.delete(tabId)
        }
        if (released.length > 0) this.notifyLeaseChanged(ownerId, ownerEpoch, 'released', released)
        this.cleanupCompleted += 1
        return released
      } catch (error) {
        this.cleanupFailures += 1
        throw error
      }
    })
  }

  private serializeTerminalCleanup<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.terminalCleanupTail.then(operation, operation)
    this.terminalCleanupTail = result.then(() => undefined, () => undefined)
    return result
  }

  private serializeAuthorityWork<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.authorityRequestTail.then(operation, operation)
    this.authorityRequestTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async retryClosedTabReceipts(): Promise<void> {
    this.cleanupRetries += 1
    for (const tabId of [...this.pendingClosedTabReceipts]) {
      const authority = this.authorities.forTab(tabId)
      if (authority === null) {
        this.pendingClosedTabReceipts.delete(tabId)
        continue
      }
      try {
        await this.chrome.tabs.get(tabId)
        // An observable target means target-loss proof is no longer available; retain authority.
        continue
      } catch { /* target remains physically gone */ }
      this.cleanupAttempts += 1
      try {
        await this.authorities.recordClosedTab(authority.ownerId, authority.ownerEpoch, tabId)
        this.pendingClosedTabReceipts.delete(tabId)
        this.cleanupCompleted += 1
        this.notifyLeaseChanged(authority.ownerId, authority.ownerEpoch, 'released', [tabId])
      } catch {
        this.cleanupFailures += 1
      }
    }
    if (this.pendingClosedTabReceipts.size > 0) this.chrome.alarms.create(CLEANUP_RETRY_ALARM, { delayInMinutes: 0.5 })
    else await this.chrome.alarms.clear(CLEANUP_RETRY_ALARM)
  }

  private reportAuthoritySnapshot(): void {
    try {
      this.native?.sendNotification('browser.authoritySnapshot', {
        protocolVersion: 1,
        snapshotId: crypto.randomUUID(),
        reports: this.authorities.releaseReports().map((report) => ({
          leaseId: report.ownerId,
          leaseEpoch: report.ownerEpoch,
          state: report.state,
          tabIds: [...report.tabIds].sort((left, right) => left - right),
        })),
      })
    } catch { /* Desktop retains every unresolved acquisition/checkpoint/ack journal. */ }
  }

  private notifyLeaseChanged(ownerId: string, ownerEpoch: number, state: 'acquired' | 'released', tabIds: number[]): void {
    if (tabIds.length === 0) return
    try {
      this.native?.sendNotification('browser.leaseChanged', {
        protocolVersion: 1,
        leaseId: ownerId,
        leaseEpoch: ownerEpoch,
        state,
        tabIds: [...tabIds].sort((left, right) => left - right),
      })
    } catch { /* Desktop retains its exact checkpoint until request acknowledgement */ }
  }

  private bridgeKey(tabId: number, frameId: number, documentId: string): string {
    return `${tabId}\0${frameId}\0${documentId}`
  }

  private bridgesForTab(tabId: number): ContentBridgeRecord[] {
    return [...(this.bridgeKeysByTab.get(tabId) ?? [])].flatMap((key) => {
      const bridge = this.contentBridges.get(key)
      return bridge === undefined ? [] : [bridge]
    })
  }

  private readyBridges(tabId: number): ContentBridgeRecord[] {
    return this.bridgesForTab(tabId).filter((bridge) => bridge.ready)
  }

  private removeBridge(bridge: ContentBridgeRecord): void {
    if (this.contentBridges.get(bridge.key) !== bridge) return
    this.contentBridges.delete(bridge.key)
    const tabKeys = this.bridgeKeysByTab.get(bridge.tabId)
    tabKeys?.delete(bridge.key)
    if (tabKeys?.size === 0) this.bridgeKeysByTab.delete(bridge.tabId)
    this.bridgesDisconnected += 1
    for (const acknowledgement of this.syntheticAcknowledgements.values()) {
      if (acknowledgement.pending.delete(bridge.port)) {
        acknowledgement.reject(new Error('trusted-input guard disconnected before acknowledgement'))
      }
    }
  }

  private disconnectBridges(tabId: number, broadcast = true): void {
    const bridges = this.bridgesForTab(tabId)
    if (broadcast) this.broadcastState([tabId], 'detached')
    for (const bridge of bridges) {
      this.removeBridge(bridge)
      bridge.port.disconnect()
    }
  }
}

function errorFromUnknown(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export async function activateServiceWorker(identity: VerifiedPayloadIdentity): Promise<ServiceWorkerPayload> {
  const runtime = new Runtime(); await runtime.initialize(identity); return runtime
}
