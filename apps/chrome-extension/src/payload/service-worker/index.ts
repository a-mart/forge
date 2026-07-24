import type { ExternalChromeChildPolicy } from '@forge/protocol'
import { DebuggerController } from '../../runtime/debugger-controller.js'
import { installedChrome, type ChromeRuntimePort, type ChromeRuntimeSender, type ChromeTab } from '../../runtime/chrome-api.js'
import { SyntheticInputSequencer, type SyntheticInputOperation } from '../../runtime/human-control.js'
import { PAYLOAD_VERSION } from '../../runtime/identity.js'
import { LeaseError, LeaseManager } from '../../runtime/lease-manager.js'
import { NativeRpcClient } from '../../runtime/native-rpc-client.js'
import type { ServiceWorkerPayload, ShellEventName } from '../../shell/service-worker-bootstrap.js'

const INSTANCE_KEY = 'forge.externalChrome.instanceId.v1'
const HEARTBEAT_ALARM = 'forge.externalChrome.heartbeat.v1'
const TRANSPORT_GRACE_ALARM = 'forge.externalChrome.transportGrace.v1'

interface ContentPort extends ChromeRuntimePort {
  sender?: ChromeRuntimeSender
}

type MessageResponse = (response: unknown) => void

interface PickerMessage {
  kind: 'picker.list' | 'picker.claim' | 'picker.release' | 'picker.current'
  leaseId?: string
  leaseEpoch?: number
  sessionAgentId?: string
  tabIds?: number[]
  groupId?: number
  childPolicy?: ExternalChromeChildPolicy
}

function isPickerMessage(value: unknown): value is PickerMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return ['picker.list', 'picker.claim', 'picker.release', 'picker.current'].includes(String((value as Record<string, unknown>).kind))
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

function payloadDirectory(): string {
  const match = /\/payloads\/([^/]+)\/service-worker\.js(?:\?|$)/.exec(import.meta.url)
  if (match === null || !match[1].startsWith(`${PAYLOAD_VERSION}-`)) throw new Error('payload directory does not match runtime version')
  return match[1]
}

class Runtime implements ServiceWorkerPayload {
  private readonly chrome = installedChrome()
  private readonly leases = new LeaseManager(this.chrome, PAYLOAD_VERSION)
  private readonly debuggers = new DebuggerController(this.chrome.debugger)
  private readonly contentPorts = new Map<number, Set<ContentPort>>()
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

  async initialize(): Promise<void> {
    this.directory = payloadDirectory()
    const stored = await this.chrome.storage.local.get(INSTANCE_KEY)
    const extensionInstanceId = typeof stored[INSTANCE_KEY] === 'string' ? stored[INSTANCE_KEY] as string : crypto.randomUUID()
    if (stored[INSTANCE_KEY] !== extensionInstanceId) await this.chrome.storage.local.set({ [INSTANCE_KEY]: extensionInstanceId })
    await this.chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    this.chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 })
    this.native = new NativeRpcClient({
      connect: (hostName) => this.chrome.runtime.connectNative(hostName),
      extensionInstanceId,
      chromeVersion: chromeVersion(),
      onConnected: () => { void this.chrome.alarms.clear(TRANSPORT_GRACE_ALARM) },
      onDisconnected: () => { this.chrome.alarms.create(TRANSPORT_GRACE_ALARM, { delayInMinutes: 0.1 }) },
    })
    this.native.start()
    const recovered = await this.leases.recover()
    if (recovered !== null) {
      try {
        for (const tabId of recovered.tabIds) await this.attachTab(tabId)
      } catch {
        await this.debuggers.detachAll()
        await this.leases.release(recovered.leaseId, recovered.leaseEpoch)
      }
    }
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
      case 'alarm': {
        const alarm = args[0] as { name?: string } | undefined
        if (alarm?.name === HEARTBEAT_ALARM && this.native !== null && !this.native.isConnected()) {
          this.native.stop()
          this.native.start()
        }
        if (alarm?.name === TRANSPORT_GRACE_ALARM && this.native?.isConnected() !== true) void this.handleTransportLoss()
        return undefined
      }
      default: return undefined
    }
  }

  shutdown(): void {
    this.native?.stop()
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

  private async dispatchPicker(message: PickerMessage): Promise<unknown> {
    if (message.kind === 'picker.list') return { windows: await this.leases.listCandidates(), lease: this.leases.current() }
    if (message.kind === 'picker.current') return { lease: this.leases.current() }
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
        for (const tabId of claimed.lease.tabIds) await this.attachTab(tabId)
      } catch (error) {
        await this.debuggers.detachAll()
        await this.leases.release(claimed.lease.leaseId, claimed.lease.leaseEpoch)
        throw new LeaseError('lease-lost', error instanceof Error ? error.message : 'debugger attach failed')
      }
      return { lease: claimed.lease, tabs: claimed.tabs.map(selectedTab) }
    }
    if (typeof message.leaseId !== 'string' || !Number.isSafeInteger(message.leaseEpoch)) throw new LeaseError('lease-lost', 'release fields are invalid')
    const lease = this.leases.current()
    const releasedTabIds = await this.leases.release(message.leaseId, message.leaseEpoch as number)
    for (const tabId of releasedTabIds) await this.debuggers.detach(tabId)
    if (lease !== null) this.broadcastStatus(lease.tabIds, 'human')
    return { releasedTabIds }
  }

  private async attachTab(tabId: number): Promise<void> {
    await this.debuggers.attach(tabId)
    await this.chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [`payloads/${this.directory}/content-script.js`],
      world: 'ISOLATED',
    })
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
    const lease = this.leases.current()
    if (lease === null || !lease.tabIds.includes(source.tabId)) return
    const targetId = accepted.targetId ?? this.debuggers.targetId(source.tabId, source.sessionId)
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
    await this.debuggers.detachAll()
    this.broadcastStatus(lease.tabIds, 'human')
    this.native?.sendNotification('browser.detached', {
      protocolVersion: 1,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      tabId: notice.tabId,
      reason: notice.devtoolsContention ? 'devtools-or-debugger-contention' : reason.slice(0, 256),
    })
  }

  private async handleTabRemoved(tabId: unknown): Promise<void> {
    if (!Number.isSafeInteger(tabId)) return
    const lease = this.leases.current()
    if (lease?.tabIds.includes(tabId as number) !== true) return
    await this.leases.markLost()
    await this.debuggers.detachAll()
  }

  private async handleTransportLoss(): Promise<void> {
    const lease = this.leases.current()
    if (lease === null) return
    await this.leases.markLost()
    await this.debuggers.detachAll()
    this.broadcastStatus(lease.tabIds, 'human')
  }

  private broadcastStatus(tabIds: number[], state: 'human' | 'agent' | 'handoff'): void {
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

export async function activateServiceWorker(): Promise<ServiceWorkerPayload> {
  const runtime = new Runtime()
  await runtime.initialize()
  return runtime
}
