import type {
  BrowserAutomationResultByOperation,
  BrowserTabSnapshot,
  ExternalChromeExecuteParams,
  ExternalChromeJsonRpcMessage,
  ExternalChromeRequest,
} from '@forge/protocol'
import { DebuggerController } from '../../runtime/debugger-controller.js'
import { installedChrome, type ChromeRuntimePort, type ChromeRuntimeSender, type ChromeTab } from '../../runtime/chrome-api.js'
import { PAYLOAD_VERSION } from '../../runtime/identity.js'
import { LeaseError, LeaseManager, type TabAuthorityRecord } from '../../runtime/lease-manager.js'
import { NativeRpcClient } from '../../runtime/native-rpc-client.js'
import { ExternalChromeOperationExecutor } from '../../runtime/operation-executor.js'
import { restrictedTargetReason } from '../../runtime/restricted-target.js'
import type { ServiceWorkerPayload, ShellEventName, VerifiedPayloadIdentity } from '../../shell/service-worker-bootstrap.js'
import { loadVerifiedPayloadSelector } from '../../shell/selector.js'

const INSTANCE_KEY = 'forge.externalChrome.instanceId.v1'
const PROFILE_ALIAS_KEY = 'forge.externalChrome.profileAlias.v1'
const HEARTBEAT_ALARM = 'forge.externalChrome.heartbeat.v2'
const TRANSPORT_GRACE_ALARM = 'forge.externalChrome.transportGrace.v2'
const REUSE_SENTINEL = '__forge_reuse_focused_tab__'
const REVEAL_SENTINEL = '/* forge:reveal-authorized-tab:v1 */ undefined'

type ContentPort = ChromeRuntimePort & { sender?: ChromeRuntimeSender }

function chromeVersion(): string { return /Chrom(?:e|ium)\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? 'unknown' }
function selectedTab(tab: ChromeTab): Record<string, unknown> {
  const url = tab.url ?? ''
  let origin = ''
  try { origin = new URL(url).origin } catch { /* restricted before selection */ }
  return { windowId: tab.windowId ?? 0, tabId: tab.id ?? 0, groupId: null, title: tab.title ?? '', url, origin, active: tab.active === true }
}

export class Runtime implements ServiceWorkerPayload {
  private readonly chrome = installedChrome()
  private readonly authorities = new LeaseManager(this.chrome, PAYLOAD_VERSION)
  private readonly debuggers = new DebuggerController(this.chrome.debugger)
  private readonly operations = new ExternalChromeOperationExecutor(this.debuggers, (tabId) => this.chrome.tabs.get(tabId))
  private readonly contentPorts = new Map<number, Set<ContentPort>>()
  private readonly activeOperations = new Map<number, Promise<void>>()
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
    const alias = await this.chrome.storage.local.get(PROFILE_ALIAS_KEY)
    const profileAlias = typeof alias[PROFILE_ALIAS_KEY] === 'string' ? String(alias[PROFILE_ALIAS_KEY]).slice(0, 512) : undefined
    const recovered = await this.authorities.recover()
    // Recovery restores only CAS ownership. Prove and release any attachment that
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
      ...(profileAlias ? { profileAlias } : {}),
      onDisconnected: () => this.chrome.alarms.create(TRANSPORT_GRACE_ALARM, { delayInMinutes: 0.1 }),
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
      case 'navigation.committed': void this.injectContentScript(args[0]); return undefined
      case 'alarm': {
        const alarm = args[0] as { name?: string } | undefined
        if (alarm?.name === HEARTBEAT_ALARM) void this.expireAuthorities()
        if (alarm?.name === TRANSPORT_GRACE_ALARM && this.native?.isConnected() !== true) void this.detachAllOperations()
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
      // V1 required this method in hello. Automatic v2 reports only whether one
      // focused tab is eligible for reuse; it never enumerates tabs.
      case 'forge.browser.listCandidates': {
        const focusedEligible = await this.authorities.focusedEligibleTab() !== null
        return {
          protocolVersion: 1, extensionInstanceId: this.extensionInstanceId,
          windows: focusedEligible ? [{ windowId: 0, focused: true, groups: [], tabs: [] }] : [],
        }
      }
      case 'forge.browser.claim': {
        const acquired = await Promise.all(request.params.tabIds.map((tabId) => this.authorities.acquire({
          tabId, ownerId: request.params.leaseId, ownerEpoch: request.params.leaseEpoch,
          sessionAgentId: request.params.sessionAgentId, expectedOwnerEpoch: 0,
        })))
        return {
          protocolVersion: 1, leaseId: request.params.leaseId, leaseEpoch: request.params.leaseEpoch,
          sessionAgentId: request.params.sessionAgentId, extensionInstanceId: this.extensionInstanceId,
          groupId: null, childPolicy: 'manual', tabs: acquired.map(({ tab }) => selectedTab(tab)),
        }
      }
      case 'forge.browser.create': {
        // Focus is only a reuse preference. Once Desktop has selected this
        // unambiguous profile, focus loss or an ineligible active tab allocates a
        // dedicated ungrouped Forge tab rather than requiring a picker.
        const { tab, createdByForge } = await this.authorities.allocateAutomaticTab({
          reuseFocused: request.params.groupTitle === REUSE_SENTINEL,
          ...(request.params.url === undefined ? {} : { url: request.params.url }),
        })
        if (tab.id === undefined) throw new LeaseError('target-not-found', 'Chrome did not return a tab ID')
        try {
          await this.authorities.acquire({
            tabId: tab.id, ownerId: request.params.leaseId, ownerEpoch: request.params.leaseEpoch,
            sessionAgentId: request.params.sessionAgentId, expectedOwnerEpoch: 0, createdByForge,
          })
        } catch (error) {
          if (createdByForge) await this.chrome.tabs.remove(tab.id).catch(() => undefined)
          throw error
        }
        return {
          protocolVersion: 1, leaseId: request.params.leaseId, leaseEpoch: request.params.leaseEpoch,
          sessionAgentId: request.params.sessionAgentId, extensionInstanceId: this.extensionInstanceId,
          // V1's obsolete group field is a compatibility placeholder; the tab remains ungrouped.
          groupId: 0, tab: selectedTab(tab),
        }
      }
      case 'forge.browser.release': {
        const tabIds = this.authorities.all().filter((entry) => entry.ownerId === request.params.leaseId && entry.ownerEpoch === request.params.leaseEpoch).map((entry) => entry.tabId)
        await Promise.all(tabIds.map((tabId) => this.debuggers.reset(tabId)))
        this.broadcastState(tabIds, 'detached')
        const releasedTabIds = await this.authorities.releaseOwner(request.params.leaseId, request.params.leaseEpoch)
        for (const tabId of releasedTabIds) this.operations.clear(tabId)
        return { protocolVersion: 1, leaseId: request.params.leaseId, leaseEpoch: request.params.leaseEpoch, releasedTabIds }
      }
      case 'forge.browser.execute': return this.execute(request.params)
      case 'forge.browser.turnEnded': {
        const exact = [...request.params.finalTabs, ...request.params.handoffTabs]
        if (new Set(exact).size !== exact.length) throw new LeaseError('scope-mismatch', 'turn disposition contains duplicate tabs')
        // Debugger control never survives an operation. Final releases ownership; handoff retains per-tab CAS affinity.
        this.broadcastState(request.params.finalTabs, 'detached')
        for (const tabId of request.params.finalTabs) await this.authorities.release(request.params.leaseId, request.params.leaseEpoch, tabId)
        return { protocolVersion: 1, leaseId: request.params.leaseId, leaseEpoch: request.params.leaseEpoch, turnId: request.params.turnId, releasedTabs: request.params.finalTabs, handoffTabs: request.params.handoffTabs }
      }
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
    if (params.operation === 'status') return this.executeResponse(params, true, { available: true, host: { hostKind: 'external-chrome', connected: true, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null }, panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: this.browserTab(await this.chrome.tabs.get(params.tabId), authority) })
    if (params.operation === 'evaluate' && (params.input as { expression?: unknown }).expression === REVEAL_SENTINEL) {
      const tab = await this.chrome.tabs.get(params.tabId)
      const tabs = this.chrome.tabs as unknown as { update(tabId: number, properties: { active: boolean }): Promise<unknown> }
      const windows = this.chrome.windows as unknown as { update(windowId: number, properties: { focused: boolean }): Promise<unknown> }
      await tabs.update(params.tabId, { active: true })
      if (tab.windowId !== undefined) await windows.update(tab.windowId, { focused: true })
      return this.executeResponse(params, true, { tabId: String(params.tabId), value: null, serializedBytes: 4 })
    }
    if (!['navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor'].includes(params.operation)) return this.executeFailure(params, 'unsupported-operation', `External Chrome does not support ${params.operation}.`, false)
    return this.operations.runExclusive(params.tabId, async () => {
      let resolveTracked!: () => void
      const tracked = new Promise<void>((resolve) => { resolveTracked = resolve })
      this.activeOperations.set(params.tabId, tracked)
      const expectedEpoch = authority.controlEpoch
      let controlEpoch: number | null = null
      let syntheticOperationId: string | null = null
      try {
        if (!this.acceptingOperations || Date.parse(params.deadlineAt) <= Date.now()) return this.executeFailure(params, 'timeout', 'Operation deadline elapsed.', true)
        await this.debuggers.attach(params.tabId)
        await this.chrome.scripting.executeScript({ target: { tabId: params.tabId, allFrames: true }, files: [`payloads/${this.directory}/content-script.js`], world: 'ISOLATED' })
        controlEpoch = await this.authorities.beginAgentControl(params.leaseId, params.leaseEpoch, params.tabId, expectedEpoch)
        const isCurrent = () => this.authorities.isOperationCurrent(params.leaseId, params.leaseEpoch, params.tabId, controlEpoch as number)
        if (params.operation === 'click' || params.operation === 'type' || params.operation === 'press') {
          syntheticOperationId = crypto.randomUUID()
          this.signalSynthetic(params.tabId, 'synthetic-start', syntheticOperationId, controlEpoch)
        }
        if (params.operation === 'navigate') {
          const input = params.input as { url?: string; readiness: 'load' | 'domContentLoaded' | 'none'; timeoutMs: number }
          if (!input.url || restrictedTargetReason(input.url) !== null) return this.executeFailure(params, 'restricted-target', 'Navigation target is missing or restricted.', false)
          const deadline = Math.min(Date.parse(params.deadlineAt), Date.now() + input.timeoutMs)
          try { await this.debuggers.navigateAndWait(params.tabId, input.url, input.readiness, deadline, isCurrent) }
          catch {
            return this.executeFailure(params, isCurrent() ? 'timeout' : 'control-interrupted', isCurrent() ? 'Navigation timed out.' : 'Human input interrupted navigation.', true)
          }
          if (!isCurrent()) return this.executeFailure(params, 'control-interrupted', 'Human input interrupted navigation.', true)
          const tab = await this.chrome.tabs.get(params.tabId)
          const result: BrowserAutomationResultByOperation['navigate'] = { tab: this.browserTab(tab, authority), readiness: input.readiness }
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
        return this.executeFailure(params, error instanceof LeaseError ? error.code : 'debugger-unavailable', error instanceof Error ? error.message : 'Chrome operation failed', true)
      } finally {
        if (syntheticOperationId !== null && controlEpoch !== null) this.signalSynthetic(params.tabId, 'synthetic-end', syntheticOperationId, controlEpoch)
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
    // The authenticated extension wire remains V1-shaped; Desktop converts this
    // compatibility alias to the protocol-v2 targetAffinity before returning it.
    return { hostKind: 'external-chrome', tabId: String(tab.id), sessionAgentId: authority.sessionAgentId, profileId: this.extensionInstanceId, url: tab.url ?? '', title: tab.title ?? '', lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: authority.state === 'agent' ? 'agent' : 'human', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now } as unknown as BrowserTabSnapshot
  }

  private handleConnect(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const port = value as ContentPort
    const tabId = port.sender?.tab?.id
    if (tabId === undefined || !/^forge-leased-frame:[0-9a-f-]{36}$/u.test(port.name) || this.authorities.forTab(tabId) === null) { port.disconnect(); return }
    const ports = this.contentPorts.get(tabId) ?? new Set<ContentPort>()
    ports.add(port); this.contentPorts.set(tabId, ports)
    port.onMessage.addListener((message) => {
      if (typeof message !== 'object' || message === null || (message as Record<string, unknown>).type !== 'trusted-human-input') return
      void this.interrupt(tabId, (message as Record<string, unknown>).event)
    })
    port.onDisconnect.addListener(() => { ports.delete(port); if (ports.size === 0) this.contentPorts.delete(tabId) })
  }

  private broadcastState(tabIds: number[], state: 'human' | 'agent' | 'detached'): void {
    for (const tabId of tabIds) for (const port of this.contentPorts.get(tabId) ?? []) {
      const nonce = port.name.slice('forge-leased-frame:'.length)
      port.postMessage({ type: 'status', nonce, state })
    }
  }

  private signalSynthetic(tabId: number, type: 'synthetic-start' | 'synthetic-end', operationId: string, controlEpoch: number): void {
    for (const port of this.contentPorts.get(tabId) ?? []) {
      const nonce = port.name.slice('forge-leased-frame:'.length)
      port.postMessage({ type, nonce, operationId, controlEpoch, ...(type === 'synthetic-start' ? { durationMs: 1_000 } : {}) })
    }
  }

  private async interrupt(tabId: number, event: unknown): Promise<void> {
    const authority = await this.authorities.trustedHumanInput(tabId)
    if (authority === null) return
    // Epoch changes synchronously before detach, so no queued CDP command can replay after interruption.
    await this.debuggers.reset(tabId).catch(() => undefined)
    this.native?.sendNotification('browser.userControl', { protocolVersion: 1, leaseId: authority.ownerId, leaseEpoch: authority.ownerEpoch, tabId, controlEpoch: authority.controlEpoch, event: ['pointer', 'key', 'wheel', 'touch'].includes(String(event)) ? event as string : 'pointer', at: new Date().toISOString() })
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
    const authority = this.authorities.forTab(value as number)
    if (authority !== null) await this.authorities.release(authority.ownerId, authority.ownerEpoch, authority.tabId)
    this.operations.clear(value as number)
  }

  private async injectContentScript(value: unknown): Promise<void> {
    const details = value as { tabId?: unknown; frameId?: unknown }
    if (!Number.isSafeInteger(details.tabId) || !Number.isSafeInteger(details.frameId) || !this.activeOperations.has(details.tabId as number)) return
    await this.chrome.scripting.executeScript({ target: { tabId: details.tabId as number, frameIds: [details.frameId as number] }, files: [`payloads/${this.directory}/content-script.js`], world: 'ISOLATED' }).catch(() => [])
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
