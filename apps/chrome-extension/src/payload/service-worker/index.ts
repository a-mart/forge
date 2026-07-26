import type {
  BrowserAutomationResultByOperation,
  BrowserTabSnapshot,
  ExternalChromeChildPolicy,
  ExternalChromeJsonRpcMessage,
  ExternalChromeLeaseChangedParams,
  ExternalChromeRequest,
} from '@forge/protocol'
import { DebuggerController } from '../../runtime/debugger-controller.js'
import { installedChrome, type ChromeRuntimePort, type ChromeRuntimeSender, type ChromeTab } from '../../runtime/chrome-api.js'
import { SyntheticInputSequencer, type SyntheticInputOperation } from '../../runtime/human-control.js'
import { PAYLOAD_VERSION } from '../../runtime/identity.js'
import { LeaseError, LeaseManager } from '../../runtime/lease-manager.js'
import { restrictedTargetReason } from '../../runtime/restricted-target.js'
import { NativeRpcClient } from '../../runtime/native-rpc-client.js'
import { ExternalChromeOperationExecutor } from '../../runtime/operation-executor.js'
import type { ServiceWorkerPayload, ShellEventName, VerifiedPayloadIdentity } from '../../shell/service-worker-bootstrap.js'
import { loadVerifiedPayloadSelector } from '../../shell/selector.js'

const INSTANCE_KEY = 'forge.externalChrome.instanceId.v1'
const PROFILE_ALIAS_KEY = 'forge.externalChrome.profileAlias.v1'
const HEARTBEAT_ALARM = 'forge.externalChrome.heartbeat.v1'
const TRANSPORT_GRACE_ALARM = 'forge.externalChrome.transportGrace.v1'
const HANDOFF_TTL_MS = 2 * 60_000

interface ContentPort extends ChromeRuntimePort {
  sender?: ChromeRuntimeSender
}

type MessageResponse = (response: unknown) => void

interface PickerMessage {
  kind: 'picker.list' | 'picker.claim' | 'picker.create' | 'picker.release' | 'picker.current'
  leaseId?: string
  leaseEpoch?: number
  sessionAgentId?: string
  tabIds?: number[]
  groupId?: number
  childPolicy?: ExternalChromeChildPolicy
  url?: string
  groupTitle?: string
}

function isPickerMessage(value: unknown): value is PickerMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return ['picker.list', 'picker.claim', 'picker.create', 'picker.release', 'picker.current'].includes(String((value as Record<string, unknown>).kind))
}

function chromeVersion(): string {
  return /Chrom(?:e|ium)\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? 'unknown'
}

function selectedTab(tab: ChromeTab): Record<string, unknown> {
  const url = tab.url ?? ''
  let origin = ''
  try { origin = new URL(url).origin } catch { /* validated before selection */ }
  return {
    windowId: tab.windowId ?? 0,
    tabId: tab.id ?? 0,
    groupId: tab.groupId === undefined || tab.groupId < 0 ? null : tab.groupId,
    title: tab.title ?? '',
    url,
    origin,
    active: tab.active === true,
  }
}

function validatePayloadIdentity(identity: VerifiedPayloadIdentity): VerifiedPayloadIdentity {
  if (!/^[a-f0-9]{64}$/u.test(identity.sha256)) throw new Error('payload has no immutable SHA-256 identity')
  if (identity.directory !== `${PAYLOAD_VERSION}-${identity.sha256}`) throw new Error('payload directory does not match runtime version and hash')
  return identity
}

export class Runtime implements ServiceWorkerPayload {
  private readonly chrome = installedChrome()
  private readonly leases = new LeaseManager(this.chrome, PAYLOAD_VERSION)
  private readonly debuggers = new DebuggerController(this.chrome.debugger)
  private readonly operations = new ExternalChromeOperationExecutor(this.debuggers, (tabId) => this.chrome.tabs.get(tabId))
  private readonly contentPorts = new Map<number, Set<ContentPort>>()
  private readonly pendingChildren = new Map<number, number>()
  private readonly pendingSynthetic = new Map<string, {
    controlEpoch: number
    expected: Set<ContentPort>
    acknowledged: Set<ContentPort>
    resolve: (value: { operationId: string; controlEpoch: number }) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly syntheticInput = new SyntheticInputSequencer({
    beginAgentControl: (operation) => this.leases.beginAgentControl(operation.leaseId, operation.leaseEpoch, operation.tabId),
    signalStart: (operation, operationId, controlEpoch) => this.signalSyntheticStart(operation.tabId, operationId, controlEpoch),
    isCurrent: (operation, controlEpoch) => this.leases.isOperationCurrent(operation.leaseId, operation.leaseEpoch, controlEpoch),
    sendCdpInput: (operation) => this.debuggers.sendInput(operation.tabId, operation.method, operation.params),
    signalEnd: (operation, operationId, controlEpoch) => this.signalSyntheticEnd(operation.tabId, operationId, controlEpoch),
    randomId: () => crypto.randomUUID(),
  })
  private native: NativeRpcClient | null = null
  private directory = ''
  private payloadSha256 = ''
  private extensionInstanceId = ''
  private acceptingOperations = true
  private readonly authorityOperations = new Set<Promise<void>>()

  async initialize(verifiedIdentity: VerifiedPayloadIdentity): Promise<void> {
    const identity = validatePayloadIdentity(verifiedIdentity)
    this.directory = identity.directory
    this.payloadSha256 = identity.sha256
    const stored = await this.chrome.storage.local.get(INSTANCE_KEY)
    const extensionInstanceId = typeof stored[INSTANCE_KEY] === 'string' ? stored[INSTANCE_KEY] as string : crypto.randomUUID()
    this.extensionInstanceId = extensionInstanceId
    if (stored[INSTANCE_KEY] !== extensionInstanceId) await this.chrome.storage.local.set({ [INSTANCE_KEY]: extensionInstanceId })
    const aliasState = await this.chrome.storage.local.get(PROFILE_ALIAS_KEY)
    const profileAlias = typeof aliasState[PROFILE_ALIAS_KEY] === 'string' ? String(aliasState[PROFILE_ALIAS_KEY]).slice(0, 512) : undefined
    await this.chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    this.chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 })
    const recovered = await this.leases.recover()
    if (recovered !== null) {
      if (recovered.state === 'LOST') {
        for (const tabId of recovered.tabIds) await this.debuggers.reconcileForRelease(tabId, this.chrome.runtime.id)
      } else if (recovered.state !== 'HANDOFF') {
        try {
          for (const tabId of recovered.tabIds) await this.attachTab(tabId)
        } catch {
          await this.releaseDebuggerAuthority(recovered.leaseId, recovered.leaseEpoch).catch(() => undefined)
        }
      }
    }
    this.native = new NativeRpcClient({
      connect: (hostName) => this.chrome.runtime.connectNative(hostName),
      extensionInstanceId,
      chromeVersion: chromeVersion(),
      payloadSha256: this.payloadSha256,
      ...(profileAlias ? { profileAlias } : {}),
      onConnected: () => {
        void this.chrome.alarms.clear(TRANSPORT_GRACE_ALARM)
        const lease = this.leases.current()
        if (lease?.state === 'LOST') void this.retryRetainedRelease(lease)
        else if (lease !== null) this.notifyLocalLease(lease, 'claimed')
      },
      onDisconnected: () => { this.chrome.alarms.create(TRANSPORT_GRACE_ALARM, { delayInMinutes: 0.1 }) },
      onRequest: (message) => this.handleDesktopRequest(message),
    })
    // Recovery and debugger reattachment complete before native hello. Desktop may now
    // reconcile its durable checkpoint without a hello deleting recoverable authority.
    this.native.start()
  }

  onShellEvent(name: ShellEventName, args: unknown[]): unknown {
    switch (name) {
      case 'action.clicked': {
        const tab = args[0] as ChromeTab | undefined
        void this.chrome.sidePanel.open(tab?.windowId === undefined ? {} : { windowId: tab.windowId })
        return undefined
      }
      case 'runtime.message': return this.handleMessage(args)
      case 'runtime.connect': this.handleConnect(args[0]); return undefined
      case 'debugger.event': void this.handleDebuggerEvent(args); return undefined
      case 'debugger.detach': void this.handleDebuggerDetach(args); return undefined
      case 'tab.removed': void this.handleTabRemoved(args[0]); return undefined
      case 'tab.created': void this.handleChildTab(args[0]); return undefined
      case 'tab.updated': void this.handleUpdatedTab(args); return undefined
      case 'navigation.committed': void this.handleNavigationCommitted(args[0]); return undefined
      case 'alarm': {
        const alarm = args[0] as { name?: string } | undefined
        if (alarm?.name === HEARTBEAT_ALARM) {
          void this.expireLeaseIfNeeded()
          if (this.native !== null && !this.native.isConnected()) {
            this.native.stop()
            this.native.start()
          }
        }
        if (alarm?.name === TRANSPORT_GRACE_ALARM && this.native?.isConnected() !== true) void this.handleTransportLoss()
        return undefined
      }
      default: return undefined
    }
  }

  shutdown(): void {
    this.native?.stop()
    const lease = this.leases.current()
    if (lease !== null) {
      this.clearOperationState(lease.tabIds)
      void this.leases.markLost()
    }
    void this.debuggers.detachAll()
  }

  private handleMessage(args: unknown[]): true {
    const message = args[0]
    const respond = args[2] as MessageResponse | undefined
    if (!isPickerMessage(message) || respond === undefined) {
      respond?.({ ok: false, error: { code: 'invalid-params', message: 'unsupported local extension message' } })
      return true
    }
    void this.dispatchPicker(message).then(
      (result) => respond({ ok: true, result }),
      (error: unknown) => respond({ ok: false, error: this.safeError(error) }),
    )
    return true
  }

  private async dispatchPicker(message: PickerMessage, authorityTracked = false): Promise<unknown> {
    if (message.kind === 'picker.list') return { windows: await this.leases.listCandidates(), lease: this.leases.current() }
    if (message.kind === 'picker.current') return { lease: this.leases.current() }
    if (!authorityTracked && (message.kind === 'picker.create' || message.kind === 'picker.claim')) {
      return this.trackAuthorityOperation(() => this.dispatchPicker(message, true))
    }
    // Quiesce is an authority barrier, not merely a Desktop transport gate. The
    // side panel remains able to inspect and to release the exact current lease,
    // but can never claim/create debugger authority after prepareUpdate begins.
    if (!this.acceptingOperations && (message.kind === 'picker.create' || message.kind === 'picker.claim')) {
      throw new LeaseError('lease-lost', 'runtime is quiesced for update')
    }
    if (message.kind === 'picker.create') {
      if (typeof message.leaseId !== 'string' || !Number.isSafeInteger(message.leaseEpoch) || typeof message.sessionAgentId !== 'string' || typeof message.groupTitle !== 'string') {
        throw new LeaseError('scope-mismatch', 'create fields are invalid')
      }
      const created = await this.leases.create({
        leaseId: message.leaseId, leaseEpoch: message.leaseEpoch as number, sessionAgentId: message.sessionAgentId,
        ...(message.url ? { url: message.url } : {}), groupTitle: message.groupTitle,
      })
      try {
        this.assertAcceptingAuthority()
        await this.attachTab(created.tab.id as number)
        this.assertAcceptingAuthority()
        this.leases.assertScope(created.lease.leaseId, created.lease.leaseEpoch, created.tab.id as number)
      } catch (error) {
        this.clearOperationState([created.tab.id as number])
        await this.debuggers.detach(created.tab.id as number).catch(() => undefined)
        await this.leases.rollbackCreatedTab(created.tab.id as number, created.lease.leaseId, created.lease.leaseEpoch)
        throw error
      }
      this.notifyLocalLease(created.lease, 'claimed')
      return { lease: created.lease, tab: selectedTab(created.tab) }
    }
    if (message.kind === 'picker.claim') {
      if (
        typeof message.leaseId !== 'string' || !Number.isSafeInteger(message.leaseEpoch) ||
        typeof message.sessionAgentId !== 'string' || !Array.isArray(message.tabIds) ||
        (message.childPolicy !== 'manual' && message.childPolicy !== 'include-opened-by-leased-tabs')
      ) throw new LeaseError('scope-mismatch', 'claim fields are invalid')
      const claimed = await this.leases.claim({
        leaseId: message.leaseId,
        leaseEpoch: message.leaseEpoch as number,
        sessionAgentId: message.sessionAgentId,
        tabIds: message.tabIds,
        ...(message.groupId === undefined ? {} : { groupId: message.groupId }),
        childPolicy: message.childPolicy,
      })
      try {
        this.assertAcceptingAuthority()
        for (const tabId of claimed.lease.tabIds) {
          await this.attachTab(tabId)
          this.assertAcceptingAuthority()
          this.leases.assertScope(claimed.lease.leaseId, claimed.lease.leaseEpoch, tabId)
        }
      } catch (error) {
        this.clearOperationState(claimed.lease.tabIds)
        await this.debuggers.detachAll()
        await this.leases.release(claimed.lease.leaseId, claimed.lease.leaseEpoch)
        throw new LeaseError('lease-lost', error instanceof Error ? error.message : 'debugger attach failed')
      }
      this.notifyLocalLease(claimed.lease, 'claimed')
      return { lease: claimed.lease, tabs: claimed.tabs.map(selectedTab) }
    }
    if (typeof message.leaseId !== 'string' || !Number.isSafeInteger(message.leaseEpoch)) throw new LeaseError('lease-lost', 'release fields are invalid')
    const lease = this.leases.current()
    const releasedTabIds = await this.releaseDebuggerAuthority(message.leaseId, message.leaseEpoch as number)
    if (lease !== null) {
      this.broadcastStatus(lease.tabIds, 'detached')
      this.notifyLocalLease(lease, 'released')
    }
    return { releasedTabIds }
  }

  private notifyLocalLease(lease: { leaseId: string; leaseEpoch: number; sessionAgentId: string; tabIds: number[]; groupId: number | null; childPolicy: ExternalChromeChildPolicy }, state: ExternalChromeLeaseChangedParams['state']): void {
    if (this.native?.isConnected() !== true) return
    try {
      this.native.sendNotification('browser.leaseChanged', {
        protocolVersion: 1, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch, state,
        tabIds: lease.tabIds, groupId: lease.groupId, childPolicy: lease.childPolicy,
      })
    } catch { /* reconnect/recovery reports the current local lease */ }
  }

  private async handleDesktopRequest(message: ExternalChromeJsonRpcMessage, authorityTracked = false): Promise<unknown> {
    if (!('method' in message) || !('id' in message)) throw new Error('Desktop message is not a request')
    const request = message as ExternalChromeRequest
    if (!this.acceptingOperations && ![
      'forge.runtime.ping', 'forge.runtime.prepareUpdate', 'forge.runtime.reload',
      'forge.browser.listCandidates', 'forge.browser.release',
    ].includes(request.method)) {
      throw new LeaseError('lease-lost', 'runtime is quiesced for update')
    }
    if (!authorityTracked && (request.method === 'forge.browser.claim' || request.method === 'forge.browser.create')) {
      return this.trackAuthorityOperation(() => this.handleDesktopRequest(message, true))
    }
    switch (request.method) {
      case 'forge.runtime.ping':
        return { protocolVersion: 1, nonce: request.params.nonce, receivedAt: new Date().toISOString() }
      case 'forge.browser.listCandidates':
        return {
          protocolVersion: 1,
          extensionInstanceId: this.extensionInstanceId,
          windows: await this.leases.listCandidates(),
        }
      case 'forge.browser.claim': {
        const claimed = await this.leases.claim(request.params)
        try {
          this.assertAcceptingAuthority()
          for (const tabId of claimed.lease.tabIds) {
            await this.attachTab(tabId)
            this.assertAcceptingAuthority()
            this.leases.assertScope(claimed.lease.leaseId, claimed.lease.leaseEpoch, tabId)
          }
        } catch (error) {
          this.clearOperationState(claimed.lease.tabIds)
          await this.debuggers.detachAll()
          await this.leases.release(claimed.lease.leaseId, claimed.lease.leaseEpoch)
          throw new LeaseError('lease-lost', error instanceof Error ? error.message : 'debugger attach failed')
        }
        return {
          protocolVersion: 1, leaseId: claimed.lease.leaseId, leaseEpoch: claimed.lease.leaseEpoch,
          sessionAgentId: claimed.lease.sessionAgentId, extensionInstanceId: this.extensionInstanceId,
          groupId: claimed.lease.groupId, childPolicy: claimed.lease.childPolicy, tabs: claimed.tabs.map(selectedTab),
        }
      }
      case 'forge.browser.create': {
        const created = await this.leases.create(request.params)
        try {
          this.assertAcceptingAuthority()
          await this.attachTab(created.tab.id as number)
          this.assertAcceptingAuthority()
          this.leases.assertScope(created.lease.leaseId, created.lease.leaseEpoch, created.tab.id as number)
        } catch (error) {
          this.clearOperationState([created.tab.id as number])
          await this.debuggers.detach(created.tab.id as number).catch(() => undefined)
          await this.leases.rollbackCreatedTab(created.tab.id as number, created.lease.leaseId, created.lease.leaseEpoch)
          throw new LeaseError('lease-lost', error instanceof Error ? error.message : 'debugger attach failed')
        }
        return {
          protocolVersion: 1, leaseId: created.lease.leaseId, leaseEpoch: created.lease.leaseEpoch,
          sessionAgentId: created.lease.sessionAgentId, extensionInstanceId: this.extensionInstanceId,
          groupId: created.lease.groupId as number, tab: selectedTab(created.tab),
        }
      }
      case 'forge.browser.release': {
        const releasedTabIds = await this.releaseDebuggerAuthority(request.params.leaseId, request.params.leaseEpoch)
        this.broadcastStatus(releasedTabIds, 'detached')
        return { protocolVersion: 1, leaseId: request.params.leaseId, leaseEpoch: request.params.leaseEpoch, releasedTabIds }
      }
      case 'forge.browser.execute':
        return this.executeDesktopRequest(request.params)
      case 'forge.browser.turnEnded': {
        const current = this.leases.current()
        if (current === null || current.leaseId !== request.params.leaseId || current.leaseEpoch !== request.params.leaseEpoch) {
          throw new LeaseError('lease-lost', 'turn disposition used stale lease authority')
        }
        const dispositions = [...request.params.finalTabs, ...request.params.handoffTabs]
        if (new Set(dispositions).size !== dispositions.length || dispositions.length !== current.tabIds.length ||
          [...dispositions].sort((a, b) => a - b).some((tabId, index) => tabId !== current.tabIds[index])) {
          throw new LeaseError('scope-mismatch', 'turn dispositions must exactly cover the leased tabs')
        }
        const detachResults = await Promise.allSettled(current.tabIds.map((tabId) => this.debuggers.detach(tabId)))
        if (detachResults.some((result) => result.status === 'rejected')) {
          await this.leases.markLost()
          this.clearOperationState(current.tabIds)
          throw new LeaseError('lease-lost', 'Chrome did not acknowledge every debugger detach at turn end')
        }
        const result = await this.leases.turnEnded(
          request.params.leaseId, request.params.leaseEpoch, request.params.finalTabs, request.params.handoffTabs, HANDOFF_TTL_MS,
        )
        // HANDOFF is the sole cache-preserving disposition. Final tabs can be
        // reclaimed by another lease immediately and must start diagnostically empty.
        this.clearOperationState(result.releasedTabs)
        this.broadcastStatus(result.releasedTabs, 'detached')
        this.broadcastStatus(result.handoffTabs, 'handoff')
        return {
          protocolVersion: 1, leaseId: request.params.leaseId, leaseEpoch: request.params.leaseEpoch,
          turnId: request.params.turnId, releasedTabs: result.releasedTabs, handoffTabs: result.handoffTabs,
        }
      }
      case 'forge.runtime.prepareUpdate': {
        // Flip the barrier before inspecting time or lease state so even an expired
        // request cannot race a local picker claim. Detach still runs to completion;
        // an elapsed deadline only withholds the acknowledgement.
        this.acceptingOperations = false
        const deadlineAt = Date.parse(request.params.deadlineAt)
        let deadlineMissed = !Number.isFinite(deadlineAt) || Date.now() >= deadlineAt
        // A prepare acknowledgement must be a true zero-authority barrier: wait
        // for pre-barrier picker/child/attach work to observe the barrier and undo.
        await Promise.allSettled([...this.authorityOperations])
        deadlineMissed ||= Date.now() >= deadlineAt
        const lease = this.leases.current()
        if (lease !== null) {
          try {
            const releasedTabIds = await this.releaseDebuggerAuthority(lease.leaseId, lease.leaseEpoch, deadlineAt)
            this.broadcastStatus(releasedTabIds, 'detached')
            this.notifyLocalLease(lease, 'released')
          } catch (error) {
            deadlineMissed ||= Date.now() >= deadlineAt
            if (!deadlineMissed) throw error
          }
        }
        deadlineMissed ||= Date.now() >= deadlineAt
        if (deadlineMissed) throw new Error('prepareUpdate deadline elapsed while detaching debugger authority')
        return { protocolVersion: 1, payloadVersion: request.params.payloadVersion, quiesced: true }
      }
      case 'forge.runtime.reload': {
        const selector = await loadVerifiedPayloadSelector((entry) => this.chrome.runtime.getURL(entry), 'service-worker.js')
        if (selector.payloadVersion !== request.params.payloadVersion || selector.payloadSha256 !== request.params.sha256) {
          throw new Error('selected payload does not match the authenticated reload request')
        }
        // The JSON-RPC response must reach Desktop before this worker invalidates its native port.
        setTimeout(() => this.chrome.runtime.reload(), 0)
        return { protocolVersion: 1, payloadVersion: request.params.payloadVersion, accepted: true }
      }
      case 'forge.runtime.hello':
        throw new Error(`${request.method} is not enabled by the current External Chrome runtime`)
    }
  }

  private async executeDesktopRequest(params: Extract<ExternalChromeRequest, { method: 'forge.browser.execute' }>['params']): Promise<unknown> {
    if (!this.acceptingOperations) throw new LeaseError('lease-lost', 'runtime is quiesced for update')
    let lease = this.leases.current()
    if (lease?.state === 'HANDOFF' && lease.leaseId === params.leaseId && lease.leaseEpoch === params.leaseEpoch && lease.tabIds.includes(params.tabId)) {
      const handoffTabs = [...lease.tabIds]
      try {
        this.assertAcceptingAuthority()
        for (const tabId of handoffTabs) {
          await this.attachTab(tabId)
          this.assertAcceptingAuthority()
        }
        lease = await this.leases.resumeHandoff(params.leaseId, params.leaseEpoch, params.tabId)
        this.assertAcceptingAuthority()
      } catch (error) {
        await this.leases.markLost()
        this.clearOperationState(handoffTabs)
        await this.debuggers.detachAll()
        this.broadcastStatus(handoffTabs, 'detached')
        throw error
      }
      this.broadcastStatus(handoffTabs, 'human')
    } else {
      lease = this.leases.assertScope(params.leaseId, params.leaseEpoch, params.tabId)
    }
    const expectedControlEpoch = lease.controlEpoch
    if (params.operation === 'status') {
      const tab = await this.chrome.tabs.get(params.tabId)
      const selectedTab = this.browserTabSnapshot(tab, lease.sessionAgentId)
      return {
        protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        tabId: params.tabId, operation: 'status', ok: true,
        result: {
          available: true,
          host: { hostKind: 'external-chrome', connected: true, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null },
          panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab,
        },
      }
    }
    if (params.operation !== 'navigate') {
      if (!['snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor'].includes(params.operation)) {
        return {
          protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
          tabId: params.tabId, operation: params.operation, ok: false,
          error: { code: 'unsupported-operation', message: `External Chrome does not support ${params.operation}.`, retryable: false },
        }
      }
      return this.executeFunctionalOperation(params)
    }
    if (Date.parse(params.deadlineAt) <= Date.now()) {
      return {
        protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        tabId: params.tabId, operation: params.operation, ok: false,
        error: { code: 'timeout', message: 'Navigation deadline elapsed.', retryable: true },
      }
    }
    const input = params.input as { url?: string; environmentPort?: number; environmentProtocol?: 'http' | 'https'; path?: string; readiness: 'load' | 'domContentLoaded' | 'none'; timeoutMs: number }
    const targetUrl = externalChromeNavigationUrl(input)
    if (targetUrl === null) {
      return {
        protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        tabId: params.tabId, operation: 'navigate', ok: false,
        error: { code: input.url || input.environmentPort ? 'restricted-target' : 'invalid-url', message: 'External Chrome navigation target is missing or restricted.', retryable: false },
      }
    }
    return this.operations.runExclusive(params.tabId, async () => {
      let controlEpoch: number
      try {
        controlEpoch = await this.leases.beginAgentControl(params.leaseId, params.leaseEpoch, params.tabId, expectedControlEpoch)
      } catch (error) {
        return this.controlStartFailure(params, expectedControlEpoch, error)
      }
      try {
        this.broadcastStatus([params.tabId], 'agent')
        const deadline = Math.min(Date.parse(params.deadlineAt), Date.now() + input.timeoutMs)
        try {
          await this.debuggers.navigateAndWait(
            params.tabId,
            targetUrl,
            input.readiness,
            deadline,
            () => this.leases.isOperationCurrent(params.leaseId, params.leaseEpoch, controlEpoch),
          )
        } catch (error) {
          const interrupted = !this.leases.isOperationCurrent(params.leaseId, params.leaseEpoch, controlEpoch)
          const timedOut = Date.now() >= deadline || /timed out/u.test(error instanceof Error ? error.message : String(error))
          await this.cancelOutstandingAndLoseLease(params.tabId)
          return {
            protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
            tabId: params.tabId, operation: 'navigate', ok: false,
            error: interrupted
              ? { code: 'control-interrupted', message: 'Trusted human input interrupted navigation.', retryable: true }
              : timedOut
                ? { code: 'timeout', message: `Navigation did not reach ${input.readiness} readiness.`, retryable: true }
                : { code: 'navigation-failed', message: 'Chrome navigation failed.', retryable: true },
          }
        }
        if (!this.leases.isOperationCurrent(params.leaseId, params.leaseEpoch, controlEpoch)) {
          await this.cancelOutstandingAndLoseLease(params.tabId)
          return {
            protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
            tabId: params.tabId, operation: 'navigate', ok: false,
            error: { code: 'control-interrupted', message: 'Trusted human input interrupted navigation.', retryable: true },
          }
        }
        const tab = await this.chrome.tabs.get(params.tabId)
        if (!this.leases.isOperationCurrent(params.leaseId, params.leaseEpoch, controlEpoch)) {
          await this.cancelOutstandingAndLoseLease(params.tabId)
          return {
            protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
            tabId: params.tabId, operation: 'navigate', ok: false,
            error: { code: 'control-interrupted', message: 'Lease authority changed before navigation completed.', retryable: true },
          }
        }
        const result: BrowserAutomationResultByOperation['navigate'] = {
          tab: this.browserTabSnapshot(tab, lease.sessionAgentId), readiness: input.readiness,
        }
        return {
          protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
          tabId: params.tabId, operation: 'navigate', ok: true, result,
        }
      } finally {
        if (await this.leases.finishAgentControl(params.leaseId, params.leaseEpoch, controlEpoch)) {
          this.broadcastStatus([params.tabId], 'human')
        }
      }
    })
  }

  private async executeFunctionalOperation(params: Extract<ExternalChromeRequest, { method: 'forge.browser.execute' }>['params']): Promise<unknown> {
    const expectedControlEpoch = this.leases.assertScope(params.leaseId, params.leaseEpoch, params.tabId).controlEpoch
    return this.operations.runExclusive(params.tabId, async () => {
      let controlEpoch: number
      try {
        controlEpoch = await this.leases.beginAgentControl(params.leaseId, params.leaseEpoch, params.tabId, expectedControlEpoch)
      } catch (error) {
        return this.controlStartFailure(params, expectedControlEpoch, error)
      }
      const navigationGeneration = this.debuggers.navigationGeneration(params.tabId)
      const protectedInput = params.operation === 'click' || params.operation === 'type' || params.operation === 'press'
      const operationId = protectedInput ? crypto.randomUUID() : null
      try {
        this.broadcastStatus([params.tabId], 'agent')
        if (operationId !== null) await this.signalSyntheticStart(params.tabId, operationId, controlEpoch)
        const outcome = await this.operations.executeNow(params, {
          navigationGeneration,
          isCurrent: () => this.leases.isOperationCurrent(params.leaseId, params.leaseEpoch, controlEpoch),
          wasHumanInterrupted: () => {
            const current = this.leases.current()
            return current?.leaseId === params.leaseId && current.leaseEpoch === params.leaseEpoch && current.controlEpoch > controlEpoch
          },
          cancelOutstanding: () => this.cancelOutstandingAndLoseLease(params.tabId),
        })
        return {
          protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
          tabId: params.tabId, operation: params.operation, ...outcome,
        }
      } catch (error) {
        const current = this.leases.current()
        const humanInterrupted = current?.leaseId === params.leaseId && current.leaseEpoch === params.leaseEpoch && current.controlEpoch > controlEpoch
        return {
          protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
          tabId: params.tabId, operation: params.operation, ok: false,
          error: humanInterrupted
            ? { code: 'control-interrupted', message: 'Trusted human input interrupted the operation.', retryable: true }
            : { code: 'execution-failed', message: error instanceof Error ? error.message.slice(0, 1_024) : 'External Chrome operation failed.', retryable: true },
        }
      } finally {
        if (operationId !== null) this.signalSyntheticEnd(params.tabId, operationId, controlEpoch)
        if (await this.leases.finishAgentControl(params.leaseId, params.leaseEpoch, controlEpoch)) this.broadcastStatus([params.tabId], 'human')
      }
    })
  }

  private controlStartFailure(
    params: Extract<ExternalChromeRequest, { method: 'forge.browser.execute' }>['params'],
    expectedControlEpoch: number,
    error: unknown,
  ): Record<string, unknown> {
    const current = this.leases.current()
    const humanInterrupted = current?.leaseId === params.leaseId && current.leaseEpoch === params.leaseEpoch && current.controlEpoch > expectedControlEpoch
    return {
      protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
      tabId: params.tabId, operation: params.operation, ok: false,
      error: humanInterrupted
        ? { code: 'control-interrupted', message: 'Trusted human input cancelled queued work before it started.', retryable: true }
        : { code: 'lease-lost', message: error instanceof Error ? error.message.slice(0, 1_024) : 'Lease authority changed before queued work started.', retryable: true },
    }
  }

  private async cancelOutstandingAndLoseLease(tabId: number): Promise<void> {
    await this.leases.markLost()
    const lease = this.leases.current()
    const tabIds = lease?.tabIds ?? [tabId]
    this.clearOperationState(tabIds)
    // A LOST lease revokes its entire tab scope. Settle every tab's outstanding
    // CDP callbacks before any per-tab queue can admit work from a later lease.
    await Promise.all(tabIds.map((leasedTabId) => this.debuggers.reset(leasedTabId)))
    if (lease !== null) this.broadcastStatus(tabIds, 'detached')
  }

  private browserTabSnapshot(tab: ChromeTab, sessionAgentId: string): BrowserTabSnapshot {
    const now = new Date().toISOString()
    return {
      hostKind: 'external-chrome', tabId: String(tab.id), sessionAgentId, profileId: this.extensionInstanceId,
      url: tab.url ?? '', title: tab.title ?? '', lifecycle: 'ready', loading: false, live: true,
      canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'human', agentCursor: null,
      recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false,
      error: null, createdAt: now, updatedAt: now,
    }
  }

  private async attachTab(tabId: number, authorityTracked = false): Promise<void> {
    if (!authorityTracked) return this.trackAuthorityOperation(() => this.attachTab(tabId, true))
    this.assertAcceptingAuthority()
    await this.debuggers.attach(tabId)
    await this.chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [`payloads/${this.directory}/content-script.js`],
      world: 'ISOLATED',
    })
    this.assertAcceptingAuthority()
  }

  private handleConnect(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const port = value as ContentPort
    const match = /^forge-leased-frame:([0-9a-f-]{36})$/.exec(port.name)
    const tabId = port.sender?.tab?.id
    if (match === null || tabId === undefined) {
      port.disconnect()
      return
    }
    try { this.leases.assertScope(this.leases.current()?.leaseId ?? '', this.leases.current()?.leaseEpoch ?? 0, tabId) } catch {
      port.disconnect()
      return
    }
    const ports = this.contentPorts.get(tabId) ?? new Set<ContentPort>()
    ports.add(port)
    this.contentPorts.set(tabId, ports)
    port.onMessage.addListener((message) => {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) return
      const event = message as Record<string, unknown>
      if (event.nonce !== match[1]) return
      if (event.type === 'synthetic-ack' && typeof event.operationId === 'string' && Number.isSafeInteger(event.controlEpoch)) {
        this.acknowledgeSynthetic(port, event.operationId, event.controlEpoch as number)
        return
      }
      if (event.type !== 'trusted-human-input') return
      void this.handleTrustedInput(tabId, event.event)
    })
    port.onDisconnect.addListener(() => {
      ports.delete(port)
      if (ports.size === 0) this.contentPorts.delete(tabId)
    })
  }

  private async handleTrustedInput(tabId: number, event: unknown): Promise<void> {
    // Content scripts emit only trusted events outside the acknowledged synthetic window. Any such
    // unmatched event interrupts, regardless of a stale observer epoch.
    const lease = await this.leases.trustedHumanInput(tabId)
    if (lease === null) return
    this.broadcastStatus([tabId], 'human')
    this.native?.sendNotification('browser.userControl', {
      protocolVersion: 1,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      tabId,
      controlEpoch: lease.controlEpoch,
      event: ['pointer', 'key', 'wheel', 'touch'].includes(String(event)) ? event as string : 'pointer',
      at: new Date().toISOString(),
    })
  }

  /** Qualified CDP primitive seam; native execute dispatch remains deliberately unadvertised in M1. */
  async runInputPrimitive(operation: SyntheticInputOperation): Promise<unknown> {
    return this.syntheticInput.run(operation)
  }

  private signalSyntheticStart(tabId: number, operationId: string, controlEpoch: number): Promise<{ operationId: string; controlEpoch: number }> {
    const expected = new Set(this.contentPorts.get(tabId) ?? [])
    if (expected.size === 0) return Promise.reject(new Error('no verified content frame acknowledged synthetic input'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSynthetic.delete(operationId)
        reject(new Error('synthetic input acknowledgement timed out'))
      }, 1_000)
      this.pendingSynthetic.set(operationId, { controlEpoch, expected, acknowledged: new Set(), resolve, reject, timer })
      for (const port of expected) {
        const nonce = port.name.slice('forge-leased-frame:'.length)
        port.postMessage({ type: 'synthetic-start', nonce, operationId, controlEpoch, durationMs: 1_000 })
      }
    })
  }

  private acknowledgeSynthetic(port: ContentPort, operationId: string, controlEpoch: number): void {
    const pending = this.pendingSynthetic.get(operationId)
    if (pending === undefined || pending.controlEpoch !== controlEpoch || !pending.expected.has(port)) return
    pending.acknowledged.add(port)
    if (pending.acknowledged.size !== pending.expected.size) return
    clearTimeout(pending.timer)
    this.pendingSynthetic.delete(operationId)
    pending.resolve({ operationId, controlEpoch })
  }

  private signalSyntheticEnd(tabId: number, operationId: string, controlEpoch: number): void {
    const pending = this.pendingSynthetic.get(operationId)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.pendingSynthetic.delete(operationId)
      pending.reject(new Error('synthetic input ended before acknowledgement'))
    }
    for (const port of this.contentPorts.get(tabId) ?? []) {
      const nonce = port.name.slice('forge-leased-frame:'.length)
      port.postMessage({ type: 'synthetic-end', nonce, operationId, controlEpoch })
    }
  }

  private async handleDebuggerEvent(args: unknown[]): Promise<void> {
    const source = args[0] as { tabId?: number; sessionId?: string }
    const method = typeof args[1] === 'string' ? args[1] : ''
    const accepted = await this.debuggers.onEvent(source, method, args[2])
    if (!accepted.accepted || source.tabId === undefined) return
    const routedSessionId = accepted.sessionId ?? source.sessionId
    const routedTargetId = accepted.targetId ?? this.debuggers.targetId(source.tabId, routedSessionId)
    if (routedTargetId !== undefined) this.operations.onCdpEvent(source.tabId, {
      targetId: routedTargetId, ...(routedSessionId === undefined ? {} : { sessionId: routedSessionId }),
    }, method, args[2])
    const lease = this.leases.current()
    if (lease === null || !lease.tabIds.includes(source.tabId)) return
    const targetId = routedTargetId
    if (targetId === undefined) return
    this.native?.sendNotification('browser.cdpEvent', {
      protocolVersion: 1,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      tabId: source.tabId,
      targetId,
      ...(accepted.sessionId === undefined && source.sessionId === undefined ? {} : { sessionId: accepted.sessionId ?? source.sessionId }),
      method,
      params: typeof args[2] === 'object' && args[2] !== null && !Array.isArray(args[2]) ? args[2] as Record<string, unknown> : {},
    })
  }

  private async handleDebuggerDetach(args: unknown[]): Promise<void> {
    const source = args[0] as { tabId?: number }
    const reason = typeof args[1] === 'string' ? args[1] : 'unknown'
    const notice = this.debuggers.onDetach(source, reason)
    const lease = this.leases.current()
    if (notice === null || lease === null || !lease.tabIds.includes(notice.tabId)) return
    await this.leases.markLost()
    this.clearOperationState(lease.tabIds)
    await this.debuggers.detachAll()
    this.broadcastStatus(lease.tabIds, 'detached')
    this.native?.sendNotification('browser.detached', {
      protocolVersion: 1,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      tabId: notice.tabId,
      reason: notice.devtoolsContention ? 'devtools-or-debugger-contention' : reason.slice(0, 256),
    })
  }

  private async handleChildTab(value: unknown): Promise<void> {
    if (!this.acceptingOperations) return
    const tab = value as ChromeTab | undefined
    if (tab?.id === undefined || tab.openerTabId === undefined) return
    const lease = this.leases.current()
    if (lease?.childPolicy !== 'include-opened-by-leased-tabs' || !lease.tabIds.includes(tab.openerTabId)) return
    if (!tab.url || tab.url === 'about:blank') {
      if (this.pendingChildren.size < 128) this.pendingChildren.set(tab.id, tab.openerTabId)
      return
    }
    await this.includeChild(tab.id, tab.openerTabId)
  }

  private async handleNavigationCommitted(value: unknown): Promise<void> {
    if (typeof value !== 'object' || value === null) return
    const details = value as { tabId?: unknown; frameId?: unknown }
    if (!Number.isSafeInteger(details.tabId) || !Number.isSafeInteger(details.frameId)) return
    const lease = this.leases.current()
    if (lease === null || lease.state === 'LOST' || !lease.tabIds.includes(details.tabId as number)) return
    try {
      await this.chrome.scripting.executeScript({
        target: { tabId: details.tabId as number, frameIds: [details.frameId as number] },
        files: [`payloads/${this.directory}/content-script.js`],
        world: 'ISOLATED',
      })
    } catch {
      // A committed restricted/transient frame cannot expand scope. Root debugger
      // loss is handled by debugger.detach; later committed leased frames retry.
    }
  }

  private async handleUpdatedTab(args: unknown[]): Promise<void> {
    const tabId = args[0]
    if (!Number.isSafeInteger(tabId)) return
    const openerTabId = this.pendingChildren.get(tabId as number)
    if (openerTabId === undefined) return
    const tab = args[2] as ChromeTab | undefined
    if (!tab?.url || tab.url === 'about:blank') return
    this.pendingChildren.delete(tabId as number)
    await this.includeChild(tabId as number, openerTabId)
  }

  private async includeChild(tabId: number, openerTabId: number, authorityTracked = false): Promise<void> {
    if (!this.acceptingOperations) return
    if (!authorityTracked) return this.trackAuthorityOperation(() => this.includeChild(tabId, openerTabId, true))
    const lease = await this.leases.includeChild(tabId, openerTabId)
    if (lease === null) return
    try {
      this.assertAcceptingAuthority()
      await this.attachTab(tabId)
      this.assertAcceptingAuthority()
      this.leases.assertScope(lease.leaseId, lease.leaseEpoch, tabId)
    } catch {
      const current = this.leases.current()
      if (current?.leaseId === lease.leaseId && current.leaseEpoch === lease.leaseEpoch && current.tabIds.includes(tabId)) {
        await this.leases.markLost()
        this.clearOperationState(current.tabIds)
        await this.debuggers.detachAll()
      } else {
        await this.debuggers.detach(tabId).catch(() => undefined)
      }
      return
    }
    this.notifyLocalLease(lease, 'claimed')
    this.native?.sendNotification('browser.tabChanged', {
      protocolVersion: 1, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch, tabId,
      change: { groupId: lease.groupId },
    })
  }

  private async handleTabRemoved(tabId: unknown): Promise<void> {
    if (Number.isSafeInteger(tabId)) this.pendingChildren.delete(tabId as number)
    if (!Number.isSafeInteger(tabId)) return
    const lease = this.leases.current()
    if (lease?.tabIds.includes(tabId as number) !== true) return
    await this.leases.markLost()
    this.clearOperationState(lease.tabIds)
    await this.debuggers.detachAll()
    this.broadcastStatus(lease.tabIds, 'detached')
  }

  private async retryRetainedRelease(lease: NonNullable<ReturnType<LeaseManager['current']>>): Promise<void> {
    try { await this.releaseDebuggerAuthority(lease.leaseId, lease.leaseEpoch) } catch { return }
    this.broadcastStatus(lease.tabIds, 'detached')
    this.notifyLocalLease(lease, 'released')
  }

  private async expireLeaseIfNeeded(): Promise<void> {
    const lease = await this.leases.expireIfNeeded()
    if (lease === null) return
    this.clearOperationState(lease.tabIds)
    try {
      await this.releaseDebuggerAuthority(lease.leaseId, lease.leaseEpoch)
    } catch {
      // Durable LOST authority is intentionally retained. The heartbeat retries
      // until every debugger detach is acknowledged.
      return
    }
    this.broadcastStatus(lease.tabIds, 'detached')
    this.notifyLocalLease(lease, 'released')
  }

  private assertAcceptingAuthority(): void {
    if (!this.acceptingOperations) throw new LeaseError('lease-lost', 'runtime is quiesced for update')
  }

  private trackAuthorityOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.assertAcceptingAuthority()
    const result = Promise.resolve().then(operation)
    const tracked = result.then(() => undefined, () => undefined)
    this.authorityOperations.add(tracked)
    void tracked.finally(() => this.authorityOperations.delete(tracked))
    return result
  }

  private async releaseDebuggerAuthority(leaseId: string, leaseEpoch: number, deadlineAt?: number): Promise<number[]> {
    const current = this.leases.current()
    if (current?.leaseId === leaseId && current.leaseEpoch === leaseEpoch) this.clearOperationState(current.tabIds)
    return releaseLeaseDebuggerAuthority(this.leases, this.debuggers, leaseId, leaseEpoch, deadlineAt)
  }

  private clearOperationState(tabIds: number[]): void {
    for (const tabId of tabIds) this.operations.clear(tabId)
  }

  private async handleTransportLoss(): Promise<void> {
    const lease = this.leases.current()
    if (lease === null) return
    await this.leases.markLost()
    this.clearOperationState(lease.tabIds)
    await this.debuggers.detachAll()
    this.broadcastStatus(lease.tabIds, 'detached')
  }

  private broadcastStatus(tabIds: number[], state: 'human' | 'agent' | 'handoff' | 'detached'): void {
    for (const tabId of tabIds) for (const port of this.contentPorts.get(tabId) ?? []) {
      const nonce = port.name.slice('forge-leased-frame:'.length)
      port.postMessage({ type: 'status', nonce, state })
    }
  }

  private safeError(error: unknown): Record<string, unknown> {
    if (error instanceof LeaseError) return { code: error.code, message: error.message.slice(0, 256), retryable: error.code === 'target-not-found' }
    return { code: 'debugger-unavailable', message: error instanceof Error ? error.message.slice(0, 256) : 'Chrome operation failed', retryable: true }
  }
}

export async function releaseLeaseDebuggerAuthority(
  leases: LeaseManager,
  debuggers: DebuggerController,
  leaseId: string,
  leaseEpoch: number,
  deadlineAt?: number,
): Promise<number[]> {
  const tabIds = await leases.beginRelease(leaseId, leaseEpoch)
  let deadlineMissed = deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt)
  const results = await Promise.allSettled(tabIds.map(async (tabId) => {
    deadlineMissed ||= deadlineAt !== undefined && Date.now() >= deadlineAt
    await debuggers.reset(tabId)
    deadlineMissed ||= deadlineAt !== undefined && Date.now() >= deadlineAt
  }))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
  await leases.completeRelease(leaseId, leaseEpoch)
  deadlineMissed ||= deadlineAt !== undefined && Date.now() >= deadlineAt
  if (deadlineMissed) throw new Error('prepareUpdate deadline elapsed while detaching debugger authority')
  return tabIds
}

function safeEnvironmentPath(value: string | undefined): string {
  if (value === undefined || value === '') return '/'
  if (value.length > 16_384 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value) || /%(?:2f|5c|40|3a|3f|23|25)/iu.test(value)) throw new Error('ambiguous environment path')
  return value
}

export function externalChromeNavigationUrl(input: {
  url?: string
  environmentPort?: number
  environmentProtocol?: 'http' | 'https'
  path?: string
}): string | null {
  let url = input.url ?? ''
  if (url === '' && Number.isSafeInteger(input.environmentPort) && input.environmentPort! >= 1 && input.environmentPort! <= 65_535) {
    const protocol = input.environmentProtocol ?? 'http'
    try {
      const path = safeEnvironmentPath(input.path)
      const base = new URL(`${protocol}://127.0.0.1:${input.environmentPort}/`)
      const environmentUrl = new URL(path, base)
      const effectivePort = environmentUrl.port || (environmentUrl.protocol === 'https:' ? '443' : '80')
      if (environmentUrl.protocol !== `${protocol}:` || environmentUrl.hostname !== '127.0.0.1' ||
        effectivePort !== String(input.environmentPort) || environmentUrl.username !== '' || environmentUrl.password !== '') return null
      url = environmentUrl.href
    } catch { return null }
  }
  return restrictedTargetReason(url) === null ? url : null
}

export async function activateServiceWorker(identity: VerifiedPayloadIdentity): Promise<ServiceWorkerPayload> {
  const runtime = new Runtime()
  await runtime.initialize(identity)
  return runtime
}
