import {
  EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
  type BrowserAutomationResultByOperation,
  type BrowserTabSnapshot,
  type ExternalChromeExecuteParams,
  type ExternalChromeJsonRpcMessage,
  type ExternalChromeRequest,
} from '@forge/protocol'
import { DebuggerAttachConflictError, DebuggerController } from '../../runtime/debugger-controller.js'
import { installedChrome, type ChromeRuntimePort, type ChromeRuntimeSender, type ChromeTab } from '../../runtime/chrome-api.js'
import { PAYLOAD_VERSION } from '../../runtime/identity.js'
import { LeaseError, LeaseManager, type TabAuthorityRecord } from '../../runtime/lease-manager.js'
import { NativeRpcClient } from '../../runtime/native-rpc-client.js'
import { ExternalChromeOperationExecutor } from '../../runtime/operation-executor.js'
import { restrictedTargetReason } from '../../runtime/restricted-target.js'
import type { ServiceWorkerPayload, ShellEventName, VerifiedPayloadIdentity } from '../../shell/service-worker-bootstrap.js'
import { loadVerifiedPayloadSelector } from '../../shell/selector.js'

const INSTANCE_KEY = 'forge.externalChrome.instanceId.v1'
const HEARTBEAT_ALARM = 'forge.externalChrome.heartbeat.v2'
const TRANSPORT_GRACE_ALARM = 'forge.externalChrome.transportGrace.v2'
const TRANSPORT_GRACE_DELAY_MINUTES = 0.5

type ContentPort = ChromeRuntimePort & { sender?: ChromeRuntimeSender }

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
  return { tabId: tab.id ?? 0, title: tab.title ?? '', url: tab.url ?? '', active: tab.active === true }
}

export class Runtime implements ServiceWorkerPayload {
  private readonly chrome = installedChrome()
  private readonly authorities = new LeaseManager(this.chrome, PAYLOAD_VERSION)
  private readonly debuggers = new DebuggerController(this.chrome.debugger)
  private readonly operations = new ExternalChromeOperationExecutor(this.debuggers, (tabId) => this.chrome.tabs.get(tabId))
  private readonly contentPorts = new Map<number, Set<ContentPort>>()
  private readonly readyContentPorts = new Map<number, Set<ContentPort>>()
  private readonly syntheticAcknowledgements = new Map<string, {
    pending: Set<ContentPort>
    controlEpoch: number
    resolve: () => void
  }>()
  private readonly activeOperations = new Map<number, Promise<void>>()
  private readonly initialNavigations = new Map<number, InitialNavigationTransition>()
  private native: NativeRpcClient | null = null
  private directory = ''
  private extensionInstanceId = ''
  private acceptingOperations = true

  async initialize(identity: VerifiedPayloadIdentity): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(identity.sha256) || identity.directory !== `${PAYLOAD_VERSION}-${identity.sha256}`) throw new Error('invalid immutable payload identity')
    this.directory = identity.directory
    const stored = await this.chrome.storage.local.get(INSTANCE_KEY)
    this.extensionInstanceId = typeof stored[INSTANCE_KEY] === 'string' ? String(stored[INSTANCE_KEY]) : crypto.randomUUID()
    if (stored[INSTANCE_KEY] !== this.extensionInstanceId) await this.chrome.storage.local.set({ [INSTANCE_KEY]: this.extensionInstanceId })
    const recovered = await this.authorities.recover()
    // Recovery restores only CAS ownership. Prove and release any debugger control that
    // survived a service-worker crash; never adopt a foreign debugger.
    for (const authority of recovered) {
      await this.debuggers.reconcileForRelease(authority.tabId, this.chrome.runtime.id)
      if (this.debuggers.state(authority.tabId) === 'ATTACHED') await this.debuggers.reset(authority.tabId)
      else if (this.debuggers.state(authority.tabId) === 'LOST') await this.authorities.markLost(authority.tabId)
    }
    this.chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 })
    this.native = new NativeRpcClient({
      connect: (host) => this.chrome.runtime.connectNative(host),
      extensionInstanceId: this.extensionInstanceId,
      chromeVersion: chromeVersion(),
      payloadSha256: identity.sha256,
      onDisconnected: () => {
        this.chrome.alarms.create(TRANSPORT_GRACE_ALARM, { delayInMinutes: TRANSPORT_GRACE_DELAY_MINUTES })
        // Chrome's Native Messaging port disconnect is the prompt reconnect
        // edge. The 30s-compliant alarm is only a durable fallback for a
        // worker that suspends before the in-memory retry can run.
        this.native?.reconnectNow()
      },
      onConnected: () => { void this.chrome.alarms.clear(TRANSPORT_GRACE_ALARM) },
      onRequest: (message) => this.handleDesktopRequest(message),
    })
    this.native.start()
  }

  onShellEvent(name: ShellEventName, args: unknown[]): unknown {
    switch (name) {
      case 'runtime.connect': this.handleConnect(args[0]); return undefined
      case 'debugger.event': void this.handleDebuggerEvent(args); return undefined
      case 'debugger.detach': void this.handleDebuggerDetach(args); return undefined
      case 'tab.removed': void this.handleTabRemoved(args[0]); return undefined
      case 'navigation.committed': void this.handleNavigationCommitted(args[0]); return undefined
      case 'navigation.domContentLoaded': void this.handleNavigationMilestone(args[0], 'domContentLoaded'); return undefined
      case 'navigation.completed': void this.handleNavigationMilestone(args[0], 'completed'); return undefined
      case 'alarm': {
        const alarm = args[0] as { name?: string } | undefined
        if (alarm?.name === HEARTBEAT_ALARM) void this.expireAuthorities()
        if (alarm?.name === TRANSPORT_GRACE_ALARM && this.native?.isConnected() !== true) {
          // A suspended MV3 worker can lose NativeRpcClient's in-memory retry timer.
          // The durable alarm is the recovery edge after Desktop closes an old epoch.
          this.native?.stop()
          this.native?.start()
          void this.detachAllOperations()
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

  shutdown(): void { this.native?.stop(); void this.detachAllOperations() }

  private async handleDesktopRequest(message: ExternalChromeJsonRpcMessage): Promise<unknown> {
    if (!('method' in message) || !('id' in message)) throw new Error('Desktop message is not a request')
    const request = message as ExternalChromeRequest
    if (!this.acceptingOperations && !['forge.runtime.ping', 'forge.runtime.prepareUpdate', 'forge.runtime.reload', 'forge.browser.release'].includes(request.method)) {
      throw new LeaseError('lease-lost', 'runtime is quiesced')
    }
    switch (request.method) {
      case 'forge.runtime.ping': return { protocolVersion: 1, nonce: request.params.nonce, receivedAt: new Date().toISOString() }
      case 'forge.browser.focusedEligibility':
        return { protocolVersion: 1, eligible: await this.authorities.focusedEligibleTab() !== null }
      case 'forge.browser.acquire': {
        // URL dispatch belongs to forge.browser.execute so it receives exact
        // operation authority, deadline, readiness, and no-replay handling.
        if (request.params.url !== undefined) throw new LeaseError('scope-mismatch', 'acquire cannot dispatch a URL')
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
          const allocated = await this.authorities.allocateAutomaticTab({ reuseFocused: request.params.reuseFocused })
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
        const tabIds = this.authorities.activeReleaseScope(request.params.leaseId, request.params.leaseEpoch)
        await Promise.all(tabIds.map((tabId) => this.debuggers.reset(tabId)))
        this.broadcastState(tabIds, 'detached')
        const releasedTabIds = await this.authorities.releaseOwner(request.params.leaseId, request.params.leaseEpoch)
        for (const tabId of releasedTabIds) this.operations.clear(tabId)
        return { protocolVersion: 1, leaseId: request.params.leaseId, leaseEpoch: request.params.leaseEpoch, releasedTabIds }
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
        await Promise.allSettled([...this.activeOperations.values()])
        await this.detachAllOperations()
        const records = this.authorities.all()
        this.broadcastState(records.map((entry) => entry.tabId), 'detached')
        const owners = new Map(records.map((entry) => [`${entry.ownerId}\0${entry.ownerEpoch}`, entry] as const))
        for (const owner of owners.values()) await this.authorities.releaseOwner(owner.ownerId, owner.ownerEpoch)
        if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error('prepareUpdate deadline elapsed')
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
    const authority = this.authorities.assertScope(params.leaseId, params.leaseEpoch, params.tabId)
    if (params.operation === 'status') return this.executeResponse(params, true, { available: true, host: { connected: true, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null }, panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: this.browserTab(await this.chrome.tabs.get(params.tabId), authority) })
    if (!['navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor'].includes(params.operation)) return this.executeFailure(params, 'unsupported-operation', `External Chrome does not support ${params.operation}.`, false)
    return this.operations.runExclusive(params.tabId, async () => {
      let resolveTracked!: () => void
      const tracked = new Promise<void>((resolve) => { resolveTracked = resolve })
      this.activeOperations.set(params.tabId, tracked)
      let controlEpoch: number | null = null
      let syntheticOperationId: string | null = null
      try {
        if (!this.acceptingOperations || Date.parse(params.deadlineAt) <= Date.now()) return this.executeFailure(params, 'timeout', 'Operation deadline elapsed.', true)
        let operationAuthority = this.authorities.assertScope(params.leaseId, params.leaseEpoch, params.tabId)
        const currentTab = await this.chrome.tabs.get(params.tabId)
        const neutralInitialTarget = operationAuthority.createdByForge && operationAuthority.initialNavigationPending && currentTab.url === 'about:blank'
        const currentRestriction = restrictedTargetReason(currentTab.url)
        if (currentRestriction !== null && !neutralInitialTarget) {
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

        const expectedEpoch = operationAuthority.controlEpoch
        if (neutralInitialTarget && navigateInput !== null) {
          controlEpoch = await this.authorities.beginAgentControl(params.leaseId, params.leaseEpoch, params.tabId, expectedEpoch)
          const isCurrent = () => this.authorities.isOperationCurrent(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch as number)
          const authorityCurrent = () => this.authorities.isAuthorityCurrent(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch as number)
          const deadline = Math.min(Date.parse(params.deadlineAt), Date.now() + navigateInput.timeoutMs)
          try {
            const tab = await this.navigateInitialTarget(params, navigateInput.url as string, navigateInput.readiness, deadline, isCurrent, authorityCurrent)
            if (!isCurrent()) return this.executeFailure(params, 'control-interrupted', 'Human input interrupted navigation.', true)
            const result: BrowserAutomationResultByOperation['navigate'] = { tab: this.browserTab(tab, operationAuthority), readiness: navigateInput.readiness }
            return this.executeResponse(params, true, result)
          } catch {
            return this.executeFailure(params, isCurrent() ? 'timeout' : 'control-interrupted', isCurrent() ? 'Navigation timed out.' : 'Human input interrupted navigation.', true)
          }
        }

        try {
          await this.debuggers.attach(params.tabId)
        } catch (error) {
          if (error instanceof DebuggerAttachConflictError) {
            return this.executeFailure(params, 'debugger-unavailable', error.message, true, EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS)
          }
          throw error
        }
        await this.chrome.scripting.executeScript({ target: { tabId: params.tabId, allFrames: true }, files: [`payloads/${this.directory}/content-script.js`], world: 'ISOLATED' })
        controlEpoch = await this.authorities.beginAgentControl(params.leaseId, params.leaseEpoch, params.tabId, expectedEpoch)
        const isCurrent = () => this.authorities.isOperationCurrent(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch as number)
        if (params.operation === 'click' || params.operation === 'type' || params.operation === 'press') {
          syntheticOperationId = crypto.randomUUID()
          await this.signalSyntheticStart(params.tabId, syntheticOperationId, controlEpoch)
        }
        if (navigateInput !== null) {
          const deadline = Math.min(Date.parse(params.deadlineAt), Date.now() + navigateInput.timeoutMs)
          try { await this.debuggers.navigateAndWait(params.tabId, navigateInput.url as string, navigateInput.readiness, deadline, isCurrent) }
          catch {
            return this.executeFailure(params, isCurrent() ? 'timeout' : 'control-interrupted', isCurrent() ? 'Navigation timed out.' : 'Human input interrupted navigation.', true)
          }
          if (!isCurrent()) return this.executeFailure(params, 'control-interrupted', 'Human input interrupted navigation.', true)
          const tab = await this.chrome.tabs.get(params.tabId)
          const result: BrowserAutomationResultByOperation['navigate'] = { tab: this.browserTab(tab, operationAuthority), readiness: navigateInput.readiness }
          return this.executeResponse(params, true, result)
        }
        const outcome = await this.operations.executeNow(params, {
          navigationGeneration: this.debuggers.navigationGeneration(params.tabId),
          isCurrent,
          wasHumanInterrupted: () => !isCurrent(),
          cancelOutstanding: async () => { await this.authorities.markLost(params.tabId); await this.debuggers.reset(params.tabId) },
        })
        return outcome.ok ? this.executeResponse(params, true, outcome.result) : this.executeFailure(params, outcome.error.code, outcome.error.message, outcome.error.retryable, outcome.error.details)
      } catch (error) {
        const code = error instanceof LeaseError
          ? error.code
          : params.operation === 'evaluate' ? 'evaluation-failed' : 'execution-failed'
        return this.executeFailure(params, code, error instanceof Error ? error.message : 'Chrome operation failed', true)
      } finally {
        if (syntheticOperationId !== null && controlEpoch !== null) this.signalSyntheticEnd(params.tabId, syntheticOperationId, controlEpoch)
        if (controlEpoch !== null) await this.authorities.finishAgentControl(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch)
        try { await this.debuggers.reset(params.tabId) } catch { await this.authorities.markLost(params.tabId) }
        resolveTracked()
        if (this.activeOperations.get(params.tabId) === tracked) this.activeOperations.delete(params.tabId)
      }
    })
  }

  private executeResponse(params: ExternalChromeExecuteParams, ok: true, result: unknown): Record<string, unknown> { return { protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, tabId: params.tabId, operation: params.operation, ok, result } }
  private executeFailure(params: ExternalChromeExecuteParams, code: string, message: string, retryable: boolean, details?: Record<string, string | number | boolean | null>): Record<string, unknown> { return { protocolVersion: 1, requestId: params.requestId, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, tabId: params.tabId, operation: params.operation, ok: false, error: { code, message: message.slice(0, 1_024), retryable, ...(details ? { details } : {}) } } }

  private browserTab(tab: ChromeTab, authority: TabAuthorityRecord): BrowserTabSnapshot {
    const now = new Date().toISOString()
    return { targetAffinity: 'external-chrome', tabId: String(tab.id), sessionAgentId: authority.sessionAgentId, profileId: this.extensionInstanceId, url: tab.url ?? '', title: tab.title ?? '', lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: authority.state === 'agent' ? 'agent' : 'human', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now }
  }

  private handleConnect(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const port = value as ContentPort
    const tabId = port.sender?.tab?.id
    if (tabId === undefined || !/^forge-leased-frame:[0-9a-f-]{36}$/u.test(port.name) || this.authorities.forTab(tabId) === null) { port.disconnect(); return }
    const ports = this.contentPorts.get(tabId) ?? new Set<ContentPort>()
    ports.add(port); this.contentPorts.set(tabId, ports)
    port.onMessage.addListener((message) => {
      if (typeof message !== 'object' || message === null) return
      const record = message as Record<string, unknown>
      if (record.nonce !== port.name.slice('forge-leased-frame:'.length)) return
      if (record.type === 'content-ready') {
        const ready = this.readyContentPorts.get(tabId) ?? new Set<ContentPort>()
        ready.add(port)
        this.readyContentPorts.set(tabId, ready)
        return
      }
      if (record.type === 'synthetic-ack' && typeof record.operationId === 'string' && Number.isSafeInteger(record.controlEpoch)) {
        const acknowledgement = this.syntheticAcknowledgements.get(this.syntheticKey(tabId, record.operationId))
        if (acknowledgement === undefined || acknowledgement.controlEpoch !== record.controlEpoch) return
        acknowledgement.pending.delete(port)
        if (acknowledgement.pending.size === 0) acknowledgement.resolve()
        return
      }
      if (record.type === 'trusted-human-input') void this.interrupt(tabId, record.event)
    })
    port.onDisconnect.addListener(() => {
      ports.delete(port)
      if (ports.size === 0) this.contentPorts.delete(tabId)
      const ready = this.readyContentPorts.get(tabId)
      ready?.delete(port)
      if (ready?.size === 0) this.readyContentPorts.delete(tabId)
      for (const acknowledgement of this.syntheticAcknowledgements.values()) {
        acknowledgement.pending.delete(port)
        if (acknowledgement.pending.size === 0) acknowledgement.resolve()
      }
    })
  }

  private broadcastState(tabIds: number[], state: 'human' | 'agent' | 'detached'): void {
    for (const tabId of tabIds) for (const port of this.contentPorts.get(tabId) ?? []) {
      const nonce = port.name.slice('forge-leased-frame:'.length)
      port.postMessage({ type: 'status', nonce, state })
    }
  }

  private async signalSyntheticStart(tabId: number, operationId: string, controlEpoch: number): Promise<void> {
    const deadline = Date.now() + 1_000
    while ((this.readyContentPorts.get(tabId)?.size ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const ports = new Set(this.readyContentPorts.get(tabId) ?? [])
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
      })
      for (const port of ports) {
        const nonce = port.name.slice('forge-leased-frame:'.length)
        port.postMessage({ type: 'synthetic-start', nonce, operationId, controlEpoch, durationMs: 1_000 })
      }
    })
  }

  private signalSyntheticEnd(tabId: number, operationId: string, controlEpoch: number): void {
    for (const port of this.readyContentPorts.get(tabId) ?? []) {
      const nonce = port.name.slice('forge-leased-frame:'.length)
      port.postMessage({ type: 'synthetic-end', nonce, operationId, controlEpoch })
    }
  }

  private syntheticKey(tabId: number, operationId: string): string { return `${tabId}\0${operationId}` }

  private async interrupt(tabId: number, event: unknown): Promise<void> {
    const authority = await this.authorities.trustedHumanInput(tabId)
    if (authority === null) return
    // Epoch changes synchronously before detach, so no queued CDP command can replay after interruption.
    await this.debuggers.reset(tabId).catch(() => undefined)
    this.native?.sendNotification('browser.userControl', { protocolVersion: 1, leaseId: authority.ownerId, leaseEpoch: authority.ownerEpoch, tabId, controlEpoch: authority.controlEpoch, event: ['pointer', 'key', 'wheel', 'touch'].includes(String(event)) ? event as string : 'pointer', at: new Date().toISOString() })
  }

  private async navigateInitialTarget(
    params: ExternalChromeExecuteParams,
    url: string,
    readiness: 'load' | 'domContentLoaded' | 'none',
    deadline: number,
    isCurrent: () => boolean,
    authorityCurrent: () => boolean,
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
    const remaining = deadline - Date.now()
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
        else if (Date.now() >= deadline) finish({ error: new Error('initial navigation deadline elapsed') })
        else finish({ value })
      }, (error) => finish({ error }))
    })
  }

  private async handleNavigationCommitted(value: unknown): Promise<void> {
    const details = value as { tabId?: unknown; frameId?: unknown; documentId?: unknown; url?: unknown }
    if (!Number.isSafeInteger(details.tabId) || !Number.isSafeInteger(details.frameId)) return
    const tabId = details.tabId as number
    const transition = this.initialNavigations.get(tabId)
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
    if (source.tabId === undefined || !this.activeOperations.has(source.tabId)) return
    const method = typeof args[1] === 'string' ? args[1] : ''
    const accepted = await this.debuggers.onEvent(source, method, args[2])
    if (!accepted.accepted) return
    const sessionId = accepted.sessionId ?? source.sessionId
    const targetId = accepted.targetId ?? this.debuggers.targetId(source.tabId, sessionId)
    if (targetId !== undefined) this.operations.onCdpEvent(source.tabId, { targetId, ...(sessionId ? { sessionId } : {}) }, method, args[2])
  }

  private async handleDebuggerDetach(args: unknown[]): Promise<void> {
    const source = args[0] as { tabId?: number }
    if (source.tabId === undefined || this.debuggers.onDetach(source, String(args[1] ?? 'unknown')) === null) return
    await this.authorities.markLost(source.tabId)
    this.operations.clear(source.tabId)
  }

  private async handleTabRemoved(value: unknown): Promise<void> {
    if (!Number.isSafeInteger(value)) return
    const transition = this.initialNavigations.get(value as number)
    if (transition !== undefined) {
      this.rejectInitialNavigation(transition, new Error('initial navigation target was removed'))
      this.initialNavigations.delete(value as number)
    }
    const authority = this.authorities.forTab(value as number)
    if (authority !== null) await this.authorities.release(authority.ownerId, authority.ownerEpoch, authority.tabId)
    await this.authorities.forgetNeutralTarget(value as number)
    this.operations.clear(value as number)
  }

  private async injectContentScript(value: unknown, transition?: InitialNavigationTransition): Promise<boolean> {
    const details = value as { tabId?: unknown; frameId?: unknown; url?: unknown }
    if (!Number.isSafeInteger(details.tabId) || !Number.isSafeInteger(details.frameId) || typeof details.url !== 'string' ||
      restrictedTargetReason(details.url) !== null) return false
    const tabId = details.tabId as number
    const transitionAuthorized = transition !== undefined && this.initialNavigations.get(tabId) === transition && transition.authorityCurrent()
    if (!transitionAuthorized && !this.activeOperations.has(tabId)) return false
    const tab = await this.chrome.tabs.get(tabId)
    if (restrictedTargetReason(tab.url) !== null || transition !== undefined && !transition.authorityCurrent()) return false
    await this.chrome.scripting.executeScript({ target: { tabId, frameIds: [details.frameId as number] }, files: [`payloads/${this.directory}/content-script.js`], world: 'ISOLATED' })
    return true
  }

  private async expireAuthorities(): Promise<void> {
    const expired = await this.authorities.expire()
    await Promise.all(expired.map((record) => this.debuggers.reset(record.tabId)))
    if (this.native !== null && !this.native.isConnected()) { this.native.stop(); this.native.start() }
  }

  private async detachAllOperations(): Promise<void> { await Promise.allSettled(this.authorities.all().map((record) => this.debuggers.reset(record.tabId))) }
}

export async function activateServiceWorker(identity: VerifiedPayloadIdentity): Promise<ServiceWorkerPayload> {
  const runtime = new Runtime(); await runtime.initialize(identity); return runtime
}
